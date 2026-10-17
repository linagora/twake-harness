import { isStringArray, readJsonColumn, type Tx } from '../db/client.js';
import type { TurnOrigin } from '../agent/tools.js';
import type { YesNoQuestion } from '../matrix/questions.js';
import {
	clearAvailabilitySharingRefusal,
	refuseAvailabilitySharing
} from '../suggestions/sharing.js';
import {
	AVAILABILITY_DOMAIN,
	type ConsentLevel,
	type ConsentSource,
	type WaitReason
} from './consent.js';

export async function hasConsent(
	tx: Tx,
	owner: string,
	domain: string,
	level: ConsentLevel
): Promise<boolean> {
	const rows = await tx.sql`
		select 1 from consents where owner = ${owner} and domain = ${domain} and level = ${level}`;
	return rows.length > 0;
}

// Resolves to whether the owner had not allowed it yet: a consent already given keeps when and how
// it was given. Letting the assistant share their availability with colleagues, which the harness
// asks about like any application, erases the refusal they may have kept of that question.
export async function grantConsent(
	tx: Tx,
	owner: string,
	domain: string,
	level: ConsentLevel,
	source: ConsentSource
): Promise<boolean> {
	const result = await tx.sql`
		insert into consents (owner, domain, level, granted_by)
		values (${owner}, ${domain}, ${level}, ${source})
		on conflict do nothing`;
	if (domain === AVAILABILITY_DOMAIN) await clearAvailabilitySharingRefusal(tx, owner);
	return result.count === 1;
}

// What an owner's assistant may use: what the owner allowed, and when
export interface ConsentRecord {
	readonly domain: string;
	readonly level: ConsentLevel;
	readonly grantedBy: ConsentSource;
	readonly grantedAt: Date;
}

interface ConsentRow {
	domain: string;
	level: ConsentLevel;
	granted_by: ConsentSource;
	granted_at: Date;
}

// Everything an owner's assistant may use, application by application, reading before writing
export async function listConsents(tx: Tx, owner: string): Promise<ConsentRecord[]> {
	const rows = await tx.sql<ConsentRow[]>`
		select domain, level, granted_by, granted_at from consents where owner = ${owner}`;
	return rows
		.map((row): ConsentRecord => ({
			domain: row.domain,
			level: row.level,
			grantedBy: row.granted_by,
			grantedAt: row.granted_at
		}))
		.sort((a, b) => a.domain.localeCompare(b.domain, 'en') || a.level.localeCompare(b.level, 'en'));
}

// What a withdrawal took back: the levels the owner had allowed in the application, and the calls
// there it closed
export interface Withdrawal {
	readonly levels: readonly ConsentLevel[];
	readonly superseded: readonly ClosedRequest[];
}

// Takes back what an owner allowed in an application, at the levels given. The calls there that
// still wait for the owner's answer, or that the owner allowed and that have not run yet, close
// with it, as an older question closes when a newer one is asked, and what they would have sent is
// erased, with the digest of what the owner was shown: nothing runs there after the withdrawal
// unless the owner allows it again. Taking back the sharing of their availability with colleagues
// keeps their refusal of it: the harness asks them nothing more, and they grant it again on the
// agreements page.
export async function withdrawConsents(
	tx: Tx,
	owner: string,
	domain: string,
	levels: readonly ConsentLevel[]
): Promise<Withdrawal> {
	const withdrawn = await tx.sql<{ level: ConsentLevel }[]>`
		delete from consents
		where owner = ${owner} and domain = ${domain} and level in ${tx.sql([...levels])}
		returning level`;
	const superseded = await tx.sql<ClosedRow[]>`
		update pending_calls set status = 'superseded', decided_at = now(), arguments = null,
			preview_digest = null
		where owner = ${owner} and domain = ${domain} and level in ${tx.sql([...levels])}
			and (status = 'open' or (status = 'approved' and replayed_at is null))
		returning id, domain, level, reasons`;
	if (domain === AVAILABILITY_DOMAIN && withdrawn.length > 0) {
		await refuseAvailabilitySharing(tx, owner);
	}
	return {
		levels: withdrawn.map((row) => row.level).sort(),
		superseded: closedRequests(superseded)
	};
}

// A consent as the model and the owner's clients read it
export interface ConsentView {
	readonly domain: string;
	readonly level: ConsentLevel;
	readonly granted_by: ConsentSource;
	readonly granted_at: string;
}

export function toConsentView(record: ConsentRecord): ConsentView {
	return {
		domain: record.domain,
		level: record.level,
		granted_by: record.grantedBy,
		granted_at: record.grantedAt.toISOString()
	};
}

export interface PendingCallInput {
	readonly owner: string;
	readonly tool: string;
	readonly contract: string;
	readonly domain: string;
	readonly level: ConsentLevel;
	readonly reasons: readonly WaitReason[];
	readonly arguments: unknown;
	// The digest of the preview its owner is shown, which the call carries once they allowed it;
	// null when its contract showed none
	readonly previewDigest: string | null;
	readonly correlationId: string | null;
	readonly origin: TurnOrigin;
	// The session of the turn that froze the call; none for a direct tool call through the API
	readonly sessionId: string | null;
	// The harness's question, as its owner reads it
	readonly request: string;
}

// Freezes a call until its owner answers; resolves to its id
export async function insertPendingCall(tx: Tx, input: PendingCallInput): Promise<string> {
	const rows = await tx.sql<{ id: string }[]>`
		insert into pending_calls (owner, tool, contract, domain, level, reasons, arguments,
			preview_digest, correlation_id, origin, session_id, request_text)
		values (${input.owner}, ${input.tool}, ${input.contract}, ${input.domain}, ${input.level},
			${JSON.stringify(input.reasons)}::jsonb, ${JSON.stringify(input.arguments)}::jsonb,
			${input.previewDigest}, ${input.correlationId}, ${input.origin}, ${input.sessionId},
			${input.request})
		returning id`;
	const row = rows[0];
	if (row === undefined) throw new Error('the pending call was not stored');
	return row.id;
}

// The Matrix event and room of the question asked about a call, which its owner's answer points
// to, and the time it was asked there, a question that asks it again counting from then; false
// when no such call is stored, so that no answer could ever find it
export async function recordRequestEvent(
	tx: Tx,
	id: string,
	eventId: string,
	roomId: string
): Promise<boolean> {
	const result = await tx.sql`
		update pending_calls set request_event_id = ${eventId}, room_id = ${roomId}, asked_at = now()
		where id = ${id}`;
	return result.count === 1;
}

// What a waiting call is about: its application, its level and the reasons it waits for. Its
// metrics count it by these, never by its owner nor what it would send.
export interface CallSubject {
	readonly domain: string;
	readonly level: ConsentLevel;
	readonly reasons: readonly WaitReason[];
}

interface SubjectRow {
	domain: string;
	level: ConsentLevel;
	reasons: unknown;
}

// Every reason a call may wait for, so that a reason read back is known for one: a reason added
// to WaitReason and missing here fails the build
const WAIT_REASONS: Readonly<Record<WaitReason, true>> = {
	consent: true,
	event_turn: true,
	high_risk: true,
	unsure: true,
	delegation: true,
	series: true
};

function isWaitReason(value: string): value is WaitReason {
	return Object.hasOwn(WAIT_REASONS, value);
}

function subjectOf(row: SubjectRow): CallSubject {
	const reasons = readJsonColumn(row.reasons);
	return {
		domain: row.domain,
		level: row.level,
		reasons: isStringArray(reasons) ? reasons.filter(isWaitReason) : []
	};
}

// A request closed unanswered, and what its call was about
export interface ClosedRequest extends CallSubject {
	readonly pendingCallId: string;
}

interface ClosedRow extends SubjectRow {
	id: string;
}

function closedRequests(rows: readonly ClosedRow[]): ClosedRequest[] {
	return rows.map((row) => ({ pendingCallId: row.id, ...subjectOf(row) }));
}

// Marks the open requests of a room older than the one just asked as superseded, erasing what
// their calls would have sent, the question and the digest of what their owner was shown
export async function supersedeRequests(
	tx: Tx,
	owner: string,
	roomId: string,
	newestId: string
): Promise<ClosedRequest[]> {
	const rows = await tx.sql<ClosedRow[]>`
		update pending_calls set status = 'superseded', decided_at = now(), arguments = null,
			request_text = null, preview_digest = null
		where owner = ${owner} and room_id = ${roomId} and status = 'open' and id <> ${newestId}
		returning id, domain, level, reasons`;
	return closedRequests(rows);
}

// Closes the owner's requests left unanswered past their lifetime, erasing what their calls would
// have sent, the question and the digest of what their owner was shown
export async function expireRequests(
	tx: Tx,
	owner: string,
	lifetimeMs: number
): Promise<ClosedRequest[]> {
	const rows = await tx.sql<ClosedRow[]>`
		update pending_calls set status = 'expired', decided_at = now(), arguments = null,
			request_text = null, preview_digest = null
		where owner = ${owner} and status = 'open'
			and created_at <= now() - make_interval(secs => ${lifetimeMs / 1000})
		returning id, domain, level, reasons`;
	return closedRequests(rows);
}

// What an answer finds: a request still open, one closed unanswered (its lifetime over, or a
// newer one asked in its room), or one already decided
export type RequestState = 'open' | 'expired' | 'superseded' | 'decided';

function stateOf(status: string): RequestState {
	return status === 'open' || status === 'expired' || status === 'superseded' ? status : 'decided';
}

export interface FoundRequest extends CallSubject {
	readonly pendingCallId: string;
	readonly state: RequestState;
}

interface RequestRow extends SubjectRow {
	id: string;
	status: string;
}

function foundRequest(row: RequestRow | undefined): FoundRequest | null {
	return row === undefined
		? null
		: { pendingCallId: row.id, state: stateOf(row.status), ...subjectOf(row) };
}

// The request asked in this event, whatever became of it
export async function findRequest(
	tx: Tx,
	owner: string,
	requestEventId: string
): Promise<FoundRequest | null> {
	const rows = await tx.sql<RequestRow[]>`
		select id, status, domain, level, reasons from pending_calls
		where owner = ${owner} and request_event_id = ${requestEventId}`;
	return foundRequest(rows[0]);
}

// The request of a room asked there last that is still open to an answer in words, its owner
// having written nothing else since it was asked. One that expired is found too, so that its
// answer gets the notice.
export async function findRequestOpenToWords(
	tx: Tx,
	owner: string,
	roomId: string
): Promise<FoundRequest | null> {
	const rows = await tx.sql<RequestRow[]>`
		select id, status, domain, level, reasons from pending_calls
		where owner = ${owner} and room_id = ${roomId} and status in ('open', 'expired')
			and words_closed_at is null
		order by asked_at desc
		limit 1`;
	return foundRequest(rows[0]);
}

// Whether a request asked in the room since that moment, or asked there again since, is open to an
// answer in words still, whenever its call froze
export async function isRequestOpenToWordsSince(
	tx: Tx,
	owner: string,
	roomId: string,
	since: Date
): Promise<boolean> {
	const rows = await tx.sql`
		select 1 from pending_calls
		where owner = ${owner} and room_id = ${roomId} and status in ('open', 'expired')
			and words_closed_at is null and asked_at > ${since}
		limit 1`;
	return rows.length > 0;
}

// The owner wrote in the room: its requests are no longer open to an answer in words
export async function closeRequestsToWords(tx: Tx, owner: string, roomId: string): Promise<void> {
	await tx.sql`
		update pending_calls set words_closed_at = now()
		where owner = ${owner} and room_id = ${roomId} and words_closed_at is null`;
}

// Whether this event of the owner already answered one of their requests, as an event delivered
// again would have, even a request the harness asked again since
export async function isAnswerEvent(tx: Tx, owner: string, eventId: string): Promise<boolean> {
	const rows = await tx.sql`
		select 1 from pending_calls
		where owner = ${owner}
			and (answer_event_id = ${eventId} or ${eventId} = any(earlier_answer_event_ids))
		limit 1`;
	return rows.length > 0;
}

// The owner's answer to a call still waiting, once: a yes approves it, for its resume job to run,
// and a no refuses it, erasing what it would have sent and the digest of what they were shown.
// From then on no other answer, nor a newer request, changes it. A yes also lands on a call its
// resume job approved first, so that the answer is recorded. False when the call was no longer
// waiting.
export async function decidePendingCall(
	tx: Tx,
	owner: string,
	id: string,
	decision: 'approved' | 'refused',
	answerEventId: string
): Promise<boolean> {
	const result = await tx.sql<{ domain: string }[]>`
		update pending_calls set status = ${decision}, decided_at = coalesce(decided_at, now()),
			answer_event_id = ${answerEventId},
			arguments = case when ${decision} = 'refused' then null else arguments end,
			request_text = case when ${decision} = 'refused' then null else request_text end,
			preview_digest = case when ${decision} = 'refused' then null else preview_digest end
		where id = ${id} and owner = ${owner}
			and (status = 'open' or (status = ${decision} and answer_event_id is null))
		returning domain`;
	// A no to the question about sharing their availability is the refusal the harness keeps: it
	// asks them nothing more, and they grant it again on the agreements page
	if (
		decision === 'refused' &&
		result[0]?.domain === AVAILABILITY_DOMAIN &&
		(await hasConsent(tx, owner, AVAILABILITY_DOMAIN, 'read')) === false
	) {
		await refuseAvailabilitySharing(tx, owner);
	}
	return result.length === 1;
}

// The owner's answer through the API to a call still waiting, recorded under an id of its own:
// a yes approves it, for its resume job to run, and a no drops it, erasing what it would have
// sent, the question and the digest of what they were shown. The answer goes in as the room's do,
// so that an answer read in the room as the call still waited finds it answered and decides
// nothing. False when the call was no longer waiting.
export async function answerPendingCall(
	tx: Tx,
	owner: string,
	id: string,
	decision: 'approved' | 'refused',
	answerId: string
): Promise<boolean> {
	const result = await tx.sql<{ domain: string }[]>`
		update pending_calls set status = ${decision}, decided_at = now(),
			answer_event_id = ${answerId},
			arguments = case when ${decision} = 'refused' then null else arguments end,
			request_text = case when ${decision} = 'refused' then null else request_text end,
			preview_digest = case when ${decision} = 'refused' then null else preview_digest end
		where id = ${id} and owner = ${owner} and status = 'open'
		returning domain`;
	// As in the chat: a no to the question about sharing their availability keeps the refusal
	if (
		decision === 'refused' &&
		result[0]?.domain === AVAILABILITY_DOMAIN &&
		(await hasConsent(tx, owner, AVAILABILITY_DOMAIN, 'read')) === false
	) {
		await refuseAvailabilitySharing(tx, owner);
	}
	return result.length === 1;
}

// The event by which the owner answered a request already closed, kept so that, delivered again,
// it is not taken for a message. Only the first answer is kept: false for any later one.
export async function recordAnswerEvent(
	tx: Tx,
	owner: string,
	id: string,
	eventId: string
): Promise<boolean> {
	const result = await tx.sql`
		update pending_calls set answer_event_id = ${eventId}
		where id = ${id} and owner = ${owner} and answer_event_id is null`;
	return result.count === 1;
}

export interface ApprovedCall extends CallSubject {
	readonly tool: string;
	readonly contract: string;
	readonly arguments: unknown;
	// The digest of the preview its owner was shown, which the call carries; null when its contract
	// showed none
	readonly previewDigest: string | null;
	readonly correlationId: string | null;
	readonly origin: TurnOrigin;
}

interface ApprovedRow extends SubjectRow {
	tool: string;
	contract: string;
	arguments: unknown;
	preview_digest: string | null;
	correlation_id: string | null;
	origin: TurnOrigin;
}

function approvedCall(row: ApprovedRow | undefined): ApprovedCall | null {
	return row === undefined
		? null
		: {
				...subjectOf(row),
				tool: row.tool,
				contract: row.contract,
				arguments: readJsonColumn(row.arguments),
				previewDigest: row.preview_digest,
				correlationId: row.correlation_id,
				origin: row.origin
			};
}

// Hands out a call its owner allowed, for its resume job to run it: approved when the answer
// came, or still waiting if the job came first. A call approved but never run, its job having
// died, is handed out again; one already run, or decided otherwise, is not.
export async function approvePendingCall(
	tx: Tx,
	owner: string,
	id: string
): Promise<ApprovedCall | null> {
	const rows = await tx.sql<ApprovedRow[]>`
		update pending_calls set status = 'approved', decided_at = coalesce(decided_at, now())
		where id = ${id} and owner = ${owner}
			and (status = 'open' or (status = 'approved' and replayed_at is null))
		returning tool, contract, domain, level, reasons, arguments, preview_digest, correlation_id,
			origin`;
	return approvedCall(rows[0]);
}

// Takes a call for the owner's yes through the API, which runs it at once with no job behind it:
// a call still waiting, or one an earlier yes through the API took and left unrun past the lease
// a replica holds a job for, its replica taken for gone. The yes is recorded under its own id,
// so that a second answer, through the API or in the room, finds the call decided.
export async function takeAllowedCall(
	tx: Tx,
	owner: string,
	id: string,
	answerId: string,
	leaseMs: number
): Promise<ApprovedCall | null> {
	const rows = await tx.sql<ApprovedRow[]>`
		update pending_calls set status = 'approved', decided_at = now(), answer_event_id = ${answerId}
		where id = ${id} and owner = ${owner}
			and (status = 'open'
				or (status = 'approved' and replayed_at is null and answer_event_id like 'api:%'
					and decided_at <= now() - make_interval(secs => ${leaseMs / 1000})))
		returning tool, contract, domain, level, reasons, arguments, preview_digest, correlation_id,
			origin`;
	return approvedCall(rows[0]);
}

// The call its owner allowed waits again once replayed, under a newer request that asks about
// everything that applies by then, such as writing they took back since: this one is closed as
// superseded by that request, and what it would have sent is erased with its question and the
// digest of what its owner was shown, the newer one holding all three
export async function supersedeApprovedCall(tx: Tx, owner: string, id: string): Promise<void> {
	await tx.sql`
		update pending_calls set status = 'superseded', arguments = null, request_text = null,
			preview_digest = null
		where id = ${id} and owner = ${owner} and status = 'approved' and replayed_at is null`;
}

// The call a suggestion froze is proposed at another time, once the invitee's assistant answered:
// what it would run changes, and only while the call still waits for its owner, whose question
// names the slot no more than it did before. A call already decided keeps what it was decided on.
export async function rewritePendingCallArguments(
	tx: Tx,
	owner: string,
	id: string,
	args: unknown
): Promise<void> {
	await tx.sql`
		update pending_calls set arguments = ${JSON.stringify(args)}::jsonb
		where id = ${id} and owner = ${owner} and status = 'open'`;
}

// The call ran, and the conversation holds it: what it sent is erased, with the question and the
// digest it carried
export async function markReplayed(tx: Tx, id: string): Promise<void> {
	await tx.sql`
		update pending_calls set replayed_at = now(), arguments = null, request_text = null,
			preview_digest = null
		where id = ${id}`;
}

// One of the owner's calls, locked until the transaction ends, so that no answer changes it
// meanwhile: its state, and whether it waits to run, allowed and not run yet. Null when no such
// call is stored.
export async function lockPendingCall(
	tx: Tx,
	owner: string,
	id: string
): Promise<{ readonly state: RequestState; readonly waitsToRun: boolean } | null> {
	const rows = await tx.sql<{ status: string; waits_to_run: boolean }[]>`
		select status, status = 'approved' and replayed_at is null as waits_to_run
		from pending_calls where id = ${id} and owner = ${owner}
		for update`;
	const row = rows[0];
	return row === undefined ? null : { state: stateOf(row.status), waitsToRun: row.waits_to_run };
}

// The call its owner allowed, which admission kept from running, waits for their answer again as
// it did once asked, should its request end after the refusal lifts, in this many milliseconds: no
// answer is recorded, and the owner's next message may answer it in words. The yes that allowed
// it is kept among its earlier answers, so that, delivered again, it answers nothing. False when
// the call no longer waited to run, or its request ends before then.
export async function reopenRequest(
	tx: Tx,
	owner: string,
	id: string,
	lifetimeMs: number,
	liftsInMs: number
): Promise<boolean> {
	const result = await tx.sql`
		update pending_calls set status = 'open', decided_at = null, answer_event_id = null,
			earlier_answer_event_ids = case when answer_event_id is null then earlier_answer_event_ids
				else array_append(earlier_answer_event_ids, answer_event_id) end,
			words_closed_at = null
		where id = ${id} and owner = ${owner} and status = 'approved' and replayed_at is null
			and created_at + make_interval(secs => ${lifetimeMs / 1000})
				> now() + make_interval(secs => ${liftsInMs / 1000})`;
	return result.count === 1;
}

// Whether a request other than this one is open in the room, its question gone out or about to:
// a newer one, as asking a request supersedes those open before it in its room
export async function hasNewerRequest(
	tx: Tx,
	owner: string,
	roomId: string,
	id: string
): Promise<boolean> {
	const rows = await tx.sql`
		select 1 from pending_calls p left join sessions s on s.id = p.session_id
		where p.owner = ${owner} and p.id <> ${id} and p.status = 'open'
			and coalesce(p.room_id, s.room_id) = ${roomId}
		limit 1`;
	return rows.length > 0;
}

// The call its owner allowed, which admission kept from running, is closed: expired past the end
// of its request, or superseded by a newer request of its room. What it would have sent is erased,
// with the question and the digest of what its owner was shown. Their yes stays recorded, so that,
// delivered again, it is not taken for a message. False when the call no longer waited to run.
export async function closeHeldRequest(
	tx: Tx,
	owner: string,
	id: string,
	status: 'expired' | 'superseded'
): Promise<boolean> {
	const result = await tx.sql`
		update pending_calls set status = ${status}, decided_at = now(), arguments = null,
			request_text = null, preview_digest = null
		where id = ${id} and owner = ${owner} and status = 'approved' and replayed_at is null`;
	return result.count === 1;
}

// What the call was frozen for went ahead without it: its request closes as expired, unanswered or
// allowed and not run yet, so that a yes to it runs nothing. What it would have sent is erased, with
// the question and the digest of what its owner was shown. The request, when it closed unanswered,
// as one past its lifetime does; null when its yes, which stays recorded, was still to run, or when
// it was decided otherwise, or ran.
export async function expireWaitingCall(
	tx: Tx,
	owner: string,
	id: string
): Promise<ClosedRequest | null> {
	const rows = await tx.sql<ClosedRow[]>`
		update pending_calls set status = 'expired', decided_at = now(), arguments = null,
			request_text = null, preview_digest = null
		where id = ${id} and owner = ${owner} and status = 'open'
		returning id, domain, level, reasons`;
	const [unanswered] = closedRequests(rows);
	if (unanswered !== undefined) return unanswered;
	await closeHeldRequest(tx, owner, id, 'expired');
	return null;
}

// Where a call was frozen, which is where its owner's answer resumes it: the owner's room, a turn
// through the API's chat in its session, or a direct call through the API's tool route. The API's
// channels say so in their names, apart from the chat in the room that consents record.
export type PendingCallChannel =
	| { readonly kind: 'room'; readonly roomId: string }
	| { readonly kind: 'api_chat'; readonly sessionId: string }
	| { readonly kind: 'api_tool' };

// A call the harness froze, as its owner's clients see it: never what it would send
export interface PendingCallRecord extends CallSubject {
	readonly id: string;
	readonly channel: PendingCallChannel;
	readonly sessionId: string | null;
	readonly tool: string;
	readonly contract: string;
	// The harness's question as its owner read it, erased once the call is decided
	readonly request: string | null;
	readonly state: RequestState;
	readonly createdAt: Date;
}

interface PendingCallRow extends SubjectRow {
	id: string;
	session_id: string | null;
	room_id: string | null;
	tool: string;
	contract: string;
	request_text: string | null;
	status: string;
	created_at: Date;
}

function toPendingCallRecord(row: PendingCallRow): PendingCallRecord {
	return {
		...subjectOf(row),
		id: row.id,
		channel:
			row.room_id !== null
				? { kind: 'room', roomId: row.room_id }
				: row.session_id !== null
					? { kind: 'api_chat', sessionId: row.session_id }
					: { kind: 'api_tool' },
		sessionId: row.session_id,
		tool: row.tool,
		contract: row.contract,
		request: row.request_text,
		state: stateOf(row.status),
		createdAt: row.created_at
	};
}

// One of the owner's calls, whatever became of it. A call asked in a room belongs to that room
// even before its question went out, through the session of the turn that froze it.
export async function findPendingCall(
	tx: Tx,
	owner: string,
	id: string
): Promise<PendingCallRecord | null> {
	const rows = await tx.sql<PendingCallRow[]>`
		select p.id, p.session_id, coalesce(p.room_id, s.room_id) as room_id, p.tool, p.contract,
			p.domain, p.level, p.reasons, p.request_text, p.status, p.created_at
		from pending_calls p left join sessions s on s.id = p.session_id
		where p.owner = ${owner} and p.id = ${id}`;
	const row = rows[0];
	return row === undefined ? null : toPendingCallRecord(row);
}

// The owner's calls that wait for their answer, the oldest first
export async function listPendingCalls(tx: Tx, owner: string): Promise<PendingCallRecord[]> {
	const rows = await tx.sql<PendingCallRow[]>`
		select p.id, p.session_id, coalesce(p.room_id, s.room_id) as room_id, p.tool, p.contract,
			p.domain, p.level, p.reasons, p.request_text, p.status, p.created_at
		from pending_calls p left join sessions s on s.id = p.session_id
		where p.owner = ${owner} and p.status = 'open'
		order by p.created_at`;
	return rows.map(toPendingCallRecord);
}

// A pending call as the owner's clients read it
export interface PendingCallView {
	readonly id: string;
	readonly channel: PendingCallChannel['kind'];
	readonly session_id: string | null;
	readonly tool: string;
	readonly contract: string;
	readonly domain: string;
	readonly level: ConsentLevel;
	readonly reasons: readonly string[];
	readonly request: string | null;
	readonly created_at: string;
	readonly expires_at: string;
}

// When the request about a call expires, its lifetime after the call froze: an answer from then on
// runs nothing
function requestExpiry(record: PendingCallRecord, lifetimeMs: number): Date {
	return new Date(record.createdAt.getTime() + lifetimeMs);
}

// The question the request about a call asks its owner, as their client tells it from other
// messages: the id and the end of validity the API shows. None once the call no longer waits for
// an answer, decided from another client or closed unanswered, so that no client offers one.
export function toYesNoQuestion(
	record: PendingCallRecord,
	lifetimeMs: number
): YesNoQuestion | null {
	return record.state === 'open'
		? { id: record.id, expiresTs: requestExpiry(record, lifetimeMs).getTime() }
		: null;
}

export function toPendingCallView(record: PendingCallRecord, lifetimeMs: number): PendingCallView {
	return {
		id: record.id,
		channel: record.channel.kind,
		session_id: record.sessionId,
		tool: record.tool,
		contract: record.contract,
		domain: record.domain,
		level: record.level,
		reasons: record.reasons,
		request: record.request,
		created_at: record.createdAt.toISOString(),
		expires_at: requestExpiry(record, lifetimeMs).toISOString()
	};
}
