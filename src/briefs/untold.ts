import type { Activity } from '../journal/repository.js';
import { activityView } from '../journal/tool.js';
import { isRecord } from '../matrix/json.js';
import {
	CANCELLED_EVENT_TYPE,
	COUNTERED_EVENT_TYPE,
	INVITED_EVENT_TYPE,
	MOVED_EVENT_TYPE,
	RENAMED_EVENT_TYPE,
	REPLIED_EVENT_TYPE,
	TASK_ASSIGNED_EVENT_TYPE
} from '../wakeups/event-types.js';

// The most activities of the owner's journal a brief is handed, the first ones that arrived
export const MAX_UNTOLD = 20;

// What an activity was, as the brief's template says it
export type UntoldKind =
	'invited' | 'moved' | 'renamed' | 'cancelled' | 'countered' | 'replied' | 'assigned' | 'other';

const KINDS: Readonly<Record<string, UntoldKind>> = {
	[INVITED_EVENT_TYPE]: 'invited',
	[MOVED_EVENT_TYPE]: 'moved',
	[RENAMED_EVENT_TYPE]: 'renamed',
	[CANCELLED_EVENT_TYPE]: 'cancelled',
	[COUNTERED_EVENT_TYPE]: 'countered',
	[REPLIED_EVENT_TYPE]: 'replied',
	[TASK_ASSIGNED_EVENT_TYPE]: 'assigned'
};

export function kindOf(activity: Activity): UntoldKind {
	return KINDS[activity.type] ?? 'other';
}

// The title of what an activity is about, as people wrote it, when its journal kept one
export function titleOf(activity: Activity): string | null {
	const title = activity.names?.untrusted['title'];
	return typeof title === 'string' ? title : null;
}

// An invitee's answer to a meeting the owner organizes, as iCalendar names it
export type Answer = 'ACCEPTED' | 'DECLINED' | 'TENTATIVE' | 'DELEGATED' | 'NEEDS-ACTION';

// The order the brief tells the answers in: the declines, then the maybes, then the others, and the
// acceptances last, which it counts
const ANSWERS: readonly Answer[] = [
	'DECLINED',
	'TENTATIVE',
	'DELEGATED',
	'NEEDS-ACTION',
	'ACCEPTED'
];

// What an invitee answered the owner's invitation, while the journal still names it
export function answerGiven(activity: Activity): Answer | null {
	const answer = activity.names?.computed['answer'];
	return ANSWERS.find((known) => known === answer) ?? null;
}

// Who answered, by the address their answer came from, when the journal still names them
export function attendeeOf(activity: Activity): string | null {
	const attendee = activity.names?.computed['attendee'];
	return typeof attendee === 'string' ? attendee : null;
}

// A meeting a brief names by a number, and what the number names for the owner's next turns: its
// UID and its occurrence
export interface NumberedMeeting {
	readonly number: number;
	readonly uid: string;
	readonly recurrence_id: string | null;
}

type Meeting = Omit<NumberedMeeting, 'number'>;

// A task an activity is about, by its id, and by its key when Tasks gave one
interface Task {
	readonly key: string | null;
	readonly task_id: string;
}

// An activity no brief named yet, as the next one names it: a meeting by its number, a task by its
// key, or neither
export interface UntoldActivity {
	readonly activity: Activity;
	readonly meeting: NumberedMeeting | null;
	readonly task: Task | null;
}

// A task the owner assigned themselves, which the brief names by a number, after the shares it tells
// before it
export interface AssignedTask {
	readonly activity: Activity;
	readonly number: number;
	readonly task: Task;
}

// The activities of the owner's journal that had no turn and that no brief named yet, the first
// ones that arrived, and whether the journal had more: the answers to their invitations, the
// declines and the maybes first, the tasks they assigned themselves, and the others
export interface Untold {
	readonly activities: readonly UntoldActivity[];
	readonly replies: readonly UntoldActivity[];
	readonly assigned: readonly AssignedTask[];
	readonly truncated: boolean;
}

// What the numbers and the keys of those activities name, for the owner's next turns
export type UntoldReference = NumberedMeeting | { readonly key?: string; readonly task_id: string };

// What the number of a task the owner assigned themselves names: its id, after its key
export interface AssignedReference {
	readonly number: number;
	readonly key?: string;
	readonly task_id: string;
}

// The meeting an activity of Calendar is about: its UID, as the organizer wrote it, and its
// occurrence
function meetingOf(activity: Activity): Meeting | null {
	const uid = activity.ids.untrusted['uid'];
	if (typeof uid !== 'string') return null;
	const occurrence = activity.ids.computed['recurrence_id'];
	return { uid, recurrence_id: typeof occurrence === 'string' ? occurrence : null };
}

// The task an activity of the activity exchange is about
function taskOf(activity: Activity): Task | null {
	const object = activity.ids.computed['object'];
	if (!isRecord(object) || object['type'] !== 'task') return null;
	const { id, key } = object;
	if (typeof id !== 'string') return null;
	return { key: typeof key === 'string' ? key : null, task_id: id };
}

// Whether an activity is a task the owner assigned themselves, which their journal kept for their
// brief: a task assigned to them by someone else is kept so only when it had no turn
function selfAssigned(activity: Activity): boolean {
	return activity.type === TASK_ASSIGNED_EVENT_TYPE && activity.outcome === 'for_brief';
}

// The answers to the owner's invitations in the order the brief tells them, in the order they
// arrived among the same answers
function byAnswer(replies: readonly Activity[]): Activity[] {
	const rank = (activity: Activity): number =>
		ANSWERS.indexOf(answerGiven(activity) ?? 'NEEDS-ACTION');
	return [...replies].sort((one, other) => rank(one) - rank(other));
}

// The activities no brief named yet, of those read, MAX_UNTOLD at most, in the order the brief tells
// them: the answers to the owner's invitations apart, and the tasks they assigned themselves. Each
// meeting is numbered after the invitations the brief numbers, or with the number of its invitation
// when the brief numbers it too, so that a number names one meeting whatever section shows it, and
// each task the owner assigned themselves after the meetings
export function untoldOf(
	activities: readonly Activity[],
	invitations: readonly NumberedMeeting[]
): Untold {
	const keyOf = (meeting: Meeting): string => JSON.stringify([meeting.uid, meeting.recurrence_id]);
	const numbers = new Map(invitations.map((invitation) => [keyOf(invitation), invitation.number]));
	let last = Math.max(0, ...invitations.map((invitation) => invitation.number));
	const numbered = (meeting: Meeting): NumberedMeeting => {
		const key = keyOf(meeting);
		const known = numbers.get(key);
		if (known !== undefined) return { number: known, ...meeting };
		last += 1;
		numbers.set(key, last);
		return { number: last, ...meeting };
	};
	const untold = (activity: Activity): UntoldActivity => {
		const meeting = meetingOf(activity);
		return {
			activity,
			meeting: meeting === null ? null : numbered(meeting),
			task: meeting === null ? taskOf(activity) : null
		};
	};
	const handed = activities.slice(0, MAX_UNTOLD);
	const tasks = handed.flatMap((activity) => {
		const task = selfAssigned(activity) ? taskOf(activity) : null;
		return task === null ? [] : [{ activity, task }];
	});
	const replied = handed.filter((activity) => activity.type === REPLIED_EVENT_TYPE);
	const apart = new Set([...replied, ...tasks.map(({ activity }) => activity)]);
	// Numbered in the order the brief tells them
	const others = handed.filter((activity) => !apart.has(activity)).map(untold);
	const replies = byAnswer(replied).map(untold);
	return {
		activities: others,
		replies,
		assigned: tasks.map((task, index) => ({ ...task, number: last + index + 1 })),
		truncated: activities.length > MAX_UNTOLD
	};
}

// The tasks the owner assigned themselves numbered after the number given: the last of those the
// brief gives before them, the shares' included
export function assignedAfter(untold: Untold, last: number): Untold {
	return {
		...untold,
		assigned: untold.assigned.map((task, index) => ({ ...task, number: last + index + 1 }))
	};
}

// What the model is handed of an activity: as the listening journal shows it to a turn, after the
// number or the key the owner answers it by
function viewOf(
	{ activity, meeting, task }: UntoldActivity,
	timeZone: string
): Record<string, unknown> {
	return {
		...(meeting === null ? {} : { number: meeting.number }),
		...(task === null || task.key === null ? {} : { key: task.key }),
		...activityView(activity, timeZone)
	};
}

// What the model is handed of the activities apart from the answers and the tasks the owner assigned
// themselves, and whether the journal had more
export function untoldData(untold: Untold, timeZone: string): Record<string, unknown> {
	return {
		activities: untold.activities.map((told) => viewOf(told, timeZone)),
		truncated: untold.truncated
	};
}

// What the model is handed of the answers to the owner's invitations, in the order the brief tells
// them
export function repliesData(untold: Untold, timeZone: string): Record<string, unknown>[] {
	return untold.replies.map((told) => viewOf(told, timeZone));
}

// What the model is handed of the tasks the owner assigned themselves, each after its number and key
export function assignedData(untold: Untold, timeZone: string): Record<string, unknown>[] {
	return untold.assigned.map(({ activity, number, task }) => ({
		number,
		...(task.key === null ? {} : { key: task.key }),
		...activityView(activity, timeZone)
	}));
}

// What their numbers and keys name: each meeting once, by its UID and occurrence, and each task by
// its id
export function untoldReferences(untold: Untold): readonly UntoldReference[] {
	const named = new Set<number>();
	return untold.activities.flatMap(({ meeting, task }): UntoldReference[] => {
		if (meeting !== null) {
			if (named.has(meeting.number)) return [];
			named.add(meeting.number);
			return [meeting];
		}
		if (task === null) return [];
		return [{ ...(task.key === null ? {} : { key: task.key }), task_id: task.task_id }];
	});
}

// What the numbers of the meetings the answers are about name: each meeting once, by its UID and
// occurrence
export function replyReferences(untold: Untold): readonly NumberedMeeting[] {
	const named = new Set<number>();
	return untold.replies.flatMap(({ meeting }): NumberedMeeting[] => {
		if (meeting === null || named.has(meeting.number)) return [];
		named.add(meeting.number);
		return [meeting];
	});
}

// What the numbers of the tasks the owner assigned themselves name: each task by its id
export function assignedReferences(untold: Untold): readonly AssignedReference[] {
	return untold.assigned.map(({ number, task }) => ({
		number,
		...(task.key === null ? {} : { key: task.key }),
		task_id: task.task_id
	}));
}
