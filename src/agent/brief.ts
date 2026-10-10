import type { FastifyBaseLogger } from 'fastify';
import { z } from 'zod';

import { localeOf } from '../assistants/locale.js';
import { findAssistant } from '../assistants/repository.js';
import { isIdleOn, ownerSeenSince } from '../briefs/activity.js';
import {
	byImportance,
	emailListSchema,
	mailboxListSchema,
	mailsSince,
	MAX_MAILS,
	participantsOf,
	type Email,
	type Mails,
	type Sender
} from '../briefs/mails.js';
import {
	BRIEF_DOMAINS,
	BRIEF_QUESTION,
	domainsAsked,
	endBriefQuestion,
	findBriefQuestion,
	findBriefReads,
	keepBriefQuestion,
	missingReads,
	settleBriefReads,
	stopBrief,
	takeBriefQuestion,
	type BriefDomain
} from '../briefs/questions.js';
import { BRIEF_NOW_TOOL } from '../briefs/now.js';
import { briefId } from '../briefs/schedule.js';
import { fetchBriefSettings } from '../briefs/settings.js';
import {
	MAX_SHARES,
	numberOf,
	shareListSchema,
	shareReferences,
	sharesOf,
	sharesSince,
	type ShareReference,
	type Shares,
	type ToldItem,
	type ToldShare
} from '../briefs/shares.js';
import {
	answerGiven,
	assignedAfter,
	assignedData,
	assignedReferences,
	attendeeOf,
	kindOf,
	MAX_UNTOLD,
	repliesData,
	replyReferences,
	titleOf,
	untoldData,
	untoldOf,
	untoldReferences,
	type AssignedReference,
	type NumberedMeeting,
	type Untold,
	type UntoldReference
} from '../briefs/untold.js';
import { endBriefWait, findBriefWait, keepBriefWait, type BriefWait } from '../briefs/waits.js';
import type { Config } from '../config.js';
import type { ResumeRequest } from '../consents/consent.js';
import type { ConsentMetrics } from '../consents/metrics.js';
import {
	approvePendingCall,
	grantConsent,
	insertPendingCall,
	markReplayed,
	supersedeApprovedCall,
	type ApprovedCall,
	type ClosedRequest,
	type PendingCallInput
} from '../consents/repository.js';
import { withPrincipal, type Db, type Tx } from '../db/client.js';
import { getMessages, type Locale, type Messages } from '../i18n/messages.js';
import { eraseActivityNames, listUntoldActivities } from '../journal/repository.js';
import { LlmError, type LlmClient, type LlmMessage } from '../llm/client.js';
import { fenced } from '../llm/data.js';
import { escapeHtml, renderQuotedMarkdown } from '../matrix/format.js';
import type { Principal } from '../principals/principal.js';
import { ensurePrincipal } from '../principals/repository.js';
import {
	ensureRoomSession,
	findSession,
	holdSession,
	saveSessionMessages,
	type SessionRecord
} from '../sessions/repository.js';
import {
	findBriefMailsReadAt,
	findBriefSharesReadAt,
	findOwnerSettings,
	saveBriefMailsReadAt,
	saveBriefSharesReadAt
} from '../settings/repository.js';
import { listenUnlessChosen, listListened } from '../sources/repository.js';
import { publishedUnder, type Source } from '../sources/sources.js';
import { eraseHeldActivities } from '../wakeups/held.js';
import { takeBriefWakeup } from '../wakeups/wake.js';
import { spentForTheDay, type Admission, type Refusal, type SpentReason } from './admission.js';
import { withoutCallMarkup } from './call-markup.js';
import { dateIn, describeMoment, isoIn, timeOfDay, type Clock, type TimeZone } from './clock.js';
import type { TurnGate } from './gate.js';
import { buildSystemPrompt } from './prompt.js';
import { runTool, type ToolContext, type ToolOutcome, type ToolRegistry } from './tools.js';
import { withDatesInWords, withTrueWeekdays } from './weekdays.js';

// The calendar's operation the brief reads the day and the invitations of, and the most meetings it
// reads of the day
const LIST_EVENTS = 'list_calendar_events';
const MAX_MEETINGS = 20;

// The invitations that wait for the owner's answer, over seven days from the brief's: the read gives
// each occurrence, a hundred at most, the most the contract gives, and the model is handed twenty
// invitations at most once each series is one
const INVITATION_DAYS = 7;
const MAX_PENDING_OCCURRENCES = 100;
const MAX_INVITATIONS = 20;

// Mail's operations the brief finds the owner's inbox with, then reads their unread emails of
const LIST_MAILBOXES = 'list_mailboxes';
const LIST_EMAILS = 'list_emails';

// The tasks' operation the brief reads the owner's late tasks and those of the day with, and the
// most tasks the model is handed, late ones first
const LIST_TASKS = 'list_my_tasks';
const MAX_TASKS = 30;

// Drive's operation the brief reads the shares other people gave the owner with
const LIST_SHARES = 'list_received_shares';

// The applications the brief reads, while the owner's assistant listens there: those the question of
// their first brief asks to read, and Drive, of which it tells the shares made to them
const READ_SOURCES: readonly Source[] = [...BRIEF_DOMAINS, 'drive'];

// What the brief's reads hand the model, as the invitation check's reads do
const BRIEF_DATA = 'brief-data';

// What the conversation keeps of a brief for the owner's next turns, as data: what its numbers, its
// tasks' keys and its emails name, until a newer brief replaces it. The line that introduces it goes
// with it.
const BRIEF_REFERENCES = 'brief-references';
const KEPT_REFERENCES = new RegExp(
	`\\n[^\\n]*\\n<<<${BRIEF_REFERENCES} ([0-9a-f]{12})\\n[^\\n]*\\n${BRIEF_REFERENCES} \\1>>>`,
	'g'
);

// How many items each section of the brief shows at most
const SHOWN = 5;

// How many times the question of an owner's first brief goes out unanswered before their brief
// stops: on its first day, then once more on their next brief day
const MAX_ASKED = 2;

// One meeting of the day as the calendar's contract lists it: what the contract computed, its
// overlaps with the owner's other meetings included, then, under untrusted, what people wrote
const meetingSchema = z.object({
	uid: z.string(),
	recurrence_id: z.string().nullable(),
	start: z.string(),
	end: z.string(),
	all_day: z.boolean(),
	status: z.string().nullable(),
	private: z.boolean(),
	my_partstat: z.string().nullable(),
	needs_action: z.boolean(),
	conflicts: z.array(z.object({ uid: z.string(), recurrence_id: z.string().nullable() })),
	untrusted: z.object({
		title: z.string().nullable(),
		location: z.string().nullable(),
		description: z.string().nullable(),
		organizer: z.string().nullable()
	})
});

type Meeting = z.infer<typeof meetingSchema>;

// What the calendar's contract lists over days, in the order its occurrences start
const listSchema = z.object({
	time_zone: z.string().nullable(),
	events: z.array(meetingSchema),
	truncated: z.boolean()
});

// The owner's day as the brief tells it: their meetings, in order, at most twenty, and whether the
// calendar had more
interface Day {
	readonly time_zone: string | null;
	readonly meetings: readonly Meeting[];
	readonly truncated: boolean;
}

// An invitation that waits for the owner's answer, as the brief tells it once, by its number: its
// first occurrence over the days read, and whether it is one of a series
type Invitation = { readonly number: number; readonly series: boolean } & Meeting;

// The invitations that wait for the owner's answer, numbered from 1 in the order they start, and
// whether the calendar had more
interface Invitations {
	readonly pending: readonly Invitation[];
	readonly truncated: boolean;
}

// What a brief's numbers, its tasks' keys and its emails name, for the owner's next turns: the uid
// and occurrence of each invitation, the id and sender of each email the brief was handed, in the
// order the harness lays them out, the ids of each task, what the numbers and keys of what arrived
// since their last brief name, and the id of each file and folder shared with them that has a number
interface References {
	readonly invitations?: readonly {
		readonly number: number;
		readonly uid: string;
		readonly recurrence_id: string | null;
	}[];
	readonly mails?: readonly {
		readonly id: string;
		readonly from: Sender | null;
	}[];
	readonly tasks?: readonly {
		readonly key: string;
		readonly board_id: string;
		readonly task_id: string;
	}[];
	readonly since_last_brief?: readonly UntoldReference[];
	readonly replies?: readonly NumberedMeeting[];
	readonly shares?: readonly ShareReference[];
	readonly self_assigned?: readonly AssignedReference[];
}

// One open task as the tasks' contract lists it: what Tasks computed, then, under untrusted, what
// members wrote
const taskSchema = z.object({
	board_id: z.string(),
	task_id: z.string(),
	key: z.string(),
	parent_id: z.string().nullable(),
	section_id: z.string().nullable(),
	state: z.string(),
	priority: z.number().nullable(),
	due_date: z.string().nullable(),
	due_time: z.string().nullable(),
	due_zone: z.string().nullable(),
	deadline: z.string().nullable(),
	assignees: z.array(z.string()),
	assigned_to_me: z.boolean().nullable(),
	untrusted: z.object({
		title: z.string(),
		board_name: z.string(),
		labels: z.array(z.string())
	})
});

type Task = z.infer<typeof taskSchema>;

const taskListSchema = z.object({ tasks: z.array(taskSchema), truncated: z.boolean() });

// The owner's open tasks due before the day of the brief, then those due that day, thirty at most
// together, and whether Tasks had more
interface Tasks {
	readonly overdue: readonly Task[];
	readonly today: readonly Task[];
	readonly truncated: boolean;
}

// The harness's question about the owner's permission for their assistant to act for them, which
// the platform's broker holds none of, or an expired one: its text, and the call it froze, which
// waits for their answer
interface DelegationQuestion {
	readonly text: string;
	readonly pendingCallId: string;
}

// A read of the brief, or why there is none: an application that needs a yes the owner did not
// give, here or on the platform, is not read, and nobody asks them for it. The day's read the
// platform's broker refused for want of their permission is the exception, while no brief waits
// for their answer about it: its call waits for them, under the harness's question.
type Read<T> =
	| { readonly ok: true; readonly value: T }
	| {
			readonly ok: false;
			readonly reason: string;
			readonly status?: number;
			readonly question?: DelegationQuestion;
	  };

// What the brief tells, section by section, as its reads gave it
interface Sections {
	readonly calendar: Read<Day>;
	readonly invitations: Read<Invitations>;
	readonly mails: Read<Mails>;
	readonly tasks: Read<Tasks>;
	readonly shares: Read<Shares>;
}

// The application each section of the brief reads, which the line of a section not read names
const DOMAINS: Readonly<Record<keyof Sections, Source>> = {
	calendar: 'calendar',
	invitations: 'calendar',
	mails: 'mail',
	tasks: 'tasks',
	shares: 'drive'
};

// The brief's reads: what it tells, the zone it is written in, the instants it read the owner's mail
// and the shares made to them at, which their next brief reads them from, when it read them, and
// what arrived since their last brief that their assistant told them nothing of, which their
// listening journal kept
interface Reads {
	readonly sections: Sections;
	readonly timeZone: TimeZone;
	readonly mailsReadAt: Date | null;
	readonly sharesReadAt: Date | null;
	readonly untold: Untold;
}

export interface BriefInput {
	readonly principal: Principal;
	readonly roomId: string;
	// What the owner's assistant is told their day starts with, as its wake-up wrote it
	readonly told: string;
	// The date, in the owner's zone, the brief is of
	readonly date: string;
	readonly log: FastifyBaseLogger;
	// What links the brief's reads in the audit: the brief's own id
	readonly correlationId: string;
	// The name the owner gave the assistant, when there is one
	readonly assistantName?: string;
}

// The owner's yes to the question a brief asked in its place: the one about their permission, once
// they gave it to the platform, or the one of their first brief about its reads
export interface BriefResumeInput {
	readonly principal: Principal;
	readonly roomId: string;
	// The call the question froze, which their yes allowed
	readonly pendingCallId: string;
	// Where they said yes, which the reads it allows record
	readonly through: ResumeRequest['through'];
	readonly log: FastifyBaseLogger;
	// The name the owner gave the assistant, when there is one
	readonly assistantName?: string;
}

export type BriefResult =
	// The brief of its date, as the model wrote it, or as the harness lays it out when the model
	// wrote nothing, its HTML, which the harness lays out either way, and what its numbers, its
	// tasks' keys and its emails name, when it shows any. Refused by admission once the owner's day,
	// or the share of it their assistant spends on its own, was spent, the harness lays it out with
	// no model call, and says why.
	| {
			readonly kind: 'ok';
			readonly text: string;
			readonly html: string;
			readonly date: string;
			readonly references: References | null;
			readonly refusedFor?: SpentReason;
	  }
	// The broker refused the day's read for want of the owner's permission, or the owner's first
	// brief lacks reads they did not allow: the brief gives way to the harness's question about it,
	// whose call waits for their answer
	| { readonly kind: 'question'; readonly text: string; readonly pendingCallId: string }
	// The broker still refuses the read, and a brief waits for the owner's answer to the question it
	// gave way to, or the question of this date went out already: this one says nothing
	| { readonly kind: 'withheld' }
	// The owner left the question of their first brief unanswered twice, or went ten working days
	// without a word or a read in their room: their brief stops, and says so, asking nothing
	| { readonly kind: 'notice'; readonly text: string }
	| { readonly kind: 'forbidden' }
	| { readonly kind: 'missing' }
	// Admission refused it for another reason, as it would a turn
	| ({ readonly kind: 'busy' } & Refusal);

export interface BriefRunnerDeps {
	readonly config: Config;
	readonly db: Db;
	readonly llm: LlmClient;
	readonly tools: ToolRegistry;
	readonly admission: Admission;
	readonly gate: TurnGate;
	readonly clock: Clock;
	// Where the role counts the requests a brief that goes out closes unanswered
	readonly consentMetrics: ConsentMetrics;
	// The assistant's persona, as its owner's turns give it, in its owner's language
	persona(assistantName: string | undefined, messages: Messages): string;
	// Runs a call its owner allowed as it was frozen, as their yes runs any
	runFrozenCall(
		approved: ApprovedCall,
		pendingCallId: string,
		context: ToolContext,
		log: FastifyBaseLogger
	): Promise<ToolOutcome>;
}

export interface BriefRunner {
	run(input: BriefInput): Promise<BriefResult>;
	// The brief that gave way to the question about the owner's permission, which their yes resumes:
	// that day's brief, whenever they said it
	resume(input: BriefResumeInput): Promise<BriefResult>;
	// The brief the owner asks for in their turn, which ends on it: their turn holds its admission
	// and their gate already
	inTurn(context: ToolContext): Promise<BriefResult>;
}

// A brief being written: its owner, their conversation and their language, what their assistant is
// told their day starts with, or that they ask for their brief, the date it is of, and the spent day
// admission refused it for, when it did: the harness lays it out then, with no model call
interface Writing {
	readonly principal: Principal;
	readonly session: SessionRecord;
	readonly locale: Locale;
	readonly told: string;
	readonly date: string;
	readonly assistantName: string | undefined;
	readonly log: FastifyBaseLogger;
	readonly refusedFor: SpentReason | null;
	// Whether the owner asked for it in their turn, which keeps it in their conversation as its
	// call and its answer, in place of the brief itself
	readonly inTurn: boolean;
	// Whether it tells the rest of their day, as the brief they asked for does, whether in their turn
	// or on their yes to the question it gave way to: their meetings not over yet
	readonly restOfDay: boolean;
}

// The wall time of a time the calendar gave in its day's zone, with that zone's offset: 09:00
function wallTimeOf(time: string): string {
	return /T(\d{2}:\d{2})/.exec(time)?.[1] ?? time;
}

// The hours of a meeting that is not a whole day's, as its calendar's zone gives them: 09:00–09:30
function hoursOf(meeting: Meeting): string {
	return `${wallTimeOf(meeting.start)}–${wallTimeOf(meeting.end)}`;
}

// A date of the days around the brief in words, as the owner reads it: "jeudi 22 octobre"
function dayWords(date: string, locale: Locale): string {
	return new Intl.DateTimeFormat(locale, {
		timeZone: 'UTC',
		weekday: 'long',
		day: 'numeric',
		month: 'long'
	}).format(new Date(`${date.slice(0, 10)}T12:00:00Z`));
}

// Text the harness lays out, and its HTML
interface Laid {
	readonly text: string;
	readonly html: string;
}

function line(text: string): Laid {
	return { text, html: `<p>${escapeHtml(text)}</p>` };
}

// A section of the brief as the harness lays it out: its heading over its first items, numbered
// from 1 or not, if it has any, then how many more there are, if any, and what it counts without
// naming, if anything. People's text is text, never markup.
function section(
	heading: string,
	items: readonly string[],
	more: string | null,
	numbered: boolean,
	counted: string | null = null
): Laid {
	const list = numbered ? 'ol' : 'ul';
	const shown = items.slice(0, SHOWN);
	const after = [more, counted].filter((text): text is string => text !== null);
	return {
		text: [
			heading,
			...shown.map((item, index) => `${numbered ? `${index + 1}.` : '-'} ${item}`),
			...after
		].join('\n'),
		html: [
			`<p>${escapeHtml(heading)}</p>`,
			...(shown.length === 0
				? []
				: [`<${list}>${shown.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</${list}>`]),
			...after.map((text) => `<p>${escapeHtml(text)}</p>`)
		].join('\n')
	};
}

// What a section says, in the words given, of the items it does not show, of those its application
// gave, or nothing
function moreOf(
	count: number,
	truncated: boolean,
	more: (count: number, atLeast: boolean) => string
): string | null {
	const hidden = Math.max(count - SHOWN, 0);
	return hidden > 0 || truncated ? more(hidden, truncated) : null;
}

// Who sent an email, as the owner reads it: the name its sender gave, or else their address
function senderOf(email: Email, words: Messages['brief']['template']): string {
	const sender = email.untrusted.from[0];
	const name = sender?.name?.trim() ?? '';
	if (name.length > 0) return name;
	const address = sender?.email ?? '';
	return address.length > 0 ? address : words.unknownSender;
}

// The day's meetings, each one with its times and title, and the titles of those it overlaps that
// the day lists
function meetingLines(
	meetings: readonly Meeting[],
	words: Messages['brief']['template']
): readonly string[] {
	const titleOf = (meeting: Meeting): string => meeting.untrusted.title ?? words.untitled;
	return meetings.map((meeting) => {
		const title = titleOf(meeting);
		const overlapped = meeting.conflicts.flatMap((conflict) =>
			meetings.filter(
				(other) => other.uid === conflict.uid && other.recurrence_id === conflict.recurrence_id
			)
		);
		const overlaps =
			meeting.conflicts.length === 0 ? '' : ` (${words.overlaps(overlapped.map(titleOf))})`;
		return meeting.all_day
			? `${words.allDay(title)}${overlaps}`
			: `${hoursOf(meeting)} ${title}${overlaps}`;
	});
}

// What a share gave the owner, as its line says it: a shared drive, a folder, or nothing for a file
function sharedKind(
	share: ToldShare,
	item: ToldItem,
	words: Messages['brief']['template']
): string | null {
	if (share.shared_drive) return words.sharedDrive;
	return item.type === 'directory' ? words.folder : null;
}

// Who shared with the owner, as they read it: the name Drive gave them, or else their address, or
// else someone
function sharerOf(share: ToldShare, words: Messages['brief']['template']): string {
	const { name, email } = share.untrusted.shared_by;
	const named = name?.trim() ?? '';
	if (named.length > 0) return named;
	return email !== null && email.length > 0 ? email : words.someone;
}

// What a section of the brief reads of an application the owner's assistant does not listen to:
// nothing, which the brief says nothing of
const NOT_LISTENED = { ok: false, reason: 'not_listened' } as const;

// Whether the brief says nothing of a read it went without: one the owner took back, which it says
// once in a line of its own, or one of an application their assistant does not listen to
function unsaid(read: Read<unknown>): boolean {
	return unallowed(read) || (!read.ok && read.reason === NOT_LISTENED.reason);
}

// The brief as the harness lays it out itself, for the owner, when the model wrote nothing: the
// sections the model is asked for, five items at most each, an empty one left out but for the day,
// which says in one line that it has no meeting, an application not read said once, but those it
// says nothing of, and two examples at most of what to answer that fit what the brief shows
function template(
	sections: Sections,
	untold: Untold,
	date: string,
	locale: Locale,
	words: Messages['brief']['template']
): Laid {
	const { calendar, invitations, mails, tasks, shares } = sections;
	const laid: Laid[] = [];
	const examples: string[] = [];
	const unread = new Set<string>();
	const notRead = (name: keyof Sections): void => {
		if (unsaid(sections[name]) || unread.has(DOMAINS[name])) return;
		unread.add(DOMAINS[name]);
		laid.push(line(words.notRead[name]));
	};
	// Its date in words: the brief's own, whatever day it goes out on
	const dateWords = describeMoment(new Date(`${date}T12:00:00Z`), 'UTC', locale).date;
	if (!calendar.ok) notRead('calendar');
	else if (calendar.value.meetings.length === 0) laid.push(line(words.none(dateWords)));
	else {
		const { meetings, truncated } = calendar.value;
		laid.push(
			section(
				words.heading(dateWords),
				meetingLines(meetings, words),
				moreOf(meetings.length, truncated, words.more),
				false
			)
		);
	}
	if (!invitations.ok) notRead('invitations');
	else {
		const { pending, truncated } = invitations.value;
		const first = pending[0];
		if (first !== undefined) {
			// The invitations shown are the first ones, whose numbers count from 1
			const lines = pending.map((invitation) =>
				words.invitation(
					invitation.untrusted.title ?? words.untitled,
					dayWords(invitation.start, locale),
					invitation.all_day ? null : hoursOf(invitation),
					invitation.series,
					invitation.untrusted.organizer
				)
			);
			laid.push(
				section(
					words.invitations(INVITATION_DAYS),
					lines,
					moreOf(pending.length, truncated, words.more),
					true
				)
			);
			examples.push(words.decline(first.number));
		}
	}
	if (!mails.ok) notRead('mails');
	else if (mails.value.unread.length > 0 || mails.value.truncated) {
		// Mail may have more unread mail than the brief read, even when all it read was sent in bulk
		const { since, unread, truncated } = mails.value;
		const lines = unread.map((email) =>
			words.mail(
				senderOf(email, words),
				email.untrusted.subject.trim().length > 0 ? email.untrusted.subject : words.noSubject,
				email.flagged
			)
		);
		laid.push(
			section(
				words.mails(dayWords(since, locale), wallTimeOf(since)),
				lines,
				moreOf(lines.length, truncated, words.unreadMore),
				false
			)
		);
		if (lines.length > 0) examples.push(words.summarize);
	}
	if (!tasks.ok) notRead('tasks');
	else {
		const { overdue, today, truncated } = tasks.value;
		const first = overdue[0] ?? today[0];
		if (first !== undefined) {
			const lines = [
				...overdue.map((task) =>
					words.late(
						task.key,
						task.untrusted.title,
						task.due_date === null ? null : dayWords(task.due_date, locale)
					)
				),
				...today.map((task) => words.dueToday(task.key, task.untrusted.title, task.due_time))
			];
			laid.push(section(words.tasks, lines, moreOf(lines.length, truncated, words.more), false));
			examples.push(words.postpone(first.key));
		}
	}
	if (untold.activities.length > 0) {
		const lines = untold.activities.map(({ activity, meeting, task }) =>
			words.untold(
				meeting === null ? (task?.key ?? null) : `${meeting.number}.`,
				titleOf(activity) ?? words.untitled,
				words.kinds[kindOf(activity)]
			)
		);
		laid.push(
			section(words.since, lines, moreOf(lines.length, untold.truncated, words.more), false)
		);
	}
	if (untold.replies.length > 0) {
		// The declines and the maybes named, then the acceptances counted
		const named = untold.replies.filter(({ activity }) => answerGiven(activity) !== 'ACCEPTED');
		const accepted = untold.replies.length - named.length;
		const lines = named.map(({ activity, meeting }) =>
			words.reply(
				meeting === null ? null : `${meeting.number}.`,
				titleOf(activity) ?? words.untitled,
				attendeeOf(activity) ?? words.someone,
				words.answers[answerGiven(activity) ?? 'NEEDS-ACTION']
			)
		);
		laid.push(
			section(
				words.replies,
				lines,
				moreOf(lines.length, false, words.more),
				false,
				accepted === 0 ? null : words.accepted(accepted)
			)
		);
	}
	if (!shares.ok) notRead('shares');
	else {
		const told = shares.value.shares.flatMap((share) =>
			share.items.map((item) => ({ share, item }))
		);
		if (told.length > 0) {
			const lines = told.map(({ share, item }) => {
				const number = numberOf(item);
				return words.share(
					number === null ? null : `${number}.`,
					item.untrusted.name,
					sharedKind(share, item, words),
					sharerOf(share, words)
				);
			});
			laid.push(
				section(
					words.shares,
					lines,
					moreOf(lines.length, shares.value.truncated, words.more),
					false
				)
			);
			// The example reads the first file the brief numbers: a folder has nothing to read
			const file = told.find(({ item }) => item.type === 'file' && numberOf(item) !== null);
			const number = file === undefined ? null : numberOf(file.item);
			if (number !== null) examples.push(words.read(number));
		}
	}
	if (untold.assigned.length > 0) {
		const lines = untold.assigned.map(({ activity, number, task }) =>
			words.assignedTask(`${number}.`, titleOf(activity) ?? words.untitled, task.key)
		);
		laid.push(section(words.assigned, lines, moreOf(lines.length, false, words.more), false));
	}
	if (examples.length > 0) laid.push(line(words.footer(examples.slice(0, 2))));
	return {
		text: laid.map((part) => part.text).join('\n\n'),
		html: laid.map((part) => part.html).join('\n')
	};
}

// The status a contract answered a call with, and its body, when it answered
function answerOf(result: unknown): { readonly status: number; readonly body: unknown } | null {
	if (typeof result !== 'object' || result === null) return null;
	const { status, body } = result as Record<string, unknown>;
	return typeof status === 'number' ? { status, body } : null;
}

// Why a call that would have waited for its owner was not made, as the contract tool tells a turn
// nobody attends
function notAskedReason(result: unknown): string | null {
	if (typeof result !== 'object' || result === null) return null;
	const { status, reasons } = result as Record<string, unknown>;
	return status === 'not_asked' && Array.isArray(reasons) ? reasons.join(',') : null;
}

// What a read of the brief came to, as the contract tool ran it
function readOf<T>({ result, final, pendingCallId }: ToolOutcome, schema: z.ZodType<T>): Read<T> {
	if (final !== undefined && pendingCallId !== undefined) {
		return { ok: false, reason: 'delegation', question: { text: final, pendingCallId } };
	}
	const reason = notAskedReason(result);
	if (reason !== null) return { ok: false, reason };
	const answer = answerOf(result);
	if (answer === null || answer.status < 200 || answer.status >= 300) {
		return { ok: false, reason: 'failed', ...(answer === null ? {} : { status: answer.status }) };
	}
	const parsed = schema.safeParse(answer.body);
	if (!parsed.success) return { ok: false, reason: 'unreadable', status: answer.status };
	return { ok: true, value: parsed.data };
}

// The owner's day as the brief tells it, from the calendar's list of it
function dayOf(list: Read<z.infer<typeof listSchema>>): Read<Day> {
	if (!list.ok) return list;
	const { time_zone, events, truncated } = list.value;
	return {
		ok: true,
		value: {
			time_zone,
			meetings: events.slice(0, MAX_MEETINGS),
			truncated: truncated || events.length > MAX_MEETINGS
		}
	};
}

// The rest of the owner's day at that instant, which the brief they ask for tells: its meetings not
// over yet, the one under way included
function restOf(day: Read<Day>, now: Date): Read<Day> {
	if (!day.ok) return day;
	const meetings = day.value.meetings.filter(
		(meeting) => meeting.all_day || Date.parse(meeting.end) > now.getTime()
	);
	return { ok: true, value: { ...day.value, meetings } };
}

// The invitations that wait for the owner's answer, from the occurrences the calendar listed in the
// order they start: each series once, by its first occurrence over the days read, numbered from 1
function invitationsOf(events: readonly Meeting[], truncated: boolean): Invitations {
	const seen = new Set<string>();
	const firsts = events.filter((event) => {
		if (!event.needs_action || seen.has(event.uid)) return false;
		seen.add(event.uid);
		return true;
	});
	return {
		pending: firsts.slice(0, MAX_INVITATIONS).map((event, index) => ({
			number: index + 1,
			series: event.recurrence_id !== null,
			...event
		})),
		truncated: truncated || firsts.length > MAX_INVITATIONS
	};
}

// What the brief's numbers, its tasks' keys and its emails name, or null when it names nothing:
// each email the model was handed, whichever it shows, and each activity no brief named before
function referencesOf(sections: Sections, untold: Untold): References | null {
	const { invitations, mails, tasks, shares } = sections;
	const numbered = invitations.ok ? invitations.value.pending : [];
	const handed = mails.ok ? mails.value.unread : [];
	const keyed = tasks.ok ? [...tasks.value.overdue, ...tasks.value.today] : [];
	const since = untoldReferences(untold);
	const replies = replyReferences(untold);
	const shared = shares.ok ? shareReferences(shares.value) : [];
	const assigned = assignedReferences(untold);
	const count =
		numbered.length +
		handed.length +
		keyed.length +
		since.length +
		replies.length +
		shared.length +
		assigned.length;
	if (count === 0) return null;
	return {
		...(numbered.length === 0
			? {}
			: {
					invitations: numbered.map(({ number, uid, recurrence_id }) => ({
						number,
						uid,
						recurrence_id
					}))
				}),
		...(handed.length === 0
			? {}
			: { mails: handed.map(({ id, untrusted }) => ({ id, from: untrusted.from[0] ?? null })) }),
		...(keyed.length === 0
			? {}
			: { tasks: keyed.map(({ key, board_id, task_id }) => ({ key, board_id, task_id })) }),
		...(since.length === 0 ? {} : { since_last_brief: since }),
		...(replies.length === 0 ? {} : { replies }),
		...(shared.length === 0 ? {} : { shares: shared }),
		...(assigned.length === 0 ? {} : { self_assigned: assigned })
	};
}

// The last number the brief gives before the shares': that of its last invitation, or of the last
// meeting that arrived since the owner's last brief, an answer's included, or none
function lastNumber(invitations: Read<Invitations>, untold: Untold): number {
	const pending = invitations.ok ? invitations.value.pending : [];
	return Math.max(
		0,
		...pending.map(({ number }) => number),
		...[...untold.activities, ...untold.replies].flatMap(({ meeting }) =>
			meeting === null ? [] : [meeting.number]
		)
	);
}

// The last number the brief gives before the tasks the owner assigned themselves: that of the last
// file or folder shared with them it numbers, or else the last before the shares
function lastSharedNumber(before: number, shares: Read<Shares>): number {
	const numbers = shares.ok ? shareReferences(shares.value).map(({ number }) => number) : [];
	return Math.max(before, ...numbers);
}

// A message of the conversation without the references an earlier brief left in it: after the line
// that told it, or in the result of the call that posted the one its owner asked for
function withoutReferences(message: LlmMessage): LlmMessage {
	if (message.role === 'tool' && message.name === BRIEF_NOW_TOOL && message.content !== null) {
		const result: unknown = JSON.parse(message.content);
		return typeof result === 'object' && result !== null && 'references' in result
			? { ...message, content: JSON.stringify({ ...result, references: undefined }) }
			: message;
	}
	return message.role === 'user' && message.content !== null
		? { ...message, content: message.content.replace(KEPT_REFERENCES, '') }
		: message;
}

// The conversation of the turn that ended on the brief its owner asked for: what came before the
// turn, its first messages, without the references of the earlier briefs, which that brief replaces
// as a newer brief does
export function withBriefAskedFor(messages: readonly LlmMessage[], earlier: number): LlmMessage[] {
	return messages.map((message, index) => (index < earlier ? withoutReferences(message) : message));
}

// Each section of the brief with its read, in the order the brief tells them
function readsOf(sections: Sections): readonly (readonly [keyof Sections, Read<unknown>])[] {
	return Object.entries(sections) as [keyof Sections, Read<unknown>][];
}

// Whether the brief went without a read for want of the owner's yes, which it no longer asks once
// their first brief settled its reads: they took that read back, which their brief says once
function unallowed(read: Read<unknown>): boolean {
	return !read.ok && read.reason.split(',').includes('consent');
}

// The applications the owner took back the read of, which the brief went without
function withdrawnOf(sections: Sections): BriefDomain[] {
	const skipped = readsOf(sections).filter(([, read]) => unallowed(read));
	return BRIEF_DOMAINS.filter((domain) => skipped.some(([name]) => DOMAINS[name] === domain));
}

// What the model is handed of the brief's reads: each section read, what arrived since the owner's
// last brief that their assistant told them nothing of, when anything did, and why each other one
// was not, but those the owner took back, which the harness tells them of itself, and those of an
// application their assistant does not listen to
function dataOf(date: string, { sections, untold, timeZone }: Reads): Record<string, unknown> {
	const data: Record<string, unknown> = { date };
	const notRead: Record<string, string> = {};
	for (const [name, read] of readsOf(sections)) {
		if (read.ok) data[name] = read.value;
		else if (!unsaid(read)) notRead[name] = read.reason;
	}
	if (untold.activities.length > 0) data['since_last_brief'] = untoldData(untold, timeZone);
	if (untold.replies.length > 0) data['replies'] = repliesData(untold, timeZone);
	if (untold.assigned.length > 0) data['self_assigned'] = assignedData(untold, timeZone);
	return Object.keys(notRead).length === 0 ? data : { ...data, not_read: notRead };
}

// The line that says the brief goes without a section's read, and why
function logSkipped(name: keyof Sections, read: Read<unknown>, log: FastifyBaseLogger): void {
	if (read.ok) return;
	log.info(
		{
			domain: DOMAINS[name],
			section: name,
			reason: read.reason,
			...(read.status === undefined ? {} : { status: read.status })
		},
		'brief application skipped'
	);
}

// The brief of an owner's working day, which the worker role's scheduler asks their assistant for.
// Admitted as a turn is, it reads the day's meetings of their calendar, the invitations that wait
// for their answer, their unread mail since their last brief, their late tasks and those of the
// day itself, and the shares made to them since their last brief, through the same tools and checks as the model's calls, with nobody to ask: an
// application they did not allow is left out, and one their assistant does not listen to is not
// read. Then one model call, with no tool and no history,
// writes the brief from those reads, given as data, which the conversation keeps as the assistant's
// answer, with what its numbers, keys and emails name.
// Should the model fail or write nothing, the harness lays out the same sections itself. The day's
// read the platform's broker refuses for want of the owner's permission for their assistant to act
// for them is the exception: the brief reads nothing else and gives way to the harness's question
// about it, once, and says nothing on the next mornings until the day's read works again. The
// owner's yes to that question, once they gave the platform their permission, sends that day's
// brief, however late.
export function makeBriefRunner(deps: BriefRunnerDeps): BriefRunner {
	const { config, db, llm, tools, admission, gate, clock, consentMetrics } = deps;

	// One read of the brief, through the same tool and checks as the model's calls, with nobody to
	// ask, but for the question about the owner's permission when the context asks it
	async function read<T>(
		context: ToolContext,
		name: string,
		args: Record<string, unknown>,
		schema: z.ZodType<T>
	): Promise<Read<T>> {
		const tool = tools.find(name);
		if (tool === null) return { ok: false, reason: 'unavailable' };
		let outcome: ToolOutcome;
		try {
			outcome = await runTool(tool, args, { ...context, unattended: true });
		} catch {
			return { ok: false, reason: 'failed' };
		}
		return readOf(outcome, schema);
	}

	// The day's read, which asks the owner nothing, but for the question about their permission
	// while no brief waits for their answer to it
	async function readDay(
		context: ToolContext,
		date: string,
		asksDelegation: boolean
	): Promise<Read<Day>> {
		return dayOf(
			await read(
				asksDelegation ? { ...context, asksDelegation } : context,
				LIST_EVENTS,
				{ from: date, days: 1, limit: MAX_MEETINGS },
				listSchema
			)
		);
	}

	async function readInvitations(context: ToolContext, date: string): Promise<Read<Invitations>> {
		const list = await read(
			context,
			LIST_EVENTS,
			{
				from: date,
				days: INVITATION_DAYS,
				limit: MAX_PENDING_OCCURRENCES,
				needs_action: true
			},
			listSchema
		);
		if (!list.ok) return list;
		return { ok: true, value: invitationsOf(list.value.events, list.value.truncated) };
	}

	// The owner's late tasks, then those of the day, the day being the one it is in the zone given:
	// left out together when either read is
	async function readTasks(context: ToolContext, zone: string): Promise<Read<Tasks>> {
		const overdue = await read(
			context,
			LIST_TASKS,
			{ zone, due: 'overdue', limit: MAX_TASKS },
			taskListSchema
		);
		if (!overdue.ok) return overdue;
		const today = await read(
			context,
			LIST_TASKS,
			{ zone, due: 'today', limit: MAX_TASKS },
			taskListSchema
		);
		if (!today.ok) return today;
		const late = overdue.value.tasks.slice(0, MAX_TASKS);
		return {
			ok: true,
			value: {
				overdue: late,
				today: today.value.tasks.slice(0, MAX_TASKS - late.length),
				truncated:
					overdue.value.truncated ||
					today.value.truncated ||
					overdue.value.tasks.length + today.value.tasks.length > MAX_TASKS
			}
		};
	}

	// The unread emails of the owner's inbox since the instant given, told in the zone given, and the
	// people of the day's meetings, whose emails count: their inbox found among their mailboxes by its
	// role, fifty emails at most, those sent in bulk left out, in the order the harness lays them out
	async function readMails(
		context: ToolContext,
		since: Date,
		zone: string,
		calendar: Read<Day>
	): Promise<Read<Mails>> {
		const mailboxes = await read(context, LIST_MAILBOXES, {}, mailboxListSchema);
		if (!mailboxes.ok) return mailboxes;
		const inbox = mailboxes.value.mailboxes.find((mailbox) => mailbox.role === 'inbox');
		if (inbox === undefined) return { ok: false, reason: 'no_inbox' };
		const after = isoIn(since, zone);
		const list = await read(
			context,
			LIST_EMAILS,
			{ mailbox: inbox.id, unread: true, after, limit: MAX_MAILS },
			emailListSchema
		);
		if (!list.ok) return list;
		const { emails, next_cursor } = list.value;
		const meetings = calendar.ok ? calendar.value.meetings : [];
		return {
			ok: true,
			value: {
				since: after,
				unread: emails
					.slice(0, MAX_MAILS)
					.filter((email) => !email.bulk)
					.sort(byImportance),
				truncated: next_cursor !== null || emails.length > MAX_MAILS,
				participants: participantsOf(
					meetings.map((meeting) => meeting.untrusted.organizer),
					context.principalId
				)
			}
		};
	}

	// The shares made to the owner since the instant given, told in the zone given, each file and
	// folder numbered after the last number given, outside a shared drive
	async function readShares(
		context: ToolContext,
		since: Date,
		zone: string,
		last: number
	): Promise<Read<Shares>> {
		const after = isoIn(since, zone);
		const list = await read(
			context,
			LIST_SHARES,
			{ since: after, limit: MAX_SHARES },
			shareListSchema
		);
		if (!list.ok) return list;
		return { ok: true, value: sharesOf(list.value, after, last) };
	}

	// The brief's reads after the day's, of the applications given, which the owner's assistant
	// listens to, alone, the zone it is written in, the instants it read the owner's mail and the
	// shares made to them at, when it did, and the activities of their journal from those
	// applications that no brief named yet
	async function readSections(
		context: ToolContext,
		date: string,
		calendar: Read<Day>,
		listened: readonly Source[]
	): Promise<Reads> {
		const owner = context.principalId;
		const listens = (name: keyof Sections): boolean => listened.includes(DOMAINS[name]);
		const invitations: Read<Invitations> = listens('invitations')
			? await readInvitations(context, date)
			: NOT_LISTENED;
		// Read once the calendar's reads may have named it, as a turn reads it: the zone of the
		// owner's calendar, which the time their mail is read from is told in, the days of their tasks
		// counted in, and the brief written in, and the days their brief goes out on
		const settings = await fetchBriefSettings(db, owner, config.timeZone);
		// One activity more than the model is handed, which tells there are more
		const { readAt, sharesReadAt, activities } = await withPrincipal(
			db,
			{ id: owner },
			async (tx) => ({
				readAt: await findBriefMailsReadAt(tx, owner),
				sharesReadAt: await findBriefSharesReadAt(tx, owner),
				activities: await listUntoldActivities(tx, owner, publishedUnder(listened), MAX_UNTOLD + 1)
			})
		);
		const now = clock.now();
		const mails: Read<Mails> = listens('mails')
			? await readMails(context, mailsSince(readAt, now, settings), settings.timeZone, calendar)
			: NOT_LISTENED;
		const tasks: Read<Tasks> = listens('tasks')
			? await readTasks(context, settings.timeZone)
			: NOT_LISTENED;
		const met = untoldOf(activities, invitations.ok ? invitations.value.pending : []);
		// The shares are numbered after the invitations and the meetings the brief numbers, and the
		// tasks the owner assigned themselves after the shares
		const before = lastNumber(invitations, met);
		const shares: Read<Shares> = listens('shares')
			? await readShares(
					context,
					sharesSince(sharesReadAt, now, settings),
					settings.timeZone,
					before
				)
			: NOT_LISTENED;
		return {
			sections: { calendar, invitations, mails, tasks, shares },
			timeZone: settings.timeZone,
			mailsReadAt: mails.ok ? now : null,
			sharesReadAt: shares.ok ? now : null,
			untold: assignedAfter(met, lastSharedNumber(before, shares))
		};
	}

	// The brief as the model writes it from its reads, in one call with no tool and no history, and
	// the tokens it took: no text when the model failed or wrote nothing. As in a turn, the model
	// reads each date it is handed written in words beside it, in its owner's zone and language,
	// and the day of each date it writes is named from the date.
	async function written(
		system: string,
		told: string,
		log: FastifyBaseLogger,
		owner: { readonly date: string; readonly timeZone: TimeZone; readonly locale: Locale }
	): Promise<{ readonly text: string | null; readonly tokens: number }> {
		const prompt: LlmMessage[] = withDatesInWords(
			[
				{ role: 'system', content: system },
				{ role: 'user', content: told }
			],
			owner.timeZone,
			owner.locale
		);
		try {
			const completion = await llm.complete(prompt, []);
			const text = withTrueWeekdays(withoutCallMarkup(completion.content ?? '').trim(), owner.date);
			const tokens =
				(completion.usage?.promptTokens ?? 0) + (completion.usage?.completionTokens ?? 0);
			if (text.length > 0) return { text, tokens };
			log.warn({ tokens }, 'brief model wrote nothing');
			return { text: null, tokens };
		} catch (err: unknown) {
			if (!(err instanceof LlmError)) throw err;
			log.warn({ err }, 'brief model failed');
			return { text: null, tokens: 0 };
		}
	}

	// A request that closed unanswered with the brief expired, as one past its lifetime does, and
	// counts the same
	function closedUnanswered(
		owner: string,
		closed: ClosedRequest | null,
		log: FastifyBaseLogger
	): void {
		if (closed === null) return;
		log.info({ owner, pendingCallId: closed.pendingCallId }, 'request expired');
		consentMetrics.expired(closed);
	}

	// The conversation keeps what the assistant was told and its answer after the messages given, as
	// it keeps a turn's, in the transaction of what goes with them; the turn the owner asked for the
	// brief in keeps them itself, as its call and its answer, which the brief only holds the
	// conversation for. False once the conversation is gone.
	async function keep(
		tx: Tx,
		writing: Writing,
		told: string,
		answer: string,
		earlier: readonly LlmMessage[] = writing.session.messages
	): Promise<boolean> {
		if (writing.inTurn) return holdSession(tx, writing.session.id);
		return saveSessionMessages(tx, writing.session.id, [
			...earlier,
			{ role: 'user', content: told },
			{ role: 'assistant', content: answer }
		]);
	}

	// The day as the brief tells it: the rest of it, for the brief the owner asked for
	function toldDay(writing: Writing, day: Read<Day>): Read<Day> {
		return writing.restOfDay ? restOf(day, clock.now()) : day;
	}

	// The brief gives way to the harness's question about the owner's permission, which the
	// conversation keeps as the assistant's answer, as it keeps a turn's, and waits for their answer
	// to it from then on, in the same transaction as what else ends with it
	async function giveWay(
		writing: Writing,
		question: DelegationQuestion,
		alongside?: (tx: Tx) => Promise<unknown>
	): Promise<BriefResult> {
		const { principal, date } = writing;
		const saved = await withPrincipal(db, principal, async (tx) => {
			const kept = await keep(tx, writing, writing.told, question.text);
			if (kept) {
				await alongside?.(tx);
				await keepBriefWait(tx, principal.id, { date, pendingCallId: question.pendingCallId });
			}
			return kept;
		});
		if (!saved) return { kind: 'missing' };
		writing.log.info({ pendingCallId: question.pendingCallId }, 'brief gave way to a question');
		return { kind: 'question', ...question };
	}

	// The brief of its date, written from its reads in their zone, by the model unless admission
	// refused it for a spent day, which the conversation keeps as the assistant's answer, in the same
	// transaction as the instant it read the owner's mail at, when it did, the erasure of what showed
	// the activities it named, what else ends with it, and its reads settled: the owner's brief asks
	// them no more for its reads, and the question of their first brief closes, should it still wait.
	// The first brief without a read the owner took back says so after it, in a line of its own. A
	// request that closed unanswered with it expired, as one past its lifetime does, and counts the
	// same.
	async function writeBrief(
		writing: Writing,
		reads: Reads,
		ending: (tx: Tx) => Promise<ClosedRequest | null>
	): Promise<BriefResult> {
		const { principal, session, locale, date, log, refusedFor } = writing;
		const { sections, timeZone, mailsReadAt, sharesReadAt, untold } = reads;
		const messages = getMessages(locale);
		for (const [name, skipped] of readsOf(sections)) logSkipped(name, skipped, log);
		const told = `${writing.told}\n${messages.brief.day(fenced(BRIEF_DATA, dataOf(date, reads)))}`;
		const moment = describeMoment(clock.now(), timeZone, locale);
		const system = buildSystemPrompt({
			persona: deps.persona(writing.assistantName, messages),
			moment: messages.now(moment.words, moment.iso, moment.timeZone),
			memory: { memory: [], user: [] },
			history: [],
			nudgeInterval: 0
		});
		const model =
			refusedFor === null
				? await written(system, told, log, { date, timeZone, locale })
				: { text: null, tokens: 0 };
		// The model's brief repeats titles people wrote, unasked, every morning: its Markdown renders
		// with nothing that acts, as the harness quotes the model in its requests, never their HTML or
		// links
		const laid: Laid =
			model.text === null
				? template(sections, untold, date, locale, messages.brief.template)
				: { text: model.text, html: renderQuotedMarkdown(model.text) };
		// The conversation keeps the brief as the owner reads it, and what its numbers, keys and emails
		// name, as data, in place of what any earlier brief's named: not the data it was written from,
		// which every later turn would carry
		const references = referencesOf(sections, untold);
		const kept =
			references === null
				? writing.told
				: `${writing.told}\n${messages.brief.references(fenced(BRIEF_REFERENCES, references))}`;
		const withdrawn = withdrawnOf(sections);
		const saved = await withPrincipal(db, principal, async (tx) => {
			// The reads taken back that no brief has said yet, which this one says
			const said = (await findBriefReads(tx, principal.id)).told;
			const lines = withdrawn
				.filter((domain) => !said.includes(domain))
				.map((domain) => line(messages.brief.withdrawn(domain)));
			const brief = [laid, ...lines];
			const text = brief.map((part) => part.text).join('\n\n');
			const stored = await keep(tx, writing, kept, text, session.messages.map(withoutReferences));
			if (!stored) return null;
			// The owner's next brief reads their mail from the instant this one read it
			if (mailsReadAt !== null) await saveBriefMailsReadAt(tx, principal.id, mailsReadAt);
			// and the shares made to them from the instant this one read them
			if (sharesReadAt !== null) await saveBriefSharesReadAt(tx, principal.id, sharesReadAt);
			const named = [...untold.activities, ...untold.replies, ...untold.assigned].map(
				({ activity }) => activity
			);
			await eraseActivityNames(tx, principal.id, named);
			// What the owner's quiet hours held, the brief named: no release wakes them for it
			await eraseHeldActivities(tx, principal.id, named);
			await settleBriefReads(tx, principal.id, withdrawn);
			return {
				text,
				html: brief.map((part) => part.html).join('\n'),
				closed: [await ending(tx), await endBriefQuestion(tx, principal.id)]
			};
		});
		if (saved === null) return { kind: 'missing' };
		for (const closed of saved.closed) closedUnanswered(principal.id, closed, log);
		// The brief the owner asked for in their turn spends their day as their words do, any other the
		// share of it their assistant spends on its own
		if (model.tokens > 0) {
			await admission.recordUsage(principal.id, model.tokens, writing.inTurn ? 'owner' : 'brief');
		}
		log.info(
			{
				by: model.text === null ? 'template' : 'model',
				meetings: sections.calendar.ok ? sections.calendar.value.meetings.length : null,
				invitations: sections.invitations.ok ? sections.invitations.value.pending.length : null,
				mails: sections.mails.ok ? sections.mails.value.unread.length : null,
				tasks: sections.tasks.ok
					? sections.tasks.value.overdue.length + sections.tasks.value.today.length
					: null,
				activities: untold.activities.length,
				replies: untold.replies.length,
				self_assigned: untold.assigned.length,
				shares: sections.shares.ok ? sections.shares.value.shares.length : null,
				tokens: model.tokens,
				...(refusedFor === null ? {} : { refused: refusedFor })
			},
			'brief written'
		);
		return {
			kind: 'ok',
			text: saved.text,
			html: saved.html,
			date,
			references,
			...(refusedFor === null ? {} : { refusedFor })
		};
	}

	// The question of the owner's first brief, in its place: what their brief tells, the days and
	// time it goes out on and how to set them, then, in one question, the reads they did not allow,
	// whose call waits a day for their answer. The conversation keeps it as the assistant's answer,
	// as it keeps a turn's, and their brief waits for their answer from then on, the question counted
	// among those it asked unanswered.
	async function ask(
		writing: Writing,
		correlationId: string,
		missing: readonly BriefDomain[],
		asked: number
	): Promise<BriefResult> {
		const { principal, session, locale, date, log } = writing;
		const settings = await fetchBriefSettings(db, principal.id, config.timeZone);
		const text = getMessages(locale).brief.ask(settings.days, timeOfDay(settings.time), missing);
		const call: PendingCallInput = {
			owner: principal.id,
			tool: BRIEF_QUESTION,
			contract: BRIEF_QUESTION,
			domain: BRIEF_QUESTION,
			level: 'read',
			reasons: ['consent'],
			arguments: { domains: missing },
			previewDigest: null,
			correlationId,
			origin: writing.inTurn ? 'owner' : 'event',
			sessionId: session.id,
			request: text
		};
		const pendingCallId = await withPrincipal(db, principal, async (tx) => {
			const kept = await keep(tx, writing, writing.told, text);
			if (!kept) return null;
			const id = await insertPendingCall(tx, call);
			await keepBriefQuestion(tx, principal.id, { date, pendingCallId: id, asked: asked + 1 });
			return id;
		});
		if (pendingCallId === null) return { kind: 'missing' };
		consentMetrics.requested(call);
		log.info({ pendingCallId, domains: missing, asked: asked + 1 }, 'brief asked for its reads');
		return { kind: 'question', text, pendingCallId };
	}

	// The owner's brief stops by itself until they resume it, and says why, which the conversation
	// keeps as the assistant's answer: they left the question of their first brief unanswered as many
	// times as it goes out, or went ten working days without a word or a read in their room. A
	// question of their brief that still waits closes as expired.
	async function pause(writing: Writing, text: string): Promise<BriefResult> {
		const { principal, log } = writing;
		const saved = await withPrincipal(db, principal, async (tx) => {
			const kept = await keep(tx, writing, writing.told, text);
			return kept ? { closed: await stopBrief(tx, principal.id) } : null;
		});
		if (saved === null) return { kind: 'missing' };
		closedUnanswered(principal.id, saved.closed, log);
		return { kind: 'notice', text };
	}

	// The applications of the brief the owner's assistant listens to, which alone it reads
	async function listenedBy(owner: string): Promise<Source[]> {
		const listened = await withPrincipal(db, { id: owner }, (tx) => listListened(tx, owner));
		return READ_SOURCES.filter((source) => listened.includes(source));
	}

	// The brief once the owner's reads are settled. The day's read asks them nothing, but for the
	// question about their permission while no brief waits for their answer to it, which the brief
	// gives way to, in the same transaction as what goes with it; the brief that waits says nothing
	// until the day's read works again, whatever keeps it from working. Then the brief's other reads,
	// and the brief written from them: the brief the owner asks for tells the rest of their day.
	// Without the owner's calendar, which their assistant does not listen to, the brief reads no day,
	// and waits for none.
	async function goOut(
		writing: Writing,
		context: ToolContext,
		waiting: BriefWait | null,
		ending: (tx: Tx) => Promise<ClosedRequest | null>,
		alongside?: (tx: Tx) => Promise<unknown>
	): Promise<BriefResult> {
		const { date, log } = writing;
		const listened = await listenedBy(context.principalId);
		if (!listened.includes('calendar')) {
			return writeBrief(writing, await readSections(context, date, NOT_LISTENED, listened), ending);
		}
		const calendar = toldDay(writing, await readDay(context, date, waiting === null));
		if (!calendar.ok && calendar.question !== undefined) {
			logSkipped('calendar', calendar, log);
			return giveWay(writing, calendar.question, alongside);
		}
		if (!calendar.ok && waiting !== null) {
			logSkipped('calendar', calendar, log);
			log.info({ pendingCallId: waiting.pendingCallId, since: waiting.date }, 'brief withheld');
			return { kind: 'withheld' };
		}
		const reads = await readSections(context, date, calendar, listened);
		return writeBrief(writing, reads, ending);
	}

	// A brief whose owner went ten working days without a word or a read in their room stops, saying
	// so. Until the owner's reads are settled, their brief asks for those they did not allow, once a
	// date, in its place: on its first day, then once more on their next brief day, then it stops.
	async function runAdmitted(
		input: BriefInput,
		refusedFor: SpentReason | null
	): Promise<BriefResult> {
		const { principal, roomId, date } = input;
		const opened = await withPrincipal(db, principal, async (tx) => {
			const record = await ensurePrincipal(tx, principal);
			if (!record.actions.includes('chat')) return null;
			const locale = localeOf(await findAssistant(tx, principal.id), config.locale);
			const session = await ensureRoomSession(tx, principal.id, roomId);
			const waiting = await findBriefWait(tx, principal.id);
			const { timeZone } = await findOwnerSettings(tx, principal.id);
			const seenAt = await ownerSeenSince(tx, principal.id, clock.now());
			const idle = isIdleOn(date, seenAt, timeZone ?? config.timeZone);
			const { settled } = await findBriefReads(tx, principal.id);
			const missing = settled ? [] : await missingReads(tx, principal.id);
			const question = await findBriefQuestion(tx, principal.id);
			return { actions: record.actions, locale, session, waiting, idle, seenAt, missing, question };
		});
		if (opened === null) return { kind: 'forbidden' };
		const { actions, locale, session, waiting, idle, seenAt, missing, question } = opened;
		const log = input.log.child({ session: session.id, principal: principal.id });
		const writing: Writing = {
			principal,
			session,
			locale,
			told: input.told,
			date,
			assistantName: input.assistantName,
			log,
			refusedFor,
			inTurn: false,
			restOfDay: false
		};
		if (idle) {
			log.info({ seenAt: seenAt.toISOString() }, 'brief stopped: its owner was not seen');
			return pause(writing, getMessages(locale).brief.idle);
		}
		if (missing.length > 0) {
			if (question?.date === date) {
				log.info({ pendingCallId: question.pendingCallId, since: date }, 'brief withheld');
				return { kind: 'withheld' };
			}
			if (question !== null && question.asked >= MAX_ASKED) {
				log.info({}, 'brief stopped: its question went unanswered');
				return pause(writing, getMessages(locale).brief.paused);
			}
			return ask(writing, input.correlationId, missing, question?.asked ?? 0);
		}
		const context: ToolContext = {
			principalId: principal.id,
			origin: 'event',
			actions,
			db,
			correlationId: input.correlationId,
			sessionId: session.id,
			log
		};
		return goOut(writing, context, waiting, (tx) => endBriefWait(tx, principal.id));
	}

	// The owner's yes to the question of their first brief allows each read it asked for, on its own,
	// as a yes to a first read allows its application, has their assistant listen to their mail,
	// unless they chose otherwise, and that day's brief goes out then, however late, its question
	// answered with it. Their yes to the question about their permission runs the
	// read the brief gave way for, as it was frozen, under the brief's own id, then the brief's other
	// reads: that day's brief, written from them, goes out then, and no brief waits any more. While
	// the broker still refuses the read, the brief waits for their answer to the harness's new
	// question, which supersedes the one they answered.
	async function resumeAdmitted(
		input: BriefResumeInput,
		refusedFor: SpentReason | null
	): Promise<BriefResult> {
		const { principal, roomId, pendingCallId } = input;
		const opened = await withPrincipal(db, principal, async (tx) => {
			const record = await ensurePrincipal(tx, principal);
			if (!record.actions.includes('chat')) return { kind: 'forbidden' as const };
			// Only the brief that waits for the call runs it: one that went out since closed its
			// question
			const waiting = await findBriefWait(tx, principal.id);
			const question = await findBriefQuestion(tx, principal.id);
			const asked = question?.pendingCallId === pendingCallId ? question : null;
			const date = asked?.date ?? (waiting?.pendingCallId === pendingCallId ? waiting.date : null);
			if (date === null) return { kind: 'missing' as const };
			const approved = await approvePendingCall(tx, principal.id, pendingCallId);
			if (approved === null) return { kind: 'missing' as const };
			const allowed = asked === null ? [] : domainsAsked(approved.arguments);
			for (const domain of allowed) {
				await grantConsent(tx, principal.id, domain, 'read', input.through);
			}
			// It also has their assistant listen to their mail, which the brief reads only then, unless
			// they chose otherwise
			if (asked !== null) await listenUnlessChosen(tx, principal.id, 'mail');
			const locale = localeOf(await findAssistant(tx, principal.id), config.locale);
			const session = await ensureRoomSession(tx, principal.id, roomId);
			const { actions } = record;
			return {
				kind: 'ok' as const,
				actions,
				locale,
				session,
				approved,
				date,
				reads: asked !== null,
				allowed
			};
		});
		if (opened.kind !== 'ok') return opened;
		const { actions, locale, session, approved, date } = opened;
		const log = input.log.child({ session: session.id, principal: principal.id });
		const id = briefId(principal.id, date);
		// A question the owner's turn asked was the brief they asked for
		const restOfDay = approved.origin === 'owner';
		const writing: Writing = {
			principal,
			session,
			locale,
			told: restOfDay ? getMessages(locale).brief.asked(id) : getMessages(locale).brief.intro(id),
			date,
			assistantName: input.assistantName,
			log,
			refusedFor,
			inTurn: false,
			restOfDay
		};
		const context: ToolContext = {
			principalId: principal.id,
			origin: 'event',
			actions,
			db,
			correlationId: id,
			sessionId: session.id,
			log
		};
		if (opened.reads) {
			log.info({ pendingCallId, domains: opened.allowed }, 'brief reads allowed');
			// The owner is there to answer the question about their permission, should the broker ask it
			const answered = async (tx: Tx): Promise<void> => {
				await markReplayed(tx, pendingCallId);
				await takeBriefQuestion(tx, principal.id, pendingCallId);
			};
			return goOut(
				writing,
				context,
				null,
				async (tx) => {
					await answered(tx);
					return endBriefWait(tx, principal.id);
				},
				answered
			);
		}
		// Without the owner's calendar, which their assistant no longer listens to, the read is not
		// run, and the brief goes out all the same
		const listened = await listenedBy(principal.id);
		const calendar: Read<Day> = listened.includes('calendar')
			? toldDay(
					writing,
					dayOf(
						readOf(
							await deps.runFrozenCall(
								approved,
								pendingCallId,
								{ ...context, origin: approved.origin, unattended: true, asksDelegation: true },
								log
							),
							listSchema
						)
					)
				)
			: NOT_LISTENED;
		if (!calendar.ok && calendar.question !== undefined) {
			logSkipped('calendar', calendar, log);
			return giveWay(writing, calendar.question, (tx) =>
				supersedeApprovedCall(tx, principal.id, pendingCallId)
			);
		}
		const reads = await readSections(context, date, calendar, listened);
		return writeBrief(writing, reads, async (tx) => {
			await markReplayed(tx, pendingCallId);
			return endBriefWait(tx, principal.id);
		});
	}

	// The brief the owner asks for in their turn, which holds its admission and their gate already:
	// the brief of the date it is on their wall clock, whether their brief is due that day, stopped or
	// paused, which takes the wake-up of that date, so that no pass sends another that day. What their
	// brief waits for an answer to closes as expired, to be asked again: the question of their first
	// brief, while their reads are not settled, or the question about their permission. Then it goes
	// out as any brief, telling the rest of their day, and their turn keeps it as its call and its
	// answer.
	async function runInTurn(context: ToolContext): Promise<BriefResult> {
		const principal: Principal = { id: context.principalId };
		const { sessionId, log } = context;
		if (sessionId === undefined) return { kind: 'missing' };
		const opened = await withPrincipal(db, principal, async (tx) => {
			const session = await findSession(tx, sessionId);
			if (session === null) return null;
			const assistant = await findAssistant(tx, principal.id);
			const { timeZone } = await findOwnerSettings(tx, principal.id);
			const date = dateIn(clock.now(), timeZone ?? config.timeZone);
			await takeBriefWakeup(tx, principal.id, briefId(principal.id, date));
			const { settled } = await findBriefReads(tx, principal.id);
			const missing = settled ? [] : await missingReads(tx, principal.id);
			const asked = (await findBriefQuestion(tx, principal.id))?.asked ?? 0;
			const closed = [
				await endBriefQuestion(tx, principal.id),
				await endBriefWait(tx, principal.id)
			];
			return { session, assistant, date, missing, asked, closed };
		});
		if (opened === null) return { kind: 'missing' };
		const { session, assistant, date, missing, asked, closed } = opened;
		for (const request of closed) closedUnanswered(principal.id, request, log);
		const locale = localeOf(assistant, config.locale);
		const id = briefId(principal.id, date);
		log.info({ date }, 'brief asked for');
		const writing: Writing = {
			principal,
			session,
			locale,
			told: getMessages(locale).brief.asked(id),
			date,
			assistantName: assistant?.name,
			log,
			refusedFor: null,
			inTurn: true,
			restOfDay: true
		};
		if (missing.length > 0) return ask(writing, context.correlationId ?? id, missing, asked);
		return goOut(writing, context, null, () => Promise.resolve(null));
	}

	// Admitted before anything else runs, as a turn is; the slot is held until the brief is written.
	// Refused for a spent day, it goes out all the same, laid out by the harness.
	async function admitted(
		owner: string,
		run: (refusedFor: SpentReason | null) => Promise<BriefResult>
	): Promise<BriefResult> {
		const decision = await admission.admit(owner, 'brief');
		if (!decision.ok) {
			const { reason } = decision.refusal;
			if (!spentForTheDay(reason)) return { kind: 'busy', ...decision.refusal };
			return gate.run(owner, () => run(reason));
		}
		try {
			return await gate.run(owner, () => run(null));
		} finally {
			decision.release();
		}
	}

	return {
		run: (input) => admitted(input.principal.id, (refusedFor) => runAdmitted(input, refusedFor)),
		resume: (input) =>
			admitted(input.principal.id, (refusedFor) => resumeAdmitted(input, refusedFor)),
		inTurn: runInTurn
	};
}
