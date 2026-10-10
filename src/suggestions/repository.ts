import type { Tx } from '../db/client.js';

// A member's own switch and the rooms they get nothing from: in force while the mute has no end or
// has not reached it
export interface SuggestionSettings {
	readonly enabled: boolean;
	readonly mutedRooms: readonly string[];
}

export async function readSettings(tx: Tx, owner: string): Promise<SuggestionSettings> {
	const settings = await tx.sql<{ enabled: boolean }[]>`
		select enabled from suggestion_settings where owner = ${owner}`;
	const muted = await tx.sql<{ room_id: string }[]>`
		select room_id from suggestion_mutes
		where owner = ${owner} and (until is null or until > now()) order by room_id`;
	return { enabled: settings[0]?.enabled ?? true, mutedRooms: muted.map((row) => row.room_id) };
}

// Turns the switch alone, the rooms muted left as they are
export async function writeEnabled(tx: Tx, owner: string, enabled: boolean): Promise<void> {
	await tx.sql`
		insert into suggestion_settings (owner, enabled) values (${owner}, ${enabled})
		on conflict (owner) do update set enabled = excluded.enabled`;
}

// Replaces the switch and the rooms muted for good; a mute with an end, from a refusal, stays
export async function writeSettings(
	tx: Tx,
	owner: string,
	settings: SuggestionSettings
): Promise<void> {
	await tx.sql`
		insert into suggestion_settings (owner, enabled) values (${owner}, ${settings.enabled})
		on conflict (owner) do update set enabled = excluded.enabled`;
	await tx.sql`delete from suggestion_mutes where owner = ${owner} and until is null`;
	for (const roomId of new Set(settings.mutedRooms)) {
		await tx.sql`
			insert into suggestion_mutes (owner, room_id, until) values (${owner}, ${roomId}, null)
			on conflict (owner, room_id) do update set until = null`;
	}
}

// A refusal as not useful mutes the room for a while, unless it is muted for good already
export async function muteRoomFor(
	tx: Tx,
	owner: string,
	roomId: string,
	ms: number
): Promise<void> {
	await tx.sql`
		insert into suggestion_mutes (owner, room_id, until)
		values (${owner}, ${roomId}, now() + make_interval(secs => ${ms / 1000}))
		on conflict (owner, room_id) do update
			set until = case when suggestion_mutes.until is null then null else excluded.until end`;
}

// The owner an assistant reads this encrypted conversation for, or null: a suggestion made there,
// and its second try at another time, search the owner's calendar alone and never the invitee's.
export async function listenedRoomOwner(tx: Tx, roomId: string): Promise<string | null> {
	const rows = await tx.sql<{ owner: string }[]>`
		select owner from assistant_listened_rooms where room_id = ${roomId}`;
	return rows[0]?.owner ?? null;
}

export interface SuggestionRecord {
	readonly pendingCallId: string;
	readonly roomId: string;
	readonly startsAt: Date;
	readonly endsAt: Date;
	readonly attempt: number;
}

export async function recordSuggestion(
	tx: Tx,
	owner: string,
	suggestion: SuggestionRecord
): Promise<void> {
	await tx.sql`
		insert into suggestions (pending_call_id, owner, room_id, starts_at, ends_at, attempt)
		values (${suggestion.pendingCallId}, ${owner}, ${suggestion.roomId}, ${suggestion.startsAt},
			${suggestion.endsAt}, ${suggestion.attempt})`;
}

export async function findSuggestion(
	tx: Tx,
	owner: string,
	pendingCallId: string
): Promise<SuggestionRecord | null> {
	const rows = await tx.sql<
		{ room_id: string; starts_at: Date; ends_at: Date; attempt: number }[]
	>`select room_id, starts_at, ends_at, attempt from suggestions
		where owner = ${owner} and pending_call_id = ${pendingCallId}`;
	const row = rows[0];
	return row === undefined
		? null
		: {
				pendingCallId,
				roomId: row.room_id,
				startsAt: row.starts_at,
				endsAt: row.ends_at,
				attempt: row.attempt
			};
}

// The arguments of a call still waiting, before a refusal erases them
export async function readCallArguments(tx: Tx, owner: string, id: string): Promise<unknown> {
	const rows = await tx.sql<{ arguments: unknown }[]>`
		select arguments from pending_calls where owner = ${owner} and id = ${id}`;
	return rows[0]?.arguments ?? null;
}

export const DAILY_CAP = 3;
export const ROOM_WINDOW_MS = 12 * 60 * 60 * 1000;
export const DAY_MS = 24 * 60 * 60 * 1000;

export type Skip = 'opted_out' | 'room_muted' | 'daily_cap' | 'room_window';

// Whether a member may be given a suggestion from this room now: the switch, the mutes and the
// caps, which count the suggestions made in a rolling day and, per room, in twelve hours. A second
// try at another time counts for neither: it answers a suggestion already counted.
export async function mayReceive(
	tx: Tx,
	owner: string,
	roomId: string,
	attempt: number
): Promise<Skip | null> {
	const settings = await readSettings(tx, owner);
	if (!settings.enabled) return 'opted_out';
	if (settings.mutedRooms.includes(roomId)) return 'room_muted';
	if (attempt > 0) return null;
	const day = await tx.sql<{ n: string }[]>`
		select count(*) as n from suggestions
		where owner = ${owner} and attempt = 0 and created_at > now() - make_interval(secs => ${DAY_MS / 1000})`;
	if (Number(day[0]?.n ?? 0) >= DAILY_CAP) return 'daily_cap';
	const room = await tx.sql<{ n: string }[]>`
		select count(*) as n from suggestions
		where owner = ${owner} and room_id = ${roomId} and attempt = 0
			and created_at > now() - make_interval(secs => ${ROOM_WINDOW_MS / 1000})`;
	return Number(room[0]?.n ?? 0) > 0 ? 'room_window' : null;
}
