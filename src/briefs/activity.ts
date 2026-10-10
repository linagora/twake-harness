import { dateIn, weekdayOf } from '../agent/clock.js';
import type { Tx } from '../db/client.js';

// How many working days, Monday to Friday, the owner may go unseen in their assistant's room before
// their brief stops: a brief nobody reads is of no use
const IDLE_WORKING_DAYS = 10;

// The owner was seen at that instant in a room of their assistant: a message of theirs there, or a
// read receipt. It counts only in the room their brief goes to, and only when later than the
// instant kept. Resolves to whether it counted.
export async function noteOwnerSeen(
	tx: Tx,
	owner: string,
	roomId: string,
	at: Date
): Promise<boolean> {
	const rows = await tx.sql`
		insert into owner_settings (owner, owner_seen_at)
		select owner, ${at} from assistants
		where owner = ${owner} and room_id = ${roomId} and deleted_at is null
		on conflict (owner) do update set
			owner_seen_at = greatest(owner_settings.owner_seen_at, excluded.owner_seen_at)
		returning owner`;
	return rows.length > 0;
}

// When the owner was last seen in their assistant's room, or, before anyone saw them there, the
// instant given, kept from then on: their first brief that looks starts the count
export async function ownerSeenSince(tx: Tx, owner: string, now: Date): Promise<Date> {
	const rows = await tx.sql<{ owner_seen_at: Date }[]>`
		insert into owner_settings (owner, owner_seen_at) values (${owner}, ${now})
		on conflict (owner) do update set
			owner_seen_at = coalesce(owner_settings.owner_seen_at, excluded.owner_seen_at)
		returning owner_seen_at`;
	return rows[0]?.owner_seen_at ?? now;
}

// The day after a day as dateIn gives it
function dayAfter(date: string): string {
	return new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

// Whether ten working days went by between the day the owner was last seen, on the wall clock of
// their zone, and the brief's date, neither of them counted
export function isIdleOn(date: string, seenAt: Date, timeZone: string): boolean {
	let workingDays = 0;
	for (let day = dayAfter(dateIn(seenAt, timeZone)); day < date; day = dayAfter(day)) {
		const weekday = weekdayOf(day);
		if (weekday !== 'saturday' && weekday !== 'sunday') workingDays += 1;
		if (workingDays >= IDLE_WORKING_DAYS) return true;
	}
	return false;
}
