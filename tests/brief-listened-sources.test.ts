import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runBriefPass } from '../src/briefs/schedule.js';
import { withPrincipal } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { noteActivity, type Noted } from '../src/journal/repository.js';
import { listListened, saveListening } from '../src/sources/repository.js';
import { CALENDAR_SOURCE } from '../src/sources/sources.js';
import { INVITED_EVENT_TYPE, TASK_ASSIGNED_EVENT_TYPE } from '../src/wakeups/event-types.js';
import { lastUser, until } from './helpers/activity.js';
import {
	BRIEF_CATALOG,
	dataOf,
	LIST_EMAILS,
	LIST_EVENTS,
	LIST_MAILBOXES,
	LIST_TASKS,
	MAILBOXES
} from './helpers/brief.js';
import { makeSettableClock } from './helpers/clock.js';
import { call, startConsentRoom, type ConsentRoom } from './helpers/consent-room.js';
import { grantConsent } from './helpers/consents.js';
import type { DecryptedMessage } from './helpers/e2ee-client.js';
import type { ChatRequest, ScriptedReply } from './helpers/fake-apisix.js';

const ALICE = 'alice@test.local';
// Where the content of a brief tells Alice's client that it is one, and of which day
const BRIEF_CONTENT_KEY = 'app.twake.assistant.brief';
// What the model writes as the brief
const WRITTEN = 'Ce matin : la revue du budget attend ta réponse.';

// The brief's contracts, which name Calendar and Mail to their owners
const CATALOG = {
	...BRIEF_CATALOG,
	'x-twake-domains': {
		calendar: { name: { en: 'Twake Calendar', fr: 'Twake Calendar' } },
		mail: { name: { en: 'Twake Mail', fr: 'Twake Mail' } }
	}
};

// What the harness says once Alice chose whether her assistant listens to her mail, which only her
// brief reads, and to her calendar
const LISTENING_TO_MAIL = "J'écoute Twake Mail : ton brief te dit ce qui t'y arrive.";
const NOT_LISTENING_TO_MAIL =
	"Je n'écoute plus Twake Mail : ton brief ne te dit plus ce qui t'y arrive, mais je peux toujours le consulter quand tu me le demandes.";
const NOT_LISTENING_TO_CALENDAR =
	"Je n'écoute plus Twake Calendar : je ne te préviens plus de ce qui t'y arrive, mais je peux toujours le consulter quand tu me le demandes.";

// What Alice asks her assistant, and the call a literal model makes for each
const ASKS: Readonly<Record<string, { readonly tool: string; readonly args: unknown }>> = {
	"Qu'écoutes-tu ?": { tool: 'listened_sources', args: {} },
	"N'écoute plus mes mails": { tool: 'stop_listening_to_source', args: { source: 'mail' } },
	'Écoute mes mails': { tool: 'listen_to_source', args: { source: 'mail' } },
	"N'écoute plus l'agenda": { tool: 'stop_listening_to_source', args: { source: 'calendar' } }
};

// A literal model: it writes the brief as given, makes the call each of Alice's asks needs and says
// what the call answered, and repeats anything else it hears
function listeningModel(brief: ScriptedReply): (request: ChatRequest) => ScriptedReply {
	return (request) => {
		const last = request.messages.at(-1);
		if (last?.role === 'tool') return { content: `Told: ${last.content ?? ''}` };
		const told = lastUser(request);
		if (told.startsWith('[brief]')) return brief;
		const ask = ASKS[told];
		return ask === undefined
			? { content: `echo: ${told}` }
			: { toolCalls: call(ask.tool, ask.args) };
	};
}

// What her calendar's contract lists of the invitations that wait for her answer, over the seven
// days from a date: Claire's review of the budget, that day
function pendingOf(date: string): Record<string, unknown> {
	return {
		time_zone: 'Europe/Paris',
		events: [
			{
				uid: 'budget',
				recurrence_id: null,
				start: `${date}T10:00:00+02:00`,
				end: `${date}T11:00:00+02:00`,
				all_day: false,
				status: 'CONFIRMED',
				private: false,
				my_partstat: 'NEEDS-ACTION',
				needs_action: true,
				conflicts: [],
				untrusted: {
					title: 'Revue du budget',
					location: null,
					description: null,
					organizer: 'claire@test.local'
				}
			}
		],
		truncated: false
	};
}

// What her listening journal keeps of an invitation: its UID, its title and its times
const INVITED: Noted = {
	ids: { computed: {}, untrusted: { uid: 'offsite' } },
	names: {
		computed: { start: '2026-10-16T09:00:00+02:00', end: '2026-10-16T12:00:00+02:00' },
		untrusted: { title: 'Séminaire de rentrée' }
	}
};
// And of a task assigned to her: its id and its key, and its title
const ASSIGNED: Noted = {
	ids: { computed: { object: { type: 'task', id: 'task-7', key: 'DEMO-7' } }, untrusted: {} },
	names: { computed: {}, untrusted: { title: 'Préparer la démo' } }
};

describe('my brief tells only of the applications my assistant listens to', () => {
	let r: ConsentRoom;
	const clock = makeSettableClock('2026-10-12T06:00:00Z');

	// Everything Alice's client received from her assistant in her room, oldest first
	const said = (): DecryptedMessage[] =>
		r.client.messages.filter((m) => m.roomId === r.room && m.sender === r.assistantId);

	async function nextSaid(seen: number): Promise<DecryptedMessage> {
		await until('a new message of her assistant', () => said().length > seen);
		const message = said()[seen];
		if (message === undefined) throw new Error('no message');
		return message;
	}

	// The briefs Alice's client received from her assistant, oldest first
	const briefs = (): DecryptedMessage[] =>
		said().filter((m) => m.content[BRIEF_CONTENT_KEY] !== undefined);

	async function nextBrief(seen: number): Promise<DecryptedMessage> {
		await until('a new brief', () => briefs().length > seen);
		const brief = briefs()[seen];
		if (brief === undefined) throw new Error('no brief');
		return brief;
	}

	// The model calls of the briefs, by what they tell the model
	const briefCalls = (): ChatRequest[] =>
		r.h.apisix.llm.calls
			.map((c) => c.request)
			.filter((request) => lastUser(request).startsWith('[brief]'));

	// What the model was handed by the first brief since that many
	function handedSince(calls: number): Record<string, unknown> {
		return dataOf(lastUser(briefCalls().slice(calls).at(0))) as Record<string, unknown>;
	}

	// The contracts the briefs called since that many calls
	const calledSince = (calls: number): string[] =>
		r.h.apisix.contracts.calls.slice(calls).map((c) => c.path);

	// The lines the api role logged with that message
	const logged = (msg: string): Record<string, unknown>[] =>
		r.h.logLines().filter((line) => line['msg'] === msg);

	// The worker role's pass, as it runs every minute, at the time the clock says
	async function pass(at: string): Promise<void> {
		clock.set(at);
		const app = r.h.apps[0];
		if (app === undefined) throw new Error('no api role');
		await runBriefPass({ config: r.h.config, db: r.h.db, log: app.log, clock });
	}

	// What Alice's assistant says next in her room after her words, starting as told
	async function answer(words: string, prefix: string): Promise<string> {
		const seen = r.saying(prefix).length;
		await r.client.sendText(r.room, words);
		return r.nextSaying(prefix, seen);
	}

	// What the call Alice's words led to answered, as the model says it
	async function told(words: string): Promise<unknown> {
		return JSON.parse((await answer(words, 'Told: ')).slice('Told: '.length)) as unknown;
	}

	// The applications an owner's assistant listens to
	const listened = (owner: string): Promise<string[]> =>
		withPrincipal(r.h.db, { id: owner }, (tx) => listListened(tx, owner));

	beforeAll(async () => {
		r = await startConsentRoom(
			{
				ASSISTANT_LOCALE: 'fr',
				ASSISTANT_TIMEZONE: 'Europe/Paris',
				BRIEF_ENABLED: 'true',
				ADMISSION_USER_PER_MINUTE: '120'
			},
			{ clock }
		);
		r.h.apisix.contracts.spec = CATALOG;
		for (const app of r.h.apps) expect(await app.agent.contracts.load()).toBeGreaterThan(0);
		// No meeting in her day, Claire's invitation waiting for her answer, no task and no mail
		r.h.apisix.contracts.handler = (c) => {
			if (c.path === LIST_MAILBOXES) return { status: 200, body: MAILBOXES };
			if (c.path === LIST_EMAILS) return { status: 200, body: { emails: [], next_cursor: null } };
			if (c.path === LIST_TASKS) return { status: 200, body: { tasks: [], truncated: false } };
			if (c.path !== LIST_EVENTS) return { status: 404, body: {} };
			const date = String(c.query['from']);
			return {
				status: 200,
				body:
					c.query['needs_action'] === 'true'
						? pendingOf(date)
						: { time_zone: 'Europe/Paris', events: [], truncated: false }
			};
		};
		r.h.apisix.llm.script = listeningModel({ content: WRITTEN });
	}, 240_000);

	afterAll(async () => {
		if (r !== undefined) await r.close();
	});

	it('listens to my mail from my yes to the question of my first brief, which it says when I ask what it listens to', async () => {
		// Until then her assistant listens to her calendar and her tasks, not to her mail
		expect(await told("Qu'écoutes-tu ?")).toEqual({
			listened: ['calendar', 'tasks'],
			not_listened: ['mail', 'drive'],
			not_yet_possible: ['chat']
		});
		const seen = said().length;
		const sent = briefs().length;
		const calls = briefCalls().length;
		// Monday 12 October at eight in Paris: her first brief asks for its reads
		await pass('2026-10-12T06:00:00Z');
		await nextSaid(seen);
		// She says yes at half past nine, and that day's brief goes out with her mail
		clock.set('2026-10-12T07:30:00Z');
		await r.client.sendText(r.room, 'oui');
		expect((await nextBrief(sent)).body).toBe(WRITTEN);
		expect(handedSince(calls)).toMatchObject({ date: '2026-10-12', mails: { unread: [] } });
		expect(await told("Qu'écoutes-tu ?")).toEqual({
			listened: ['calendar', 'tasks', 'mail'],
			not_listened: ['drive'],
			not_yet_possible: ['chat']
		});
	});

	it('leaves my mail out of my next brief once I stop it listening there, and puts it back once I have it listen again', async () => {
		expect(await answer("N'écoute plus mes mails", "Je n'écoute plus")).toBe(NOT_LISTENING_TO_MAIL);
		const seen = briefs().length;
		const calls = briefCalls().length;
		const reads = r.h.apisix.contracts.calls.length;
		// Tuesday 13 October at eight: her day, her invitations and her tasks, and no mail read
		await pass('2026-10-13T06:00:00Z');
		await nextBrief(seen);
		expect(calledSince(reads)).toEqual([LIST_EVENTS, LIST_EVENTS, LIST_TASKS, LIST_TASKS]);
		const tuesday = handedSince(calls);
		expect(tuesday).toMatchObject({
			date: '2026-10-13',
			calendar: { meetings: [] },
			invitations: { pending: [expect.objectContaining({ uid: 'budget' })] },
			tasks: { overdue: [], today: [] }
		});
		// Nor said to be unread: her assistant does not listen there
		expect(tuesday).not.toHaveProperty('mails');
		expect(tuesday).not.toHaveProperty('not_read');
		expect(logged('brief application skipped')).toContainEqual(
			expect.objectContaining({
				domain: 'mail',
				section: 'mails',
				reason: 'not_listened',
				principal: ALICE
			})
		);
		// She let it read her mail: listening there again asks her nothing
		const before = said().length;
		expect(await answer('Écoute mes mails', "J'écoute")).toBe(LISTENING_TO_MAIL);
		expect(
			said()
				.slice(before)
				.map((m) => m.body)
		).toEqual([LISTENING_TO_MAIL]);
		// Wednesday at eight, with her mail again
		await pass('2026-10-14T06:00:00Z');
		await nextBrief(seen + 1);
		expect(handedSince(calls + 1)).toMatchObject({ date: '2026-10-14', mails: { unread: [] } });
	});

	it('leaves my meetings, my invitations and what reached me in my calendar out of my brief once I stop it listening there', async () => {
		expect(await answer("N'écoute plus l'agenda", "Je n'écoute plus")).toBe(
			NOT_LISTENING_TO_CALENDAR
		);
		// Since Wednesday's brief, kept for her next one: an invitation, and a task assigned to her
		// that her hourly cap held back
		await withPrincipal(r.h.db, { id: ALICE }, async (tx) => {
			await noteActivity(tx, ALICE, {
				source: CALENDAR_SOURCE,
				eventId: 'invited-offsite',
				type: INVITED_EVENT_TYPE,
				receivedAt: new Date('2026-10-14T15:00:00Z'),
				outcome: 'for_brief',
				noted: INVITED
			});
			await noteActivity(tx, ALICE, {
				source: 'twake://tasks',
				eventId: 'assigned-demo',
				type: TASK_ASSIGNED_EVENT_TYPE,
				receivedAt: new Date('2026-10-14T16:00:00Z'),
				outcome: 'capped',
				noted: ASSIGNED
			});
		});
		// The model fails: the harness lays the brief out itself
		r.h.apisix.llm.script = listeningModel({ failWith: 502 });
		const seen = briefs().length;
		const calls = briefCalls().length;
		const reads = r.h.apisix.contracts.calls.length;
		// Thursday 15 October at eight: no read of her calendar
		await pass('2026-10-15T06:00:00Z');
		const thursday = await nextBrief(seen);
		expect(calledSince(reads)).toEqual([LIST_MAILBOXES, LIST_EMAILS, LIST_TASKS, LIST_TASKS]);
		const handed = handedSince(calls);
		expect(handed).toMatchObject({ date: '2026-10-15', mails: { unread: [] } });
		expect(handed).not.toHaveProperty('calendar');
		expect(handed).not.toHaveProperty('invitations');
		expect(handed).not.toHaveProperty('not_read');
		// Of what reached her since her last brief, only the task
		expect(JSON.stringify(handed['since_last_brief'])).toContain('Préparer la démo');
		expect(JSON.stringify(handed['since_last_brief'])).not.toContain('Séminaire de rentrée');
		// Nor does the harness's brief say anything of her day
		expect(thursday.body).toContain('Préparer la démo');
		expect(thursday.body).not.toContain("Tu n'as aucune réunion aujourd'hui");
		expect(thursday.body).not.toContain('Revue du budget');
		expect(thursday.body).not.toContain('Séminaire de rentrée');
		expect(thursday.body).not.toContain("Je n'ai pas pu lire");
	});

	it('listens, from its rollout, to the mail of whoever let their assistant read it, unless they chose otherwise', async () => {
		const BOB = 'bob@test.local';
		const CAROL = 'carol@test.local';
		const DAVE = 'dave@test.local';
		// Bob let his assistant read his mail; so did Carol, who chose it would not listen there; Dave
		// let it read nothing
		await grantConsent(r.h.db, BOB, 'mail', 'read');
		await grantConsent(r.h.db, CAROL, 'mail', 'read');
		await withPrincipal(r.h.db, { id: CAROL }, (tx) => saveListening(tx, CAROL, 'mail', false));
		await r.h.db.sql`delete from schema_migrations where name = '0092_listened_mail.sql'`;
		expect((await runMigrations(r.h.db)).applied).toEqual(['0092_listened_mail.sql']);
		expect(await listened(BOB)).toEqual(['calendar', 'tasks', 'mail']);
		expect(await listened(CAROL)).toEqual(['calendar', 'tasks']);
		expect(await listened(DAVE)).toEqual(['calendar', 'tasks']);
		// Alice's choices stand: her mail, listened to again, and her calendar, not
		expect(await listened(ALICE)).toEqual(['tasks', 'mail']);
	});
});
