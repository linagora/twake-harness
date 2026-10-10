import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.js';
import { startWorkerRole, type WorkerRole } from '../src/worker/role.js';
import {
	ACTIVITY,
	activityEvent,
	ASSIGNED,
	HARNESS_PASSWORD,
	HARNESS_USER,
	lastUser,
	logSink,
	PREFIX,
	startActivityBroker,
	turnCalls,
	until,
	whenListening,
	type ActivityEvent,
	type LogSink
} from './helpers/activity.js';
import { makeSettableClock } from './helpers/clock.js';
import { call, startConsentRoom, type ConsentRoom } from './helpers/consent-room.js';
import type { ChatRequest, ScriptedReply } from './helpers/fake-apisix.js';
import type { TestBroker } from './helpers/rabbitmq.js';

const ALICE = 'alice@test.local';
const ASKED = 'What did you see today?';
const JOURNAL = 'listening_journal';

// Friday 9 October 2026 at half past nine in Paris, then Saturday and Sunday at the same time
const FRIDAY_MORNING = '2026-10-09T07:30:00Z';
const SATURDAY_MORNING = '2026-10-10T07:30:00Z';
const SUNDAY_MORNING = '2026-10-11T07:30:00Z';

// What Alice reads once her assistant spent the share of her day kept for what it does on its own
const SHARE_SPENT =
	"I have used the part of today's quota kept for what I do on my own, so I will not react to your activities on my own again until midnight. My next brief will name what comes in until then, and I still answer whenever you write to me.";
// What she reads once her whole day is spent, her own words included
const DAY_SPENT = 'I have reached my limit for the day';

// The title of a task whose turn takes three hundred tokens, more than the share of a day of a
// thousand that a reserve of three quarters leaves to what the assistant does on its own
const HEAVY = 'Read the whole board';

let serial = 0;

// A task Bob assigns Alice, as Twake Tasks publishes it on the activity exchange
function assignment(title = 'Write the quarterly report'): ActivityEvent {
	serial += 1;
	return activityEvent({
		id: `0199b6f4-${String(serial).padStart(4, '0')}-7c3e-8a1f-6d2b4e8c9a07`,
		recipient: ALICE,
		object: { type: 'task', id: `task-${serial}`, key: `ROAD-${serial}`, title }
	});
}

// A literal model: it names the activity its turn was told of, three hundred tokens for a heavy
// one, reads the journal when its owner asks what it saw and says what the journal answered, and
// repeats anything else it hears, five hundred tokens for words that start with Spend
function reserveModel(request: ChatRequest): ScriptedReply {
	const last = request.messages.at(-1);
	if (last?.role === 'tool' && last.name === JOURNAL) return { content: `Saw: ${last.content}` };
	const told = lastUser(request);
	const id = /\(id ([^)]+)\)/.exec(told)?.[1];
	if (id !== undefined) {
		return {
			content: `Told of ${id}`,
			...(told.includes(HEAVY) ? { usage: { promptTokens: 290, completionTokens: 10 } } : {})
		};
	}
	if (told === ASKED) return { toolCalls: call(JOURNAL, {}) };
	if (told.startsWith('Spend')) {
		return { content: `Heard: ${told}`, usage: { promptTokens: 495, completionTokens: 5 } };
	}
	return { content: `Heard: ${told}` };
}

let broker: TestBroker;

beforeAll(async () => {
	broker = await startActivityBroker();
}, 120_000);

afterAll(async () => {
	if (broker !== undefined) await broker.stop();
});

describe('the share of my day kept for my own words', () => {
	let r: ConsentRoom;
	let worker: WorkerRole;
	// Both roles read the same present
	const clock = makeSettableClock(FRIDAY_MORNING);
	const logs: LogSink = logSink();

	const publish = (event: ActivityEvent): Promise<void> =>
		broker.publish(ACTIVITY, event.type, event, event.id);
	const answerTo = (event: ActivityEvent): Promise<string> =>
		r.client.waitForMessage(r.room, r.assistantId, (text) => text === `Told of ${event.id}`);
	// The lines saying what came of an activity, from either role
	const noted = (event: ActivityEvent): Record<string, unknown>[] =>
		[...logs.lines(), ...r.h.logLines()].filter(
			(line) => line['msg'] === 'activity noted' && line['eventId'] === event.id
		);
	// What Alice's assistant answers her next, whatever it says
	async function answer(text: string): Promise<string> {
		const said = r.saying('').length;
		await r.client.sendText(r.room, text);
		await until(`an answer to « ${text} »`, () => r.saying('').length > said);
		return r.saying('')[said]?.body ?? '';
	}

	beforeAll(async () => {
		r = await startConsentRoom(
			{
				ACTIVITY_ENABLED: 'true',
				ACTIVITY_AMQP_URL: broker.urlFor(HARNESS_USER, HARNESS_PASSWORD),
				RABBITMQ_PREFIX: `${PREFIX}.reserve`,
				ASSISTANT_TIMEZONE: 'Europe/Paris',
				// A day of a thousand tokens, three quarters of them kept for Alice's own words
				ADMISSION_USER_DAILY_TOKENS: '1000',
				CHAT_RESERVE: '0.75',
				ADMISSION_USER_PER_MINUTE: '100'
			},
			{ clock }
		);
		r.h.apisix.llm.script = reserveModel;
		worker = await whenListening(
			await startWorkerRole({
				config: { ...r.h.config, role: 'worker' },
				db: r.h.db,
				logStream: logs.stream,
				clock
			})
		);
	}, 240_000);
	afterAll(async () => {
		if (worker !== undefined) await worker.stop();
		if (r !== undefined) await r.close();
	});

	it('wakes my assistant no more once it spent its share, tells me so once, and keeps what came for my brief', async () => {
		// Its turn takes 300 tokens of the 250 left to what my assistant does on its own
		const heavy = assignment(HEAVY);
		await publish(heavy);
		await answerTo(heavy);
		// The next two wake nobody, and I am told why once
		const second = assignment();
		await publish(second);
		await until('the second activity noted', () => noted(second).length > 0);
		expect(await r.nextSaying(SHARE_SPENT, 0)).toBe(SHARE_SPENT);
		const third = assignment();
		await publish(third);
		await until('the third activity noted', () => noted(third).length > 0);
		for (const refused of [second, third]) {
			expect(noted(refused)).toEqual([
				expect.objectContaining({
					level: 30,
					source: 'twake://tasks',
					type: ASSIGNED,
					owner: ALICE,
					outcome: 'share_spent'
				})
			]);
			expect(turnCalls(r.h.apisix.llm.calls, refused.id)).toEqual([]);
			// Neither waits for a later try nor is given up
			expect(
				r.h
					.logLines()
					.filter(
						(line) =>
							(line['msg'] === 'event turn deferred' || line['msg'] === 'event turn abandoned') &&
							line['reqId'] === refused.id
					)
			).toEqual([]);
		}
		expect(r.h.logLines()).toContainEqual(
			expect.objectContaining({ msg: 'admission refused', principal: ALICE, reason: 'event_share' })
		);
		// My own words are answered, after which no second notice came
		expect(await answer('Hello')).toBe('Heard: Hello');
		expect(r.saying(SHARE_SPENT)).toHaveLength(1);
		// What I saw today tells me what my assistant made of each
		const said = r.saying('Saw: ').length;
		await r.client.sendText(r.room, ASKED);
		const saw = JSON.parse((await r.nextSaying('Saw: ', said)).slice('Saw: '.length)) as {
			activities: Record<string, unknown>[];
		};
		expect(saw.activities.map((activity) => activity['outcome'])).toEqual([
			'suggested',
			'share_spent',
			'share_spent'
		]);
	});

	it('answers my own words up to my whole day, past the share kept for them', async () => {
		// Some 845 tokens spent, past the 750 kept for my words: they are still answered
		expect(await answer('Spend some')).toBe('Heard: Spend some');
		expect(await answer('Spend more')).toBe('Heard: Spend more');
		// Past the thousand of my day, they are not
		expect(await answer('And now?')).toMatch(new RegExp(`^${DAY_SPENT}`));
	});

	it('wakes my assistant again the next day, until my own words spent my whole day', async () => {
		clock.set(SATURDAY_MORNING);
		const saturday = assignment();
		await publish(saturday);
		await answerTo(saturday);
		expect(noted(saturday)).toEqual([expect.objectContaining({ outcome: 'suggested' })]);
		expect(await answer('Spend some')).toBe('Heard: Spend some');
		expect(await answer('Spend more')).toBe('Heard: Spend more');
		// Kept for my brief as well, without the notice, which says my assistant still answers me
		const late = assignment();
		await publish(late);
		await until('the late activity noted', () => noted(late).length > 0);
		expect(noted(late)).toEqual([expect.objectContaining({ outcome: 'share_spent' })]);
		expect(turnCalls(r.h.apisix.llm.calls, late.id)).toEqual([]);
		expect(await answer('And now?')).toMatch(new RegExp(`^${DAY_SPENT}`));
		expect(r.saying(SHARE_SPENT)).toHaveLength(1);
	});

	it('tells me again on another day once my assistant spent that day’s share', async () => {
		clock.set(SUNDAY_MORNING);
		const heavy = assignment(HEAVY);
		await publish(heavy);
		await answerTo(heavy);
		const refused = assignment();
		await publish(refused);
		await until('the refused activity noted', () => noted(refused).length > 0);
		expect(noted(refused)).toEqual([expect.objectContaining({ outcome: 'share_spent' })]);
		expect(await r.nextSaying(SHARE_SPENT, 1)).toBe(SHARE_SPENT);
	});
});

describe('the setting of the reserve', () => {
	const base = {
		HARNESS_ROLE: 'api',
		DATABASE_URL: 'postgres://x@localhost/x',
		AUTH_JWKS_URL: 'https://example.test/jwks',
		AUTH_ISSUER: 'https://example.test/',
		AUTH_AUDIENCE: 'twake-harness',
		APISIX_BASE_URL: 'http://apisix.test',
		APISIX_CONSUMER_KEY: 'k'
	};

	it('keeps half of each day for the owner’s own words unless CHAT_RESERVE says otherwise, from none to all of it', () => {
		expect(loadConfig(base).admission.chatReserve).toBe(0.5);
		expect(loadConfig({ ...base, CHAT_RESERVE: '0.75' }).admission.chatReserve).toBe(0.75);
		expect(loadConfig({ ...base, CHAT_RESERVE: '0' }).admission.chatReserve).toBe(0);
		expect(loadConfig({ ...base, CHAT_RESERVE: '1' }).admission.chatReserve).toBe(1);
		expect(() => loadConfig({ ...base, CHAT_RESERVE: '1.5' })).toThrow('CHAT_RESERVE');
		expect(() => loadConfig({ ...base, CHAT_RESERVE: '-0.1' })).toThrow('CHAT_RESERVE');
	});
});
