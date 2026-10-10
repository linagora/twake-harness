import type { WakeOutcome } from './wake.js';

// What came of a message: what came of its recipients, or its dead lettering
export type MessageOutcome = WakeOutcome | 'dead_lettered';

// What came of one recipient: a wake-up's outcome, or invalid for a recipient named in a shape
// the listener cannot read, which it skips
export type RecipientOutcome = WakeOutcome | 'invalid';

// How many of a message's recipients had each outcome
export type RecipientOutcomes = Readonly<Partial<Record<RecipientOutcome, number>>>;

// The outcome of a message is the first of these that one of its recipients had, the one the
// operator most needs to see; a recipient that cannot be read counts as ignored. Every outcome of
// a wake-up has its place here, and a new one compiles once it has: one that holds back a turn
// due, such as a cap on an owner's wake-ups, comes right after woken, then one an owner's quiet
// hours hold, and one kept for the brief after it. One an owner chose, such as an application
// their assistant does not listen to, comes after a duplicate, before what no owner chose.
const PRECEDENCE: Readonly<Record<WakeOutcome, number>> = {
	woken: 0,
	capped: 1,
	quiet_hours: 2,
	for_brief: 3,
	duplicate: 4,
	unlistened: 5,
	no_assistant: 6,
	ignored: 7
};

// The outcome of a message from those of its recipients, ignored when it names nobody, and how
// many had each
export function outcomeOf(recipients: readonly RecipientOutcome[]): {
	readonly outcome: WakeOutcome;
	readonly outcomes: RecipientOutcomes;
} {
	const outcomes: Partial<Record<RecipientOutcome, number>> = {};
	let outcome: WakeOutcome = 'ignored';
	for (const recipient of recipients) {
		outcomes[recipient] = (outcomes[recipient] ?? 0) + 1;
		const counted = recipient === 'invalid' ? 'ignored' : recipient;
		if (PRECEDENCE[counted] < PRECEDENCE[outcome]) outcome = counted;
	}
	return { outcome, outcomes };
}
