import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { makeAgentService } from '../src/agent/service.js';
import { runBriefPass } from '../src/briefs/schedule.js';
import { makeConsentMetrics } from '../src/consents/metrics.js';
import { withPrincipal } from '../src/db/client.js';
import { wake } from '../src/wakeups/wake.js';
import { ASSIGNED, lastUser, turnCalls, until } from './helpers/activity.js';
import {
	BRIEF_CATALOG,
	dataOf,
	emailOf,
	LIST_EMAILS,
	LIST_EVENTS,
	LIST_MAILBOXES,
	LIST_TASKS,
	MAILBOXES,
	referencesIn,
	seenEveryDay,
	type Mail
} from './helpers/brief.js';
import { makeSettableClock } from './helpers/clock.js';
import {
	call,
	QUESTION_CONTENT_KEY,
	startConsentRoom,
	type ConsentRoom
} from './helpers/consent-room.js';
import { allowBriefReads, withdrawConsent } from './helpers/consents.js';
import type { DecryptedMessage } from './helpers/e2ee-client.js';
import {
	toolsOf,
	type ChatRequest,
	type ContractCall,
	type ScriptedReply
} from './helpers/fake-apisix.js';

const ALICE = 'alice@test.local';
const BRIEF_NOW = 'brief_now';
// Where the content of a brief tells Alice's client that it is one, and of which day
const BRIEF_CONTENT_KEY = 'app.twake.assistant.brief';
// What Alice asks for, and what the model writes as the brief
const ASK_FOR_IT = 'Fais-moi mon brief';
const WRITTEN = 'Voici ton brief : trois réunions, rien d’urgent.';
// The applications her brief reads
const DOMAINS = ['calendar', 'mail', 'tasks'];
// The question of her first brief, for the three reads, in her language
const ALL_THREE = [
	"Je t'enverrai un brief de ta journée : tes réunions, tes invitations en attente, tes mails importants et tes tâches. Il part du lundi au vendredi à 08:00 ; pour le régler, dis-moi par exemple « brief à 7:30 » ou « pas de brief le mercredi ».",
	"Pour l'écrire, puis-je lire ton agenda, tes mails et tes tâches ? Réponds par oui ou non dans ton prochain message. Tu pourras retirer chaque lecture à part."
].join('\n');

// A literal model: it writes the brief, posts it when Alice asks for it, tells what a call gave
// back, and repeats anything else it hears
function model(request: ChatRequest): ScriptedReply {
	const told = lastUser(request);
	if (told.startsWith('[brief]')) return { content: WRITTEN };
	const last = request.messages.at(-1);
	if (last?.role === 'tool') return { content: `Tool: ${last.content ?? ''}` };
	if (told === ASK_FOR_IT) return { toolCalls: call(BRIEF_NOW, {}) };
	return { content: `Heard: ${told}` };
}

// What her calendar's contract lists for a day of November, in winter time: the stand-up at nine,
// the review of the budget from half past two to half past three, and the demo at four
function dayOf(date: string): Record<string, unknown> {
	const meeting = (
		uid: string,
		start: string,
		end: string,
		title: string
	): Record<string, unknown> => ({
		uid,
		recurrence_id: null,
		start: `${date}T${start}:00+01:00`,
		end: `${date}T${end}:00+01:00`,
		all_day: false,
		status: 'CONFIRMED',
		private: false,
		my_partstat: 'ACCEPTED',
		needs_action: false,
		conflicts: [],
		untrusted: { title, location: null, description: null, organizer: 'bob@test.local' }
	});
	return {
		time_zone: 'Europe/Paris',
		events: [
			meeting('standup', '09:00', '09:15', 'Stand-up'),
			meeting('budget', '14:30', '15:30', 'Revue du budget'),
			meeting('demo', '16:00', '16:30', 'Démo')
		],
		truncated: false
	};
}

// The references of briefs a model call reads in the conversation: after the line that told a brief,
// and in the result of the call that posted the one she asked for
function referencesOf(request: ChatRequest | undefined): unknown[] {
	const posted = (request?.messages ?? []).flatMap((message) => {
		if (message.role !== 'tool' || message.name !== BRIEF_NOW) return [];
		const { references } = JSON.parse(String(message.content)) as { references?: unknown };
		return references === undefined ? [] : [references];
	});
	return [...referencesIn(request), ...posted];
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('I ask for my brief whenever I want it, and it is the answer of my turn', () => {
	let r: ConsentRoom;
	// Monday 2 November 2026 at seven in Paris, in winter time
	const clock = makeSettableClock('2026-11-02T06:00:00Z');
	// The unread emails of her inbox
	let inbox: Mail[] = [];

	// Everything Alice's client received from her assistant in her room, oldest first
	const said = (): DecryptedMessage[] =>
		r.client.messages.filter((m) => m.roomId === r.room && m.sender === r.assistantId);

	async function nextSaid(seen: number): Promise<DecryptedMessage> {
		await until('a new message of her assistant', () => said().length > seen);
		const message = said()[seen];
		if (message === undefined) throw new Error('no message');
		return message;
	}

	// The model calls of the briefs, by what they tell the model
	const briefCalls = (): ChatRequest[] =>
		r.h.apisix.llm.calls
			.map((call) => call.request)
			.filter((request) => lastUser(request).startsWith('[brief]'));

	// The reads of her mail that reached the gateway
	const mailReads = (): ContractCall[] =>
		r.h.apisix.contracts.calls.filter((call) => call.path === LIST_EMAILS);

	// The worker role's pass, as it runs every minute, at the time the clock says
	async function pass(at: string): Promise<void> {
		clock.set(at);
		const app = r.h.apps[0];
		if (app === undefined) throw new Error('no api role');
		await runBriefPass({ config: r.h.config, db: r.h.db, log: app.log, clock });
	}

	// She asks for her brief at the time given, and reads what her assistant answers
	async function ask(at: string, seen: number): Promise<DecryptedMessage> {
		clock.set(at);
		await r.client.sendText(r.room, ASK_FOR_IT);
		return nextSaid(seen);
	}

	// Whether her brief is stopped, and until when it is paused, as the harness keeps them
	async function held(): Promise<{ stopped: boolean; pausedUntil: string | null }> {
		const rows = await withPrincipal(
			r.h.db,
			{ id: ALICE },
			(tx) =>
				tx.sql<{ brief_stopped: boolean; brief_paused_until: string | null }[]>`
				select brief_stopped, brief_paused_until::text as brief_paused_until
				from owner_settings where owner = ${ALICE}`
		);
		return {
			stopped: rows[0]?.brief_stopped ?? false,
			pausedUntil: rows[0]?.brief_paused_until ?? null
		};
	}

	// The tokens her days spent, and those of them her briefs spent, out of the share her assistant
	// spends on its own
	async function spent(): Promise<{ tokens: number; briefs: number }> {
		const rows = await withPrincipal(
			r.h.db,
			{ id: ALICE },
			(tx) =>
				tx.sql<{ tokens: number; briefs: number }[]>`
				select coalesce(sum(tokens), 0)::int as tokens, coalesce(sum(brief_tokens), 0)::int as briefs
				from usage_daily where owner = ${ALICE}`
		);
		return rows[0] ?? { tokens: 0, briefs: 0 };
	}

	async function hold(stopped: boolean, pausedUntil: string | null): Promise<void> {
		await withPrincipal(
			r.h.db,
			{ id: ALICE },
			(tx) => tx.sql`
				insert into owner_settings (owner, brief_stopped, brief_paused_until)
				values (${ALICE}, ${stopped}, ${pausedUntil})
				on conflict (owner) do update set brief_stopped = excluded.brief_stopped,
					brief_paused_until = excluded.brief_paused_until`
		);
	}

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
		r.h.apisix.contracts.spec = BRIEF_CATALOG;
		for (const app of r.h.apps) expect(await app.agent.contracts.load()).toBeGreaterThan(0);
		// Her day, no invitation waiting for her answer, the unread emails a test puts in her inbox, and
		// no task
		r.h.apisix.contracts.handler = (call) => {
			if (call.path === LIST_MAILBOXES) return { status: 200, body: MAILBOXES };
			if (call.path === LIST_EMAILS)
				return { status: 200, body: { emails: inbox.map(emailOf), next_cursor: null } };
			if (call.path === LIST_TASKS) return { status: 200, body: { tasks: [], truncated: false } };
			if (call.path !== LIST_EVENTS) return { status: 404, body: {} };
			return {
				status: 200,
				body:
					call.query['needs_action'] === 'true'
						? { time_zone: 'Europe/Paris', events: [], truncated: false }
						: dayOf(String(call.query['from']))
			};
		};
		r.h.apisix.llm.script = model;
	}, 240_000);

	// Her three reads allowed and her mail listened to, her brief neither stopped nor paused, her
	// inbox empty
	beforeEach(async () => {
		inbox = [];
		await seenEveryDay(r.h.db, ALICE);
		await allowBriefReads(r.h.db, ALICE);
		await hold(false, null);
	});

	afterAll(async () => {
		if (r !== undefined) await r.close();
	});

	it('gives me, asked before eight, the brief of the day, marked as the brief, as the answer that ends my turn, and none goes out at eight', async () => {
		const seen = said().length;
		const calls = r.h.apisix.llm.calls.length;
		const briefs = briefCalls().length;
		const before = await spent();
		// Monday at seven
		const brief = await ask('2026-11-02T06:00:00Z', seen);
		expect(brief.body).toBe(WRITTEN);
		// It spent her day as her words do, and nothing of the share her assistant spends on its own
		const after = await spent();
		expect(after.tokens).toBeGreaterThan(before.tokens);
		expect(after.briefs).toBe(before.briefs);
		expect(brief.content[BRIEF_CONTENT_KEY]).toEqual({ date: '2026-11-02' });
		expect(brief.content[QUESTION_CONTENT_KEY]).toBeUndefined();
		expect(brief.content['formatted_body']).toContain('trois réunions');
		// Her turn called the model once, which called the tool, and was not called after it
		const turn = r.h.apisix.llm.calls
			.slice(calls)
			.filter((c) => lastUser(c.request) === ASK_FOR_IT);
		expect(turn).toHaveLength(1);
		expect(toolsOf(turn[0]?.request)).toContain(BRIEF_NOW);
		// The brief was written once, from all her meetings of the day
		const written = briefCalls().slice(briefs);
		expect(written).toHaveLength(1);
		expect(dataOf(lastUser(written[0]))).toMatchObject({
			date: '2026-11-02',
			calendar: { meetings: [{ uid: 'standup' }, { uid: 'budget' }, { uid: 'demo' }] }
		});
		// At eight, no other brief
		await pass('2026-11-02T07:00:00Z');
		await sleep(1000);
		expect(said()).toHaveLength(seen + 1);
		expect(briefCalls()).toHaveLength(briefs + 1);
		// Her next turn reads the brief as her assistant's answer
		await r.client.sendText(r.room, 'Merci');
		expect((await nextSaid(seen + 1)).body).toBe('Heard: Merci');
		const next = r.h.apisix.llm.calls.at(-1)?.request;
		expect(next?.messages.some((m) => m.role === 'assistant' && m.content === WRITTEN)).toBe(true);
	});

	it('gives me, asked at three after the brief of eight, the meetings not over yet and the mail since that brief', async () => {
		const seen = said().length;
		// Tuesday at eight, the brief goes out
		await pass('2026-11-03T07:00:00Z');
		expect((await nextSaid(seen)).content[BRIEF_CONTENT_KEY]).toEqual({ date: '2026-11-03' });
		const emails = mailReads().length;
		// At three, during the review of the budget
		const brief = await ask('2026-11-03T14:00:00Z', seen + 1);
		expect(brief.content[BRIEF_CONTENT_KEY]).toEqual({ date: '2026-11-03' });
		const data = dataOf(lastUser(briefCalls().at(-1))) as {
			calendar: { meetings: { uid: string }[] };
		};
		expect(data.calendar.meetings.map((meeting) => meeting.uid)).toEqual(['budget', 'demo']);
		expect(
			mailReads()
				.slice(emails)
				.map((read) => read.query['after'])
		).toEqual(['2026-11-03T08:00:00+01:00']);
	});

	it('gives me my brief while it is stopped, or paused, and leaves it so', async () => {
		const seen = said().length;
		await hold(true, null);
		// Wednesday at ten
		const stopped = await ask('2026-11-04T09:00:00Z', seen);
		expect(stopped.content[BRIEF_CONTENT_KEY]).toEqual({ date: '2026-11-04' });
		expect(await held()).toEqual({ stopped: true, pausedUntil: null });
		await hold(false, '2026-11-20');
		// Thursday at ten
		const paused = await ask('2026-11-05T09:00:00Z', seen + 1);
		expect(paused.content[BRIEF_CONTENT_KEY]).toEqual({ date: '2026-11-05' });
		expect(await held()).toEqual({ stopped: false, pausedUntil: '2026-11-20' });
	});

	it('asks, while my brief lacks reads, the question of my first brief, gives the brief of the day when I say yes, and none goes out at eight', async () => {
		const seen = said().length;
		const briefs = briefCalls().length;
		for (const domain of DOMAINS) await withdrawConsent(r.h.db, ALICE, domain, 'read');
		await withPrincipal(
			r.h.db,
			{ id: ALICE },
			(tx) => tx.sql`update owner_settings set brief_reads_settled = false where owner = ${ALICE}`
		);
		// Friday at seven
		const question = await ask('2026-11-06T06:00:00Z', seen);
		expect(question.body).toBe(ALL_THREE);
		await r.requestAskedIn(question.eventId, 'brief');
		expect(question.content[BRIEF_CONTENT_KEY]).toBeUndefined();
		expect(briefCalls()).toHaveLength(briefs);
		// She says yes at half past seven
		clock.set('2026-11-06T06:30:00Z');
		await r.client.sendText(r.room, 'oui');
		const brief = await nextSaid(seen + 1);
		expect(brief.body).toBe(WRITTEN);
		expect(brief.content[BRIEF_CONTENT_KEY]).toEqual({ date: '2026-11-06' });
		// At eight, no other brief
		await pass('2026-11-06T07:00:00Z');
		await sleep(1000);
		expect(said()).toHaveLength(seen + 2);
	});

	it('is offered to my own turns alone, and to none with the briefs off', async () => {
		const seen = said().length;
		const app = r.h.apps[0];
		if (app === undefined) throw new Error('no api role');
		// Monday 9 November at ten: a task someone assigned her asks for her brief
		clock.set('2026-11-09T09:00:00Z');
		const id = 'task-brief-now';
		const woke = await wake(
			{ config: r.h.config, db: r.h.db, log: app.log, clock },
			{
				source: 'twake://tasks',
				id,
				type: ASSIGNED,
				recipient: { email: ALICE, uuid: null, reason: 'assignee' },
				actor: { email: 'bob@test.local', uuid: null },
				shown: { computed: { type: ASSIGNED }, untrusted: { title: ASK_FOR_IT } }
			}
		);
		expect(woke).toBe('woken');
		await nextSaid(seen);
		const [woken] = turnCalls(r.h.apisix.llm.calls, id);
		expect(toolsOf(woken?.request)).not.toContain(BRIEF_NOW);
		expect(app.agent.tools.definitions.map((tool) => tool.function.name)).toContain(BRIEF_NOW);
		const off = makeAgentService({
			config: {
				...r.h.config,
				brief: { enabled: false },
				contracts: { ...r.h.config.contracts, refreshMs: 0 }
			},
			db: r.h.db,
			log: app.log,
			consentMetrics: makeConsentMetrics()
		});
		expect(off.tools.definitions.map((tool) => tool.function.name)).not.toContain(BRIEF_NOW);
	});

	it('takes what my earlier brief named out of my conversation, as a newer brief does, and the next brief takes out what it named', async () => {
		const seen = said().length;
		// Tuesday 10 November at eight, the brief goes out with an email of her inbox
		inbox = [
			{
				id: 'mail-1',
				at: '2026-11-10T06:30:00Z',
				from: 'carol@test.local',
				name: 'Carol',
				subject: 'Contrat',
				toMe: true
			}
		];
		await pass('2026-11-10T07:00:00Z');
		await nextSaid(seen);
		// At ten, another email came, and she asks for her brief
		inbox = [
			{
				id: 'mail-2',
				at: '2026-11-10T08:30:00Z',
				from: 'dan@test.local',
				name: 'Dan',
				subject: 'Budget',
				toMe: true
			}
		];
		await ask('2026-11-10T09:00:00Z', seen + 1);
		// Her next turn reads what the brief she asked for names, and that alone
		let turns = r.h.apisix.llm.calls.length;
		await r.client.sendText(r.room, 'Réponds à Dan');
		await nextSaid(seen + 2);
		expect(referencesOf(r.h.apisix.llm.calls.slice(turns).at(0)?.request)).toEqual([
			{ mails: [{ id: 'mail-2', from: { name: 'Dan', email: 'dan@test.local' } }] }
		]);
		// Thursday's brief, which names nothing, takes them out
		inbox = [];
		await pass('2026-11-12T07:00:00Z');
		await nextSaid(seen + 3);
		turns = r.h.apisix.llm.calls.length;
		await r.client.sendText(r.room, 'Merci');
		await nextSaid(seen + 4);
		expect(referencesOf(r.h.apisix.llm.calls.slice(turns).at(0)?.request)).toEqual([]);
	});
});
