import type { FastifyBaseLogger } from 'fastify';
import { z } from 'zod';

import type { Config } from '../config.js';
import { withPrincipal, type Db, type Tx } from '../db/client.js';
import { completeJob, enqueueJob, type Job } from '../jobs/queue.js';
import { startJobWorker, type Deferral, type JobWorker } from '../jobs/worker.js';
import { fetchOwnerMessages } from '../assistants/locale.js';
import { findAssistant, type AssistantRecord } from '../assistants/repository.js';
import { BRIEF_QUESTION } from '../briefs/questions.js';
import { findBriefWait } from '../briefs/waits.js';
import type { PendingQuestion, ResumeRequest } from '../consents/consent.js';
import {
	closeHeldRequest,
	findPendingCall,
	hasNewerRequest,
	lockPendingCall,
	reopenRequest,
	toYesNoQuestion,
	type RequestState
} from '../consents/repository.js';
import { requestHtml, type OwnerRequest } from '../consents/request.js';
import type { Locale, Messages } from '../i18n/messages.js';
import { settleActivity, type WokenTurnOutcome } from '../journal/repository.js';
import type { BriefMarker } from '../matrix/brief.js';
import type { YesNoQuestion } from '../matrix/questions.js';
import { spentForTheDay, type Refusal, type RefusalReason } from './admission.js';
import { invitationSchema } from './invitation.js';
import { matrixUserIdOfPrincipal } from '../principals/identity.js';
import {
	suggestPayloadSchema,
	SUGGEST_MAX_AGE_MS,
	SUGGEST_RECHECK_MS,
	type SuggestPayload
} from '../suggestions/job.js';
import { mayReceive, recordSuggestion } from '../suggestions/repository.js';
import type { SpaceNotifications } from '../suggestions/space.js';
import { proposalSentence } from '../suggestions/text.js';
import type { AgentService, OwnerTurnResult } from './service.js';

const turnPayload = z.object({
	owner: z.string().min(1),
	roomId: z.string().min(1),
	eventId: z.string().min(1),
	text: z.string().min(1),
	// Who started the turn: the owner's message, an event the harness took from the broker, or the
	// worker role's scheduler, for the brief of the owner's working day
	origin: z.enum(['owner', 'event', 'brief']).optional(),
	// The event, when the turn is an event's: its id and CloudEvent type, as its source published
	// them, that source, by which its owner's listening journal keeps it, and for a new invitation,
	// a move, a cancellation or a counter-proposal, the meeting, whose slot, or the time proposed,
	// the harness checks before the model speaks unless it is cancelled. A brief is keyed as an
	// event is, by the id the scheduler gave it.
	event: z
		.object({
			id: z.string().min(1),
			type: z.string().min(1),
			// Not in a turn queued before the journal was
			source: z.string().min(1).optional(),
			invitation: invitationSchema.optional()
		})
		.optional(),
	// For a brief, the date in the owner's zone it is the brief of
	brief: z.object({ date: z.iso.date() }).optional()
});

export type TurnPayload = z.infer<typeof turnPayload>;

type PayloadOrigin = NonNullable<TurnPayload['origin']>;

// The prefix that keys a turn an event woke, in its payload and its jobs' dedup keys
const EVENT_KEY_PREFIX = 'event:';

// How long a turn nobody can send again waits the first time admission refuses it, before it is
// tried again, whether an event woke it or its owner's yes resumed it: each refusal after that
// doubles the wait, up to a minute, the window of the turns a user may start per minute
const REFUSED_TURN_RETRY_MS = 2000;
const REFUSED_TURN_RETRY_MAX_MS = 60_000;

// What links a turn's contract calls and log lines to their cause: the Matrix id of the owner's
// message, or, for a turn an event woke, the bare id the event's source gave it, so that the
// gateway's audit records match it exactly, and for a brief, the id the scheduler gave it, which
// names no owner. The prefixed form stays the turn's internal key.
function correlationIdOf(payload: TurnPayload, origin: PayloadOrigin): string {
	if (origin === 'owner') return payload.eventId;
	if (payload.event !== undefined) return payload.event.id;
	return payload.eventId.startsWith(EVENT_KEY_PREFIX)
		? payload.eventId.slice(EVENT_KEY_PREFIX.length)
		: payload.eventId;
}

// A turn queued before the origin was recorded is an event's when its id says so
function originOf(payload: TurnPayload): PayloadOrigin {
	return payload.origin ?? (payload.eventId.startsWith(EVENT_KEY_PREFIX) ? 'event' : 'owner');
}

const resumePayload = z.object({
	owner: z.string().min(1),
	roomId: z.string().min(1),
	pendingCallId: z.string().min(1),
	// A job queued before answers came through the API was answered in the chat
	through: z.enum(['chat', 'api']).default('chat'),
	replyTo: z.string().min(1).optional()
}) satisfies z.ZodType<ResumeRequest>;

export interface SendPayload {
	readonly asUserId: string;
	readonly roomId: string;
	readonly text: string;
	// The message the text answers, which the matrix role marks as answered: the owner's own, or,
	// for a turn their reaction resumed, the assistant's question they reacted to
	readonly replyTo?: string;
	readonly outcome?: 'answered' | 'failed';
	// The text asks the owner about a frozen call: the matrix role remembers the event it sent,
	// which the owner's answer points to
	readonly request?: PendingQuestion;
	// The text asks the owner a question to answer yes or no: what the matrix role marks the
	// message's content with, for their client to tell which one
	readonly questionMarker?: YesNoQuestion;
	// The text as HTML, when the harness laid it out itself rather than the model writing Markdown
	readonly html?: string;
	// The turn answered once it reached one of its limits: there is more to do
	readonly atLimit?: true;
	// The text is the brief of the owner's working day: what the matrix role marks the message's
	// content with, for their client to tell it and its date
	readonly brief?: BriefMarker;
}

// The actions a turn has done so far, which the matrix role shows its owner in the turn's status
// message
export interface ProgressPayload {
	readonly asUserId: string;
	readonly roomId: string;
	// The message the turn answers, whose status shows them
	readonly replyTo: string;
	readonly actions: number;
}

// What the yes of a turn admission refused did to the call it allowed, in the state an answer finds
// its request: settled, open again or closed, or left as it was, null once the call is gone
type Settlement =
	| { readonly settled: true; readonly state: Exclude<RequestState, 'decided'> }
	| { readonly settled: false; readonly state: RequestState | null };

export interface TurnWorkerOptions {
	readonly db: Db;
	readonly agent: AgentService;
	readonly log: FastifyBaseLogger;
	// The language of the fixed texts a failed or refused turn answers with, for owners who chose
	// none
	readonly locale: Locale;
	// The deployment's settings of a turn
	readonly turn: Config['turn'];
	// How long the owner may answer a request, which its question tells their client
	readonly requestLifetimeMs: number;
	// Takes the jobs that propose actions from the messages of channels; none without it
	readonly suggestions?: {
		readonly config: Config;
		// Twake Space's notifications, or null to post in the assistant's room alone
		readonly space: SpaceNotifications | null;
	};
	readonly pollIntervalMs?: number;
	// How many turns this replica runs at once
	readonly concurrency?: number;
}

// Turns queued by the matrix role: the owner's message becomes an answer queued back for sending.
export function startTurnWorker(options: TurnWorkerOptions): JobWorker {
	const { db, agent, log, locale, turn, requestLifetimeMs } = options;

	// A turn nobody can send again waits out admission refusing it: the owner asked for no event's
	// turn, and their yes resumes a call they already allowed. It is tried again later, each time
	// twice as late up to a minute, or given up once it waited too long since admission first
	// refused it, which is logged. A turn queued long before, during an outage of the api role,
	// still waits that long once back.
	function deferOrAbandon(
		job: Job,
		reason: RefusalReason,
		turnLog: FastifyBaseLogger,
		owner: string,
		kind: 'event' | 'resumed' | 'brief'
	): Deferral | null {
		const leftMs = turn.eventMaxDelayMs - job.deferredForMs;
		if (leftMs <= 0) {
			turnLog.warn({ owner, reason, deferredForMs: job.deferredForMs }, `${kind} turn abandoned`);
			return null;
		}
		const deferral: Deferral = {
			retryInMs: Math.min(
				REFUSED_TURN_RETRY_MS * 2 ** job.deferrals,
				REFUSED_TURN_RETRY_MAX_MS,
				leftMs
			)
		};
		turnLog.info({ owner, reason, ...deferral }, `${kind} turn deferred`);
		return deferral;
	}

	// Sets what came of the activity a turn was woken for in its owner's listening journal, once the
	// turn ended, in the transaction given under their principal, then says so once committed: once
	// for each activity, with what identifies it and none of its content
	async function settleWith(
		owner: string,
		event: TurnPayload['event'],
		outcome: WokenTurnOutcome,
		turnLog: FastifyBaseLogger,
		alongside: (tx: Tx) => Promise<unknown>
	): Promise<void> {
		const source = event?.source;
		const settled = await withPrincipal(db, { id: owner }, async (tx) => {
			await alongside(tx);
			return event === undefined || source === undefined
				? false
				: settleActivity(tx, owner, source, event.id, outcome);
		});
		if (settled && event !== undefined) {
			turnLog.info(
				{ source, eventId: event.id, type: event.type, owner, outcome },
				'activity noted'
			);
		}
	}

	// What came of the activity a turn was woken for, on its own
	function settle(
		owner: string,
		event: TurnPayload['event'],
		outcome: WokenTurnOutcome,
		turnLog: FastifyBaseLogger
	): Promise<void> {
		return settleWith(owner, event, outcome, turnLog, () => Promise.resolve());
	}

	// Tells the owner once a day, in their assistant's room, that their assistant spent the share of
	// their day it may spend on its own: it stays quiet until midnight, and still answers them
	async function noticeShareSpent(
		assistant: AssistantRecord,
		roomId: string,
		turnLog: FastifyBaseLogger
	): Promise<void> {
		const { owner } = assistant;
		const { notices } = await fetchOwnerMessages(db, owner, locale);
		const queued = await withPrincipal(db, { id: owner }, async (tx) => {
			if (!(await agent.admission.shareNoticeDue(tx, owner))) return false;
			await enqueueJob(tx, {
				kind: 'send',
				payload: {
					asUserId: assistant.userId,
					roomId,
					text: notices.shareSpent
				} satisfies SendPayload,
				groupKey: `send:${roomId}`
			});
			return true;
		});
		if (queued) turnLog.info({ owner }, 'share spent notice queued');
	}

	// The owner's assistant, when this room is still its room
	async function roomAssistant(owner: string, roomId: string): Promise<AssistantRecord | null> {
		const assistant = await withPrincipal(db, { id: owner }, (tx) => findAssistant(tx, owner));
		if (assistant === null || assistant.deletedAt !== null) return null;
		const rooms = await db.sql`
			select 1 from assistant_rooms where room_id = ${roomId} and owner = ${owner}`;
		return rooms.length === 0 ? null : assistant;
	}

	// Each count goes to the matrix role best effort, in a group of the room's counts alone: no count
	// holds an answer back, even when no matrix role takes counts, and one that comes after its
	// answer is dropped there
	function reportActions(
		log: FastifyBaseLogger,
		payload: Omit<ProgressPayload, 'actions'>
	): (actions: number) => void {
		return (actions) => {
			void enqueueJob(db, {
				kind: 'progress',
				payload: { ...payload, actions } satisfies ProgressPayload,
				groupKey: `progress:${payload.roomId}`
			}).catch((err: unknown) => {
				log.warn({ actions, err }, 'actions not reported');
			});
		};
	}

	// What a message that asks the owner about a call the harness froze carries: the request, whose
	// event the matrix role remembers for their answer, and its marker for their client while the
	// call still waits for that answer
	async function asking(
		owner: string,
		pendingCallId: string
	): Promise<Pick<SendPayload, 'request' | 'questionMarker'>> {
		const call = await withPrincipal(db, { id: owner }, (tx) =>
			findPendingCall(tx, owner, pendingCallId)
		);
		const questionMarker = call === null ? null : toYesNoQuestion(call, requestLifetimeMs);
		return {
			request: { pendingCallId, owner },
			...(questionMarker === null ? {} : { questionMarker })
		};
	}

	// What the assistant sends back for a turn: its answer, or the fixed notice of a refused or
	// failed turn, and the question it asks when the turn froze a call
	async function replyTo(
		result: OwnerTurnResult,
		assistant: AssistantRecord,
		roomId: string,
		notices: Messages['notices']
	): Promise<SendPayload> {
		const { owner } = assistant;
		const pendingCallId = result.kind === 'ok' ? result.pendingCallId : undefined;
		return {
			asUserId: assistant.userId,
			roomId,
			text:
				result.kind === 'ok'
					? result.answer
					: result.kind === 'busy'
						? notices.busy(result.reason)
						: notices.turnFailed,
			outcome: result.kind === 'ok' ? 'answered' : 'failed',
			...(pendingCallId === undefined ? {} : await asking(owner, pendingCallId)),
			// The harness's own request, laid out by the harness as HTML too
			...(result.kind === 'ok' && result.request !== undefined
				? { html: requestHtml(result.request) }
				: {}),
			// The brief the owner asked for, as the harness laid it out, marked as the brief of its date
			...(result.kind === 'ok' && result.brief !== undefined
				? { html: result.brief.html, brief: { date: result.brief.date } }
				: {}),
			...(result.kind === 'ok' && result.atLimit === true ? { atLimit: true } : {})
		};
	}

	// The call its owner allowed did not run, admission refusing the turn their yes resumed: their
	// day is spent, or the turn waited for room too long. The yes settles the call all the same. A
	// newer request open in its room, asked while the yes waited, stays the room's question: this
	// one closes as superseded, which the assistant tells them as it would an answer to it.
	// Otherwise its request waits for an answer again, should it last until the refusal lifts, at
	// midnight or now, which the assistant tells them on a message marked as the request, for their
	// client to offer the answers again: a message that asks it again, superseding no other request.
	// Failing that, it closes as expired, which the assistant tells them too. The job is done in the
	// same transaction rather than by its worker once this returns, so that their next yes queues one
	// again at once, and so that a stop in between leaves no job to claim again: run again, it would
	// find the call open and approve it without a new yes. A call that no longer waits to run is left
	// as it is, and one whose yes is still to be recorded waits for it.
	async function settleRefusedYes(
		job: Job,
		request: ResumeRequest,
		assistant: AssistantRecord,
		refusal: Refusal,
		turnLog: FastifyBaseLogger
	): Promise<Deferral | null> {
		const { owner, roomId, pendingCallId } = request;
		const { consent } = await fetchOwnerMessages(db, owner, locale);
		// When the refusal lifts, and what the assistant tells the owner of their request, open again or
		// expired: a spent day lifts at midnight, and a turn kept waiting too long for room may run at
		// once
		const { liftsInMs, open, expired } =
			refusal.reason === 'user_budget'
				? {
						liftsInMs: refusal.liftsInMs,
						open: consent.heldUntilMidnight,
						expired: consent.endsBeforeMidnight
					}
				: { liftsInMs: 0, open: consent.heldTooLong, expired: consent.expired };
		const told = { open, expired, superseded: consent.superseded };
		const settlement = await withPrincipal(db, { id: owner }, async (tx): Promise<Settlement> => {
			// Locked before anything is read of it: an answer recorded meanwhile waits for this
			// transaction to end, and finds the call as it left it
			const held = await lockPendingCall(tx, owner, pendingCallId);
			if (held === null || !held.waitsToRun) return { settled: false, state: held?.state ?? null };
			const newer = await hasNewerRequest(tx, owner, roomId, pendingCallId);
			const reopened =
				!newer && (await reopenRequest(tx, owner, pendingCallId, requestLifetimeMs, liftsInMs));
			const state = reopened ? 'open' : newer ? 'superseded' : 'expired';
			if (state !== 'open') await closeHeldRequest(tx, owner, pendingCallId, state);
			const call = reopened ? await findPendingCall(tx, owner, pendingCallId) : null;
			const questionMarker = call === null ? null : toYesNoQuestion(call, requestLifetimeMs);
			const asked: PendingQuestion = { pendingCallId, owner, again: true };
			await enqueueJob(tx, {
				kind: 'send',
				payload: {
					asUserId: assistant.userId,
					roomId,
					text: told[state],
					outcome: 'failed',
					...(reopened ? { request: asked } : {}),
					...(questionMarker === null ? {} : { questionMarker }),
					...(request.replyTo === undefined ? {} : { replyTo: request.replyTo })
				} satisfies SendPayload,
				groupKey: `send:${roomId}`
			});
			await completeJob(tx, job.id);
			return { settled: true, state };
		});
		if (!settlement.settled) {
			// The matrix role records a yes right after it queued its job: a job refused in between waits
			// for the yes as a turn waits for room, and once given up, leaves the call open to the
			// owner's answer
			if (settlement.state === 'open') {
				return deferOrAbandon(job, refusal.reason, turnLog, owner, 'resumed');
			}
			turnLog.info({ pendingCallId }, 'resume dropped: the call is no longer waiting');
			return null;
		}
		turnLog.info(
			{ pendingCallId, reason: refusal.reason, liftsInMs, state: settlement.state },
			'refused yes settled'
		);
		return null;
	}

	// The owner allowed the call already, and sending their yes again would change nothing: a turn
	// refused for room waits for it, and one refused for their day, or kept waiting too long,
	// settles the call their yes allowed
	async function waitOrSettle(
		job: Job,
		request: ResumeRequest,
		assistant: AssistantRecord,
		refusal: Refusal,
		turnLog: FastifyBaseLogger
	): Promise<Deferral | null> {
		if (refusal.reason !== 'user_budget') {
			const deferral = deferOrAbandon(job, refusal.reason, turnLog, request.owner, 'resumed');
			if (deferral !== null) return deferral;
		}
		return settleRefusedYes(job, request, assistant, refusal, turnLog);
	}

	// The brief that gave way to the question about the owner's permission, or to the question of
	// their first brief, which their yes resumes: that day's brief goes out, marked as the brief of
	// its date, or, while the broker refuses, its question, marked as a question, either one
	// answering their yes. A brief refused for the share of the day the assistant spends on its own
	// goes out laid out by the harness, and the assistant tells its owner so, once a day, as for the
	// brief of the morning.
	async function resumeBrief(
		job: Job,
		request: ResumeRequest,
		assistant: AssistantRecord,
		turnLog: FastifyBaseLogger
	): Promise<Deferral | null> {
		const { owner, roomId, pendingCallId, through } = request;
		const result = await agent.resumeBrief({
			principal: { id: owner },
			roomId,
			pendingCallId,
			through,
			log: turnLog,
			assistantName: assistant.name
		});
		if (result.kind === 'missing') {
			turnLog.info({ pendingCallId }, 'resume dropped: the call is no longer waiting');
			return null;
		}
		if (result.kind === 'busy') return waitOrSettle(job, request, assistant, result, turnLog);
		let reply: Pick<
			SendPayload,
			'text' | 'outcome' | 'html' | 'brief' | 'request' | 'questionMarker'
		>;
		if (result.kind === 'ok') {
			reply = {
				text: result.text,
				html: result.html,
				brief: { date: result.date },
				outcome: 'answered'
			};
		} else if (result.kind === 'question') {
			reply = {
				text: result.text,
				outcome: 'answered',
				...(await asking(owner, result.pendingCallId))
			};
		} else {
			turnLog.warn({ result: result.kind }, 'resumed brief did not succeed');
			const { notices } = await fetchOwnerMessages(db, owner, locale);
			reply = { text: notices.turnFailed, outcome: 'failed' };
		}
		await enqueueJob(db, {
			kind: 'send',
			payload: {
				asUserId: assistant.userId,
				roomId,
				...reply,
				// The owner's yes, which the matrix role marks as answered
				...(request.replyTo === undefined ? {} : { replyTo: request.replyTo })
			} satisfies SendPayload,
			dedupKey: `send:resume:${pendingCallId}`,
			groupKey: `send:${roomId}`
		});
		if (result.kind === 'ok' && result.refusedFor === 'event_share') {
			await noticeShareSpent(assistant, roomId, turnLog);
		}
		return null;
	}

	// Runs the call its owner allowed, then the rest of the turn, and sends the answer. The call a
	// brief's read froze, which the brief waits for, resumes that brief.
	async function resume(job: Job, request: ResumeRequest): Promise<Deferral | null> {
		const { owner, roomId, pendingCallId, through } = request;
		const assistant = await roomAssistant(owner, roomId);
		if (assistant === null) {
			log.info({ owner, roomId }, 'resume dropped: no assistant for this room');
			return null;
		}
		const turnLog = log.child({ reqId: `resume:${pendingCallId}`, roomId });
		// The question of the owner's first brief, the one that waits for their answer or an older
		// one, is the brief's own, which no turn could run
		const brief = await withPrincipal(
			db,
			{ id: owner },
			async (tx) =>
				(await findBriefWait(tx, owner))?.pendingCallId === pendingCallId ||
				(await findPendingCall(tx, owner, pendingCallId))?.tool === BRIEF_QUESTION
		);
		if (brief) return resumeBrief(job, request, assistant, turnLog);
		const actionsDone =
			request.replyTo === undefined
				? null
				: reportActions(turnLog, { asUserId: assistant.userId, roomId, replyTo: request.replyTo });
		const result = await agent.runOwnerTurn({
			principal: { id: owner },
			target: { kind: 'room', roomId },
			message: null,
			log: turnLog,
			assistantName: assistant.name,
			resume: { pendingCallId, through },
			...(actionsDone === null ? {} : { actionsDone })
		});
		// A call already decided, by an answer delivered twice for instance, runs nothing more
		if (result.kind === 'missing' || result.kind === 'decided') {
			turnLog.info({ pendingCallId }, 'resume dropped: the call is no longer waiting');
			return null;
		}
		if (result.kind === 'busy') return waitOrSettle(job, request, assistant, result, turnLog);
		if (result.kind !== 'ok') turnLog.warn({ result }, 'resumed turn did not succeed');
		// Read once the turn is over: the owner may have changed their language in it
		const { notices } = await fetchOwnerMessages(db, owner, locale);
		await enqueueJob(db, {
			kind: 'send',
			payload: {
				...(await replyTo(result, assistant, roomId, notices)),
				// What carries the owner's yes, which the matrix role marks as answered as it would a
				// message: their words, or the assistant's own question they reacted to
				...(request.replyTo === undefined ? {} : { replyTo: request.replyTo })
			},
			dedupKey: `send:resume:${pendingCallId}`,
			groupKey: `send:${roomId}`
		});
		return null;
	}

	// What an owner's assistant proposes from the quotes of a job: the quotes are used here, sent
	// to the model, and gone with the job. Its handler catches what this throws, so that a failed
	// job never keeps them. A job that asked its owner for a permission waits for their answer, as
	// long as its quotes may be kept; it waited already once deferred.
	async function suggest(payload: SuggestPayload, waited: boolean): Promise<Deferral | null> {
		const settings = options.suggestions;
		if (settings === undefined) return null;
		const { owner, roomId } = payload;
		const attempt = payload.retry === undefined ? 0 : 1;
		const jobLog = log.child({ reqId: `suggest:${payload.eventId}`, roomId });
		// Turned off since the job was queued, as a second try at another time can be
		if (!settings.config.suggestions.enabled) {
			jobLog.info({ owner }, 'suggestion dropped: off');
			return null;
		}
		const leftMs = payload.at + SUGGEST_MAX_AGE_MS - Date.now();
		if (leftMs < 0) {
			jobLog.info({ owner }, 'suggestion dropped: too old');
			return null;
		}
		const skip = await withPrincipal(db, { id: owner }, (tx) =>
			mayReceive(tx, owner, roomId, attempt)
		);
		if (skip !== null) {
			jobLog.info({ owner, reason: skip }, 'suggestion skipped');
			return null;
		}
		const result = await agent.runSuggestion({ payload, attempt, waited, log: jobLog });
		if (result.kind === 'asked') {
			jobLog.info({ owner, pendingCallId: result.pendingCallId }, 'suggestion asks for consent');
			await sendSuggestionQuestion(owner, result);
		}
		if (result.kind === 'asked' || result.kind === 'waiting') {
			return { retryInMs: Math.min(SUGGEST_RECHECK_MS, leftMs) };
		}
		if (result.kind !== 'proposed') {
			jobLog.info(
				{
					owner,
					outcome: result.kind,
					...(result.kind === 'none' ? { reason: result.reason } : {})
				},
				'suggestion decided'
			);
			return null;
		}
		const { pendingCallId, proposal } = result;
		await withPrincipal(db, { id: owner }, (tx) =>
			recordSuggestion(tx, owner, {
				pendingCallId,
				roomId,
				startsAt: new Date(proposal.start),
				endsAt: new Date(proposal.end),
				attempt
			})
		);
		jobLog.info({ owner, pendingCallId, attempt }, 'suggestion made');
		const matrixUserId = matrixUserIdOfPrincipal(settings.config, owner);
		if (settings.space !== null && matrixUserId !== null) {
			const outcome = await settings.space.suggest({
				matrixUserId,
				externalId: pendingCallId,
				text: proposalSentence(result.locale, proposal),
				pendingCallId,
				matrixRoomId: roomId
			});
			jobLog.info({ owner, pendingCallId, outcome }, 'suggestion sent to Space');
		}
		await sendSuggestionQuestion(owner, result);
		return null;
	}

	// The harness's request about the call a suggestion froze, in the owner's assistant room
	async function sendSuggestionQuestion(
		owner: string,
		result: { pendingCallId: string; answer: string; request: OwnerRequest | null }
	): Promise<void> {
		const { pendingCallId } = result;
		const assistant = await withPrincipal(db, { id: owner }, (tx) => findAssistant(tx, owner));
		if (assistant?.roomId === null || assistant === null) return;
		const call = await withPrincipal(db, { id: owner }, (tx) =>
			findPendingCall(tx, owner, pendingCallId)
		);
		const questionMarker = call === null ? null : toYesNoQuestion(call, requestLifetimeMs);
		await enqueueJob(db, {
			kind: 'send',
			payload: {
				asUserId: assistant.userId,
				roomId: assistant.roomId,
				text: result.answer,
				request: { pendingCallId, owner },
				...(questionMarker === null ? {} : { questionMarker }),
				...(result.request === null ? {} : { html: requestHtml(result.request) })
			} satisfies SendPayload,
			dedupKey: `send:suggest:${pendingCallId}`,
			groupKey: `send:${assistant.roomId}`
		});
	}

	// The brief of the owner's working day, which the worker role's scheduler asked for, goes out as
	// a message of its own, marked as the brief of its date, or the question it gave way to, about
	// their permission or the reads of their first brief, marked as a question, or what it says once
	// it stops by itself, its question unanswered or its owner not seen. Refused by admission for
	// rate or room, it waits as a turn an event woke does, and the line that says so says why.
	// Refused for a spent day, it goes out laid out by the harness, and once the share of the day the
	// assistant spends on its own was spent, the assistant tells its owner so, once a day.
	async function sendBrief(
		job: Job,
		payload: TurnPayload,
		assistant: AssistantRecord,
		correlationId: string,
		turnLog: FastifyBaseLogger
	): Promise<Deferral | null> {
		const { owner, roomId, eventId, text, brief } = payload;
		if (brief === undefined) throw new Error('turn payload is malformed');
		const result = await agent.runBrief({
			principal: { id: owner },
			roomId,
			told: text,
			date: brief.date,
			log: turnLog,
			correlationId,
			assistantName: assistant.name
		});
		if (result.kind === 'busy') return deferOrAbandon(job, result.reason, turnLog, owner, 'brief');
		// A brief that waits for its owner's answer says nothing while the broker still refuses
		if (result.kind === 'withheld') return null;
		if (result.kind !== 'ok' && result.kind !== 'question' && result.kind !== 'notice') {
			turnLog.warn({ result: result.kind }, 'brief dropped');
			return null;
		}
		await enqueueJob(db, {
			kind: 'send',
			payload: {
				asUserId: assistant.userId,
				roomId,
				text: result.text,
				...(result.kind === 'ok'
					? { html: result.html, brief: { date: brief.date } }
					: result.kind === 'question'
						? await asking(owner, result.pendingCallId)
						: {})
			} satisfies SendPayload,
			dedupKey: `send:${eventId}`,
			groupKey: `send:${roomId}`
		});
		if (result.kind === 'ok' && result.refusedFor === 'event_share') {
			await noticeShareSpent(assistant, roomId, turnLog);
		}
		return null;
	}

	return startJobWorker({
		db,
		log,
		kinds: options.suggestions === undefined ? ['turn', 'resume'] : ['turn', 'resume', 'suggest'],
		...(options.pollIntervalMs === undefined ? {} : { pollIntervalMs: options.pollIntervalMs }),
		...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
		handler: async (job) => {
			if (job.kind === 'suggest') {
				const quoted = suggestPayloadSchema.safeParse(job.payload);
				if (!quoted.success) {
					log.warn({ job: job.id }, 'suggestion dropped: malformed');
					return null;
				}
				try {
					return await suggest(quoted.data, job.deferrals > 0);
				} catch (err: unknown) {
					log.warn(
						{ job: job.id, reason: err instanceof Error ? err.name : 'error' },
						'suggestion failed'
					);
				}
				return null;
			}
			if (job.kind === 'resume') {
				const resumed = resumePayload.safeParse(job.payload);
				if (!resumed.success) throw new Error('resume payload is malformed');
				return resume(job, resumed.data);
			}
			const parsed = turnPayload.safeParse(job.payload);
			if (!parsed.success) throw new Error('turn payload is malformed');
			const { owner, roomId, eventId, text } = parsed.data;
			const origin = originOf(parsed.data);
			const assistant = await roomAssistant(owner, roomId);
			if (assistant === null) {
				log.info({ owner, roomId }, 'turn dropped: no assistant for this room');
				// Nobody was told of the activity it was woken for
				if (origin === 'event') await settle(owner, parsed.data.event, 'failed', log);
				return null;
			}
			const correlationId = correlationIdOf(parsed.data, origin);
			const turnLog = log.child({ reqId: correlationId, roomId });
			if (origin === 'brief') {
				return sendBrief(job, parsed.data, assistant, correlationId, turnLog);
			}
			// A turn woken by an event posted to the API answers no message of the room
			const actionsDone = eventId.startsWith('$')
				? reportActions(turnLog, { asUserId: assistant.userId, roomId, replyTo: eventId })
				: null;
			const result = await agent.runOwnerTurn({
				principal: { id: owner },
				target: { kind: 'room', roomId },
				message: text,
				log: turnLog,
				correlationId,
				origin,
				assistantName: assistant.name,
				...(parsed.data.event === undefined ? {} : { event: parsed.data.event }),
				...(actionsDone === null ? {} : { actionsDone })
			});
			if (result.kind === 'busy' && origin === 'event') {
				// Refused for a spent day, the activity waits for its owner's brief rather than for room,
				// and once the share of the day their assistant spends on its own was spent, the assistant
				// tells them so, once a day
				if (spentForTheDay(result.reason)) {
					await settle(owner, parsed.data.event, 'share_spent', turnLog);
					if (result.reason === 'event_share') {
						await noticeShareSpent(assistant, roomId, turnLog);
					}
					return null;
				}
				const deferral = deferOrAbandon(job, result.reason, turnLog, owner, 'event');
				if (deferral === null) await settle(owner, parsed.data.event, 'abandoned', turnLog);
				return deferral;
			}
			if (result.kind !== 'ok') turnLog.warn({ result }, 'turn did not succeed');
			// An activity the assistant found nothing useful in leaves nothing in the room
			if (origin === 'event' && result.kind === 'ok' && result.silent === true) {
				await settle(owner, parsed.data.event, 'nothing_useful', turnLog);
				return null;
			}
			// Read once the turn is over: the owner may have changed their language in it
			const { notices } = await fetchOwnerMessages(db, owner, locale);
			const send = {
				kind: 'send' as const,
				payload: {
					...(await replyTo(result, assistant, roomId, notices)),
					// A turn woken by an event posted to the API answers no message of the room
					...(eventId.startsWith('$') ? { replyTo: eventId } : {})
				},
				dedupKey: `send:${eventId}`,
				groupKey: `send:${roomId}`
			};
			if (origin !== 'event') {
				await enqueueJob(db, send);
				return null;
			}
			// What came of the activity is settled with what tells its owner of it, or not at all
			await settleWith(
				owner,
				parsed.data.event,
				result.kind === 'ok' ? 'suggested' : 'failed',
				turnLog,
				(tx) => enqueueJob(tx, send)
			);
			return null;
		},
		// A turn an activity woke that failed for good told its owner nothing of it
		failedForGood: async (job) => {
			const parsed = turnPayload.safeParse(job.payload);
			if (job.kind !== 'turn' || !parsed.success || originOf(parsed.data) !== 'event') return;
			await settle(parsed.data.owner, parsed.data.event, 'failed', log);
		}
	});
}
