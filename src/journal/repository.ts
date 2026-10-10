import { readJsonColumn, type Tx } from '../db/client.js';
import { isRecord } from '../matrix/json.js';

// What came of an activity a source published for an owner: woken until the turn it woke ends,
// then suggested once that turn answered, nothing_useful once it ended on no words, abandoned once
// it waited too long for admission, share_spent once admission refused it as the owner's day, or
// the share of it their assistant spends on its own, was spent, failed otherwise; capped when the
// owner's hourly cap held it back, and for_brief when it called for no word at once, such as a task
// they assigned themselves, both with no turn; quiet_hours when it reached them during their quiet
// hours, until it wakes them as they end, woken then, unless their brief names it first
export type ActivityOutcome =
	| 'woken'
	| 'suggested'
	| 'nothing_useful'
	| 'abandoned'
	| 'share_spent'
	| 'failed'
	| 'capped'
	| 'for_brief'
	| 'quiet_hours';

// The outcomes the turn an activity woke ends on
export type WokenTurnOutcome = Exclude<
	ActivityOutcome,
	'woken' | 'capped' | 'for_brief' | 'quiet_hours'
>;

// Something as the model is shown it: what its source computed, apart from what people wrote,
// which is data, never instructions
export interface Shown {
	readonly computed: Readonly<Record<string, unknown>>;
	readonly untrusted: Readonly<Record<string, unknown>>;
}

// What the journal keeps of an activity beyond its source, type and id: what identifies it to act
// on it, such as the UID of a meeting or the id of a task, and what shows it, such as the title and
// the times of a meeting or the title of a task. Never the text of a message, nor the place or the
// description of a meeting.
export interface Noted {
	readonly ids: Shown;
	readonly names: Shown;
}

export const NOTHING_SHOWN: Shown = { computed: {}, untrusted: {} };

// An activity of an owner's journal
export interface Activity {
	readonly source: string;
	readonly eventId: string;
	readonly type: string;
	readonly receivedAt: Date;
	readonly outcome: ActivityOutcome;
	readonly ids: Shown;
	// Null once erased
	readonly names: Shown | null;
}

interface ActivityRow {
	source: string;
	event_id: string;
	type: string;
	received_at: Date;
	outcome: ActivityOutcome;
	ids: unknown;
	names: unknown;
}

function shownOf(value: unknown): Shown {
	const read = readJsonColumn(value);
	if (!isRecord(read)) return NOTHING_SHOWN;
	const { computed, untrusted } = read;
	return {
		computed: isRecord(computed) ? computed : {},
		untrusted: isRecord(untrusted) ? untrusted : {}
	};
}

function activityOf(row: ActivityRow): Activity {
	return {
		source: row.source,
		eventId: row.event_id,
		type: row.type,
		receivedAt: row.received_at,
		outcome: row.outcome,
		ids: shownOf(row.ids),
		names: row.names === null ? null : shownOf(row.names)
	};
}

// Notes an activity in its owner's journal, in the transaction given under their principal. The
// owner joins the index of the principals, whose journal the worker role's purge walks.
export async function noteActivity(
	tx: Tx,
	owner: string,
	activity: Omit<Activity, 'ids' | 'names'> & { readonly noted: Noted }
): Promise<void> {
	const { source, eventId, type, receivedAt, outcome, noted } = activity;
	await tx.sql`insert into principal_index (owner) values (${owner}) on conflict do nothing`;
	await tx.sql`
		insert into listening_journal (owner, source, event_id, type, received_at, outcome, ids, names)
		values (
			${owner}, ${source}, ${eventId}, ${type}, ${receivedAt}, ${outcome},
			${JSON.stringify(noted.ids)}::jsonb, ${JSON.stringify(noted.names)}::jsonb
		)`;
}

// Whether the owner's journal noted that activity, which then wakes them no more, whether it woke
// them or their cap held it back
export async function wasNoted(
	tx: Tx,
	owner: string,
	source: string,
	eventId: string
): Promise<boolean> {
	const rows = await tx.sql`
		select 1 from listening_journal
		where owner = ${owner} and source = ${source} and event_id = ${eventId}`;
	return rows.length > 0;
}

// Sets what came of an activity once the turn it woke ended, if that turn is still to end: false
// for an activity the journal does not hold as woken, such as an event posted to the API
export async function settleActivity(
	tx: Tx,
	owner: string,
	source: string,
	eventId: string,
	outcome: WokenTurnOutcome
): Promise<boolean> {
	const rows = await tx.sql`
		update listening_journal set outcome = ${outcome}
		where owner = ${owner} and source = ${source} and event_id = ${eventId} and outcome = 'woken'
		returning 1`;
	return rows.length > 0;
}

// Sets an activity the owner's quiet hours held as woken, once it wakes them as they end: the turn
// it wakes settles what came of it
export async function noteReleased(
	tx: Tx,
	owner: string,
	source: string,
	eventId: string
): Promise<void> {
	await tx.sql`
		update listening_journal set outcome = 'woken'
		where owner = ${owner} and source = ${source} and event_id = ${eventId}
			and outcome = 'quiet_hours'`;
}

// The owner's activities received from a given instant on, in the order they arrived
export async function listActivitiesSince(tx: Tx, owner: string, since: Date): Promise<Activity[]> {
	const rows = await tx.sql<ActivityRow[]>`
		select source, event_id, type, received_at, outcome, ids, names from listening_journal
		where owner = ${owner} and received_at >= ${since}
		order by received_at, source, event_id`;
	return rows.map(activityOf);
}

// What came of the activities that had no turn, which the owner's next brief names: those their
// hourly cap held back, those that waited too long for admission or that admission refused once
// their assistant's share of the day was spent, those kept for their brief, and those their quiet
// hours hold
const UNTOLD_OUTCOMES: readonly ActivityOutcome[] = [
	'capped',
	'abandoned',
	'share_spent',
	'for_brief',
	'quiet_hours'
];

// The owner's activities published under the sources given that had no turn and that no brief named
// yet, nor the purge erased the names of, in the order they arrived, the first ones given
export async function listUntoldActivities(
	tx: Tx,
	owner: string,
	sources: readonly string[],
	limit: number
): Promise<Activity[]> {
	if (sources.length === 0) return [];
	const rows = await tx.sql<ActivityRow[]>`
		select source, event_id, type, received_at, outcome, ids, names from listening_journal
		where owner = ${owner} and source in ${tx.sql([...sources])}
			and outcome in ${tx.sql([...UNTOLD_OUTCOMES])} and names is not null
		order by received_at, source, event_id
		limit ${limit}`;
	return rows.map(activityOf);
}

// Erases the names of the owner's activities a brief named, once it went out
export async function eraseActivityNames(
	tx: Tx,
	owner: string,
	activities: readonly Pick<Activity, 'source' | 'eventId'>[]
): Promise<void> {
	for (const { source, eventId } of activities) {
		await tx.sql`
			update listening_journal set names = null
			where owner = ${owner} and source = ${source} and event_id = ${eventId}`;
	}
}

// How many activities a purge erased the names of, and how many it deleted
export interface Purged {
	readonly erased: number;
	readonly purged: number;
}

// Erases the names of the owner's activities received before an instant, and deletes those
// received before another
export async function purgeActivities(
	tx: Tx,
	owner: string,
	before: { readonly names: Date; readonly rows: Date }
): Promise<Purged> {
	const purged = await tx.sql`
		delete from listening_journal where owner = ${owner} and received_at < ${before.rows}`;
	const erased = await tx.sql`
		update listening_journal set names = null
		where owner = ${owner} and received_at < ${before.names} and names is not null`;
	return { erased: erased.count, purged: purged.count };
}
