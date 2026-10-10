import { dayAfter, instantIn, isoIn } from '../agent/clock.js';

// A span of the owner's calendar, as the contracts read and write it
export interface Slot {
	readonly start: Date;
	readonly end: Date;
}

// What a listened conversation asked for, read from the model's one harness tool and kept as
// absolute instants in the owner's zone
export interface Asked {
	// The requested day, as dateIn writes it
	readonly day: string;
	// The last day of the requested period, inclusive, or null for the day alone
	readonly until: string | null;
	// The asked time, minutes after midnight, or null when none was said
	readonly minutes: number | null;
	readonly durationMs: number;
}

// What the code reads to build the candidates: the owner's own free/busy over one slot, and the
// owner's free slots over a window, both with the owner's address alone, never the invitee's
export interface SlotReaders {
	ownerFree(window: Slot): Promise<boolean>;
	ownerSlots(window: Slot): Promise<readonly Slot[]>;
}

// The most candidates a suggestion keeps, and how far it looks for them
const MAX_SLOTS = 5;
const HORIZON_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
// Never a candidate closer to now than this
const NOT_BEFORE_MS = 60 * 60 * 1000;

const midnight = (day: string, timeZone: string): Date => instantIn(day, 0, timeZone);

// The candidates in the order a suggestion tries them, the first one it proposes: the asked time
// first when it is still to come and the owner is free there, even outside working hours, then the
// owner's own free slots, the requested day nearest the asked time first, before or after alike and
// the earlier one on a tie, then the following days in order, from the start of the day when no time
// was said, and never closer than an hour to now
export async function candidateSlots(
	asked: Asked,
	now: Date,
	timeZone: string,
	readers: SlotReaders
): Promise<readonly Slot[]> {
	const floor = now.getTime() + NOT_BEFORE_MS;
	const periodEnd =
		asked.until === null
			? midnight(dayAfter(asked.day), timeZone)
			: midnight(dayAfter(asked.until), timeZone);
	const search: Slot = {
		start: midnight(asked.day, timeZone),
		end: new Date(midnight(asked.day, timeZone).getTime() + HORIZON_DAYS * DAY_MS)
	};
	const askedAt =
		asked.minutes === null ? null : instantIn(asked.day, asked.minutes, timeZone).getTime();
	let first: Slot | null = null;
	if (askedAt !== null) {
		const slot = { start: new Date(askedAt), end: new Date(askedAt + asked.durationMs) };
		if (askedAt > now.getTime() && (await readers.ownerFree(slot))) first = slot;
	}
	const found = (await readers.ownerSlots(search))
		.filter((slot) => slot.start.getTime() >= floor)
		.filter((slot) => first === null || slot.start.getTime() !== first.start.getTime());
	const within = found.filter((slot) => slot.start.getTime() < periodEnd.getTime());
	const after = found.filter((slot) => slot.start.getTime() >= periodEnd.getTime());
	const byDistance = (a: Slot, b: Slot): number =>
		askedAt === null
			? a.start.getTime() - b.start.getTime()
			: Math.abs(a.start.getTime() - askedAt) - Math.abs(b.start.getTime() - askedAt) ||
				a.start.getTime() - b.start.getTime();
	within.sort(byDistance);
	after.sort((a, b) => a.start.getTime() - b.start.getTime());
	return [...(first === null ? [] : [first]), ...within, ...after].slice(0, MAX_SLOTS);
}

// The candidate a suggestion proposes: the first of them, or null when there is none
export function firstCandidate(candidates: readonly Slot[]): Slot | null {
	return candidates[0] ?? null;
}

// The two instants of a candidate as the arguments of a create_meeting call, in the owner's zone
export function slotArguments(slot: Slot, timeZone: string): { start: string; end: string } {
	return { start: isoIn(slot.start, timeZone), end: isoIn(slot.end, timeZone) };
}
