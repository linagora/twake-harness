import { z } from 'zod';

import { fenced } from '../llm/data.js';
import { MEETING_SCOPES } from '../wakeups/event-types.js';
import { wallTimeIn } from './clock.js';
import type { ToolOutcome } from './tools.js';

// What the wake-up of a new invitation, a move, a cancellation or a counter-proposal carries of its
// meeting, which its turn's payload keeps: its UID, its start and end from DTSTART and DTEND, the
// time proposed for a counter-proposal, and the TZID, "UTC", or null for an all-day event; for a
// change to a meeting or a counter-proposal, what it is about, which its turn's words and the
// answers it may prepare follow, a meeting on its own when it says nothing. The harness checks the
// slot of a new invitation or a move, and the time a counter-proposal proposes, before the model
// speaks, never a cancellation's.
export const invitationSchema = z.object({
	uid: z.string().min(1),
	start: z.string().nullable(),
	end: z.string().nullable(),
	timezone: z.string().nullable(),
	scope: z.enum(MEETING_SCOPES).optional()
});

export type Invitation = z.infer<typeof invitationSchema>;

// Whether an event carries a meeting, whichever source it came from: only the calendar listener
// gives one, and what its wake-up tells, and its turn, follow from that first, never from its type
// alone, which then tells a new invitation, a move, a cancellation and a counter-proposal apart
export function carriesInvitation<T extends { readonly invitation?: Invitation | undefined }>(
	event: T | undefined
): event is T & { readonly invitation: Invitation } {
	return event?.invitation !== undefined;
}

// The period read_freebusy is asked about, or why it is not asked
export type InvitationSlot =
	| { readonly ok: true; readonly start: string; readonly end: string }
	| { readonly ok: false; readonly reason: string };

type TimeOf =
	{ readonly ok: true; readonly time: string } | { readonly ok: false; readonly reason: string };

// read_freebusy refuses a longer period, as the contract does
const LONGEST_PERIOD_MS = 31 * 24 * 60 * 60 * 1000;
const NOT_CHECKED = 'availability not checked: ';

// RFC 3339 with its offset or Z, the shape read_freebusy accepts as it is
const AWARE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;
// The date of an all-day event
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function timeOf(
	value: unknown,
	timezone: unknown,
	defaultZone: string,
	which: 'start' | 'end'
): TimeOf {
	if (value === null || value === undefined || value === '') {
		return { ok: false, reason: `${NOT_CHECKED}no ${which} time` };
	}
	const unreadable: TimeOf = { ok: false, reason: `${NOT_CHECKED}unreadable ${which} time` };
	if (typeof value !== 'string') return unreadable;
	if (AWARE.test(value))
		return Number.isNaN(Date.parse(value)) ? unreadable : { ok: true, time: value };
	if (DATE.test(value)) {
		// An all-day event runs from midnight to midnight in the owner's zone, the deployment's when
		// none is kept
		const midnight = wallTimeIn(`${value}T00:00:00`, defaultZone);
		return midnight === null ? unreadable : { ok: true, time: midnight };
	}
	// A wall time, in the zone the invitation names: one the runtime does not know is no zone
	if (wallTimeIn(value, 'UTC') === null) return unreadable;
	if (typeof timezone !== 'string' || timezone.length === 0) {
		return { ok: false, reason: `${NOT_CHECKED}a time without offset and no time zone` };
	}
	const time = wallTimeIn(value, timezone);
	// The organizer wrote the zone: the reason, which the logs and the model read, never names it
	return time === null
		? { ok: false, reason: `${NOT_CHECKED}unknown time zone` }
		: { ok: true, time };
}

// The instant a start of the invitation names, read as its slot's is: null for one it cannot read
export function instantOfStart(
	start: string | null,
	timezone: string | null,
	defaultZone: string
): Date | null {
	const time = timeOf(start, timezone, defaultZone, 'start');
	return time.ok ? new Date(time.time) : null;
}

// The invitation's own period, as read_freebusy takes it, or why it is not asked: the contract
// refuses a time without offset, a period that ends before it starts and one over 31 days, so
// none of those is ever sent, and no length is guessed for an event without an end
export function invitationSlot(
	times: Pick<Invitation, 'start' | 'end' | 'timezone'>,
	defaultZone: string
): InvitationSlot {
	const start = timeOf(times.start, times.timezone, defaultZone, 'start');
	if (!start.ok) return start;
	const end = timeOf(times.end, times.timezone, defaultZone, 'end');
	if (!end.ok) return end;
	const from = Date.parse(start.time);
	const to = Date.parse(end.time);
	if (to <= from) {
		return { ok: false, reason: `${NOT_CHECKED}the invitation ends before it starts` };
	}
	if (to - from > LONGEST_PERIOD_MS) {
		return { ok: false, reason: `${NOT_CHECKED}the invitation lasts over 31 days` };
	}
	return { ok: true, start: start.time, end: end.time };
}

// Runs a tool of the turn by its name, through the same path as the model's own calls and with
// the same context, or tells that the catalog has no such tool
export type ToolRunner = (
	name: string,
	args: Readonly<Record<string, unknown>>
) => Promise<ToolOutcome | null>;

const READ_FREEBUSY = 'read_freebusy';

function statusOf(outcome: ToolOutcome): number | null {
	const result = outcome.result;
	if (typeof result !== 'object' || result === null || !('status' in result)) return null;
	return typeof result.status === 'number' ? result.status : null;
}

function isSuccess(status: number | null): status is number {
	return status !== null && status >= 200 && status < 300;
}

// What the calendar answered of an invitation's slot, as the model reads it
const CALENDAR_DATA = 'calendar-data';

export interface AvailabilityCheck {
	// What the calendar answered, fenced as data, for the message the model reads
	readonly data: string;
	// For the logs, never the content: how the read ended, and why the slot went unchecked
	readonly freeBusyStatus: number | null;
	readonly reason: string | null;
}

// Before the model speaks about an invitation, the harness checks its owner's availability over its
// slot itself, from the times its wake-up carries, through the same contract and in the same
// context as the model would: whether the owner is free is the heart of the proposal, so it does
// not depend on the model choosing to call a tool. What came back is handed to the model as data,
// an error too; a read that waits for its owner, such as one the platform's broker refused, leaves
// the owner to the harness's own question.
export async function checkAvailability(
	run: ToolRunner,
	invitation: Invitation,
	options: { readonly timeZone: string }
): Promise<AvailabilityCheck> {
	const unchecked = (reason: string): AvailabilityCheck => ({
		data: fenced(CALENDAR_DATA, { tool: READ_FREEBUSY, not_called: reason }),
		freeBusyStatus: null,
		reason
	});
	const slot = invitationSlot(invitation, options.timeZone);
	if (!slot.ok) return unchecked(slot.reason);
	// The invitation is already in the owner's calendar: left out, it does not count against itself
	const args = { start: slot.start, end: slot.end, exclude: [invitation.uid] };
	let outcome: ToolOutcome | null;
	try {
		outcome = await run(READ_FREEBUSY, args);
	} catch (err: unknown) {
		// A read that throws becomes data too: the turn goes on and the model says it could not check
		const message = err instanceof Error ? err.message : String(err);
		outcome = { result: { error: `the call failed: ${message}` } };
	}
	if (outcome === null) {
		return unchecked(
			'availability not checked: the calendar contract read_freebusy is not available'
		);
	}
	const freeBusyStatus = statusOf(outcome);
	return {
		data: fenced(CALENDAR_DATA, { tool: READ_FREEBUSY, arguments: args, result: outcome.result }),
		freeBusyStatus,
		reason: isSuccess(freeBusyStatus) ? null : 'availability not checked: the free/busy read failed'
	};
}
