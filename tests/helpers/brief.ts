import { withPrincipal, type Db } from '../../src/db/client.js';
import { CALENDAR_CATALOG, type ChatRequest } from './fake-apisix.js';

// The owner reads their room every day, as far as their brief can tell, whatever day the test's
// clock says: their brief never stops for want of them
export async function seenEveryDay(db: Db, owner: string): Promise<void> {
	await withPrincipal(
		db,
		{ id: owner },
		(tx) => tx.sql`
			insert into owner_settings (owner, owner_seen_at) values (${owner}, '2999-12-31T00:00:00Z')
			on conflict (owner) do update set owner_seen_at = excluded.owner_seen_at`
	);
}

// The paths the gateway receives the brief's reads at: the days of the owner's calendar, their
// tasks, their mailboxes and the emails in them
export const LIST_EVENTS = '/contracts/v1/calendar/events';
export const LIST_TASKS = '/contracts/v1/tasks/mine';
export const LIST_MAILBOXES = '/contracts/v1/mail/mailboxes';
export const LIST_EMAILS = '/contracts/v1/mail/emails';

// The calendar's contracts with the list of the invitations that wait for the owner's answer alone,
// the list of their open tasks by when they are due, and the lists of their mailboxes and of the
// emails in them, as the contracts service publishes them
export const BRIEF_CATALOG = {
	...CALENDAR_CATALOG,
	paths: {
		...CALENDAR_CATALOG.paths,
		[LIST_EVENTS]: {
			get: {
				...CALENDAR_CATALOG.paths[LIST_EVENTS].get,
				parameters: [
					...CALENDAR_CATALOG.paths[LIST_EVENTS].get.parameters,
					{ name: 'needs_action', in: 'query', required: false, schema: { type: 'boolean' } }
				]
			}
		},
		[LIST_TASKS]: {
			get: {
				operationId: 'list_my_tasks',
				summary: "List the user's open tasks in Twake Tasks",
				tags: ['tasks.task.read.v1'],
				parameters: [
					{ name: 'zone', in: 'query', required: true, schema: { type: 'string' } },
					{
						name: 'due',
						in: 'query',
						required: false,
						schema: { type: 'string', enum: ['overdue', 'today', 'upcoming', 'all'] }
					},
					{ name: 'days', in: 'query', required: false, schema: { type: 'integer' } },
					{ name: 'limit', in: 'query', required: false, schema: { type: 'integer' } }
				]
			}
		},
		[LIST_MAILBOXES]: {
			get: {
				operationId: 'list_mailboxes',
				summary: "List the user's mailboxes",
				tags: ['mail.mailboxes.read.v1']
			}
		},
		[LIST_EMAILS]: {
			get: {
				operationId: 'list_emails',
				summary: "List the user's emails, newest first",
				tags: ['mail.emails.read.v1'],
				parameters: [
					{ name: 'mailbox', in: 'query', required: false, schema: { type: 'string' } },
					{ name: 'unread', in: 'query', required: false, schema: { type: 'boolean' } },
					{ name: 'flagged', in: 'query', required: false, schema: { type: 'boolean' } },
					{ name: 'from', in: 'query', required: false, schema: { type: 'string' } },
					{ name: 'after', in: 'query', required: false, schema: { type: 'string' } },
					{ name: 'before', in: 'query', required: false, schema: { type: 'string' } },
					{ name: 'limit', in: 'query', required: false, schema: { type: 'integer' } },
					{ name: 'cursor', in: 'query', required: false, schema: { type: 'string' } }
				]
			}
		}
	}
};

// The id of the owner's inbox, as Mail lists their mailboxes: the mailbox of what they sent first,
// so that only its role tells the inbox
export const INBOX = 'mailbox-inbox';
export const MAILBOXES = {
	mailboxes: [
		{
			id: 'mailbox-sent',
			name: 'Sent',
			role: 'sent',
			parent_id: null,
			total_emails: 40,
			unread_emails: 0
		},
		{
			id: INBOX,
			name: 'INBOX',
			role: 'inbox',
			parent_id: null,
			total_emails: 120,
			unread_emails: 9
		}
	]
};

// An unread email of the owner's inbox, as a test writes it
export interface Mail {
	readonly id: string;
	// When Mail received it, in UTC as JMAP gives it
	readonly at: string;
	// Its sender's address, and their name when the mail gives one
	readonly from: string;
	readonly name?: string;
	readonly subject: string;
	readonly preview?: string;
	readonly flagged?: boolean;
	// Whether the owner is among its recipients in To
	readonly toMe?: boolean;
	// Whether it was sent in bulk, as a newsletter or an automatic notice is
	readonly bulk?: boolean;
}

// That email as Mail lists it: what Mail computed, then, under untrusted, what its sender wrote
export function emailOf(mail: Mail): Record<string, unknown> {
	return {
		id: mail.id,
		thread_id: `thread-${mail.id}`,
		mailbox_ids: [INBOX],
		received_at: mail.at,
		unread: true,
		flagged: mail.flagged ?? false,
		has_attachment: false,
		bulk: mail.bulk ?? false,
		to_me: mail.toMe ?? false,
		untrusted: {
			from: [{ name: mail.name ?? null, email: mail.from }],
			subject: mail.subject,
			preview: mail.preview ?? ''
		}
	};
}

// What the model is handed: one line of JSON between the fences of a nonce
const FENCED = /<<<brief-data ([0-9a-f]{12})\n(.+)\nbrief-data \1>>>/;

// What the conversation keeps of a brief for the next turns, as data, the same way
const REFERENCES = /<<<brief-references ([0-9a-f]{12})\n(.+)\nbrief-references \1>>>/g;

// The data a brief's model call is handed
export function dataOf(told: string): unknown {
	const line = FENCED.exec(told)?.[2];
	if (line === undefined) throw new Error(`no brief data in ${told}`);
	return JSON.parse(line) as unknown;
}

// The references of briefs a model call reads in the conversation
export function referencesIn(request: ChatRequest | undefined): unknown[] {
	return (request?.messages ?? []).flatMap((message) =>
		message.role === 'user'
			? [...String(message.content).matchAll(REFERENCES)].map(
					(match) => JSON.parse(match[2] ?? '') as unknown
				)
			: []
	);
}
