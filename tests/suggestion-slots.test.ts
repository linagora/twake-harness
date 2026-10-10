import { describe, expect, it } from 'vitest';

import { candidateSlots, firstCandidate, type Asked, type Slot } from '../src/suggestions/slots.js';

const PARIS = 'Europe/Paris';
const MINUTES = (h: number, m = 0): number => h * 60 + m;
const at = (iso: string): Date => new Date(iso);

// What the owner's calendar answers, as the two readers a suggestion builds on it: a fixed set of
// free slots, and whether the owner is free over one slot of their own
function readers(free: readonly Slot[], freeWindows: readonly Slot[] = free) {
	return {
		ownerSlots: async (window: Slot): Promise<readonly Slot[]> =>
			free.filter((slot) => slot.start >= window.start && slot.start < window.end),
		ownerFree: async (window: Slot): Promise<boolean> =>
			freeWindows.some((slot) => slot.start <= window.start && slot.end >= window.end)
	};
}

// Monday 12 October 2026, and the days after it, in Paris
const MONDAY = '2026-10-12';
const now = at('2026-10-12T06:00:00+02:00');

function asked(overrides: Partial<Asked> = {}): Asked {
	return { day: MONDAY, until: null, minutes: null, durationMs: 30 * 60 * 1000, ...overrides };
}

const slot = (startIso: string, minutes = 30): Slot => ({
	start: at(startIso),
	end: new Date(at(startIso).getTime() + minutes * 60 * 1000)
});

describe('the candidate slots a suggestion tries', () => {
	it('takes the asked time first when it is still to come and the owner is free there, even at 8h', async () => {
		const eight = slot('2026-10-12T08:00:00+02:00');
		const found = await candidateSlots(
			asked({ minutes: MINUTES(8) }),
			now,
			PARIS,
			readers([slot('2026-10-12T09:00:00+02:00')], [eight])
		);
		expect(found[0]).toEqual(eight);
	});

	it('is at the asked time even on a Saturday', async () => {
		const saturday = slot('2026-10-17T10:00:00+02:00');
		const found = await candidateSlots(
			asked({ day: '2026-10-17', minutes: MINUTES(10) }),
			now,
			PARIS,
			readers([], [saturday])
		);
		expect(firstCandidate(found)).toEqual(saturday);
	});

	it('takes the nearest free slot when the owner is busy at the asked time, never closer than an hour to now', async () => {
		const before = slot('2026-10-12T06:30:00+02:00');
		const after = slot('2026-10-12T09:00:00+02:00');
		const found = await candidateSlots(
			asked({ minutes: MINUTES(8) }),
			now,
			PARIS,
			readers([before, after], [])
		);
		expect(firstCandidate(found)).toEqual(after);
	});

	it('without an asked time, starts from the beginning of the requested day', async () => {
		const morning = slot('2026-10-12T07:00:00+02:00');
		const later = slot('2026-10-12T09:00:00+02:00');
		const found = await candidateSlots(asked(), now, PARIS, readers([later, morning]));
		expect(firstCandidate(found)).toEqual(morning);
	});

	it('keeps at most five candidates', async () => {
		const many = Array.from({ length: 8 }, (_, i) =>
			slot(`2026-10-12T${String(i + 8).padStart(2, '0')}:00:00+02:00`)
		);
		const found = await candidateSlots(asked(), now, PARIS, readers(many));
		expect(found).toHaveLength(5);
	});
});
