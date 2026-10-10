import { expireWaitingCall, hasConsent, type ClosedRequest } from '../consents/repository.js';
import type { Tx } from '../db/client.js';

// The applications an owner's brief reads, each allowed on its own at the read level
export const BRIEF_DOMAINS = ['calendar', 'mail', 'tasks'] as const;
export type BriefDomain = (typeof BRIEF_DOMAINS)[number];

export function isBriefDomain(value: unknown): value is BriefDomain {
	return BRIEF_DOMAINS.some((domain) => domain === value);
}

// What the question of an owner's first brief goes under among the calls that wait for their
// answer: its tool, its contract and its domain, which no application has. Its arguments name the
// reads it asks for.
export const BRIEF_QUESTION = 'brief';

// The reads of the brief the owner did not allow, in the order the question names them
export async function missingReads(tx: Tx, owner: string): Promise<BriefDomain[]> {
	const missing: BriefDomain[] = [];
	for (const domain of BRIEF_DOMAINS) {
		if (!(await hasConsent(tx, owner, domain, 'read'))) missing.push(domain);
	}
	return missing;
}

// The reads the question asked for, as its call's arguments name them
export function domainsAsked(args: unknown): BriefDomain[] {
	if (typeof args !== 'object' || args === null) return [];
	const { domains } = args as Record<string, unknown>;
	return Array.isArray(domains) ? domains.filter(isBriefDomain) : [];
}

// The question an owner's first brief asked in its place, for the reads they did not allow: the
// date of the brief it holds back, the call it froze, whose yes allows them and sends that brief,
// and how many times it was asked unanswered
export interface BriefQuestion {
	readonly date: string;
	readonly pendingCallId: string;
	readonly asked: number;
}

// The question the owner's brief waits for their answer to, if it does
export async function findBriefQuestion(tx: Tx, owner: string): Promise<BriefQuestion | null> {
	const rows = await tx.sql<{ brief_date: string; pending_call_id: string; asked: number }[]>`
		select brief_date::text as brief_date, pending_call_id, asked from brief_questions
		where owner = ${owner}`;
	const row = rows[0];
	return row === undefined
		? null
		: { date: row.brief_date, pendingCallId: row.pending_call_id, asked: row.asked };
}

// The brief waits for the owner's answer to this question, in place of the one it asked before
export async function keepBriefQuestion(
	tx: Tx,
	owner: string,
	question: BriefQuestion
): Promise<void> {
	await tx.sql`
		insert into brief_questions (owner, brief_date, pending_call_id, asked)
		values (${owner}, ${question.date}, ${question.pendingCallId}, ${question.asked})
		on conflict (owner) do update set brief_date = excluded.brief_date,
			pending_call_id = excluded.pending_call_id, asked = excluded.asked`;
}

// The brief waits for no answer any more, and its question closes as expired, should it still wait
// for one, so that a yes to it then runs nothing. Resolves to that question's request when it closed
// unanswered.
export async function endBriefQuestion(tx: Tx, owner: string): Promise<ClosedRequest | null> {
	const rows = await tx.sql<{ pending_call_id: string }[]>`
		delete from brief_questions where owner = ${owner} returning pending_call_id`;
	const ended = rows[0];
	return ended === undefined ? null : expireWaitingCall(tx, owner, ended.pending_call_id);
}

// The owner's answer to the question took it: it waits for nothing more. None when the call was not
// the question the brief waits for.
export async function takeBriefQuestion(
	tx: Tx,
	owner: string,
	pendingCallId: string
): Promise<BriefQuestion | null> {
	const rows = await tx.sql<{ brief_date: string; pending_call_id: string; asked: number }[]>`
		delete from brief_questions where owner = ${owner} and pending_call_id = ${pendingCallId}
		returning brief_date::text as brief_date, pending_call_id, asked`;
	const row = rows[0];
	return row === undefined
		? null
		: { date: row.brief_date, pendingCallId: row.pending_call_id, asked: row.asked };
}

// Where the owner's brief stands with its reads: whether it asks them no more, and the applications
// whose read they took back since, which it said once
export interface BriefReads {
	readonly settled: boolean;
	readonly told: readonly BriefDomain[];
}

export async function findBriefReads(tx: Tx, owner: string): Promise<BriefReads> {
	const rows = await tx.sql<{ brief_reads_settled: boolean; brief_reads_told: string[] }[]>`
		select brief_reads_settled, brief_reads_told from owner_settings where owner = ${owner}`;
	const row = rows[0];
	return {
		settled: row?.brief_reads_settled ?? false,
		told: (row?.brief_reads_told ?? []).filter(isBriefDomain)
	};
}

// The brief asks the owner no more for its reads, and has said once that they took back those given
export async function settleBriefReads(
	tx: Tx,
	owner: string,
	told: readonly BriefDomain[]
): Promise<void> {
	await tx.sql`
		insert into owner_settings (owner, brief_reads_settled, brief_reads_told)
		values (${owner}, true, ${[...told]})
		on conflict (owner) do update set brief_reads_settled = true,
			brief_reads_told = excluded.brief_reads_told`;
}

// The owner's brief is held back until they resume it, the question it waited for, if any, closed
// as expired. Resolves to that question's request when it closed unanswered.
export async function stopBrief(tx: Tx, owner: string): Promise<ClosedRequest | null> {
	await tx.sql`
		insert into owner_settings (owner, brief_stopped) values (${owner}, true)
		on conflict (owner) do update set brief_stopped = true`;
	return endBriefQuestion(tx, owner);
}

// The owner said no to the question their first brief asked: it stops, until they resume it, and
// asks again then. False when the call was not that question, which then changes nothing.
export async function refuseBriefQuestion(
	tx: Tx,
	owner: string,
	pendingCallId: string
): Promise<boolean> {
	if ((await takeBriefQuestion(tx, owner, pendingCallId)) === null) return false;
	await stopBrief(tx, owner);
	return true;
}
