import type { FastifyBaseLogger } from 'fastify';

import { localeOf } from '../assistants/locale.js';
import { findAssistant, holdAssistantInRoom } from '../assistants/repository.js';
import { BRIEF_NOW_TOOL, makeBriefNowTool } from '../briefs/now.js';
import { BRIEF_SETTINGS_TOOL, makeBriefSettingsTool } from '../briefs/tool.js';
import type { Config } from '../config.js';
import { makeContractCatalog, type ContractCatalog } from '../contracts/catalog.js';
import { replayOutcome, type ConsentMetrics, type ReplayOutcome } from '../consents/metrics.js';
import {
	approvePendingCall,
	grantConsent,
	takeAllowedCall,
	markReplayed,
	supersedeApprovedCall,
	type ApprovedCall
} from '../consents/repository.js';
import { conversationText, type OwnerRequest } from '../consents/request.js';
import { withPrincipal, type Db } from '../db/client.js';
import { getMessages, type Messages } from '../i18n/messages.js';
import { DEFAULT_LEASE_MS } from '../jobs/worker.js';
import { LISTENING_JOURNAL_TOOL, makeListeningJournalTool } from '../journal/tool.js';
import { LlmError, makeLlmClient, type LlmClient, type LlmMessage } from '../llm/client.js';
import { listMemory } from '../memory/repository.js';
import { ORGANIZATION_PRINCIPAL, type Principal } from '../principals/principal.js';
import { ensurePrincipal } from '../principals/repository.js';
import { makeQuietHoursTool, QUIET_HOURS_TOOL } from '../quiet/tool.js';
import {
	createSession,
	ensureRoomSession,
	findSession,
	saveSessionMessages,
	type SessionRecord
} from '../sessions/repository.js';
import { fetchOwnerTimeZone } from '../settings/time-zone.js';
import { LISTENING_TOOLS, makeListeningTools } from '../sources/tools.js';
import {
	CANCELLED_EVENT_TYPE,
	COUNTERED_EVENT_TYPE,
	MOVED_EVENT_TYPE,
	type MeetingScope
} from '../wakeups/event-types.js';
import { makeAdmission, type Admission, type Refusal } from './admission.js';
import {
	makeBriefRunner,
	withBriefAskedFor,
	type BriefInput,
	type BriefResult,
	type BriefResumeInput
} from './brief.js';
import { dateIn, describeMoment, SYSTEM_CLOCK, type Clock } from './clock.js';
import { makeTurnGate, type TurnGate } from './gate.js';
import {
	carriesInvitation,
	checkAvailability,
	type Invitation,
	type ToolRunner
} from './invitation.js';
import { assistantPrompt, defaultPrompt, organizationPrompt } from './persona.js';
import { buildSystemPrompt } from './prompt.js';
import { listSkills } from '../skills/repository.js';
import {
	clarifyTool,
	comesFromOthers,
	consentsListTool,
	languageTool,
	makeConsentsWithdrawTool,
	makeToolRegistry,
	memoryTool,
	onlyTools,
	runTool,
	toolCallStatus,
	sessionSearchTool,
	sessionsListTool,
	sessionsReadTool,
	skillsListTool,
	skillsProposeTool,
	skillsReadTool,
	skillsSearchTool,
	type ToolContext,
	type ToolOutcome,
	type ToolRegistry,
	type TurnBrief,
	type TurnOrigin,
	WITHDRAW_OWN_CONSENTS,
	withoutTools,
	WRITE_OWN_MEMORY,
	WRITE_OWN_SETTINGS
} from './tools.js';

export type { TurnOrigin } from './tools.js';
import { runTurn, TurnError } from './turn.js';
import { SUGGEST_CALL, makeSuggestionConsentTool } from '../suggestions/consent.js';
import {
	makeSuggestionRunner,
	makeSuggestionTools,
	readMeeting,
	suggestionMaxToolCalls,
	type SuggestionInput,
	type SuggestionResult
} from './suggestion.js';

export type SessionTarget =
	| { readonly kind: 'new' }
	| { readonly kind: 'id'; readonly id: string }
	| { readonly kind: 'room'; readonly roomId: string };

// What a turn an event started may not do, whatever its owner may: change how the assistant speaks
// to its owner, keep a note or a skill proposal that later turns would read as the assistant's own,
// or withdraw a consent. The event's own text comes from a third party, so only the owner, in a
// turn of their own, can make the assistant remember or change what they decided. Such a turn may
// prepare a write through a contract, which then waits for its owner's yes to the harness's own
// request, whatever they allowed.
const WITHHELD_FROM_EVENT_TURNS: readonly string[] = [
	WRITE_OWN_SETTINGS,
	WRITE_OWN_MEMORY,
	WITHDRAW_OWN_CONSENTS
];

// The tools a turn an event started is never offered, even once its owner's yes resumed it,
// whatever their rights: the owner's listening journal, which tells them in their own turns what
// their assistant saw, and would show such a turn the text third parties wrote in every other
// activity; the tools by which they choose what their assistant listens to, which a third party's
// text never changes; the settings of their morning brief, which only they move, pause or stop;
// their brief at once, which only they ask for; and their quiet hours, which only they set. A
// suggestion's turn is offered its own two tools alone.
const TOOLS_HIDDEN_FROM_EVENT_TURNS: readonly string[] = [
	LISTENING_JOURNAL_TOOL,
	...LISTENING_TOOLS,
	BRIEF_SETTINGS_TOOL,
	BRIEF_NOW_TOOL,
	QUIET_HOURS_TOOL
];

// The tools alone that a turn a meeting's change woke is given, by the type of that change and
// what it is about, among those its owner's rights and the rule above leave it: for a move of a
// meeting or of a whole series, the check of its new slot and the answers to it; for a move of one
// occurrence of a series, which the answers cannot reach apart from the rest of it, none; for a
// cancellation, which the model only tells, none; for a counter-proposal, whatever it is about, the
// check of the time proposed alone, as the owner changes a meeting's time in Calendar. The turn
// their yes resumes is told of no event, and is not held to them.
const ANSWERS_TO_A_MOVE = ['read_freebusy', 'accept_invitation', 'decline_invitation'];
const CHECK_ALONE = ['read_freebusy'];
const TOOLS_OF_MEETING_CHANGES: ReadonlyMap<
	string,
	Readonly<Record<MeetingScope, readonly string[]>>
> = new Map([
	[MOVED_EVENT_TYPE, { event: ANSWERS_TO_A_MOVE, series: ANSWERS_TO_A_MOVE, occurrence: [] }],
	[CANCELLED_EVENT_TYPE, { event: [], series: [], occurrence: [] }],
	[COUNTERED_EVENT_TYPE, { event: CHECK_ALONE, series: CHECK_ALONE, occurrence: CHECK_ALONE }]
]);

// What follows what a meeting's wake-up told once the harness checked it, by its type, which only
// the calendar listener gives: a move's new slot, a counter-proposal's time, or else a new
// invitation's slot
function availabilityOf(
	type: string,
	calendarData: string,
	scope: MeetingScope,
	messages: Messages
): string {
	if (type === MOVED_EVENT_TYPE) return messages.events.movedAvailability(calendarData, scope);
	if (type === COUNTERED_EVENT_TYPE) return messages.events.counteredAvailability(calendarData);
	return messages.events.availability(calendarData);
}

// The harness's own question to an owner about a call it froze, on which the turn ends
interface Question {
	readonly text: string;
	// What the conversation keeps of it, for later turns of the model: the request without what an
	// application said of the call, which only its owner reads
	readonly kept: string;
	readonly pendingCallId: string;
	// Its parts, when the harness laid it out as a request about the call
	readonly request: OwnerRequest | null;
}

// The question a tool's outcome ends the turn on, when its call waits for its owner
function questionOf(outcome: ToolOutcome): Question | null {
	return outcome.final !== undefined && outcome.pendingCallId !== undefined
		? {
				text: outcome.final,
				kept: outcome.request === undefined ? outcome.final : conversationText(outcome.request),
				pendingCallId: outcome.pendingCallId,
				request: outcome.request ?? null
			}
		: null;
}

// What the model of a turn is told, and the harness's own question when a read it made before
// the model speaks waits for the owner
interface Told {
	readonly message: string | null;
	readonly question: Question | null;
}

// What the model reads when the contract its owner allowed is no longer offered as it was
const CONTRACT_CHANGED = {
	error: 'contract_changed',
	hint: 'The contract the owner allowed is no longer offered as it was, so nothing ran. Tell the owner.'
} as const;

// What came of the call its owner allowed: the call and its result, as the session keeps them;
// the harness's new question, when the call waits for its owner again; and the harness's own
// notice, when the call did not run as its owner allowed it: its contract refused it, as what it
// acts on changed since the preview its owner was shown, or, asked anew what the call would do,
// did it; or when a call of the harness's own confirms what it did
interface Replayed {
	readonly messages: LlmMessage[];
	readonly question: Question | null;
	readonly notice: string | null;
	// Whether the call went to its contract: one no longer offered as its owner allowed it did not
	readonly ran: boolean;
}

// What a contract answers the call its owner allowed once they saw its preview, when what the call
// acts on changed since: nothing was done
const CHANGED_SINCE_PREVIEW = 409;

// Whether the contract refused the call its owner allowed, as what it acts on changed since the
// preview they were shown: the call carried that preview's digest, and the contract answered 409
function changedSincePreview(approved: ApprovedCall, outcome: ToolOutcome): boolean {
	return (
		approved.previewDigest !== null &&
		questionOf(outcome) === null &&
		statusOf(outcome.result) === CHANGED_SINCE_PREVIEW
	);
}

// The HTTP status a contract answered with, when the result carries one
function statusOf(result: unknown): number | null {
	if (typeof result !== 'object' || result === null) return null;
	const status = (result as Record<string, unknown>)['status'];
	return typeof status === 'number' ? status : null;
}

// What came of a call of the harness's own its owner allowed, which answers no HTTP status: whether
// it did what it was asked
function ownReplayOutcome(result: unknown): ReplayOutcome {
	if (typeof result !== 'object' || result === null) return 'failed';
	return (result as Record<string, unknown>)['success'] === true ? 'ok' : 'failed';
}

export interface OwnerTurnInput {
	readonly principal: Principal;
	readonly target: SessionTarget;
	// The owner's message, or null when the turn resumes from a call its owner allowed
	readonly message: string | null;
	readonly log: FastifyBaseLogger;
	// What links the turn's calls in the audit: the request id, or the Matrix event id
	readonly correlationId?: string;
	// The owner unless told otherwise
	readonly origin?: TurnOrigin;
	// The name the owner gave the assistant answering in this turn, when there is one
	readonly assistantName?: string;
	// The event of a turn of origin event: its id and CloudEvent type, and for a new invitation, a
	// move, a cancellation or a counter-proposal, the meeting, whose slot, or the time proposed, the
	// harness checks before the model speaks unless it is cancelled
	readonly event?: {
		readonly id: string;
		readonly type: string;
		readonly invitation?: Invitation | undefined;
	};
	// The call its owner just allowed: the turn runs it as frozen, then goes on from there, with
	// no new message
	readonly resume?: ResumeInput;
	// Told, after each action that does not end the turn, the actions it has done so far
	readonly actionsDone?: (actions: number) => void;
}

// How the owner allowed the call a turn resumes, which the consent it grants records: in the chat,
// or through the API. An answer in the chat, or through the API to a call asked in the room,
// approved the call before its job ran. A yes through the API to a call of a turn through the API
// is the answer itself, under its own id: the resumed turn takes the call as it starts, once
// admitted, so that the first answer wins and a turn refused for now leaves the call waiting.
export interface ResumeInput {
	readonly pendingCallId: string;
	readonly through: 'chat' | 'api';
	readonly answerId?: string;
}

export type OwnerTurnResult =
	| {
			readonly kind: 'ok';
			readonly sessionId: string;
			readonly answer: string;
			readonly model: string;
			// The call the harness froze, when the turn ended on its question to the owner
			readonly pendingCallId?: string;
			// That question in its parts, when the harness laid it out as a request about the call
			readonly request?: OwnerRequest;
			// The brief the owner asked for, when the turn ended on it
			readonly brief?: TurnBrief;
			// The turn reached one of its limits before it answered: there is more to do
			readonly atLimit?: true;
			// A turn an activity woke found nothing useful to say: its answer is empty, for nobody
			readonly silent?: true;
	  }
	| { readonly kind: 'forbidden' }
	| { readonly kind: 'missing' }
	// The call to resume no longer waited: another answer came first
	| { readonly kind: 'decided' }
	// Admission refused the turn; for a user whose day is spent, until the next one starts
	| ({ readonly kind: 'busy' } & Refusal)
	| { readonly kind: 'failed'; readonly error: string };

export interface AgentService {
	readonly llm: LlmClient;
	readonly tools: ToolRegistry;
	readonly gate: TurnGate;
	readonly contracts: ContractCatalog;
	readonly admission: Admission;
	runOwnerTurn(input: OwnerTurnInput): Promise<OwnerTurnResult>;
	runAllowedCall(input: AllowedCallInput): Promise<AllowedCallResult>;
	// What the owner's assistant proposes from the messages of a channel, if anything
	runSuggestion(input: SuggestionInput): Promise<SuggestionResult>;
	runBrief(input: BriefInput): Promise<BriefResult>;
	// The owner's yes to the question a brief gave way to: that day's brief
	resumeBrief(input: BriefResumeInput): Promise<BriefResult>;
}

// A call a direct tool call through the API froze, which its owner allows through the API
export interface AllowedCallInput {
	readonly principal: Principal;
	readonly pendingCallId: string;
	// The owner's yes through the API, under its own id, which takes the call
	readonly answerId: string;
	readonly log: FastifyBaseLogger;
}

export type AllowedCallResult =
	| { readonly kind: 'ok'; readonly outcome: ToolOutcome }
	// The call no longer waited: another answer came first
	| { readonly kind: 'decided' };

export interface AgentServiceDeps {
	readonly config: Config;
	readonly db: Db;
	readonly log: FastifyBaseLogger;
	readonly llm?: LlmClient;
	readonly clock?: Clock;
	// Where its role counts the calls it freezes and those it replays
	readonly consentMetrics: ConsentMetrics;
}

export function makeAgentService(deps: AgentServiceDeps): AgentService {
	const { config, db } = deps;
	const clock = deps.clock ?? SYSTEM_CLOCK;
	// The persona's rules are in English; how to address people is told in the language the model
	// speaks, when that language marks it
	const withAddressing = (persona: string, messages: Messages): string =>
		messages.addressing === null ? persona : `${persona} ${messages.addressing}`;
	// An owner's assistant is told, in its owner's language, to speak it; the organization agent
	// answers each member in their own language, as it always did
	const withLanguage = (persona: string, messages: Messages): string =>
		withAddressing(`${persona} ${messages.language.speak}`, messages);
	const llm =
		deps.llm ??
		makeLlmClient({
			baseUrl: config.apisix.baseUrl,
			consumerKey: config.apisix.consumerKey,
			model: config.llm.model,
			maxTokens: config.llm.maxTokens,
			timeoutMs: config.llm.timeoutMs
		});
	const { consentMetrics } = deps;
	const contracts = makeContractCatalog({ config, log: deps.log, consentMetrics });
	const tools = makeToolRegistry(
		[
			clarifyTool,
			memoryTool,
			languageTool,
			sessionsListTool,
			sessionsReadTool,
			sessionSearchTool,
			skillsListTool,
			skillsSearchTool,
			skillsReadTool,
			skillsProposeTool,
			consentsListTool,
			makeConsentsWithdrawTool({
				// Each application once, as consents_list names it
				applications: () => [...new Set(contracts.contracts.map((c) => c.domain))].sort(),
				consentMetrics
			}),
			makeListeningJournalTool({ clock, timeZone: config.timeZone }),
			...makeListeningTools({
				config,
				consentMetrics,
				domains: () => contracts.domainDescriptions
			}),
			makeBriefSettingsTool({ clock, timeZone: config.timeZone }),
			makeQuietHoursTool({
				timeZone: config.timeZone,
				locale: config.locale,
				defaults: config.quietHours
			}),
			// The brief its owner asks for exists while the briefs are on alone, written as the
			// scheduler's are, once the service is made
			...(config.brief.enabled
				? [makeBriefNowTool({ brief: (context) => briefs.inTurn(context) })]
				: [])
		],
		() => contracts.tools
	);
	// What the owner's yes to a suggestion's question about a permission runs, which no model and no
	// direct tool call ever finds: the replay of that call alone
	const suggestionConsent = makeSuggestionConsentTool({ config });
	const gate = makeTurnGate();
	const admission = makeAdmission({ config, db, log: deps.log, clock });

	// What the model is told. An invitation an event brings, a move or a counter-proposal has its
	// slot, or the time proposed, checked by the harness before the model speaks, from the UID and
	// the times its wake-up carries, through the same tools and context as the model's calls: what
	// the calendar answered follows what the wake-up told, as data. A cancellation leaves nothing to
	// check, and any other message is told as it is. A read of that check that waits for its owner,
	// such as the first read of their calendar, ends the turn on the harness's question.
	async function messageFor(
		input: OwnerTurnInput,
		context: ToolContext,
		log: FastifyBaseLogger,
		messages: Messages
	): Promise<Told> {
		const event = input.origin === 'event' ? input.event : undefined;
		if (!carriesInvitation(event) || event.type === CANCELLED_EVENT_TYPE) {
			return { message: input.message, question: null };
		}
		const { invitation } = event;
		let question: Question | null = null;
		const run: ToolRunner = async (name, args) => {
			const tool = tools.find(name);
			if (tool === null) return null;
			const outcome = await runTool(tool, args, context);
			question ??= questionOf(outcome);
			return outcome;
		};
		// An all-day invitation's days are those of the zone the owner's turns state the present in:
		// theirs, the deployment's when none is kept
		const timeZone = await fetchOwnerTimeZone(db, context.principalId, config.timeZone);
		const check = await checkAvailability(run, invitation, { timeZone });
		log.info({ freeBusyStatus: check.freeBusyStatus, reason: check.reason }, 'invitation checked');
		const availability = availabilityOf(
			event.type,
			check.data,
			invitation.scope ?? 'event',
			messages
		);
		return {
			message: input.message === null ? availability : `${input.message}\n${availability}`,
			question
		};
	}

	// Runs the call its owner allowed, exactly as it was frozen. A tool that no longer stands for
	// the contract the owner allowed, at the same level, runs nothing; a call of the harness's own,
	// such as listening to an application, finds its tool by the name it was frozen under, and a
	// suggestion's question about a permission finds the tool kept for it. The call
	// waits for nothing the owner's yes answered; one that waits for its owner again, such as one
	// the platform's broker still refuses or one in an application whose writing they took back
	// since, comes back with the harness's new question. A call whose contract showed its owner what
	// it would do carries the digest of that preview, which the contract checks.
	async function runFrozenCall(
		approved: ApprovedCall,
		pendingCallId: string,
		context: ToolContext,
		log: FastifyBaseLogger
	): Promise<ToolOutcome> {
		const definition = contracts.contracts.find((c) => c.toolName === approved.tool);
		const tool = approved.contract === SUGGEST_CALL ? suggestionConsent : tools.find(approved.tool);
		const unchanged =
			tool !== null &&
			(definition === undefined
				? tool.frozenAs === approved.contract
				: definition.id === approved.contract && definition.level === approved.level);
		const outcome: ToolOutcome = unchanged
			? await runTool(tool, approved.arguments, {
					...context,
					answeredReasons: approved.reasons,
					...(approved.previewDigest === null ? {} : { previewDigest: approved.previewDigest })
				})
			: { result: CONTRACT_CHANGED };
		const question = questionOf(outcome);
		const httpStatus = statusOf(outcome.result);
		const changed = changedSincePreview(approved, outcome);
		if (question === null) {
			consentMetrics.replayed(
				approved,
				definition === undefined ? ownReplayOutcome(outcome.result) : replayOutcome(httpStatus)
			);
			log.info(
				{
					pendingCallId,
					tool: approved.tool,
					status: unchanged ? toolCallStatus(outcome) : 'contract_changed',
					...(httpStatus === null ? {} : { httpStatus }),
					...(changed ? { changedSincePreview: true } : {})
				},
				'pending call replayed'
			);
		} else {
			// Its new request is what counts: it asks about everything that applies now
			log.info(
				{ pendingCallId, tool: approved.tool, nextPendingCallId: question.pendingCallId },
				'pending call waits again'
			);
		}
		return outcome;
	}

	// Runs the call its owner allowed, and writes it in the session as the assistant's call followed
	// by its result, for the model to go on from, with the harness's new question when it waits
	// again, or its own notice when the call did not run as its owner allowed it
	async function replay(
		approved: ApprovedCall,
		pendingCallId: string,
		context: ToolContext,
		log: FastifyBaseLogger,
		consent: Messages['consent']
	): Promise<Replayed> {
		const outcome = await runFrozenCall(approved, pendingCallId, context, log);
		const question = questionOf(outcome);
		const callId = `replay_${pendingCallId}`;
		return {
			messages: [
				{
					role: 'assistant',
					content: null,
					tool_calls: [
						{
							id: callId,
							type: 'function',
							function: { name: approved.tool, arguments: JSON.stringify(approved.arguments) }
						}
					]
				},
				{
					role: 'tool',
					tool_call_id: callId,
					name: approved.tool,
					content: JSON.stringify(outcome.result)
				}
			],
			question,
			// A call that did not run as its owner allowed it ends the turn on the harness's notice:
			// one its contract refused, as what it acts on changed since the preview they were shown,
			// or one a preview asked for anew did, which the tool's outcome carries without a question.
			// So does a call of the harness's own, on its words that confirm what it did.
			notice: changedSincePreview(approved, outcome)
				? consent.changed
				: question === null
					? (outcome.final ?? null)
					: null,
			ran: outcome.result !== CONTRACT_CHANGED
		};
	}

	// A call a direct tool call froze has no turn to go on with: once its owner allowed it through
	// the API, it runs as it was frozen, under the correlation id of the request that froze it, if
	// it still waited, or if an earlier yes left it unrun past the lease
	async function runAllowedCall(input: AllowedCallInput): Promise<AllowedCallResult> {
		const { principal, pendingCallId, answerId, log } = input;
		const opened = await withPrincipal(db, principal, async (tx) => {
			const record = await ensurePrincipal(tx, principal);
			const approved = await takeAllowedCall(
				tx,
				principal.id,
				pendingCallId,
				answerId,
				DEFAULT_LEASE_MS
			);
			if (approved === null) return null;
			// As in a turn: a yes to a first use allows the application from now on, a yes to the
			// broker's request grants nothing
			if (approved.reasons.includes('consent')) {
				await grantConsent(tx, principal.id, approved.domain, approved.level, 'api');
			}
			return { actions: record.actions, approved };
		});
		if (opened === null) return { kind: 'decided' };
		const { actions, approved } = opened;
		const outcome = await runFrozenCall(
			approved,
			pendingCallId,
			{
				principalId: principal.id,
				origin: approved.origin,
				actions,
				db,
				...(approved.correlationId === null ? {} : { correlationId: approved.correlationId }),
				log
			},
			log
		);
		// A call that waits for its owner again is not stamped as run: its newer request supersedes
		// the one answered
		await withPrincipal(db, principal, (tx) =>
			questionOf(outcome) === null
				? markReplayed(tx, pendingCallId)
				: supersedeApprovedCall(tx, principal.id, pendingCallId)
		);
		return { kind: 'ok', outcome };
	}

	async function runOwnerTurn(input: OwnerTurnInput): Promise<OwnerTurnResult> {
		const { principal } = input;
		// Admitted before anything else runs; the slot is held until the turn ends. A yes that resumes
		// a call spends its owner's day as their words do, whatever turn froze the call.
		const decision = await admission.admit(principal.id, input.origin ?? 'owner');
		if (!decision.ok) return { kind: 'busy', ...decision.refusal };
		try {
			return await gate.run(principal.id, () => runAdmittedTurn(input));
		} finally {
			decision.release();
		}
	}

	async function runAdmittedTurn(input: OwnerTurnInput): Promise<OwnerTurnResult> {
		const { principal, target } = input;
		{
			// A short transaction settles rights and the session; the model call runs outside it.
			const opened = await withPrincipal(db, principal, async (tx) => {
				const record = await ensurePrincipal(tx, principal);
				if (!record.actions.includes('chat')) return { kind: 'forbidden' as const };
				// A turn of a room opens nothing once its assistant no longer answers there, as when the
				// owner deleted it while the turn waited for their turn before it: the record of the
				// assistant is held until this transaction ends, so that a deletion that comes meanwhile
				// waits for what this transaction keeps, then erases it too
				if (
					target.kind === 'room' &&
					!(await holdAssistantInRoom(tx, principal.id, target.roomId))
				) {
					return { kind: 'missing' as const };
				}
				// The owner's answer approves the call once. Asked about a first use, it also lets the
				// assistant use that application at that level from now on; asked to try again once
				// the platform has their permission, it allows nothing more.
				let approved: ApprovedCall | null = null;
				if (input.resume !== undefined) {
					const { pendingCallId, through, answerId } = input.resume;
					approved =
						answerId === undefined
							? await approvePendingCall(tx, principal.id, pendingCallId)
							: await takeAllowedCall(tx, principal.id, pendingCallId, answerId, DEFAULT_LEASE_MS);
					if (approved === null) {
						return answerId === undefined
							? { kind: 'missing' as const }
							: { kind: 'decided' as const };
					}
					if (approved.reasons.includes('consent')) {
						await grantConsent(tx, principal.id, approved.domain, approved.level, through);
					}
				}
				const locale = localeOf(await findAssistant(tx, principal.id), config.locale);
				let session: SessionRecord | null;
				if (target.kind === 'new') session = await createSession(tx, principal.id);
				else if (target.kind === 'room')
					session = await ensureRoomSession(tx, principal.id, target.roomId);
				else session = await findSession(tx, target.id);
				return session === null
					? { kind: 'missing' as const }
					: { kind: 'ok' as const, session, actions: record.actions, approved, locale };
			});
			if (opened.kind !== 'ok') return opened;
			const { session, approved, locale } = opened;
			const messages = getMessages(locale);
			// A resumed turn may do no more than the turn that froze its call. Resumed from a call that
			// a turn an event started prepared, it is still that event's: the owner's yes runs that
			// call alone, and any other write it prepares waits for them again.
			const origin = approved?.origin ?? input.origin;
			const withheld = comesFromOthers(origin)
				? opened.actions.filter((action) => WITHHELD_FROM_EVENT_TURNS.includes(action))
				: [];
			const actions = opened.actions.filter((action) => !withheld.includes(action));
			// A turn resumed from a suggestion's call is still that suggestion's, whatever its owner may
			// do in their own turns: it reads none of their memory or skills, may look for slots with the
			// people of the meeting their yes allowed and prepare that meeting again, which waits for
			// them once more, and makes no more calls than the suggestion could
			const suggestion =
				origin === 'suggestion'
					? {
							tools: makeSuggestionTools(
								contracts,
								principal.id,
								readMeeting(approved?.arguments)?.attendees ?? [],
								null
							),
							maxToolCalls: suggestionMaxToolCalls(config)
						}
					: null;
			const memory =
				suggestion === null && actions.includes('memory.read_own')
					? await withPrincipal(db, principal, (tx) => listMemory(tx, principal.id))
					: { memory: [], user: [] };
			const skills =
				suggestion === null && actions.includes('skills.read_own')
					? await withPrincipal(db, principal, (tx) => listSkills(tx))
					: [];
			const log = input.log.child({ session: session.id, principal: principal.id });
			// A resumed turn keeps the correlation id of the turn that froze its call, so that the
			// gateway's audit links both
			const correlationId = approved?.correlationId ?? input.correlationId;
			const context: ToolContext = {
				principalId: principal.id,
				...(origin === undefined ? {} : { origin }),
				actions,
				withheldActions: withheld,
				db,
				...(correlationId === undefined ? {} : { correlationId }),
				sessionId: session.id,
				log
			};
			// A resumed turn has no new message: it goes on from the call its owner allowed
			const told: Told =
				approved === null
					? await messageFor(input, context, log, messages)
					: { message: null, question: null };
			log.info({ messageLength: told.message?.length ?? 0 }, 'turn started');
			if (told.question !== null) {
				// The conversation keeps what the model would have been told, for the turn the
				// owner's answer resumes
				const asked: LlmMessage[] = [
					...session.messages,
					{ role: 'user', content: told.message },
					{ role: 'assistant', content: told.question.kept }
				];
				const saved = await withPrincipal(db, principal, (tx) =>
					saveSessionMessages(tx, session.id, asked)
				);
				if (!saved) return { kind: 'missing' };
				const { pendingCallId, request } = told.question;
				log.info({ pendingCallId }, 'turn stopped on a question to the owner');
				return {
					kind: 'ok',
					sessionId: session.id,
					answer: told.question.text,
					model: llm.model,
					pendingCallId,
					...(request === null ? {} : { request })
				};
			}
			let history: readonly LlmMessage[] = session.messages;
			// The call its owner allowed counts among the actions of the turn it resumes
			let actionsBefore = 0;
			if (approved !== null && input.resume !== undefined) {
				const { pendingCallId } = input.resume;
				const replayed = await replay(approved, pendingCallId, context, log, messages.consent);
				if (replayed.ran) actionsBefore = 1;
				// A call that waits for its owner again ends the turn on the harness's new question,
				// which the conversation keeps as the assistant's answer: the owner's next yes tries it
				// once more, never the model
				const newQuestion = replayed.question;
				// A call that did not run as its owner allowed it ends the turn on the harness's own
				// notice: the owner learns it from the harness, never from the model, which reads the
				// call, its result and the notice in the conversation
				const { notice } = replayed;
				history = [
					...history,
					...replayed.messages,
					...(newQuestion === null
						? []
						: [{ role: 'assistant' as const, content: newQuestion.kept }]),
					...(notice === null ? [] : [{ role: 'assistant' as const, content: notice }])
				];
				// The conversation holds the call at once, whatever happens to the rest of the turn. A
				// call that waits again is not stamped as run: the newer request supersedes the one
				// answered.
				const kept = history;
				await withPrincipal(db, principal, async (tx) => {
					await saveSessionMessages(tx, session.id, kept);
					if (newQuestion === null) await markReplayed(tx, pendingCallId);
					else await supersedeApprovedCall(tx, principal.id, pendingCallId);
				});
				if (newQuestion !== null) {
					log.info(
						{ pendingCallId: newQuestion.pendingCallId },
						'turn stopped on a question to the owner'
					);
					return {
						kind: 'ok',
						sessionId: session.id,
						answer: newQuestion.text,
						model: llm.model,
						pendingCallId: newQuestion.pendingCallId,
						...(newQuestion.request === null ? {} : { request: newQuestion.request })
					};
				}
				if (notice !== null) {
					log.info({ pendingCallId }, 'turn stopped on a notice to the owner');
					return { kind: 'ok', sessionId: session.id, answer: notice, model: llm.model };
				}
			}
			// Read at the start of every turn, never kept: a session can span days. It is told in the
			// zone of the owner's calendar once a read of it named one, the call their yes just ran
			// included, and in the deployment's until then.
			const timeZone = await fetchOwnerTimeZone(db, principal.id, config.timeZone);
			const now = clock.now();
			const moment = describeMoment(now, timeZone, locale);
			// The call its owner allowed is the first action of the turn that goes on from it
			if (actionsBefore > 0) input.actionsDone?.(actionsBefore);
			const offered = comesFromOthers(origin)
				? withoutTools(tools, TOOLS_HIDDEN_FROM_EVENT_TURNS)
				: tools;
			const meetingTools =
				origin === 'event' && carriesInvitation(input.event)
					? (TOOLS_OF_MEETING_CHANGES.get(input.event.type)?.[
							input.event.invitation.scope ?? 'event'
						] ?? null)
					: null;
			const turnTools =
				suggestion?.tools ?? (meetingTools === null ? offered : onlyTools(offered, meetingTools));
			// The turn an activity woke, rather than the one its owner's yes resumed from it, may say
			// nothing
			const woken = origin === 'event' && approved === null;
			// The names of the tools the model is given, which its rules are built on
			const toolNames = turnTools.definitions.map((tool) => tool.function.name);
			try {
				const turn = await runTurn(
					{
						llm,
						tools: turnTools,
						log,
						maxToolCalls: suggestion?.maxToolCalls ?? config.turn.maxToolCalls,
						maxTurnTokens: config.turn.maxTokens,
						historyMaxChars: config.turn.historyMaxChars
					},
					{
						systemPrompt: buildSystemPrompt({
							persona:
								principal.id === ORGANIZATION_PRINCIPAL
									? withAddressing(
											organizationPrompt(config.org.name, config.org.persona, toolNames),
											messages
										)
									: withLanguage(
											input.assistantName === undefined
												? defaultPrompt(toolNames)
												: assistantPrompt(input.assistantName, toolNames),
											messages
										),
							moment: messages.now(moment.words, moment.iso, moment.timeZone),
							woken,
							memory,
							skills,
							history,
							nudgeInterval: suggestion === null ? config.turn.memoryNudgeInterval : 0
						}),
						history,
						message: told.message,
						context,
						actionsBefore,
						limitNotice: (actions) => messages.notices.turnLimit(actions),
						...(input.actionsDone === undefined ? {} : { actionsDone: input.actionsDone }),
						mayStaySilent: woken,
						today: dateIn(now, timeZone),
						timeZone,
						locale
					}
				);
				// A turn that ended on the brief its owner asked for takes what the earlier briefs named
				// out of the conversation, as a newer brief does
				const saved = await withPrincipal(db, principal, (tx) =>
					saveSessionMessages(
						tx,
						session.id,
						turn.brief === undefined
							? turn.messages
							: withBriefAskedFor(turn.messages, history.length)
					)
				);
				if (!saved) return { kind: 'missing' };
				await admission.recordUsage(principal.id, turn.tokens, input.origin ?? 'owner');
				log.info({ answerLength: turn.answer.length, tokens: turn.tokens }, 'turn finished');
				return {
					kind: 'ok',
					sessionId: session.id,
					answer: turn.answer,
					model: llm.model,
					...(turn.pendingCallId === undefined ? {} : { pendingCallId: turn.pendingCallId }),
					...(turn.request === undefined ? {} : { request: turn.request }),
					...(turn.brief === undefined ? {} : { brief: turn.brief }),
					...(turn.atLimit === true ? { atLimit: true } : {}),
					...(turn.silent === true ? { silent: true } : {})
				};
			} catch (err: unknown) {
				if (err instanceof TurnError || err instanceof LlmError) {
					log.error({ err }, 'turn failed');
					return { kind: 'failed', error: err.message };
				}
				throw err;
			}
		}
	}

	const suggestions = makeSuggestionRunner({
		config,
		db,
		llm,
		contracts,
		admission,
		gate,
		clock,
		consentMetrics
	});

	// The brief of the owner's working day, which the worker role's scheduler asks for, or the owner
	// in their turn: the assistant speaks as in its owner's turns, given no tool
	const briefs = makeBriefRunner({
		config,
		db,
		llm,
		tools,
		admission,
		gate,
		clock,
		consentMetrics,
		persona: (assistantName, messages) =>
			withLanguage(
				assistantName === undefined ? defaultPrompt([]) : assistantPrompt(assistantName, []),
				messages
			),
		runFrozenCall
	});

	return {
		llm,
		tools,
		gate,
		contracts,
		admission,
		runOwnerTurn,
		runAllowedCall,
		runSuggestion: suggestions.run,
		runBrief: briefs.run,
		resumeBrief: briefs.resume
	};
}
