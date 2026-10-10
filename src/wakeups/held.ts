import { dateIn, instantIn } from '../agent/clock.js';
import { BRIEF_WINDOW_MINUTES, isBriefDate, type BriefSettings } from '../briefs/settings.js';
import { readJsonColumn, type Tx } from '../db/client.js';
import type { Activity } from '../journal/repository.js';
import { quietEndAfter, type QuietHours } from '../quiet/hours.js';
import type { Wakeup } from './wake.js';

// When an activity that reaches its owner during their quiet hours comes out of them: at their
// brief, when it goes out on the day those hours end, which names it, or else at their end. A
// meeting that starts before that point cannot wait for it. Should that brief not go out, the
// worker role's scheduler wakes them for the activity once its window closed.
export interface QuietExit {
	readonly at: Date;
	readonly releaseAt: Date;
}

// When an activity that reaches an owner at an instant comes out of their quiet hours, on the wall
// clock of their zone, with their brief as it stands, none when the briefs are off; null for an
// instant out of those hours
export function quietExitOf(
	hours: QuietHours,
	timeZone: string,
	brief: BriefSettings | null,
	now: Date
): QuietExit | null {
	const end = quietEndAfter(hours, timeZone, now);
	if (end === null) return null;
	const day = dateIn(end, timeZone);
	if (brief !== null && isBriefDate(brief, day)) {
		const at = instantIn(day, brief.time, timeZone);
		if (at > now) {
			return { at, releaseAt: new Date(at.getTime() + BRIEF_WINDOW_MINUTES * 60_000) };
		}
	}
	return { at: end, releaseAt: end };
}

// Holds an activity for its owner until its release, with the wake-up its turn will need, as its
// listener cleaned it on arrival, in the transaction given under their principal
export async function holdActivity(
	tx: Tx,
	owner: string,
	wakeup: Wakeup,
	heldAt: Date,
	releaseAt: Date
): Promise<void> {
	await tx.sql`
		insert into held_activities (owner, source, event_id, held_at, release_at, wakeup)
		values (
			${owner}, ${wakeup.source}, ${wakeup.id}, ${heldAt}, ${releaseAt},
			${JSON.stringify(wakeup)}::jsonb
		)
		on conflict do nothing`;
}

// Whether the owner has an activity held whose release came, the one thing most passes ask
export async function hasReleasedActivities(tx: Tx, owner: string, now: Date): Promise<boolean> {
	const rows = await tx.sql`
		select 1 from held_activities where owner = ${owner} and release_at <= ${now} limit 1`;
	return rows.length > 0;
}

// The wake-ups of the owner's held activities whose release came, the first due first, then the
// first held, as many as given at most
export async function listReleasedActivities(
	tx: Tx,
	owner: string,
	now: Date,
	limit: number
): Promise<Wakeup[]> {
	if (limit <= 0) return [];
	const rows = await tx.sql<{ wakeup: unknown }[]>`
		select wakeup from held_activities
		where owner = ${owner} and release_at <= ${now}
		order by release_at, held_at, source, event_id
		limit ${limit}`;
	// Only holdActivity writes them, from a wake-up
	return rows.map((row) => readJsonColumn(row.wakeup) as Wakeup);
}

// Ends the hold of the owner's activities a brief named, or that their release woke them for
export async function eraseHeldActivities(
	tx: Tx,
	owner: string,
	activities: readonly Pick<Activity, 'source' | 'eventId'>[]
): Promise<void> {
	for (const { source, eventId } of activities) {
		await tx.sql`
			delete from held_activities
			where owner = ${owner} and source = ${source} and event_id = ${eventId}`;
	}
}
