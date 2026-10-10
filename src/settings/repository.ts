import { findTimeZone, type TimeZone, type Weekday } from '../agent/clock.js';
import type { Tx } from '../db/client.js';

// The zone of the owner's calendar, as a calendar read last returned it; null before any did
export async function findOwnerTimeZone(tx: Tx, owner: string): Promise<TimeZone | null> {
	return (await findOwnerSettings(tx, owner)).timeZone;
}

// Keeps the zone a calendar read returned, in place of the one before
export async function saveOwnerTimeZone(tx: Tx, owner: string, timeZone: TimeZone): Promise<void> {
	await tx.sql`
		insert into owner_settings (owner, time_zone) values (${owner}, ${timeZone})
		on conflict (owner) do update set time_zone = excluded.time_zone`;
}

// What an owner chose of their morning brief, null where they kept the default
export interface BriefChoices {
	// The time it is due, in minutes after midnight on their wall clock, on the quarter hour
	readonly time: number | null;
	// The days of the week it goes out, in the order of the week, one at least
	readonly days: readonly Weekday[] | null;
	// The date it goes out again after a pause, as dateIn gives it; none before it
	readonly pausedUntil: string | null;
	// Whether they stopped it, until they resume it
	readonly stopped: boolean;
}

// What an owner chose of their quiet hours, null where they kept the deployment's
export interface QuietChoices {
	// Their daily range, in minutes after midnight on their wall clock, on the quarter hour, which
	// crosses midnight when it ends before it starts: both null or neither, the same minute for both
	// when they have none
	readonly start: number | null;
	readonly end: number | null;
	// Their whole quiet days, in the order of the week, none when empty
	readonly days: readonly Weekday[] | null;
}

// An owner's settings: the zone of their calendar, null before a read of it named one, and what
// they chose of their brief and of their quiet hours
export interface OwnerSettings {
	readonly timeZone: TimeZone | null;
	readonly brief: BriefChoices;
	readonly quiet: QuietChoices;
}

interface OwnerSettingsRow {
	readonly time_zone: string | null;
	readonly brief_time: number | null;
	readonly brief_days: Weekday[] | null;
	readonly brief_paused_until: string | null;
	readonly brief_stopped: boolean;
	readonly quiet_start: number | null;
	readonly quiet_end: number | null;
	readonly quiet_days: Weekday[] | null;
}

export async function findOwnerSettings(tx: Tx, owner: string): Promise<OwnerSettings> {
	const rows = await tx.sql<OwnerSettingsRow[]>`
		select time_zone, brief_time, brief_days, brief_paused_until::text as brief_paused_until,
			brief_stopped, quiet_start, quiet_end, quiet_days
		from owner_settings where owner = ${owner}`;
	const row = rows[0];
	const zone = row?.time_zone ?? null;
	return {
		// A zone the runtime no longer knows falls back to the deployment's, as if none were kept
		timeZone: zone === null ? null : findTimeZone(zone),
		brief: {
			time: row?.brief_time ?? null,
			days: row?.brief_days ?? null,
			pausedUntil: row?.brief_paused_until ?? null,
			stopped: row?.brief_stopped ?? false
		},
		quiet: {
			start: row?.quiet_start ?? null,
			end: row?.quiet_end ?? null,
			days: row?.quiet_days ?? null
		}
	};
}

// Keeps what an owner chose of their quiet hours, in place of what they chose before, the rest of
// their settings kept
export async function saveQuietChoices(tx: Tx, owner: string, quiet: QuietChoices): Promise<void> {
	const days = quiet.days === null ? null : [...quiet.days];
	await tx.sql`
		insert into owner_settings (owner, quiet_start, quiet_end, quiet_days)
		values (${owner}, ${quiet.start}, ${quiet.end}, ${days})
		on conflict (owner) do update set
			quiet_start = excluded.quiet_start,
			quiet_end = excluded.quiet_end,
			quiet_days = excluded.quiet_days`;
}

// Keeps what an owner chose of their brief, in place of what they chose before, their zone kept
export async function saveBriefChoices(tx: Tx, owner: string, brief: BriefChoices): Promise<void> {
	const days = brief.days === null ? null : [...brief.days];
	await tx.sql`
		insert into owner_settings (owner, brief_time, brief_days, brief_paused_until, brief_stopped)
		values (${owner}, ${brief.time}, ${days}, ${brief.pausedUntil}, ${brief.stopped})
		on conflict (owner) do update set
			brief_time = excluded.brief_time,
			brief_days = excluded.brief_days,
			brief_paused_until = excluded.brief_paused_until,
			brief_stopped = excluded.brief_stopped`;
}

// The instant an owner's last brief read their mail; null until a brief did
export async function findBriefMailsReadAt(tx: Tx, owner: string): Promise<Date | null> {
	const rows = await tx.sql<{ brief_mails_read_at: Date | null }[]>`
		select brief_mails_read_at from owner_settings where owner = ${owner}`;
	return rows[0]?.brief_mails_read_at ?? null;
}

// Keeps the instant a brief read an owner's mail, in place of the one before, the rest kept
export async function saveBriefMailsReadAt(tx: Tx, owner: string, at: Date): Promise<void> {
	await tx.sql`
		insert into owner_settings (owner, brief_mails_read_at) values (${owner}, ${at})
		on conflict (owner) do update set brief_mails_read_at = excluded.brief_mails_read_at`;
}

// The instant an owner's last brief read the shares made to them; null until a brief did
export async function findBriefSharesReadAt(tx: Tx, owner: string): Promise<Date | null> {
	const rows = await tx.sql<{ brief_shares_read_at: Date | null }[]>`
		select brief_shares_read_at from owner_settings where owner = ${owner}`;
	return rows[0]?.brief_shares_read_at ?? null;
}

// Keeps the instant a brief read the shares made to an owner, in place of the one before, the rest
// kept
export async function saveBriefSharesReadAt(tx: Tx, owner: string, at: Date): Promise<void> {
	await tx.sql`
		insert into owner_settings (owner, brief_shares_read_at) values (${owner}, ${at})
		on conflict (owner) do update set brief_shares_read_at = excluded.brief_shares_read_at`;
}
