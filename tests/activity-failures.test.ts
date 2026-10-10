import type { Writable } from 'node:stream';
import { connect, type ConfirmChannel } from 'amqplib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.js';
import { makeDb, type Db } from '../src/db/client.js';
import { startWorkerRole, type WorkerRole } from '../src/worker/role.js';
import {
	ACTIVITY,
	activityEvent,
	ASSIGNED,
	HARNESS_PASSWORD,
	HARNESS_PERMISSIONS,
	HARNESS_USER,
	lastUser,
	logSink,
	PREFIX,
	silent,
	startActivityBroker,
	turnCalls,
	until,
	whenListening,
	type ActivityEvent,
	type LogSink
} from './helpers/activity.js';
import { TEST_DATABASE_URL } from './helpers/app.js';
import { startConsentRoom, type ConsentRoom } from './helpers/consent-room.js';
import type { ChatRequest, RecordedCall } from './helpers/fake-apisix.js';
import type { TestBroker } from './helpers/rabbitmq.js';
import { freePort, spawnWorker, type WorkerProcess } from './helpers/process.js';
import {
	startSilentServer,
	startTcpProxy,
	upstreamOf,
	type TcpProxy
} from './helpers/tcp-proxy.js';

// A type the deployment does not listen to
const COMPLETED = 'com.twake.tasks.task.completed.v1';
// The instance's own queue on the broker, and its dead letters
const QUEUE = `${PREFIX}.activity`;
const DEAD_LETTERS = `${QUEUE}.dlq`;
// What people wrote, which no log line may carry
const CONFIDENTIAL = 'Salary review: Bob leaves in June';
// The first delay of the worker's retries, which doubles from there
const RETRY_DELAY_MS = 50;
// How long the suite's broker lets a consumer hold a message unacknowledged, by default: three
// seconds rather than half an hour
const CONSUMER_TIMEOUT_MS = 3000;

const ALICE = { email: 'alice@test.local', reason: 'assigned' };

type LogLine = Record<string, unknown>;

// A vhost of its own, as the platform sets one up: its name, and the platform's channel there
interface OwnVhost {
	readonly name: string;
	readonly channel: ConfirmChannel;
}

// The first word of what people wrote, as a JSON parse error would quote it
const CONTENT = CONFIDENTIAL.split(' ')[0] ?? CONFIDENTIAL;

// Nothing of what an event says reaches a worker's logs, at any level, nor a stack in the lines
// of its listener, which would quote the message of a failure
function expectNoContentIn(logs: LogSink): void {
	expect(JSON.stringify(logs.lines())).not.toContain(CONTENT);
	expect(
		logs
			.lines()
			.filter((line) => line['listener'] !== undefined && JSON.stringify(line).includes('"stack"'))
			.map((line) => line['msg'])
	).toEqual([]);
}

let serial = 0;

// A task assigned by Bob, published as Twake Tasks does, each under an id of its own and with a
// title that no line may carry, for Alice unless told otherwise
function assignment(recipients: readonly Record<string, unknown>[] = [ALICE]): ActivityEvent {
	serial += 1;
	return activityEvent({
		id: `0199c0de-${String(serial).padStart(4, '0')}-7c3e-8a1f-6d2b4e8c9a07`,
		recipients,
		object: { type: 'task', id: `task-${serial}`, key: `ROAD-${serial}`, title: CONFIDENTIAL }
	});
}

// Those of one assistant, known by the name its system prompt gives it
function turnsOf(calls: readonly RecordedCall[], eventId: string, name: string): RecordedCall[] {
	return turnCalls(calls, eventId).filter((call) =>
		call.request.messages[0]?.content?.includes(`"${name}"`)
	);
}

describe('an event that fails holds back none of those after it, and is never lost', () => {
	let broker: TestBroker;
	let r: ConsentRoom;
	let worker: WorkerRole;
	// The worker reaches its database through a proxy the tests take down and bring back, and the
	// broker through another, which follows the broker when a restart moves it
	let database: TcpProxy;
	let workerDb: Db;
	let amqp: TcpProxy;
	const logs = logSink();
	beforeAll(async () => {
		broker = await startActivityBroker({ consumerTimeoutMs: CONSUMER_TIMEOUT_MS });
		r = await startConsentRoom({
			ACTIVITY_ENABLED: 'true',
			ACTIVITY_AMQP_URL: broker.urlFor(HARNESS_USER, HARNESS_PASSWORD),
			RABBITMQ_PREFIX: PREFIX,
			// The suite wakes Alice's assistant more often than an owner may start turns by default
			ADMISSION_USER_PER_MINUTE: '120'
		});
		database = await startTcpProxy(() => upstreamOf(TEST_DATABASE_URL));
		workerDb = makeDb(database.through(TEST_DATABASE_URL));
		amqp = await startTcpProxy(() => broker.address());
		const { activity } = r.h.config;
		if (activity === null) throw new Error('the suite listens to the activity exchange');
		// Every line the worker writes, down to its debug lines, is read for content
		worker = await startWorkerRole({
			config: {
				...r.h.config,
				role: 'worker',
				logLevel: 'debug',
				activity: {
					...activity,
					amqpUrl: amqp.through(broker.urlFor(HARNESS_USER, HARNESS_PASSWORD))
				}
			},
			db: workerDb,
			logStream: logs.stream,
			retryDelayMs: RETRY_DELAY_MS
		});
		await whenListening(worker);
		// A literal model: it says which event it was told of
		r.h.apisix.llm.script = (request: ChatRequest) => {
			const id = /\(id ([^)]+)\)/.exec(lastUser(request))?.[1];
			return { content: id === undefined ? 'Heard you.' : `Told of (${id})` };
		};
	}, 240_000);
	afterAll(async () => {
		if (worker !== undefined) await worker.stop();
		if (workerDb !== undefined) await workerDb.close();
		if (database !== undefined) await database.close();
		if (amqp !== undefined) await amqp.close();
		if (r !== undefined) await r.close();
		if (broker !== undefined) await broker.stop();
	});

	function publish(event: ActivityEvent): Promise<void> {
		return broker.publish(ACTIVITY, event.type, event, event.id);
	}

	// Waits until Alice's assistant told her of an event in her room
	async function toldAlice(event: ActivityEvent): Promise<void> {
		await r.client.waitForMessage(r.room, r.assistantId, (t) => t === `Told of (${event.id})`);
	}

	// The line the worker logged once it was done with a message
	function handled(since: number): LogLine[] {
		return logs
			.lines()
			.slice(since)
			.filter((line) => line['msg'] === 'event handled');
	}

	// A fault every attempt meets, as a bug would be: the database refuses the wake-ups it matches.
	// A trigger on the wake-ups is the only way through the black box to a failure that is not
	// transient: what the listener reads is checked before anything is written, and what it writes
	// is its own.
	async function refuseWakeups(when: string): Promise<void> {
		await r.h.db.sql.unsafe(`create or replace function refuse_wakeup() returns trigger
			language plpgsql as $$ begin raise exception 'wake-up refused'; end $$`);
		await r.h.db.sql.unsafe(`create trigger refuse_wakeup before insert on wakeups for each row
			when (${when}) execute function refuse_wakeup()`);
	}

	// The fault fixed
	async function allowWakeups(): Promise<void> {
		await r.h.db.sql.unsafe('drop trigger if exists refuse_wakeup on wakeups');
	}

	// What a worker's health check says of its listener
	async function healthOf(role: WorkerRole): Promise<unknown> {
		const health = await role.app.inject({ method: 'GET', url: '/health' });
		expect(health.statusCode).toBe(200);
		return health.json<{ activity?: string }>().activity;
	}

	// A worker of its own, on a vhost of its own, as the instance's user there
	function workerOn(amqpUrl: string, logStream: Writable, db: Db = r.h.db): Promise<WorkerRole> {
		return startWorkerRole({
			config: {
				...r.h.config,
				role: 'worker',
				logLevel: 'debug',
				activity: { amqpUrl, types: [ASSIGNED] }
			},
			db,
			logStream,
			retryDelayMs: RETRY_DELAY_MS
		});
	}

	// A vhost of its own, with the activity exchange unless told otherwise, and the instance's
	// user there, who may do nothing elsewhere
	async function vhostOf(name: string, user: string, exchange = true): Promise<OwnVhost> {
		const channel = await broker.addVhost(name);
		if (exchange) await channel.assertExchange(ACTIVITY, 'topic', { durable: true });
		await broker.addUser(user, HARNESS_PASSWORD, { configure: '^$', write: '^$', read: '^$' });
		await broker.allow(user, name, HARNESS_PERMISSIONS);
		return { name, channel };
	}

	// Publishes an event as Twake Tasks does, on a vhost of its own
	async function publishOn(vhost: OwnVhost, event: ActivityEvent): Promise<void> {
		vhost.channel.publish(ACTIVITY, event.type, Buffer.from(JSON.stringify(event)), {
			persistent: true,
			messageId: event.id
		});
		await vhost.channel.waitForConfirms();
	}

	// A worker role of its own process, started as a deployment starts it, which the test may kill
	async function startWorkerProcess(amqpUrl: string): Promise<WorkerProcess> {
		const { config } = r.h;
		return spawnWorker({
			HARNESS_ROLE: 'worker',
			HOST: '127.0.0.1',
			PORT: String(await freePort()),
			DATABASE_URL: TEST_DATABASE_URL,
			AUTH_JWKS_URL: config.auth.jwksUrl.toString(),
			AUTH_ISSUER: config.auth.issuer,
			AUTH_AUDIENCE: config.auth.audience,
			APISIX_BASE_URL: config.apisix.baseUrl.toString(),
			APISIX_CONSUMER_KEY: config.apisix.consumerKey,
			MATRIX_SERVER_NAME: config.matrix.serverName,
			ACTIVITY_ENABLED: 'true',
			ACTIVITY_AMQP_URL: amqpUrl,
			RABBITMQ_PREFIX: PREFIX,
			LOG_LEVEL: 'debug',
			// Quiet hours only where a test sets them: this one runs at any hour of the system clock
			QUIET_HOURS_DEFAULT: 'none'
		});
	}

	// The database makes every wake-up wait, until released, as a handler that never ends would
	async function lockWakeups(): Promise<{ release(): Promise<void> }> {
		let release = (): void => undefined;
		const released = new Promise<void>((resolve) => {
			release = resolve;
		});
		let taken = (): void => undefined;
		const locked = new Promise<void>((resolve) => {
			taken = resolve;
		});
		const holding = r.h.db.sql.begin(async (tx) => {
			await tx`lock table wakeups in share mode`;
			taken();
			await released;
		});
		await locked;
		return {
			release: async () => {
				release();
				await holding;
			}
		};
	}

	// The lines of the attempts at an event that failed, once there are that many
	async function failuresOf(event: ActivityEvent, count: number): Promise<LogLine[]> {
		const failures = (): LogLine[] =>
			logs.lines().filter((line) => line['msg'] === 'event failed' && line['eventId'] === event.id);
		await until(`${count} failed attempts at ${event.id}`, () => failures().length >= count);
		return failures();
	}

	it('dead-letters at once a message that is no event, logging why and nothing of what it says', async () => {
		await broker.channel.purgeQueue(DEAD_LETTERS);
		const mark = logs.lines().length;
		// Not JSON at all, then a CloudEvent without its source, then one about no object
		broker.channel.publish(ACTIVITY, ASSIGNED, Buffer.from(`${CONFIDENTIAL} {`), {
			persistent: true,
			messageId: 'not-json'
		});
		await broker.channel.waitForConfirms();
		const withoutSource: ActivityEvent = { ...assignment(), source: undefined };
		const aboutNothing = assignment();
		const withoutObject: ActivityEvent = {
			...aboutNothing,
			data: { recipients: [ALICE], preview: CONFIDENTIAL }
		};
		await publish(withoutSource);
		await publish(withoutObject);
		// The next event is told as ever
		const next = assignment();
		await publish(next);
		await toldAlice(next);
		// The broker counts a dead letter once its dead letter queue confirmed it
		await broker.waitForMessages(DEAD_LETTERS, 3);
		expect(turnCalls(r.h.apisix.llm.calls, withoutSource.id)).toHaveLength(0);
		expect(turnCalls(r.h.apisix.llm.calls, withoutObject.id)).toHaveLength(0);
		expect(
			handled(mark).map(({ eventId, type, outcome, reason }) => ({
				eventId,
				type,
				outcome,
				reason
			}))
		).toEqual([
			{ eventId: undefined, type: ASSIGNED, outcome: 'dead_lettered', reason: 'not JSON' },
			{ eventId: withoutSource.id, type: ASSIGNED, outcome: 'dead_lettered', reason: 'no source' },
			{
				eventId: withoutObject.id,
				type: ASSIGNED,
				outcome: 'dead_lettered',
				reason: 'no data.object'
			},
			{ eventId: next.id, type: ASSIGNED, outcome: 'woken', reason: undefined }
		]);
		expectNoContentIn(logs);
	});

	it('logs one line per event, with what came of each recipient and nothing anyone wrote', async () => {
		const mark = logs.lines().length;
		const dave = { email: 'dave@test.local', reason: 'assigned' };
		const elsewhere = { email: 'alice@elsewhere.test', reason: 'assigned' };
		const unreadable = { email: 'not an address', reason: 'assigned' };
		const many = assignment([ALICE, dave, elsewhere, unreadable]);
		const nobody = assignment([]);
		// Of a type the deployment no longer listens to, whose binding stays on the broker until it
		// is removed there
		const completed: ActivityEvent = { ...assignment(), type: COMPLETED };
		await broker.channel.bindQueue(QUEUE, ACTIVITY, COMPLETED);
		const next = assignment();
		try {
			await publish(many);
			await toldAlice(many);
			// Delivered again, as after a restart
			await publish(many);
			await publish(nobody);
			await publish(completed);
			await publish(next);
			await toldAlice(next);
		} finally {
			await broker.channel.unbindQueue(QUEUE, ACTIVITY, COMPLETED);
		}
		expect(turnCalls(r.h.apisix.llm.calls, many.id)).toHaveLength(1);
		expect(turnCalls(r.h.apisix.llm.calls, completed.id)).toHaveLength(0);
		expect(
			handled(mark).map(({ eventId, recipients, outcome, outcomes, reason }) => ({
				eventId,
				recipients,
				outcome,
				outcomes,
				reason
			}))
		).toEqual([
			{
				eventId: many.id,
				recipients: 4,
				outcome: 'woken',
				outcomes: { woken: 1, no_assistant: 1, ignored: 1, invalid: 1 }
			},
			{
				eventId: many.id,
				recipients: 4,
				outcome: 'duplicate',
				outcomes: { duplicate: 1, no_assistant: 1, ignored: 1, invalid: 1 }
			},
			{ eventId: nobody.id, recipients: 0, outcome: 'ignored', outcomes: {} },
			{ eventId: completed.id, recipients: 1, outcome: 'ignored', reason: 'type not listened to' },
			{ eventId: next.id, recipients: 1, outcome: 'woken', outcomes: { woken: 1 } }
		]);
		expectNoContentIn(logs);
	});

	it('tries an event again while the database is down, ever further apart, then wakes me once', async () => {
		await broker.channel.purgeQueue(DEAD_LETTERS);
		const mark = logs.lines().length;
		const event = assignment();
		database.cut();
		try {
			await publish(event);
			// Tried more than the five times a lasting failure gets, never dead-lettered, and held
			const failures = await failuresOf(event, 7);
			expect(failures.map((line) => line['transient'])).toEqual(Array(7).fill(true));
			expect((await broker.queue(DEAD_LETTERS))?.messages).toBe(0);
			expect((await broker.queue(QUEUE))?.messages).toBe(1);
			// Each wait twice as long as the one before it
			const times = failures.map((line) => Number(line['time']));
			for (let i = 1; i < times.length; i += 1) {
				expect((times[i] ?? 0) - (times[i - 1] ?? 0)).toBeGreaterThanOrEqual(
					RETRY_DELAY_MS * 2 ** (i - 1) - 2
				);
			}
		} finally {
			database.restore();
		}
		await toldAlice(event);
		expect(turnCalls(r.h.apisix.llm.calls, event.id)).toHaveLength(1);
		expect((await broker.queue(DEAD_LETTERS))?.messages).toBe(0);
		expect(handled(mark).map(({ eventId, outcome }) => ({ eventId, outcome }))).toEqual([
			{ eventId: event.id, outcome: 'woken' }
		]);
		expectNoContentIn(logs);
	});

	it("holds an event past the broker's own consumer timeout while the database is down", async () => {
		// The broker takes a message back from a consumer that holds it past its consumer timeout, as
		// a queue declared as the harness's are, but without a timeout of its own, shows
		const control = 'control.activity';
		await broker.channel.assertQueue(control, {
			durable: true,
			arguments: {
				'x-queue-type': 'quorum',
				'x-single-active-consumer': true,
				'x-delivery-limit': 5
			}
		});
		broker.channel.sendToQueue(control, Buffer.from('{}'), { persistent: true });
		await broker.channel.waitForConfirms();
		const consumer = await connect(broker.urlFor('guest', 'guest'));
		consumer.on('error', () => undefined);
		const holding = await consumer.createChannel();
		let takenBack = '';
		holding.on('error', (err: Error) => {
			takenBack = err.message;
		});
		await holding.prefetch(1);
		await holding.consume(control, () => undefined, { noAck: false });
		await until('the control taken back', () => takenBack.includes('timed out'));
		await consumer.close().catch(() => undefined);
		await broker.channel.deleteQueue(control);
		// The worker holds an event past it, trying it again, and never has it taken back
		const mark = logs.lines().length;
		const event = assignment();
		database.cut();
		try {
			await publish(event);
			await failuresOf(event, 1);
			await new Promise((resolve) => setTimeout(resolve, 3 * CONSUMER_TIMEOUT_MS));
			expect(
				logs
					.lines()
					.slice(mark)
					.filter((line) => ['Channel error', 'Channel closed'].includes(String(line['msg'])))
			).toEqual([]);
			expect(await healthOf(worker)).toBe('connected');
		} finally {
			database.restore();
		}
		await toldAlice(event);
		expect(turnCalls(r.h.apisix.llm.calls, event.id)).toHaveLength(1);
		expectNoContentIn(logs);
	});

	it('dead-letters an event that keeps failing after five attempts, and goes on with the next', async () => {
		await broker.channel.purgeQueue(DEAD_LETTERS);
		const mark = logs.lines().length;
		const failing = assignment();
		const next = assignment();
		await refuseWakeups(`new.event_id = '${failing.id}'`);
		try {
			await publish(failing);
			await publish(next);
			await toldAlice(next);
		} finally {
			await allowWakeups();
		}
		const failures = await failuresOf(failing, 5);
		expect(failures.map((line) => line['transient'])).toEqual(Array(5).fill(false));
		await broker.waitForMessages(DEAD_LETTERS, 1);
		expect(turnCalls(r.h.apisix.llm.calls, failing.id)).toHaveLength(0);
		expect(
			handled(mark).map(({ eventId, outcome, reason }) => ({ eventId, outcome, reason }))
		).toEqual([
			{ eventId: failing.id, outcome: 'dead_lettered', reason: 'failed 5 times' },
			{ eventId: next.id, outcome: 'woken', reason: undefined }
		]);
		expectNoContentIn(logs);
	});

	it('wakes nobody twice when its dead letters are replayed once the fault is fixed', async () => {
		await broker.channel.purgeQueue(DEAD_LETTERS);
		// Carol has an assistant too, whose wake-ups the database refuses for now
		await r.h.synapse.registerUser('carol');
		const created = await r.h.api.post('carol@test.local', '/v1/assistants', { name: 'Friday' });
		expect(created.status).toBe(201);
		const carol = { email: 'carol@test.local', reason: 'assigned' };
		const event = assignment([ALICE, carol]);
		await refuseWakeups(`new.owner = 'carol@test.local'`);
		try {
			// Alice is told at the first attempt, and the event is dead-lettered for Carol's sake
			await publish(event);
			await toldAlice(event);
			await failuresOf(event, 5);
			await broker.waitForMessages(DEAD_LETTERS, 1);
		} finally {
			await allowWakeups();
		}
		const mark = logs.lines().length;
		expect(await broker.replay(DEAD_LETTERS, QUEUE)).toBe(1);
		await until('Carol told', () => turnsOf(r.h.apisix.llm.calls, event.id, 'Friday').length > 0);
		expect(
			handled(mark).map(({ eventId, outcome, outcomes }) => ({ eventId, outcome, outcomes }))
		).toEqual([{ eventId: event.id, outcome: 'woken', outcomes: { duplicate: 1, woken: 1 } }]);
		expect(turnsOf(r.h.apisix.llm.calls, event.id, 'Jarvis')).toHaveLength(1);
		expect(turnsOf(r.h.apisix.llm.calls, event.id, 'Friday')).toHaveLength(1);
		// Taken from both queues, as the broker counts them once it settled them
		await broker.waitForMessages(DEAD_LETTERS, 0);
		await broker.waitForMessages(QUEUE, 0);
		expectNoContentIn(logs);
	});

	it('forgets the wake-ups past their retention, and keeps the younger ones', async () => {
		// The time the worker logged an event as woken
		const wokenAt = async (event: ActivityEvent): Promise<number> => {
			let line: LogLine | undefined;
			await until(`${event.id} woken`, () => {
				line = logs
					.lines()
					.find(
						(each) =>
							each['msg'] === 'event handled' &&
							each['eventId'] === event.id &&
							each['outcome'] === 'woken'
					);
				return line !== undefined;
			});
			return Number(line?.['time']);
		};
		const old = assignment();
		await publish(old);
		const oldAt = await wokenAt(old);
		await new Promise((resolve) => setTimeout(resolve, 3000));
		const young = assignment();
		await publish(young);
		const youngAt = await wokenAt(young);
		// A retention halfway between their ages, for a worker whose start purges
		const retentionMs = Date.now() - youngAt + (youngAt - oldAt) / 2;
		const purgeLogs = logSink();
		const purging = await startWorkerRole({
			config: {
				...r.h.config,
				role: 'worker',
				activity: null,
				wakeups: { ...r.h.config.wakeups, retentionMs }
			},
			db: r.h.db,
			logStream: purgeLogs.stream
		});
		try {
			await until('purged', () =>
				purgeLogs.lines().some((line) => line['msg'] === 'wake-ups purged')
			);
		} finally {
			await purging.stop();
		}
		// Delivered again, the old event wakes Alice again, and the young one does not
		const mark = logs.lines().length;
		await publish(old);
		await publish(young);
		await until('both handled', () => handled(mark).length === 2);
		expect(handled(mark).map(({ eventId, outcome }) => ({ eventId, outcome }))).toEqual([
			{ eventId: old.id, outcome: 'woken' },
			{ eventId: young.id, outcome: 'duplicate' }
		]);
	});

	it('starts without the activity exchange, holds no connection while it waits, and listens once it is there', async () => {
		const vhost = await vhostOf('late', 'twake-harness-late', false);
		const lateLogs = logSink();
		const late = await workerOn(
			broker.urlFor('twake-harness-late', HARNESS_PASSWORD, vhost.name),
			lateLogs.stream
		);
		const connections = async (): Promise<number> =>
			(await broker.connectedUsers(vhost.name)).filter((user) => user === 'twake-harness-late')
				.length;
		try {
			expect(await healthOf(late)).toBe('disconnected');
			await until(
				'three attempts',
				() => lateLogs.lines().filter((line) => line['msg'] === 'listen failed').length >= 3
			);
			// Each attempt closes its connection once it failed, so that none piles up
			expect(await connections()).toBeLessThanOrEqual(1);
			// The platform declares the exchange
			await vhost.channel.assertExchange(ACTIVITY, 'topic', { durable: true });
			await whenListening(late);
			const event = assignment();
			await publishOn(vhost, event);
			await toldAlice(event);
		} finally {
			await late.stop();
		}
		await until('no connection left', async () => (await connections()) === 0);
		expectNoContentIn(lateLogs);
	});

	it('dead-letters, saying so, an event that brings the worker down whenever it holds it', async () => {
		const loop = await vhostOf('loop', 'twake-harness-loop');
		const url = broker.urlFor('twake-harness-loop', HARNESS_PASSWORD, loop.name);
		// A first life declares the queue, before the event is published
		const first = await whenListening(await workerOn(url, silent()));
		await first.stop();
		const event = assignment();
		await publishOn(loop, event);
		const lives: WorkerProcess[] = [];
		const lock = await lockWakeups();
		try {
			// Each life of the worker, a process of its own, takes the event and is killed holding it
			for (let life = 1; life <= 5; life += 1) {
				const process = await startWorkerProcess(url);
				lives.push(process);
				await until(`life ${life} holding the event`, () =>
					process.lines().some((line) => line['msg'] === 'Message received, processing')
				);
				await process.kill('SIGKILL');
			}
			// At the last delivery its queue allows, the next life dead-letters it, and says so
			const last = await startWorkerProcess(url);
			lives.push(last);
			try {
				await until('the event handled', () =>
					last.lines().some((line) => line['msg'] === 'event handled')
				);
				expect(
					last
						.lines()
						.filter((line) => line['msg'] === 'event handled')
						.map(({ eventId, outcome, reason }) => ({ eventId, outcome, reason }))
				).toEqual([{ eventId: event.id, outcome: 'dead_lettered', reason: 'delivery_limit' }]);
				await broker.waitForMessages(DEAD_LETTERS, 1, loop.name);
				await broker.waitForMessages(QUEUE, 0, loop.name);
			} finally {
				await last.kill('SIGTERM');
			}
		} finally {
			await lock.release();
		}
		for (const life of lives) expect(life.text()).not.toContain(CONTENT);
	});

	it('starts while the broker is out of reach, listens once it is back, and stops while it is gone', async () => {
		const vhost = await vhostOf('away', 'twake-harness-away');
		const proxy = await startTcpProxy(() => broker.address());
		proxy.cut();
		const awayLogs = logSink();
		const away = await workerOn(
			proxy.through(broker.urlFor('twake-harness-away', HARNESS_PASSWORD, vhost.name)),
			awayLogs.stream
		);
		let stopped = false;
		try {
			expect(await healthOf(away)).toBe('disconnected');
			await until(
				'three attempts',
				() => awayLogs.lines().filter((line) => line['msg'] === 'listen failed').length >= 3
			);
			// A broker that is not there yet is a warning while the worker tries again, not an error
			expect(
				awayLogs
					.lines()
					.filter((line) => Number(line['level']) >= 50)
					.map((line) => line['msg'])
			).toEqual([]);
			proxy.restore();
			await whenListening(away);
			const event = assignment();
			await publishOn(vhost, event);
			await toldAlice(event);
			// The broker goes again, and the role stops meanwhile, as at a rollout
			proxy.cut();
			await until('disconnected', async () => (await healthOf(away)) === 'disconnected');
			stopped = true;
			await away.stop();
		} finally {
			if (!stopped) await away.stop();
			await proxy.close();
		}
		expectNoContentIn(awayLogs);
	});

	it('answers its health at once against a broker that never answers, and keeps trying', async () => {
		const silent = await startSilentServer();
		const silentLogs = logSink();
		const startedAt = Date.now();
		// A connection has half a second to open, rather than the ten seconds of a deployment
		const role = await workerOn(
			`amqp://${HARNESS_USER}:${HARNESS_PASSWORD}@127.0.0.1:${silent.port}?connection_timeout=500`,
			silentLogs.stream
		);
		try {
			expect(Date.now() - startedAt).toBeLessThan(2000);
			expect(await healthOf(role)).toBe('disconnected');
			await until(
				'three attempts',
				() => silentLogs.lines().filter((line) => line['msg'] === 'listen failed').length >= 3
			);
			// Each attempt gave up on its connection, so that none piles up
			expect(silent.connections()).toBeLessThanOrEqual(1);
			expect(JSON.stringify(silentLogs.lines())).toContain('connect ETIMEDOUT');
		} finally {
			await role.stop();
			await silent.close();
		}
		expectNoContentIn(silentLogs);
	});

	it('tries again when it cannot read its queue again after a reconnection, saying so meanwhile', async () => {
		const vhost = await vhostOf('gone', 'twake-harness-gone');
		const goneLogs = logSink();
		const gone = await workerOn(
			broker.urlFor('twake-harness-gone', HARNESS_PASSWORD, vhost.name),
			goneLogs.stream
		);
		try {
			await whenListening(gone);
			// The exchange goes, then the broker drops the listener's connection
			await vhost.channel.deleteExchange(ACTIVITY);
			await broker.closeConnectionsOf('twake-harness-gone');
			await until('disconnected', async () => (await healthOf(gone)) === 'disconnected');
			await until('tried again', () =>
				goneLogs.lines().some((line) => line['msg'] === 'listen failed')
			);
			await vhost.channel.assertExchange(ACTIVITY, 'topic', { durable: true });
			await until('connected again', async () => (await healthOf(gone)) === 'connected');
			const event = assignment();
			await publishOn(vhost, event);
			await toldAlice(event);
		} finally {
			await gone.stop();
		}
		expectNoContentIn(goneLogs);
	});

	// Last of the suite, since every connection to the broker drops
	it('listens again by itself once the broker restarted, its health saying so meanwhile', async () => {
		expect(await healthOf(worker)).toBe('connected');
		const restarting = broker.restart();
		try {
			await until('disconnected', async () => (await healthOf(worker)) === 'disconnected');
		} finally {
			await restarting;
		}
		await until('connected again', async () => (await healthOf(worker)) === 'connected');
		const event = assignment();
		await publish(event);
		await toldAlice(event);
		expectNoContentIn(logs);
	});
});

describe('the retention of the wake-ups', () => {
	const base = {
		HARNESS_ROLE: 'worker',
		DATABASE_URL: 'postgres://x@localhost/x',
		AUTH_JWKS_URL: 'https://example.test/jwks',
		AUTH_ISSUER: 'https://example.test/',
		AUTH_AUDIENCE: 'twake-harness',
		APISIX_BASE_URL: 'http://apisix.test',
		APISIX_CONSUMER_KEY: 'k'
	};

	it('keeps the wake-ups thirty days unless told otherwise, and an hour at least', () => {
		expect(loadConfig(base).wakeups.retentionMs).toBe(30 * 24 * 3_600_000);
		expect(loadConfig({ ...base, WAKEUPS_RETENTION_MS: '86400000' }).wakeups.retentionMs).toBe(
			86_400_000
		);
		expect(() => loadConfig({ ...base, WAKEUPS_RETENTION_MS: '60000' })).toThrow(
			/^invalid configuration: WAKEUPS_RETENTION_MS/
		);
	});
});
