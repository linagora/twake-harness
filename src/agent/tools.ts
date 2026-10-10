import type { FastifyBaseLogger } from 'fastify';
import { z } from 'zod';

import { setAssistantLocale } from '../assistants/repository.js';
import type { ConsentMetrics } from '../consents/metrics.js';
import { listConsents, toConsentView, withdrawConsents } from '../consents/repository.js';
import type { WaitReason } from '../consents/consent.js';
import type { OwnerRequest } from '../consents/request.js';
import { withPrincipal, type Db, type Tx } from '../db/client.js';
import { getMessages, isLocale, LOCALES, type Locale } from '../i18n/messages.js';
import type { LlmToolDefinition } from '../llm/client.js';
import {
	addMemoryEntry,
	removeMemoryEntry,
	replaceMemoryEntry,
	toMemoryTarget
} from '../memory/repository.js';
import { ORGANIZATION_PRINCIPAL } from '../principals/principal.js';
import {
	findSession,
	holdSession,
	listSessionIds,
	searchSessions
} from '../sessions/repository.js';
import {
	findSkill,
	insertSkill,
	listSkills,
	searchSkills,
	toSkillMarkdown
} from '../skills/repository.js';

export const ACCESS_DENIED = { error: 'access denied' } as const;

// What the model reads when its turn may not use a right its owner holds, such as a turn an event
// started changing the assistant's language or keeping a note: it relays the proposal and waits
// for a yes. A write through a contract never reads it: it waits for its owner instead.
export const NEEDS_OWNER_APPROVAL = {
	error: 'needs_owner_approval',
	hint: "This action needs the owner's approval. Tell the owner what you would do and ask them; act only after their explicit yes in the room."
} as const;

export interface ToolOutcome {
	// What the model reads back
	readonly result: unknown;
	// When set, the turn ends with this text as the answer to the user
	readonly final?: string;
	// Set when the caller tried to reach something that is not theirs
	readonly denied?: boolean;
	// The call the harness froze until its owner answers, when the turn ends on its question
	readonly pendingCallId?: string;
	// That question in its parts, when the harness laid it out as a request about the call:
	// `final` is its plain text
	readonly request?: OwnerRequest;
	// The brief the turn ends on, when `final` is the brief the owner asked for
	readonly brief?: TurnBrief;
}

// A brief a turn ends on: the date it is of, and its HTML, which the harness laid out
export interface TurnBrief {
	readonly date: string;
	readonly html: string;
}

// How a tool call ended, as the info logs report it: never the arguments or the result
export type ToolCallStatus = 'ok' | 'final' | 'denied' | 'unknown_tool' | 'invalid_arguments';

export function toolCallStatus(outcome: ToolOutcome): ToolCallStatus {
	if (outcome.denied === true) return 'denied';
	return outcome.final === undefined ? 'ok' : 'final';
}

// Who started a turn: the owner, by a message or a request, an event the harness took from the
// broker, or a suggestion the harness made from the messages of a channel. The last two come from
// what other people wrote, so every write they prepare waits for the owner.
export type TurnOrigin = 'owner' | 'event' | 'suggestion';

// Whether a turn comes from what other people wrote: any but the owner's own, which a turn that
// names no origin is
export function comesFromOthers(origin: TurnOrigin | undefined): boolean {
	return (origin ?? 'owner') !== 'owner';
}

export interface ToolContext {
	readonly principalId: string;
	// Who started the turn, which a call frozen in it keeps for the turn its owner's answer resumes:
	// every write a turn an event started prepares waits for its owner
	readonly origin?: TurnOrigin;
	readonly actions: readonly string[];
	// Actions the principal holds but this turn may not use: a turn an event started never changes
	// the owner's settings nor keeps anything, so text written by a third party cannot steer the
	// assistant, now or in a later turn. The zone a read of the owner's calendar returns is kept
	// whatever turn read it, one an event started included: the contract takes it from the settings
	// of their calendar, which no third party writes.
	readonly withheldActions?: readonly string[];
	readonly db: Db;
	// What links this turn's calls in the audit: the request id, or the Matrix event id
	readonly correlationId?: string;
	// The turn's session, which a call frozen in it keeps for its owner's answer; none for a direct
	// tool call through the API
	readonly sessionId?: string;
	// The turn's or the request's logger, for what a tool changes on its owner's behalf
	readonly log: FastifyBaseLogger;
	// What the model wrote alongside this call, in the same answer: a call that waits for its
	// owner shows it to them as the assistant's own words
	readonly accompanyingText?: string;
	// For the call its owner allowed, run again as it was frozen: the reasons their yes answered,
	// which it no longer waits for
	readonly answeredReasons?: readonly WaitReason[];
	// For that call, when its contract showed them what it would do: the digest of that preview,
	// which the call carries so that its contract refuses it should what it acts on have changed
	readonly previewDigest?: string;
	// Nobody waits on the turn to answer a question, as on the brief the worker role asks for: a call
	// that would wait for its owner is not made, or not frozen once the broker refused it, and its
	// result says why
	readonly unattended?: true;
	// For such a turn, the brief: a call the broker refused waits for its owner all the same, and the
	// turn gives way to the harness's question about what they must give the platform first
	readonly asksDelegation?: true;
}

// What the model reads when its turn's conversation was erased with its assistant while the turn
// ran: nothing was kept
export const CONVERSATION_GONE = {
	error: 'conversation_gone',
	hint: 'The owner deleted their assistant while this turn ran, and this conversation with it: nothing was kept, and nothing waits for the owner. Do not make the call again.'
} as const;

// Writes what a call keeps in the name of its turn's conversation, under its owner's principal,
// while that conversation still stands, which is held until the write's transaction ends: an
// erasure that comes meanwhile waits for the write, then erases it too, and one that came first
// leaves nothing to write, which CONVERSATION_GONE says. A direct call through the API has no
// conversation: what it keeps is its owner's own.
export async function keepInConversation<T>(
	context: ToolContext,
	write: (tx: Tx) => Promise<T>
): Promise<T | typeof CONVERSATION_GONE> {
	return withPrincipal(context.db, { id: context.principalId }, async (tx) =>
		context.sessionId === undefined || (await holdSession(tx, context.sessionId))
			? write(tx)
			: CONVERSATION_GONE
	);
}

// Whether a write in the name of a turn's conversation found it gone, and kept nothing
export function isConversationGone<T>(
	kept: T | typeof CONVERSATION_GONE
): kept is typeof CONVERSATION_GONE {
	return kept === CONVERSATION_GONE;
}

export interface Tool {
	readonly definition: LlmToolDefinition;
	// The argument keys the tool accepts; anything else is refused before it runs
	readonly argumentKeys: readonly string[];
	readonly requiredAction: string | null;
	// For a tool of the harness's own whose call may wait for its owner, as listening to an
	// application they have not let their assistant read: what its frozen calls name in place of a
	// contract, by which the call their yes allowed finds the tool again
	readonly frozenAs?: string;
	run(args: unknown, context: ToolContext): Promise<ToolOutcome>;
}

export interface ToolRegistry {
	readonly definitions: readonly LlmToolDefinition[];
	find(name: string): Tool | null;
}

// Static tools, plus a source of tools that may change over time, such as the contract catalog
export function makeToolRegistry(
	tools: readonly Tool[],
	extra: () => readonly Tool[] = () => []
): ToolRegistry {
	const byName = new Map(tools.map((tool) => [tool.definition.function.name, tool]));
	return {
		get definitions() {
			return [...tools, ...extra()].map((tool) => tool.definition);
		},
		find: (name) =>
			byName.get(name) ?? extra().find((tool) => tool.definition.function.name === name) ?? null
	};
}

// The tools of a registry whose names it keeps: no other is offered to the model or run, should it
// name one all the same
function keptTools(registry: ToolRegistry, kept: (name: string) => boolean): ToolRegistry {
	return {
		get definitions() {
			return registry.definitions.filter((tool) => kept(tool.function.name));
		},
		find: (name) => (kept(name) ? registry.find(name) : null)
	};
}

// The tools of a registry but those named
export function withoutTools(registry: ToolRegistry, names: readonly string[]): ToolRegistry {
	return keptTools(registry, (name) => !names.includes(name));
}

// The tools of a registry of those names alone
export function onlyTools(registry: ToolRegistry, names: readonly string[]): ToolRegistry {
	return keptTools(registry, (name) => names.includes(name));
}

function hasOnlyKeys(args: unknown, keys: readonly string[]): args is Record<string, unknown> {
	return (
		typeof args === 'object' &&
		args !== null &&
		!Array.isArray(args) &&
		Object.keys(args).every((key) => keys.includes(key))
	);
}

// Identity never travels in tool arguments: a tool that receives an unknown key, an owner, a
// path or a profile is refused before it runs, whoever the caller is.
export async function runTool(
	tool: Tool,
	args: unknown,
	context: ToolContext
): Promise<ToolOutcome> {
	if (!hasOnlyKeys(args, tool.argumentKeys)) return { result: ACCESS_DENIED, denied: true };
	if (tool.requiredAction !== null && !context.actions.includes(tool.requiredAction)) {
		const withheld = context.withheldActions?.includes(tool.requiredAction) === true;
		return { result: withheld ? NEEDS_OWNER_APPROVAL : ACCESS_DENIED, denied: true };
	}
	return tool.run(args, context);
}

const clarifyArgs = z.object({ question: z.string().min(1) });

// Asking the user a question ends the turn: the question is the answer.
export const clarifyTool: Tool = {
	definition: {
		type: 'function',
		function: {
			name: 'clarify',
			description:
				'Ask the user one short question when the request is ambiguous and you cannot proceed without the answer.',
			parameters: {
				type: 'object',
				properties: { question: { type: 'string', description: 'The question to ask' } },
				required: ['question'],
				additionalProperties: false
			}
		}
	},
	argumentKeys: ['question'],
	requiredAction: null,
	run: async (args) => {
		const parsed = clarifyArgs.safeParse(args);
		if (!parsed.success) return { result: { error: 'question is required' } };
		return { result: { asked: true }, final: parsed.data.question };
	}
};

// The right to change one's own settings, such as the language: a turn an event started never
// holds it, so that a third party's text cannot change how the assistant speaks to its owner. The
// zone of the owner's calendar takes no right: a read of their calendar keeps it, whatever turn
// made the read, as their calendar's settings give it.
export const WRITE_OWN_SETTINGS: string = 'settings.write_own';

// The languages the harness speaks, each by its own name
const LANGUAGES = Object.fromEntries(
	LOCALES.map((locale) => [locale, getMessages(locale).language.name])
) as Readonly<Record<Locale, string>>;

const languageArgs = z.object({ language: z.string() });

// The owner asks their assistant to speak another language: from the next turn on, the assistant
// speaks it with them, and so do the harness's own sentences
export const languageTool: Tool = {
	definition: {
		type: 'function',
		function: {
			name: 'set_language',
			description: `Change the language you speak with the person writing to you, when they ask for it; the harness's own messages follow. Supported: ${LOCALES.map((locale) => `${locale} (${LANGUAGES[locale]})`).join(', ')}.`,
			parameters: {
				type: 'object',
				properties: {
					language: { type: 'string', description: 'The language code, such as en or fr' }
				},
				required: ['language'],
				additionalProperties: false
			}
		}
	},
	argumentKeys: ['language'],
	requiredAction: WRITE_OWN_SETTINGS,
	run: async (args, context) => {
		const parsed = languageArgs.safeParse(args);
		const language = parsed.success ? parsed.data.language.trim().toLowerCase() : '';
		if (!isLocale(language)) {
			return { result: { success: false, error: 'unsupported language', supported: LANGUAGES } };
		}
		// The organization agent speaks the deployment's language with every member
		if (context.principalId === ORGANIZATION_PRINCIPAL)
			return { result: ACCESS_DENIED, denied: true };
		const saved = await withPrincipal(context.db, { id: context.principalId }, (tx) =>
			setAssistantLocale(tx, context.principalId, language)
		);
		return {
			result: saved ? { success: true, language } : { success: false, error: 'no assistant' }
		};
	}
};

const memoryArgs = z.object({
	action: z.enum(['add', 'replace', 'remove']),
	target: z.string().optional(),
	content: z.string().optional(),
	old_text: z.string().optional(),
	new_text: z.string().optional()
});

// The right to keep something for later turns, which read it as the assistant's own notes: a turn
// an event started never holds it, so that a third party's text cannot steer a later turn
export const WRITE_OWN_MEMORY: string = 'memory.write_own';

export const memoryTool: Tool = {
	definition: {
		type: 'function',
		function: {
			name: 'memory',
			description:
				"Persist what is worth remembering across conversations. target 'user' holds who the user is and how they like answers; target 'memory' holds your own notes. Entries are short, one fact each.",
			parameters: {
				type: 'object',
				properties: {
					action: { type: 'string', enum: ['add', 'replace', 'remove'] },
					target: { type: 'string', enum: ['memory', 'user'] },
					content: {
						type: 'string',
						description: 'The entry to add, or the new text of a replace'
					},
					old_text: { type: 'string', description: 'The exact entry to replace or remove' },
					new_text: { type: 'string', description: 'The new text of a replace' }
				},
				required: ['action'],
				additionalProperties: false
			}
		}
	},
	argumentKeys: ['action', 'target', 'content', 'old_text', 'new_text'],
	requiredAction: WRITE_OWN_MEMORY,
	run: async (args, context) => {
		const parsed = memoryArgs.safeParse(args);
		if (!parsed.success) return { result: { success: false, error: 'invalid arguments' } };
		const target = toMemoryTarget(parsed.data.target ?? 'memory');
		if (target === null) return { result: ACCESS_DENIED, denied: true };
		const { action, content, old_text: oldText, new_text: newText } = parsed.data;
		const result = await keepInConversation(context, async (tx) => {
			if (action === 'add') return addMemoryEntry(tx, context.principalId, target, content ?? '');
			if (oldText === undefined) return { success: false as const, error: 'old_text is required' };
			if (action === 'remove') return removeMemoryEntry(tx, context.principalId, target, oldText);
			return replaceMemoryEntry(tx, context.principalId, target, oldText, newText ?? content ?? '');
		});
		return { result };
	}
};

export const sessionsListTool: Tool = {
	definition: {
		type: 'function',
		function: {
			name: 'scoped_sessions_list',
			description: 'List the identifiers of your own past conversations.',
			parameters: { type: 'object', properties: {}, additionalProperties: false }
		}
	},
	argumentKeys: [],
	requiredAction: 'sessions.read_own',
	run: async (_args, context) => ({
		result: {
			sessions: await withPrincipal(context.db, { id: context.principalId }, (tx) =>
				listSessionIds(tx)
			)
		}
	})
};

const sessionReadArgs = z.object({ session_id: z.string() });

export const sessionsReadTool: Tool = {
	definition: {
		type: 'function',
		function: {
			name: 'scoped_sessions_read',
			description: 'Read the transcript of one of your own past conversations.',
			parameters: {
				type: 'object',
				properties: { session_id: { type: 'string' } },
				required: ['session_id'],
				additionalProperties: false
			}
		}
	},
	argumentKeys: ['session_id'],
	requiredAction: 'sessions.read_own',
	run: async (args, context) => {
		const parsed = sessionReadArgs.safeParse(args);
		if (!parsed.success) return { result: ACCESS_DENIED, denied: true };
		const session = await withPrincipal(context.db, { id: context.principalId }, (tx) =>
			findSession(tx, parsed.data.session_id)
		);
		return session === null
			? { result: ACCESS_DENIED, denied: true }
			: { result: { messages: session.messages } };
	}
};

export const skillsListTool: Tool = {
	definition: {
		type: 'function',
		function: {
			name: 'scoped_skills_list',
			description: 'List the skills available to you: your own and those of the organization.',
			parameters: { type: 'object', properties: {}, additionalProperties: false }
		}
	},
	argumentKeys: [],
	requiredAction: 'skills.read_own',
	run: async (_args, context) => ({
		result: {
			skills: await withPrincipal(context.db, { id: context.principalId }, (tx) => listSkills(tx))
		}
	})
};

const skillSearchArgs = z.object({ query: z.string().min(1).max(200) });

export const skillsSearchTool: Tool = {
	definition: {
		type: 'function',
		function: {
			name: 'skills_search',
			description:
				"Find skills by words of their name or description, among yours and the organization's.",
			parameters: {
				type: 'object',
				properties: { query: { type: 'string' } },
				required: ['query'],
				additionalProperties: false
			}
		}
	},
	argumentKeys: ['query'],
	requiredAction: 'skills.read_own',
	run: async (args, context) => {
		const parsed = skillSearchArgs.safeParse(args);
		if (!parsed.success) return { result: { error: 'query is required' } };
		return {
			result: {
				skills: await withPrincipal(context.db, { id: context.principalId }, (tx) =>
					searchSkills(tx, parsed.data.query)
				)
			}
		};
	}
};

const skillReadArgs = z.object({ skill_id: z.string().min(1) });

export const skillsReadTool: Tool = {
	definition: {
		type: 'function',
		function: {
			name: 'scoped_skills_read',
			description: 'Read a skill by its id and follow its instructions for the task at hand.',
			parameters: {
				type: 'object',
				properties: { skill_id: { type: 'string' } },
				required: ['skill_id'],
				additionalProperties: false
			}
		}
	},
	argumentKeys: ['skill_id'],
	requiredAction: 'skills.read_own',
	run: async (args, context) => {
		const parsed = skillReadArgs.safeParse(args);
		if (!parsed.success) return { result: ACCESS_DENIED, denied: true };
		const skill = await withPrincipal(context.db, { id: context.principalId }, (tx) =>
			findSkill(tx, parsed.data.skill_id)
		);
		if (skill === null || skill.status !== 'active') return { result: ACCESS_DENIED, denied: true };
		return { result: { id: skill.id, content: toSkillMarkdown(skill) } };
	}
};

const skillProposeArgs = z.object({
	name: z.string().min(1).max(80),
	description: z.string().min(1).max(500),
	content: z.string().min(1).max(20_000)
});

// What the assistant learns becomes a proposal its owner approves before it is ever used
export const skillsProposeTool: Tool = {
	definition: {
		type: 'function',
		function: {
			name: 'skills_propose',
			description:
				'Propose a new skill from what you learned: a reusable way of doing something for this user. It waits for the user to approve it.',
			parameters: {
				type: 'object',
				properties: {
					name: { type: 'string' },
					description: { type: 'string', description: 'When to use it, in one sentence' },
					content: { type: 'string', description: 'The instructions, in Markdown' }
				},
				required: ['name', 'description', 'content'],
				additionalProperties: false
			}
		}
	},
	argumentKeys: ['name', 'description', 'content'],
	// A proposal keeps what the assistant learned for later turns, as its memory does
	requiredAction: WRITE_OWN_MEMORY,
	run: async (args, context) => {
		const parsed = skillProposeArgs.safeParse(args);
		if (!parsed.success) return { result: { error: 'name, description and content are required' } };
		const skill = await keepInConversation(context, (tx) =>
			insertSkill(tx, {
				scope: 'user',
				owner: context.principalId,
				status: 'proposed',
				...parsed.data
			})
		);
		if (isConversationGone(skill)) return { result: skill };
		return { result: { proposed: skill.id, status: 'proposed' } };
	}
};

// What the owner allowed their assistant to use in their applications, which the model reads to
// answer them; only the owner's own answer to the harness's question ever grants an access
export const consentsListTool: Tool = {
	definition: {
		type: 'function',
		function: {
			name: 'consents_list',
			description:
				"List what the user allowed you to use in their applications: each application for reading or for writing, and how it was allowed. For anything else, the harness asks the user the first time you need it; only the user's answer grants an access, never you.",
			parameters: { type: 'object', properties: {}, additionalProperties: false }
		}
	},
	argumentKeys: [],
	requiredAction: null,
	run: async (_args, context) => {
		// The organization agent acts for no user, and no consent applies to its calls
		if (context.principalId === ORGANIZATION_PRINCIPAL)
			return { result: ACCESS_DENIED, denied: true };
		const consents = await withPrincipal(context.db, { id: context.principalId }, (tx) =>
			listConsents(tx, context.principalId)
		);
		return { result: { consents: consents.map(toConsentView) } };
	}
};

// The right to take back what the owner allowed: a turn an event started never holds it, so that
// a third party's text cannot change what the owner decided
export const WITHDRAW_OWN_CONSENTS: string = 'consents.withdraw_own';

const consentsWithdrawArgs = z.object({
	domain: z.string().min(1).max(64),
	level: z.literal('write').optional()
});

export interface ConsentsWithdrawDeps {
	// The applications the catalog offers now, as consents_list names them
	readonly applications: () => readonly string[];
	// Where the api role counts the questions a withdrawal closes
	readonly consentMetrics: ConsentMetrics;
}

// The owner tells their assistant to stop using an application, or only to stop writing there:
// the next call there asks them again. The model can take an access back, never give one.
export function makeConsentsWithdrawTool(deps: ConsentsWithdrawDeps): Tool {
	return {
		definition: {
			type: 'function',
			function: {
				name: 'consents_withdraw',
				description:
					'Withdraw what the user allowed you in one of their applications, when they tell you to stop using it, or only to stop writing there. The next time you need it, the harness asks them again. You can never grant an access.',
				parameters: {
					type: 'object',
					properties: {
						domain: {
							type: 'string',
							description: 'The application, as consents_list names it, such as mail'
						},
						level: {
							type: 'string',
							enum: ['write'],
							description:
								'write to withdraw only writing there and keep reading; leave it out to withdraw the whole application'
						}
					},
					required: ['domain'],
					additionalProperties: false
				}
			}
		},
		argumentKeys: ['domain', 'level'],
		requiredAction: WITHDRAW_OWN_CONSENTS,
		run: async (args, context) => {
			const owner = context.principalId;
			if (owner === ORGANIZATION_PRINCIPAL) return { result: ACCESS_DENIED, denied: true };
			const parsed = consentsWithdrawArgs.safeParse(args);
			if (!parsed.success) {
				return { result: { error: 'domain is required, and level can only be write' } };
			}
			const { domain, level } = parsed.data;
			const applications = deps.applications();
			const done = await withPrincipal(context.db, { id: owner }, async (tx) => {
				// A name the catalog does not offer withdraws nothing, and must not read as done; an
				// application the owner allowed before the catalog dropped it is still theirs to close
				const allowed = await listConsents(tx, owner);
				if (!applications.includes(domain) && !allowed.some((c) => c.domain === domain)) {
					return null;
				}
				const withdrawal = await withdrawConsents(
					tx,
					owner,
					domain,
					level === undefined ? ['read', 'write'] : [level]
				);
				return { withdrawal, kept: await listConsents(tx, owner) };
			});
			if (done === null) return { result: { error: 'unknown application', applications } };
			const { withdrawal, kept } = done;
			if (withdrawal.levels.length > 0) {
				context.log.info(
					{ principal: owner, domain, levels: withdrawal.levels },
					'consent withdrawn'
				);
			}
			for (const request of withdrawal.superseded) {
				context.log.info({ owner, pendingCallId: request.pendingCallId }, 'request superseded');
				deps.consentMetrics.superseded(request);
			}
			return {
				result: {
					domain,
					withdrawn: withdrawal.levels,
					still_allowed: kept.filter((c) => c.domain === domain).map((c) => c.level)
				}
			};
		}
	};
}

const sessionSearchArgs = z.object({ query: z.string().min(1).max(200) });

export const sessionSearchTool: Tool = {
	definition: {
		type: 'function',
		function: {
			name: 'session_search',
			description: 'Find your past conversations with this user by words they contain.',
			parameters: {
				type: 'object',
				properties: { query: { type: 'string' } },
				required: ['query'],
				additionalProperties: false
			}
		}
	},
	argumentKeys: ['query'],
	requiredAction: 'sessions.read_own',
	run: async (args, context) => {
		const parsed = sessionSearchArgs.safeParse(args);
		if (!parsed.success) return { result: { error: 'query is required' } };
		const matches = await withPrincipal(context.db, { id: context.principalId }, (tx) =>
			searchSessions(tx, parsed.data.query)
		);
		return { result: { sessions: matches.map((m) => ({ session_id: m.id, snippet: m.snippet })) } };
	}
};
