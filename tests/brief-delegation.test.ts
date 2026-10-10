import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { runBriefPass } from '../src/briefs/schedule.js';
import { lastUser, until } from './helpers/activity.js';
import { makeSettableClock } from './helpers/clock.js';
import {
	QUESTION_CONTENT_KEY,
	startConsentRoom,
	type ConsentRoom
} from './helpers/consent-room.js';
import { allowBriefReads } from './helpers/consents.js';
import type { DecryptedMessage } from './helpers/e2ee-client.js';
import {
	BROKER_CONSENT_URL,
	brokerRefusal,
	CALENDAR_CATALOG,
	type ChatRequest,
	type ContractCall,
	type ContractReply
} from './helpers/fake-apisix.js';

const ALICE = 'alice@test.local';
// Where the content of a brief tells Alice's client that it is one, and of which day
const BRIEF_CONTENT_KEY = 'app.twake.assistant.brief';
const LIST_EVENTS = '/contracts/v1/calendar/events';
// What the model writes as the brief
const WRITTEN = 'Ce matin : le stand-up à 9 h.';
// The deployment's consent link bound to Alice, the owner it is for, as the broker expects it
const ALICE_CONSENT_URL = `${BROKER_CONSENT_URL}?owner=alice%40test.local`;
// The harness's question about the permission for her assistant to act for her, as a read of her
// calendar asks it, in her language
const NEEDED =
	"Pour lire tes données dans calendar, j'ai besoin de ton autorisation d'agir en ton nom";
const TRY_AGAIN =
	"Une fois que c'est fait, je réessaie ? Réponds par oui ou non dans ton prochain message.";
const MISSING = `${NEEDED}, et tu ne l'as pas encore donnée. Donne-la ici : ${ALICE_CONSENT_URL}\n${TRY_AGAIN}`;
const EXPIRED = `${NEEDED}, et celle que tu m'as donnée a expiré. Donne-la à nouveau ici : ${ALICE_CONSENT_URL}\n${TRY_AGAIN}`;
// What her assistant answers a yes to a request closed unanswered
const CLOSED =
	"Cette demande a expiré, je n'ai donc rien fait. Redemande-moi si tu en as encore besoin.";
// The counter of her calendar's requests about that permission closed unanswered, as the api role
// exposes it
const EXPIRIES =
	'harness_consent_expiries_total{domain="calendar",level="read",reason="delegation"}';

// Her calendar's contracts with the list of the invitations that wait for her answer alone, as the
// contracts service publishes them; no list of her tasks
const CATALOG = {
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
		}
	}
};

// The read of a day of hers, as the gateway receives it
const readOf = (date: string): Record<string, unknown> => ({ from: date, days: '1', limit: '20' });
const MONDAY = readOf('2026-10-12');
// The read of the invitations that wait for her answer over the week from a date
const weekOf = (date: string): Record<string, unknown> => ({
	from: date,
	days: '7',
	limit: '100',
	needs_action: 'true'
});

// What the model is handed: one line of JSON between the fences of a nonce
const FENCED = /<<<brief-data ([0-9a-f]{12})\n(.+)\nbrief-data \1>>>/;

function dataOf(told: string): unknown {
	const line = FENCED.exec(told)?.[2];
	if (line === undefined) throw new Error(`no brief data in ${told}`);
	return JSON.parse(line) as unknown;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// What her calendar's contract lists for a day: the stand-up
function dayOf(date: string): Record<string, unknown> {
	const at = (time: string): string => `${date}T${time}:00+02:00`;
	return {
		time_zone: 'Europe/Paris',
		start: at('00:00'),
		end: `${date}T23:59:59+02:00`,
		events: [
			{
				uid: 'standup',
				recurrence_id: null,
				start: at('09:00'),
				end: at('09:30'),
				all_day: false,
				status: 'CONFIRMED',
				private: false,
				my_partstat: 'ACCEPTED',
				needs_action: false,
				conflicts: [],
				untrusted: { title: 'Stand-up', location: null, description: null, organizer: null }
			}
		],
		truncated: false
	};
}

describe('my brief gives way to the question about my permission when the platform holds none', () => {
	let r: ConsentRoom;
	const clock = makeSettableClock('2026-10-12T06:00:00Z');
	// What the platform's broker says of Alice's permission for her assistant to act for her: the
	// gateway relays its refusal for every contract call until she gives it
	let broker: ContractReply | null = null;

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

	// The reads of her calendar that reached the gateway, its days' and its invitations'
	const calendarReads = (): ContractCall[] =>
		r.h.apisix.contracts.calls.filter((call) => call.path === LIST_EVENTS);

	// What those reads asked for, after the first `seen` ones
	const queriesSince = (seen: number): Record<string, unknown>[] =>
		calendarReads()
			.slice(seen)
			.map((read) => read.query);

	// Whether her brief of a date went without a word, waiting for her answer
	const withheld = (date: string): boolean =>
		r.h
			.logLines()
			.some(
				(line) =>
					line['msg'] === 'brief withheld' && String(line['reqId']).startsWith(`brief-${date}-`)
			);

	// What an operator reads of that counter, summed over the replicas of the api role
	async function expiries(): Promise<number> {
		const texts = await Promise.all(
			r.h.apps.map(async (app) => (await app.inject({ method: 'GET', url: '/metrics' })).body)
		);
		return texts
			.flatMap((text) => text.split('\n'))
			.filter((line) => line.startsWith(`${EXPIRIES} `))
			.reduce((sum, line) => sum + Number(line.slice(EXPIRIES.length + 1)), 0);
	}

	// The worker role's pass, as it runs every minute, at the time the clock says
	async function pass(at: string): Promise<void> {
		clock.set(at);
		const app = r.h.apps[0];
		if (app === undefined) throw new Error('no api role');
		await runBriefPass({ config: r.h.config, db: r.h.db, log: app.log, clock });
	}

	beforeAll(async () => {
		r = await startConsentRoom(
			{
				ASSISTANT_LOCALE: 'fr',
				ASSISTANT_TIMEZONE: 'Europe/Paris',
				BRIEF_ENABLED: 'true',
				BROKER_CONSENT_URL,
				ADMISSION_USER_PER_MINUTE: '120'
			},
			{ clock }
		);
		r.h.apisix.contracts.spec = CATALOG;
		for (const app of r.h.apps) expect(await app.agent.contracts.load()).toBeGreaterThan(0);
		// She allowed every read of her brief: its first one asks her nothing of them
		await allowBriefReads(r.h.db, ALICE);
		r.h.apisix.contracts.handler = (call) =>
			broker ??
			(call.path === LIST_EVENTS
				? { status: 200, body: dayOf(String(call.query['from'])) }
				: { status: 404, body: {} });
	}, 240_000);

	beforeEach(() => {
		broker = null;
		r.h.apisix.llm.script = (request) =>
			lastUser(request).startsWith('[brief]')
				? { content: WRITTEN }
				: { content: `echo: ${lastUser(request)}` };
	});

	afterAll(async () => {
		if (r !== undefined) await r.close();
	});

	it('sends me, at eight, the question with the link in one message, in place of the brief, and that day’s brief once I gave it and said yes, even late', async () => {
		const seen = said().length;
		const calls = briefCalls().length;
		const reads = calendarReads().length;
		broker = brokerRefusal('delegation_missing');
		// Monday at eight in Paris
		await pass('2026-10-12T06:00:00Z');
		const question = await nextSaid(seen);
		expect(question.body).toBe(MISSING);
		expect(question.content['formatted_body']).toContain(`href="${ALICE_CONSENT_URL}"`);
		// A question that waits for her answer, as any of the harness's, and no brief
		await r.requestAskedIn(question.eventId, 'calendar');
		expect(question.content[BRIEF_CONTENT_KEY]).toBeUndefined();
		// The day's read reached the gateway once, nothing else was read, and no brief was written
		expect(queriesSince(reads)).toEqual([MONDAY]);
		await sleep(1000);
		expect(said().slice(seen)).toEqual([question]);
		expect(briefCalls().slice(calls)).toHaveLength(0);
		// At three in the afternoon, past the hours of the briefs, she gives the platform her
		// permission, then says yes
		clock.set('2026-10-12T13:00:00Z');
		broker = null;
		await r.client.sendText(r.room, 'oui');
		const brief = await nextSaid(seen + 1);
		expect(brief.body).toBe(WRITTEN);
		expect(brief.content[BRIEF_CONTENT_KEY]).toEqual({ date: '2026-10-12' });
		// Written by the model from that day's read, made again under the brief's own id, then from
		// the brief's other reads, under the same id: the catalog has no list of her mail or her tasks
		expect(queriesSince(reads)).toEqual([MONDAY, MONDAY, weekOf('2026-10-12')]);
		const [first, again, week] = calendarReads().slice(reads);
		expect(again?.headers['x-correlation-id']).toMatch(/^brief-2026-10-12-[0-9a-f]{16}$/);
		expect(again?.headers['x-correlation-id']).toBe(first?.headers['x-correlation-id']);
		expect(week?.headers['x-correlation-id']).toBe(first?.headers['x-correlation-id']);
		const [standup] = dayOf('2026-10-12')['events'] as Record<string, unknown>[];
		expect(dataOf(lastUser(briefCalls().slice(calls).at(0)))).toEqual({
			date: '2026-10-12',
			date_in_words: 'lundi 12 octobre 2026',
			calendar: {
				time_zone: 'Europe/Paris',
				meetings: [
					{
						...standup,
						start_in_words: 'lundi 12 octobre 2026, 09:00',
						end_in_words: 'lundi 12 octobre 2026, 09:30'
					}
				],
				truncated: false
			},
			invitations: { pending: [], truncated: false },
			not_read: { mails: 'unavailable', tasks: 'unavailable' }
		});
		// Her yes started no turn of its own: the brief is all her assistant said
		await sleep(1000);
		expect(said().slice(seen)).toEqual([question, brief]);
	});

	it('tells me nothing the next mornings while my day still cannot be read, and my brief comes back by itself, asking nothing, once it can', async () => {
		const seen = said().length;
		const calls = briefCalls().length;
		const reads = calendarReads().length;
		const expired = await expiries();
		broker = brokerRefusal('delegation_expired');
		// Tuesday at eight: the question, in place of the brief
		await pass('2026-10-13T06:00:00Z');
		const question = await nextSaid(seen);
		expect(question.body).toBe(EXPIRED);
		await r.requestAskedIn(question.eventId, 'calendar');
		// Wednesday, the platform still refuses, and Thursday, the gateway fails: her day is read,
		// nothing else, and nothing is said
		const mornings: [string, ContractReply][] = [
			['2026-10-14', brokerRefusal('delegation_expired')],
			['2026-10-15', { status: 500, body: {} }]
		];
		for (const [date, reply] of mornings) {
			broker = reply;
			await pass(`${date}T06:00:00Z`);
			await until(`her brief of ${date} withheld`, () => withheld(date));
		}
		await sleep(1000);
		expect(said().slice(seen)).toEqual([question]);
		expect(briefCalls().slice(calls)).toHaveLength(0);
		expect(queriesSince(reads)).toEqual([
			readOf('2026-10-13'),
			readOf('2026-10-14'),
			readOf('2026-10-15')
		]);
		// Friday, the platform holds her permission again: her brief comes back, asking nothing
		broker = null;
		await pass('2026-10-16T06:00:00Z');
		const brief = await nextSaid(seen + 1);
		expect(brief.body).toBe(WRITTEN);
		expect(brief.content[BRIEF_CONTENT_KEY]).toEqual({ date: '2026-10-16' });
		expect(brief.content[QUESTION_CONTENT_KEY]).toBeUndefined();
		expect(dataOf(lastUser(briefCalls().slice(calls).at(0)))).toMatchObject({
			date: '2026-10-16'
		});
		// The question it gave way to closed with it, unanswered, as one past its lifetime does: a yes
		// to it now runs nothing
		expect(await expiries()).toBe(expired + 1);
		await r.client.sendText(r.room, 'oui');
		const notice = await nextSaid(seen + 2);
		expect(notice.body).toBe(CLOSED);
		await sleep(1000);
		expect(said().slice(seen)).toEqual([question, brief, notice]);
		expect(briefCalls().slice(calls)).toHaveLength(1);
		expect(queriesSince(reads).slice(3)).toEqual([readOf('2026-10-16'), weekOf('2026-10-16')]);
	});

	it('asks me again, in one message, when I say yes before I gave the platform my permission, and sends that day’s brief once I did', async () => {
		const seen = said().length;
		const calls = briefCalls().length;
		const reads = calendarReads().length;
		broker = brokerRefusal('delegation_missing');
		// Monday 19 October at eight
		await pass('2026-10-19T06:00:00Z');
		const question = await nextSaid(seen);
		expect(question.body).toBe(MISSING);
		const first = await r.requestAskedIn(question.eventId, 'calendar');
		// She says yes at once, the platform still holding no permission of hers: the question again,
		// a request of its own that waits for her answer in its turn
		await r.client.sendText(r.room, 'oui');
		const again = await nextSaid(seen + 1);
		expect(again.body).toBe(MISSING);
		expect(again.content[BRIEF_CONTENT_KEY]).toBeUndefined();
		const asked = await r.requestAskedIn(again.eventId, 'calendar');
		expect(asked.id).not.toBe(first.id);
		await sleep(1000);
		expect(said().slice(seen)).toEqual([question, again]);
		// She gives it, then says yes again: that day's brief
		broker = null;
		await r.client.sendText(r.room, 'oui');
		const brief = await nextSaid(seen + 2);
		expect(brief.body).toBe(WRITTEN);
		expect(brief.content[BRIEF_CONTENT_KEY]).toEqual({ date: '2026-10-19' });
		expect(queriesSince(reads)).toEqual([
			readOf('2026-10-19'),
			readOf('2026-10-19'),
			readOf('2026-10-19'),
			weekOf('2026-10-19')
		]);
		await sleep(1000);
		expect(said().slice(seen)).toEqual([question, again, brief]);
		expect(briefCalls().slice(calls)).toHaveLength(1);
	});
});
