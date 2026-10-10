import type { FastifyBaseLogger } from 'fastify';

import type { Clock } from '../agent/clock.js';
import { carriesInvitation, instantOfStart, type Invitation } from '../agent/invitation.js';
import type { TurnPayload } from '../agent/turn-worker.js';
import { localeOf } from '../assistants/locale.js';
import { findAssistant } from '../assistants/repository.js';
import { briefSettingsOf } from '../briefs/settings.js';
import type { Config } from '../config.js';
import { withPrincipal, type Db, type Tx } from '../db/client.js';
import { getMessages, type Locale, type Messages } from '../i18n/messages.js';
import { enqueueJob } from '../jobs/queue.js';
import {
	noteActivity,
	noteReleased,
	NOTHING_SHOWN,
	wasNoted,
	type ActivityOutcome,
	type Noted,
	type Shown
} from '../journal/repository.js';
import { fenced } from '../llm/data.js';
import { isRecord } from '../matrix/json.js';
import { matrixLocalpartOfPrincipal } from '../principals/identity.js';
import { quietHoursOf } from '../quiet/hours.js';
import { findOwnerSettings } from '../settings/repository.js';
import { isListening } from '../sources/repository.js';
import { sourceOfActivity } from '../sources/sources.js';
import {
	CANCELLED_EVENT_TYPE,
	COUNTERED_EVENT_TYPE,
	MOVED_EVENT_TYPE,
	TASK_ASSIGNED_EVENT_TYPE
} from './event-types.js';
import {
	eraseHeldActivities,
	hasReleasedActivities,
	holdActivity,
	listReleasedActivities,
	quietExitOf,
	type QuietExit
} from './held.js';

// Someone an event names, as its source knows them
export interface Person {
	readonly email: string | null;
	readonly uuid: string | null;
}

// What wakes an assistant: an event a source published, for one of the people it concerns, and
// what its turn shows the model of it, the text other people wrote apart from what the source
// computed
export interface Wakeup {
	readonly source: string;
	readonly id: string;
	readonly type: string;
	readonly recipient: Person & { readonly reason: string };
	readonly actor: Person;
	readonly shown: Shown;
	// What its owner's listening journal keeps of it beyond its source, type and id, nothing unless
	// its source says
	readonly noted?: Noted;
	// For a new invitation to a meeting, its move, its cancellation or a counter-proposal of another
	// time, the meeting, whose slot, or the time proposed, its turn checks before the model speaks
	// unless it is cancelled
	readonly invitation?: Invitation;
	// For an activity that calls for no word at once: its owner's journal keeps it for their brief,
	// and it wakes nobody
	readonly forBrief?: true;
	// For the brief of its owner's working day, the date in their zone it is the brief of: only the
	// worker role's scheduler sets it, and a turn is a brief's for that alone, never for its type
	readonly brief?: { readonly date: string };
}

// The source of the wake-ups the worker role's scheduler makes, the briefs, which no other wake-up
// may take: a source may publish any name, this one included
export const BRIEF_SOURCE = 'schedule';

export type WakeOutcome =
	| 'woken'
	| 'duplicate'
	| 'no_assistant'
	| 'ignored'
	| 'capped'
	| 'for_brief'
	| 'quiet_hours'
	| 'unlistened';

export interface WakeDeps {
	readonly config: Config;
	readonly db: Db;
	readonly log: FastifyBaseLogger;
	// The present the daily reminders, the briefs and the listening journal read
	readonly clock: Clock;
}

export interface WakeOptions {
	// Whether a wake-up the owner's hourly cap holds back is logged: the scheduler tries a brief
	// again at each pass, and says so at the first alone
	readonly logCapped?: boolean;
}

// The message that tells a wake-up that carries a meeting, by its type, beside a new invitation's
const TOLD_OF_MEETING = new Map<string, 'moved' | 'cancelled' | 'countered'>([
	[MOVED_EVENT_TYPE, 'moved'],
	[CANCELLED_EVENT_TYPE, 'cancelled'],
	[COUNTERED_EVENT_TYPE, 'countered']
]);

// The event as the model is handed it: what its source computed, apart from what people wrote
function eventData(wakeup: Wakeup): string {
	return fenced('event-data', { ...wakeup.shown.computed, untrusted: wakeup.shown.untrusted });
}

// What the owner's assistant is told, in its owner's language: what arrived, then the event, or
// that their day starts, for a brief, whose turn reads the rest. Of a wake-up that carries a
// meeting, which only the calendar listener gives, its type tells whether it is a new invitation,
// a move, a cancellation or a counter-proposal.
function told(wakeup: Wakeup, messages: Messages): string {
	if (wakeup.brief !== undefined) return messages.brief.intro(wakeup.id);
	if (carriesInvitation(wakeup)) {
		const kind = TOLD_OF_MEETING.get(wakeup.type);
		return kind === undefined
			? messages.events.invited(wakeup.id, eventData(wakeup))
			: messages.events[kind](wakeup.id, eventData(wakeup), wakeup.invitation.scope ?? 'event');
	}
	return wakeup.type === TASK_ASSIGNED_EVENT_TYPE
		? messages.events.taskAssigned(wakeup.id, eventData(wakeup))
		: messages.events.published(wakeup.type, wakeup.id, eventData(wakeup));
}

function same(a: string | null, b: string | null): boolean {
	return a !== null && b !== null && a.toLowerCase() === b.toLowerCase();
}

// Whether the recipient is the person whose action it was, by either identifier the source gives
function isOwnAction({ actor, recipient }: Wakeup): boolean {
	return same(actor.email, recipient.email) || same(actor.uuid, recipient.uuid);
}

// Whether the meeting an activity is about starts before an instant: at its time, at the one it
// had for a move, or at the one a counter-proposal proposes, an all-day event at midnight in the
// owner's zone. An activity about no meeting, or a time that cannot be read, never does.
function startsBefore(wakeup: Wakeup, at: Date, timeZone: string): boolean {
	if (!carriesInvitation(wakeup)) return false;
	const { start, timezone } = wakeup.invitation;
	const object = wakeup.shown.computed['object'];
	const previous = isRecord(object) ? object['previous_start'] : undefined;
	return [start, typeof previous === 'string' ? previous : null].some((time) => {
		const instant = instantOfStart(time, timezone, timeZone);
		return instant !== null && instant < at;
	});
}

// When an activity that reaches its owner now comes out of their quiet hours, as they and their
// brief stand, on the wall clock of their zone: null for one that does not wait, out of those hours
// or about a meeting that starts before then
async function heldUntil(
	tx: Tx,
	deps: WakeDeps,
	owner: string,
	wakeup: Wakeup
): Promise<QuietExit | null> {
	const { config, clock } = deps;
	const settings = await findOwnerSettings(tx, owner);
	const timeZone = settings.timeZone ?? config.timeZone;
	const brief = config.brief.enabled ? briefSettingsOf(settings.brief, timeZone) : null;
	const hours = quietHoursOf(settings.quiet, config.quietHours);
	const exit = quietExitOf(hours, timeZone, brief, clock.now());
	return exit === null || startsBefore(wakeup, exit.at, timeZone) ? null : exit;
}

// Queues the turn that tells an owner of a wake-up, in their room and their language, serialized
// with their other turns, and keeps the wake-up with it, or neither
async function queueTurn(
	tx: Tx,
	wakeup: Wakeup,
	owner: string,
	roomId: string,
	locale: Locale
): Promise<void> {
	await tx.sql`
		insert into wakeups (source, event_id, owner) values (${wakeup.source}, ${wakeup.id}, ${owner})`;
	const key = `event:${JSON.stringify([wakeup.source, wakeup.id, owner])}`;
	const payload: TurnPayload = {
		owner,
		roomId,
		eventId: key,
		text: told(wakeup, getMessages(locale)),
		origin: wakeup.brief === undefined ? 'event' : 'brief',
		event: {
			id: wakeup.id,
			type: wakeup.type,
			source: wakeup.source,
			...(wakeup.invitation === undefined ? {} : { invitation: wakeup.invitation })
		},
		...(wakeup.brief === undefined ? {} : { brief: wakeup.brief })
	};
	await enqueueJob(tx, { kind: 'turn', payload, dedupKey: key, groupKey: `turn:${owner}` });
}

// Wakes the assistant of the person a wake-up is for, its owner: a turn of origin event in their
// room, serialized with their other turns, which tells them of the event it carries, or of origin
// brief for the brief the scheduler asks for. The owner is
// the recipient by their email, which is their principal: only a person of the instance's mail
// domain has one, nobody is woken for their own action, and nobody more often in an hour than the
// deployment allows. An activity of an application their assistant does not listen to, as they
// chose or by its default, wakes nothing and leaves nothing. Their listening journal notes each
// event they are woken for or their cap holds back, and for their brief, with no turn, a task they
// assigned themselves or an activity its source keeps for it, such as a meeting's new title, none
// of which wakes them twice; a brief, which the scheduler tries again, it never notes.
export async function wake(
	deps: WakeDeps,
	wakeup: Wakeup,
	options: WakeOptions = {}
): Promise<WakeOutcome> {
	const { config, db } = deps;
	const owner = wakeup.recipient.email?.toLowerCase() ?? null;
	if (owner === null || matrixLocalpartOfPrincipal(config, owner) === null) return 'ignored';
	// Of the owner's own actions, only a task they assigned themselves, or that their assistant
	// assigned them on their yes, as them, is noted
	const ownAction = isOwnAction(wakeup);
	if (ownAction && wakeup.type !== TASK_ASSIGNED_EVENT_TYPE) return 'ignored';
	// A brief comes from the scheduler's source, and that source brings nothing else: an event
	// published under it is nobody's brief, and takes none of their wake-ups
	if ((wakeup.source === BRIEF_SOURCE) !== (wakeup.brief !== undefined)) return 'ignored';
	// A brief is no activity: the journal notes the others alone
	const isActivity = wakeup.brief === undefined;
	// The application an activity comes from, by the source it was published under: one the
	// harness does not know is listened to by nobody
	const application = isActivity ? sourceOfActivity(wakeup.source) : null;
	const outcome = await withPrincipal(db, { id: owner }, async (tx) => {
		const assistant = await findAssistant(tx, owner);
		if (assistant === null || assistant.deletedAt !== null || assistant.roomId === null) {
			return 'no_assistant' as const;
		}
		// What the owner does not have their assistant listen to reaches neither their room nor
		// their journal, and takes none of their wake-ups
		if (isActivity && (application === null || !(await isListening(tx, owner, application)))) {
			return 'unlistened' as const;
		}
		// One wake-up of an owner at a time, whatever source it comes from: what woke them is settled
		// when it is read, and no two events take the last wake-up of their hour
		await tx.sql`select pg_advisory_xact_lock(hashtext(${`wakeups:${owner}`}))`;
		const [prior] = await tx.sql<{ seen: boolean; woken: number }[]>`
			select
				exists (
					select 1 from wakeups
					where source = ${wakeup.source} and event_id = ${wakeup.id} and owner = ${owner}
				) as seen,
				(
					select count(*)::int from wakeups
					where owner = ${owner} and woken_at > now() - interval '1 hour'
				) as woken`;
		// An owner the event already woke, or whose journal noted it, is not woken again
		if (prior?.seen === true || (await wasNoted(tx, owner, wakeup.source, wakeup.id))) {
			return 'duplicate' as const;
		}
		const noteAs = (journaled: ActivityOutcome): Promise<void> =>
			noteActivity(tx, owner, {
				source: wakeup.source,
				eventId: wakeup.id,
				type: wakeup.type,
				receivedAt: deps.clock.now(),
				outcome: journaled,
				noted: wakeup.noted ?? { ids: NOTHING_SHOWN, names: NOTHING_SHOWN }
			});
		// A task the owner assigned themselves, or an activity its source keeps for their brief, calls
		// for no word at once and takes none of their wake-ups: their journal keeps it for their brief
		if (ownAction || wakeup.forBrief === true) {
			await noteAs('for_brief');
			return 'for_brief' as const;
		}
		// Nor during their quiet hours, unless it is about a meeting that starts before they come out
		// of them: it waits for their brief, or their end, with what its turn will need
		const held = isActivity ? await heldUntil(tx, deps, owner, wakeup) : null;
		if (held !== null) {
			await holdActivity(tx, owner, wakeup, deps.clock.now(), held.releaseAt);
			await noteAs('quiet_hours');
			return 'quiet_hours' as const;
		}
		// Nor past their hourly cap: a burst of events, a mass assignment or what piled up during an
		// outage, drowns neither their room nor their quota
		if ((prior?.woken ?? 0) >= config.wakeups.perHour) {
			if (isActivity) await noteAs('capped');
			return 'capped' as const;
		}
		if (isActivity) await noteAs('woken');
		await queueTurn(tx, wakeup, owner, assistant.roomId, localeOf(assistant, config.locale));
		return 'woken' as const;
	});
	const logged = { source: wakeup.source, eventId: wakeup.id, type: wakeup.type, owner };
	if (outcome === 'woken') deps.log.info(logged, 'event queued');
	// A source the harness does not know publishes for nobody: its operator learns which
	if (outcome === 'unlistened' && application === null) {
		deps.log.warn(logged, 'activity of an unknown source, listened to by nobody');
	}
	// Taken all the same, for no turn: nothing tells the owner of an event past their cap
	if (outcome === 'capped' && options.logCapped !== false) deps.log.info(logged, 'event capped');
	// What came of an activity, once settled: one capped, kept for the brief or held for the quiet
	// hours is, one woken once its turn ends
	if (
		(outcome === 'capped' || outcome === 'for_brief' || outcome === 'quiet_hours') &&
		isActivity
	) {
		deps.log.info({ ...logged, outcome }, 'activity noted');
	}
	return outcome;
}

// The brief its owner asks for in their turn takes the wake-up of its date, as a pass's would, so
// that no pass wakes them for that date after it: under the lock of their wake-ups, as any of
// theirs is taken, and counted among those of their hour. One a pass took first stays as it is.
export async function takeBriefWakeup(tx: Tx, owner: string, id: string): Promise<void> {
	await tx.sql`select pg_advisory_xact_lock(hashtext(${`wakeups:${owner}`}))`;
	await tx.sql`
		insert into wakeups (source, event_id, owner) values (${BRIEF_SOURCE}, ${id}, ${owner})
		on conflict do nothing`;
}

// Wakes an owner's assistant for the activities their quiet hours held whose release came, the
// first due first, within their hourly cap, the rest left for a later pass. Each comes out of the
// hold, and wakes nobody whose assistant left its room or who no longer listens to its
// application, whose journal keeps it as held. Gives how many it woke.
export async function releaseHeld(deps: WakeDeps, owner: string): Promise<number> {
	const { config, db, clock } = deps;
	const now = clock.now();
	const woken = await withPrincipal(db, { id: owner }, async (tx) => {
		if (!(await hasReleasedActivities(tx, owner, now))) return [];
		// One wake-up of an owner at a time, as wake() takes them
		await tx.sql`select pg_advisory_xact_lock(hashtext(${`wakeups:${owner}`}))`;
		const [prior] = await tx.sql<{ woken: number }[]>`
			select count(*)::int as woken from wakeups
			where owner = ${owner} and woken_at > now() - interval '1 hour'`;
		const released = await listReleasedActivities(
			tx,
			owner,
			now,
			config.wakeups.perHour - (prior?.woken ?? 0)
		);
		const assistant = await findAssistant(tx, owner);
		const queued: Wakeup[] = [];
		for (const wakeup of released) {
			await eraseHeldActivities(tx, owner, [{ source: wakeup.source, eventId: wakeup.id }]);
			if (assistant === null || assistant.deletedAt !== null || assistant.roomId === null) continue;
			const application = sourceOfActivity(wakeup.source);
			if (application === null || !(await isListening(tx, owner, application))) continue;
			await noteReleased(tx, owner, wakeup.source, wakeup.id);
			await queueTurn(tx, wakeup, owner, assistant.roomId, localeOf(assistant, config.locale));
			queued.push(wakeup);
		}
		return queued;
	});
	for (const wakeup of woken) {
		deps.log.info(
			{ source: wakeup.source, eventId: wakeup.id, type: wakeup.type, owner },
			'event queued'
		);
	}
	return woken.length;
}
