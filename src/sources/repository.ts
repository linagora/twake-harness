import type { Tx } from '../db/client.js';
import { LISTENABLE, LISTENED_BY_DEFAULT, type Source } from './sources.js';

// Whether the owner's assistant listens to a source: as they last chose, or by its default
export async function isListening(tx: Tx, owner: string, source: Source): Promise<boolean> {
	return (await listListened(tx, owner)).includes(source);
}

// Keeps the owner's choice for a source, in place of the one before
export async function saveListening(
	tx: Tx,
	owner: string,
	source: Source,
	listening: boolean
): Promise<void> {
	await tx.sql`
		insert into listened_sources (owner, source, listening)
		values (${owner}, ${source}, ${listening})
		on conflict (owner, source) do update set listening = excluded.listening`;
}

// Has the owner's assistant listen to a source, unless they chose for it already
export async function listenUnlessChosen(tx: Tx, owner: string, source: Source): Promise<void> {
	await tx.sql`
		insert into listened_sources (owner, source, listening)
		values (${owner}, ${source}, true)
		on conflict (owner, source) do nothing`;
}

// The listenable sources the owner's assistant listens to: those they chose to, and those they never
// chose for that it listens to by default
export async function listListened(tx: Tx, owner: string): Promise<Source[]> {
	const rows = await tx.sql<{ source: string; listening: boolean }[]>`
		select source, listening from listened_sources where owner = ${owner}`;
	const chosen = new Map(rows.map((row) => [row.source, row.listening]));
	return LISTENABLE.filter((source) => chosen.get(source) ?? LISTENED_BY_DEFAULT.includes(source));
}
