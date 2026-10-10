import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startWorkerRole, type WorkerRole } from '../src/worker/role.js';
import {
	ACTIVITY,
	ASSIGNED,
	HARNESS_PASSWORD,
	HARNESS_USER,
	lastUser,
	logSink,
	PREFIX,
	startActivityBroker,
	toldOf,
	turnCalls,
	whenListening,
	type LogSink
} from './helpers/activity.js';
import { startConsentRoom, type ConsentRoom } from './helpers/consent-room.js';
import type { ChatRequest, ScriptedReply } from './helpers/fake-apisix.js';
import type { TestBroker } from './helpers/rabbitmq.js';

const ALICE = { email: 'alice@test.local', reason: 'assigned' };
const CAROL = { email: 'carol@test.local', reason: 'assigned' };

// What Twake Tasks publishes when Bob assigns a task: a CloudEvent naming the assignees in
// data.recipients
interface Assignment extends Record<string, unknown> {
	readonly id: string;
	readonly type: string;
}

let serial = 0;

function assignment(recipients: readonly Record<string, unknown>[] = [ALICE]): Assignment {
	serial += 1;
	return {
		specversion: '1.0',
		id: `0199b6f3-${String(serial).padStart(4, '0')}-7c3e-8a1f-6d2b4e8c9a07`,
		source: 'twake://tasks',
		type: ASSIGNED,
		time: '2026-10-07T14:41:40.123456Z',
		twakeactor: 'bob@test.local',
		data: {
			object: { type: 'task', id: `task-${serial}`, key: `ROAD-${serial}`, title: 'Write it' },
			recipients
		}
	};
}

// What the assistant says when admission refuses a turn for too many at once
const TOO_MANY = 'I received too many messages at once';

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// A literal model: it names the event it was told of, and repeats anything else it hears
function literal(request: ChatRequest): ScriptedReply {
	const told = lastUser(request);
	const id = /\(id ([^)]+)\)/.exec(told)?.[1];
	return { content: id === undefined ? `Heard: ${told}` : `Told of ${id}` };
}

let broker: TestBroker;

beforeAll(async () => {
	broker = await startActivityBroker();
}, 120_000);

afterAll(async () => {
	if (broker !== undefined) await broker.stop();
});

// Alice in her assistant's room, the worker role listening to the activity exchange on a queue of
// the suite's own, under the settings given
interface Listening {
	readonly r: ConsentRoom;
	readonly queue: string;
	// The log lines of the worker roles the suite starts
	readonly logs: LogSink;
	listen(): Promise<WorkerRole>;
	publish(event: Assignment): Promise<void>;
	// What Alice's assistant told her of an event, in her room
	answerTo(event: Assignment, timeoutMs?: number): Promise<string>;
	close(): Promise<void>;
}

async function startListening(suite: string, env: Record<string, string>): Promise<Listening> {
	const prefix = `${PREFIX}.${suite}`;
	const r = await startConsentRoom({
		ACTIVITY_ENABLED: 'true',
		ACTIVITY_AMQP_URL: broker.urlFor(HARNESS_USER, HARNESS_PASSWORD),
		RABBITMQ_PREFIX: prefix,
		...env
	});
	r.h.apisix.llm.script = literal;
	const logs = logSink();
	return {
		r,
		queue: `${prefix}.activity`,
		logs,
		listen: async () =>
			whenListening(
				await startWorkerRole({
					config: { ...r.h.config, role: 'worker' },
					db: r.h.db,
					logStream: logs.stream
				})
			),
		publish: (event) => broker.publish(ACTIVITY, event.type, event, event.id),
		answerTo: (event, timeoutMs) =>
			r.client.waitForMessage(
				r.room,
				r.assistantId,
				(text) => text === `Told of ${event.id}`,
				timeoutMs
			),
		close: () => r.close()
	};
}

// The lines the turn workers logged with this message about the turn of an event, once there are
// that many
async function turnLines(
	l: Listening,
	msg: string,
	event: Assignment,
	count: number
): Promise<Record<string, unknown>[]> {
	for (let i = 0; i < 240; i += 1) {
		const lines = l.r.h
			.logLines()
			.filter((line) => line['msg'] === msg && line['reqId'] === event.id);
		if (lines.length >= count) return lines;
		await sleep(250);
	}
	throw new Error(`fewer than ${count} lines "${msg}" for ${event.id}`);
}

describe('a burst of assignments', () => {
	let l: Listening;
	beforeAll(async () => {
		// Twenty turns in a row are no flood to admission
		l = await startListening('burst', { ADMISSION_USER_PER_MINUTE: '100' });
		// Carol has an assistant too
		await l.r.h.synapse.registerUser('carol');
		const created = await l.r.h.api.post('carol@test.local', '/v1/assistants', { name: 'Friday' });
		expect(created.status).toBe(201);
	}, 240_000);
	afterAll(async () => {
		if (l !== undefined) await l.close();
	});

	it('wakes my assistant for twenty of my twenty-one assignments of the hour, and Carol’s for hers', async () => {
		const mine = Array.from({ length: 21 }, () => assignment());
		const [tenth, last] = [mine[9], mine[20]];
		if (tenth === undefined || last === undefined) throw new Error('no assignments');
		// Counted in the database: a worker started again halfway through knows the first ten
		let worker = await l.listen();
		for (const event of mine.slice(0, 10)) await l.publish(event);
		await l.answerTo(tenth);
		await worker.stop();
		worker = await l.listen();
		try {
			for (const event of mine.slice(10)) await l.publish(event);
			// Carol's, published last, is told once the queue, read in order, has taken all of mine
			const carols = assignment([CAROL]);
			await l.publish(carols);
			await toldOf(l.r.h.apisix, carols.id, 1);
			// My own words wait behind every turn the assignments queued for my assistant, and are
			// answered all the same
			await l.r.client.sendText(l.r.room, 'Anything else?');
			await l.r.client.waitForMessage(
				l.r.room,
				l.r.assistantId,
				(text) => text === 'Heard: Anything else?'
			);
			for (const event of mine.slice(0, 20)) await l.answerTo(event);
			expect(turnCalls(l.r.h.apisix.llm.calls, last.id)).toHaveLength(0);
			expect(l.logs.lines()).toContainEqual(
				expect.objectContaining({
					msg: 'event capped',
					source: 'twake://tasks',
					eventId: last.id,
					type: ASSIGNED,
					owner: 'alice@test.local'
				})
			);
			// Taken all the same, and not dead-lettered
			expect((await broker.queue(l.queue))?.messages).toBe(0);
			expect((await broker.queue(`${l.queue}.dlq`))?.messages).toBe(0);
		} finally {
			await worker.stop();
		}
	});
});

describe('an event turn the rate limit refuses', () => {
	let l: Listening;
	let worker: WorkerRole;
	beforeAll(async () => {
		// One turn a minute
		l = await startListening('rate', { ADMISSION_USER_PER_MINUTE: '1' });
		worker = await l.listen();
	}, 240_000);
	afterAll(async () => {
		if (worker !== undefined) await worker.stop();
		if (l !== undefined) await l.close();
	});

	it('runs once my rate allows it, tried again within the minute, never telling me I asked too much', async () => {
		const first = assignment();
		await l.publish(first);
		await l.answerTo(first);
		// My minute is spent: the next two assignments wait for the next one
		const second = assignment();
		const third = assignment();
		await l.publish(second);
		await l.publish(third);
		// My own words are refused as before, and I am told so at once, while they wait
		await l.r.client.sendText(l.r.room, 'And now?');
		await l.r.client.waitForMessage(l.r.room, l.r.assistantId, (text) => text.startsWith(TOO_MANY));
		// One is told once my next minute comes, and the other waits for the minute after it
		const told = await l.r.client.waitForMessage(
			l.r.room,
			l.r.assistantId,
			(text) => text === `Told of ${second.id}` || text === `Told of ${third.id}`,
			150_000
		);
		const waiting = told === `Told of ${second.id}` ? third : second;
		// Tried again twice as late each time, but never more than a minute later, the window of the
		// rate
		const deferred = await turnLines(l, 'event turn deferred', waiting, 6);
		expect(deferred.slice(0, 6).map((line) => line['retryInMs'])).toEqual([
			2000, 4000, 8000, 16000, 32000, 60000
		]);
		expect(deferred.every((line) => line['reason'] === 'user_rate')).toBe(true);
		// Told I asked too much for my own words alone
		expect(l.r.saying(TOO_MANY)).toHaveLength(1);
	}, 180_000);
});

describe('event turns queued while the api role is down', () => {
	let l: Listening;
	let worker: WorkerRole;
	beforeAll(async () => {
		// Three turns a minute, and forty seconds for an event's turn admission refused to start
		l = await startListening('outage', {
			ADMISSION_USER_PER_MINUTE: '3',
			TURN_EVENT_MAX_DELAY_MS: '40000'
		});
		worker = await l.listen();
	}, 240_000);
	afterAll(async () => {
		if (worker !== undefined) await worker.stop();
		if (l !== undefined) await l.close();
	});

	it('tells me of them once it is back, however long it was down and however over my rate', async () => {
		// My minute is spent just before the api role goes down
		const spent = [assignment(), assignment(), assignment()];
		for (const event of spent) await l.publish(event);
		for (const event of spent) await l.answerTo(event);
		await l.r.h.stopTurnWorkers();
		const queued = [assignment(), assignment(), assignment()];
		for (const event of queued) await l.publish(event);
		// The worker role wakes my assistant for them all the same
		for (let i = 0; i < 120; i += 1) {
			const woken = l.logs
				.lines()
				.filter((line) => line['msg'] === 'event queued')
				.map((line) => line['eventId']);
			if (queued.every((event) => woken.includes(event.id))) break;
			await sleep(250);
		}
		// Down for longer than an event's turn may wait once admission refused it
		await sleep(45_000);
		l.r.h.startTurnWorkers();
		for (const event of queued) await l.answerTo(event, 60_000);
		expect(l.r.h.logLines().filter((line) => line['msg'] === 'event turn abandoned')).toEqual([]);
		expect(l.r.saying(TOO_MANY)).toHaveLength(0);
	}, 180_000);
});

describe('an event turn admission refuses for too long', () => {
	let l: Listening;
	let worker: WorkerRole;
	beforeAll(async () => {
		// One turn a minute, and three seconds for an event's turn admission refused to start: a spent
		// day would refuse it for good, and keep it for the brief
		l = await startListening('late', {
			ADMISSION_USER_PER_MINUTE: '1',
			TURN_EVENT_MAX_DELAY_MS: '3000'
		});
		worker = await l.listen();
	}, 240_000);
	afterAll(async () => {
		if (worker !== undefined) await worker.stop();
		if (l !== undefined) await l.close();
	});

	it('gives the turn up once too late, and never tells me I asked too much', async () => {
		const first = assignment();
		await l.publish(first);
		await l.answerTo(first);
		// My minute is spent: the next assignment's turn waits, then is given up
		const second = assignment();
		await l.publish(second);
		const [abandoned] = await turnLines(l, 'event turn abandoned', second, 1);
		expect(abandoned).toMatchObject({ reason: 'user_rate' });
		// My own words are refused as before: the only ones I am told I asked too much for
		await l.r.client.sendText(l.r.room, 'And now?');
		await l.r.client.waitForMessage(l.r.room, l.r.assistantId, (text) => text.startsWith(TOO_MANY));
		expect(l.r.saying(TOO_MANY)).toHaveLength(1);
		expect(turnCalls(l.r.h.apisix.llm.calls, second.id)).toHaveLength(0);
	});
});
