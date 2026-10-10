import { z } from 'zod';

import {
	ACCESS_DENIED,
	isConversationGone,
	keepInConversation,
	WRITE_OWN_SETTINGS,
	type Tool,
	type ToolContext,
	type ToolOutcome
} from '../agent/tools.js';
import { fetchOwnerLocale } from '../assistants/locale.js';
import type { Config } from '../config.js';
import type { ConsentMetrics } from '../consents/metrics.js';
import { hasConsent, insertPendingCall, type PendingCallInput } from '../consents/repository.js';
import { makeOwnerRequest, requestText } from '../consents/request.js';
import { labelOf, type DomainDescriptions } from '../contracts/domains.js';
import { withPrincipal } from '../db/client.js';
import { getMessages } from '../i18n/messages.js';
import { ORGANIZATION_PRINCIPAL } from '../principals/principal.js';
import { listListened, saveListening } from './repository.js';
import {
	isListenable,
	isSource,
	LISTENABLE,
	SOURCES,
	wakesAssistant,
	type Source
} from './sources.js';

export const LISTEN_TOOL = 'listen_to_source';
export const STOP_LISTENING_TOOL = 'stop_listening_to_source';
export const LISTENED_SOURCES_TOOL = 'listened_sources';

// The tools that turn a source on or off, or tell which are, which only the owner's own turns are
// given: a turn an activity woke never changes what their assistant listens to
export const LISTENING_TOOLS: readonly string[] = [
	LISTEN_TOOL,
	STOP_LISTENING_TOOL,
	LISTENED_SOURCES_TOOL
];

// What a call to listen that waits for its owner's consent names in place of a contract, by which
// the call their yes allowed finds its tool again
export const LISTEN_CALL = 'harness.listen_to_source';

export interface ListeningToolsDeps {
	readonly config: Config;
	// Where the api role counts the calls that wait for their owner
	readonly consentMetrics: ConsentMetrics;
	// How the catalog names the applications to their owners, as it last loaded
	readonly domains: () => DomainDescriptions;
}

const sourceArgs = z.object({ source: z.string() });

// The source a call names, as the owner said it
function namedSource(args: unknown): string {
	const parsed = sourceArgs.safeParse(args);
	return parsed.success ? parsed.data.source.trim().toLowerCase() : '';
}

const SOURCE_PARAMETERS = {
	type: 'object',
	properties: {
		source: { type: 'string', enum: [...SOURCES], description: 'The application' }
	},
	required: ['source'],
	additionalProperties: false
};

// What the model reads when the owner names a source their assistant cannot listen to: one it may
// not listen to yet, or one the harness does not know
function notListenable(named: string): ToolOutcome {
	return {
		result: {
			success: false,
			error: isSource(named) ? 'not yet possible' : 'unknown source',
			listenable: LISTENABLE
		}
	};
}

// The tools by which the owner turns the sources their assistant listens to on and off, and learns
// which it listens to
export function makeListeningTools(deps: ListeningToolsDeps): Tool[] {
	const { config } = deps;

	// Keeps the owner's choice, and ends the turn on the harness's own words that confirm it, which
	// name the application as the catalog does, in their language
	async function keep(
		context: ToolContext,
		source: Source,
		listening: boolean
	): Promise<ToolOutcome> {
		const owner = context.principalId;
		await withPrincipal(context.db, { id: owner }, (tx) =>
			saveListening(tx, owner, source, listening)
		);
		context.log.info({ source, listening }, 'listened source set');
		const locale = await fetchOwnerLocale(context.db, owner, config.locale);
		const { name } = labelOf(deps.domains(), source, 'read', locale, config.locale);
		const { sources } = getMessages(locale);
		// What reaches them in an application that wakes no assistant, such as Mail or Drive, only their
		// brief tells them of
		const said = wakesAssistant(source)
			? { on: sources.listening(name), off: sources.notListening(name) }
			: { on: sources.listeningForBrief(name), off: sources.notListeningForBrief(name) };
		return {
			result: { success: true, source, listening },
			final: listening ? said.on : said.off
		};
	}

	// Listening to an application whose data the owner has not let their assistant read asks them
	// first, with the question of a first read there, and freezes the call until they answer:
	// listening starts on their yes, which also lets it read there, as any first read's does
	async function ask(context: ToolContext, source: Source): Promise<ToolOutcome> {
		const owner = context.principalId;
		const locale = await fetchOwnerLocale(context.db, owner, config.locale);
		const values = { source };
		const request = makeOwnerRequest(
			{
				tool: LISTEN_TOOL,
				application: labelOf(deps.domains(), source, 'read', locale, config.locale),
				level: 'read',
				reasons: ['consent'],
				arguments: values,
				summary: null,
				said: context.accompanyingText ?? null
			},
			getMessages(locale)
		);
		// The call it shows is a few bytes: only a question grown past what a message holds is refused
		if (request === null) return { result: { success: false, error: 'question too large' } };
		const call: PendingCallInput = {
			owner,
			tool: LISTEN_TOOL,
			contract: LISTEN_CALL,
			domain: source,
			level: 'read',
			reasons: ['consent'],
			arguments: values,
			previewDigest: null,
			correlationId: context.correlationId ?? null,
			origin: context.origin ?? 'owner',
			sessionId: context.sessionId ?? null,
			request: request.question
		};
		const pendingCallId = await keepInConversation(context, (tx) => insertPendingCall(tx, call));
		if (isConversationGone(pendingCallId)) return { result: pendingCallId };
		deps.consentMetrics.requested(call);
		context.log.info(
			{
				pendingCallId,
				reasons: call.reasons,
				tool: LISTEN_TOOL,
				domain: source,
				// pino writes the line's own level under `level`
				consentLevel: 'read'
			},
			'listening waits for its owner'
		);
		return {
			result: { status: 'awaiting_owner', reasons: call.reasons, domain: source, level: 'read' },
			final: requestText(request),
			pendingCallId,
			request
		};
	}

	const listen: Tool = {
		definition: {
			type: 'function',
			function: {
				name: LISTEN_TOOL,
				description:
					'Start listening to one of the user\'s applications when they ask you to, such as "listen to my calendar": what arrives for them there wakes you, and you tell them of it, but for their mail and their drive, which only their brief tells them of. Only calendar, tasks, mail and drive can be listened to for now. If they have not let you read that application yet, the harness asks them first, and listening starts on their yes.',
				parameters: SOURCE_PARAMETERS
			}
		},
		argumentKeys: ['source'],
		requiredAction: WRITE_OWN_SETTINGS,
		frozenAs: LISTEN_CALL,
		run: async (args, context) => {
			// The organization agent listens for nobody
			if (context.principalId === ORGANIZATION_PRINCIPAL) {
				return { result: ACCESS_DENIED, denied: true };
			}
			const named = namedSource(args);
			if (!isListenable(named)) return notListenable(named);
			const owner = context.principalId;
			// The call its owner allowed runs as it was frozen: their yes let their assistant read there
			const mayRead =
				context.answeredReasons?.includes('consent') === true ||
				(await withPrincipal(context.db, { id: owner }, (tx) =>
					hasConsent(tx, owner, named, 'read')
				));
			if (mayRead) return keep(context, named, true);
			// Nobody attends a turn that would ask, such as the brief's: nothing waits
			if (context.unattended === true) {
				return { result: { status: 'not_asked', reasons: ['consent'] } };
			}
			return ask(context, named);
		}
	};

	const stopListening: Tool = {
		definition: {
			type: 'function',
			function: {
				name: STOP_LISTENING_TOOL,
				description:
					'Stop listening to one of the user\'s applications when they ask you to, such as "stop listening to my calendar": what arrives for them there no longer wakes you, nor does their brief tell them of it, and you can still read it when they ask. Only calendar, tasks, mail and drive can be turned off for now.',
				parameters: SOURCE_PARAMETERS
			}
		},
		argumentKeys: ['source'],
		requiredAction: WRITE_OWN_SETTINGS,
		run: async (args, context) => {
			if (context.principalId === ORGANIZATION_PRINCIPAL) {
				return { result: ACCESS_DENIED, denied: true };
			}
			const named = namedSource(args);
			return isListenable(named) ? keep(context, named, false) : notListenable(named);
		}
	};

	const listened: Tool = {
		definition: {
			type: 'function',
			function: {
				name: LISTENED_SOURCES_TOOL,
				description:
					"List the user's applications you listen to, which their brief tells them of and whose activities wake you, but for their mail's and their drive's, those you could listen to but do not, and those you cannot listen to yet. Use it when they ask what you listen to or watch for them.",
				parameters: { type: 'object', properties: {}, additionalProperties: false }
			}
		},
		argumentKeys: [],
		requiredAction: WRITE_OWN_SETTINGS,
		run: async (_args, context) => {
			const owner = context.principalId;
			if (owner === ORGANIZATION_PRINCIPAL) return { result: ACCESS_DENIED, denied: true };
			const sources = await withPrincipal(context.db, { id: owner }, (tx) =>
				listListened(tx, owner)
			);
			return {
				result: {
					listened: sources,
					not_listened: LISTENABLE.filter((source) => !sources.includes(source)),
					not_yet_possible: SOURCES.filter((source) => !LISTENABLE.includes(source))
				}
			};
		}
	};

	return [listen, stopListening, listened];
}
