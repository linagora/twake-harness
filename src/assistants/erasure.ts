import type { Tx } from '../db/client.js';
import { deleteJobsOf } from '../jobs/queue.js';
import { forgetIdentityQuestion } from '../matrix/owner-cross-signing-repository.js';
import { markAssistantDeleted, type AssistantRecord } from './repository.js';

// Erases, in the transaction given under the owner's principal, what the harness keeps of their
// assistant and of what they told it: their conversations, its memory, their skills, the
// permissions they gave it, the calls that wait for their answer, the suggestions it made them, the
// brief that waits for their answer, the question of their first brief and where their brief stands
// with its reads, when they were last seen in its room, what they chose of their brief and the zone
// of their calendar, the activities their quiet hours hold, the reminders of their delegation, what
// it told them of their sessions, the question it asked them about their identity with their
// answer, and the jobs that would still run for it. Its record stays, marked deleted, with the
// language its owner chose, and its rooms leave the index, the encrypted conversations it read for
// its owner with them. What a new assistant needs or must not lose stays: the Matrix account, its
// device and keys, as a Matrix identifier is never reused, the owner's quota counters, the channels
// they took out of the suggestions and whether they
// want them at all, which they chose for themselves, the identity the harness pinned for them and
// the one it saw last, and what keeps the next assistant from taking anything twice: the wake-ups,
// which keep an event replayed later from waking it, and a brief of a date that had one from going
// out again that date, the owner's words received, which keep a copy
// of them from counting, and when it first read each session their words came from, which keeps the
// words of a session older than those it remembers from counting.
// False when the live assistant is no longer the one created at that time.
export async function eraseAssistant(
	tx: Tx,
	assistant: Pick<AssistantRecord, 'owner' | 'userId' | 'createdAt'>
): Promise<boolean> {
	const { owner, userId, createdAt } = assistant;
	// Locked first: a deletion that comes at the same time waits, then finds nothing left to erase
	const [live] = await tx.sql<{ created_at: Date }[]>`
		select created_at from assistants where owner = ${owner} and deleted_at is null for update`;
	if (live === undefined || live.created_at.getTime() !== createdAt.getTime()) return false;
	await markAssistantDeleted(tx, owner);
	await tx.sql`delete from assistant_rooms where owner = ${owner}`;
	await tx.sql`delete from assistant_listened_rooms where owner = ${owner}`;
	await tx.sql`delete from assistant_provisioned where owner = ${owner}`;
	// The conversations go before what a turn keeps in their name, which holds its conversation as
	// it writes: such a write that came first is erased below, and one that comes later finds its
	// conversation gone and keeps nothing
	await tx.sql`delete from sessions where owner = ${owner}`;
	await tx.sql`delete from memory_entries where owner = ${owner}`;
	await tx.sql`delete from skills where owner = ${owner} and scope = 'user'`;
	// The calls that wait for the owner go before the permissions, which a yes grants under the lock
	// it takes on its call: a yes that took its call first has granted its permission by the time the
	// calls are erased, and that permission is erased below, and one that comes later finds no call
	// to allow and grants nothing
	await tx.sql`delete from pending_calls where owner = ${owner}`;
	// The suggestions it made name those calls, and the channels they came from, and a brief that
	// waits for the owner's answer names one too
	await tx.sql`delete from suggestions where owner = ${owner}`;
	await tx.sql`delete from brief_delegation_waits where owner = ${owner}`;
	await tx.sql`delete from brief_questions where owner = ${owner}`;
	// What the owner's quiet hours hold would wake it as they end, as a job would
	await tx.sql`delete from held_activities where owner = ${owner}`;
	await tx.sql`delete from consents where owner = ${owner}`;
	// The reads their brief had go with the permissions: the next assistant's first brief asks for
	// them again. When the owner was last seen in its room goes with the room: the next assistant's
	// first brief starts the count again. What they chose of their brief goes, and the zone of their
	// calendar with it: the next assistant's brief goes out by default, and its turns state the
	// present, on the deployment's wall clock until a read names their zone again.
	await tx.sql`
		update owner_settings set brief_reads_settled = false, brief_reads_told = '{}',
			owner_seen_at = null, brief_time = null, brief_days = null, brief_paused_until = null,
			brief_stopped = false, time_zone = null
		where owner = ${owner}`;
	await tx.sql`delete from delegation_reminders where owner = ${owner}`;
	// The next assistant tells its owner of their sessions again, in its own room
	await tx.sql`delete from owner_device_notices where owner = ${owner}`;
	// It asks them again, there too, about an identity of theirs it does not know
	await forgetIdentityQuestion(tx, owner);
	await deleteJobsOf(tx, owner, userId);
	return true;
}
