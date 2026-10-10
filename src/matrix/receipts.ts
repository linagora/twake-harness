import { isRecord } from './json.js';

// The read receipt that tells a user read a room. A private one (`m.read.private`) is theirs alone:
// the Matrix specification keeps it from an application service, as Synapse does from 1.162 on, so
// it counts nowhere, even where an older Synapse still pushes it.
const READ_RECEIPT = 'm.read';

// The room of a read receipt Synapse pushes, and the users it says read there publicly, whatever
// event each one read: null for any other ephemeral event
export function readersOf(
	event: Record<string, unknown>
): { readonly roomId: string; readonly userIds: ReadonlySet<string> } | null {
	const roomId = event['room_id'];
	const content = event['content'];
	if (event['type'] !== 'm.receipt' || typeof roomId !== 'string' || !isRecord(content)) {
		return null;
	}
	const userIds = new Set<string>();
	for (const receipts of Object.values(content)) {
		if (!isRecord(receipts)) continue;
		const users = receipts[READ_RECEIPT];
		if (isRecord(users)) for (const userId of Object.keys(users)) userIds.add(userId);
	}
	return { roomId, userIds };
}
