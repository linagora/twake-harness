import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { FastifyInstance } from 'fastify';

import type { Clock } from '../../src/agent/clock.js';
import { startTurnWorker } from '../../src/agent/turn-worker.js';
import type { JobKind, RetryDelays } from '../../src/jobs/queue.js';
import type { JobWorker } from '../../src/jobs/worker.js';
import { buildApp } from '../../src/app.js';
import { loadConfig, type Config } from '../../src/config.js';
import { makeDb, type Db } from '../../src/db/client.js';
import { spaceFromConfig } from '../../src/suggestions/space.js';
import { buildRegistrationFile } from '../../src/matrix/registration.js';
import { startMatrixRole, type MatrixRole } from '../../src/matrix/role.js';
import { ensureAppRole, resetDatabase, TEST_DATABASE_URL, TEST_REPLICAS } from './app.js';
import { makeClient, type TestClient } from './client.js';
import { startFakeApisix, type FakeApisix } from './fake-apisix.js';
import { startTestIssuer, type TestIssuer } from './jwks-server.js';
import { reservePort, startTestSynapse, SYNAPSE_SERVER_NAME, type TestSynapse } from './synapse.js';

export interface MatrixTestHarness {
	// Stops and starts the matrix role again on the same database and encryption stores, or
	// with the stores and the devices' tokens lost, as a volume would be; with settings over this
	// harness's, as a deployment whose values changed, the api role keeping its own
	restartRole(options?: { wipeCryptoStore?: boolean; env?: Record<string, string> }): Promise<void>;
	readonly synapse: TestSynapse;
	readonly apisix: FakeApisix;
	role: MatrixRole;
	readonly config: Config;
	readonly db: Db;
	readonly port: number;
	readonly hsToken: string;
	readonly issuer: TestIssuer;
	// The api role on the same database, driven over HTTP, and its replicas
	readonly api: TestClient;
	readonly apps: readonly FastifyInstance[];
	logLines(): Record<string, unknown>[];
	// Stops the turn workers of the api replicas, as when the api role is down, and starts them
	// again, as when it is back: on the first replica alone when asked, the one `api` calls, so that
	// a turn the queue runs waits for the owner's turn `api` runs, as on a single replica
	stopTurnWorkers(): Promise<void>;
	startTurnWorkers(options?: { readonly firstReplicaOnly?: boolean }): void;
	// What the matrix role made of a message of an assistant's room, as it logged it: the line of
	// the turn it queued, or of the message it ignored; null when it logged neither in time
	decisionOn(eventId: string): Promise<Record<string, unknown> | null>;
	close(): Promise<void>;
}

// The matrix role, a real Synapse pushing to it and the fake APISIX in between for its calls.
export interface MatrixStartOptions {
	// Settings of this harness, over the defaults
	readonly env?: Record<string, string>;
	// Settings of its homeserver, over the suites' own
	readonly synapse?: Readonly<Record<string, unknown>>;
	// How long the role lets the SDK process a push before it gives the push up
	readonly pushDeadlineMs?: number;
	// How long a status message waits for its turn's answer before it gives up
	readonly statusMaxMs?: number;
	// How long a job of the matrix role that failed waits before each of its next tries, by kind,
	// over the queue's
	readonly retryDelaysMs?: Partial<Record<JobKind, RetryDelays>>;
	// The present the agent, the creator and the check of the owner's devices read, set by the test
	// instead of the system clock
	readonly clock?: Clock;
}

// The lines by which the matrix role tells what it made of a message of an assistant's room
const MESSAGE_DECISIONS = new Set([
	'turn queued',
	'assistant ignored an unencrypted message',
	'assistant ignored an unverified device',
	'assistant ignored a copy of earlier words',
	'assistant command answered',
	'assistant ignored words of an old session'
]);

export async function startMatrixHarness(
	options: MatrixStartOptions = {}
): Promise<MatrixTestHarness> {
	await ensureAppRole(false);
	// Held while Synapse starts, so its mapped port cannot land on the role's
	const reserved = await reservePort();
	const port = reserved.port;
	const asToken = 'as-token-test';
	const hsToken = 'hs-token-test';
	const apisix = await startFakeApisix();
	const issuer = await startTestIssuer();
	const settings: Record<string, string> = {
		HARNESS_ROLE: 'matrix',
		DATABASE_URL: TEST_DATABASE_URL,
		AUTH_JWKS_URL: issuer.jwksUrl.toString(),
		AUTH_ISSUER: issuer.issuer,
		AUTH_AUDIENCE: issuer.audience,
		APISIX_BASE_URL: apisix.baseUrl,
		APISIX_CONSUMER_KEY: apisix.consumerKey,
		MATRIX_SERVER_NAME: SYNAPSE_SERVER_NAME,
		MATRIX_AS_TOKEN: asToken,
		MATRIX_HS_TOKEN: hsToken,
		MATRIX_CRYPTO_STORE_PATH: join(await mkdtemp(join(tmpdir(), 'harness-crypto-')), 'crypto'),
		LOG_LEVEL: 'info',
		// The status message of a slow turn has a suite of its own: elsewhere, whatever the speed of
		// the runner, a turn answers with a message of its own as before
		TURN_STATUS_DELAY_MS: '600000',
		// Quiet hours only where a test sets them: the others run at any hour of the system clock
		QUIET_HOURS_DEFAULT: 'none',
		...(options.env ?? {})
	};
	const config = loadConfig(settings);
	const synapse = await startTestSynapse(
		{ file: buildRegistrationFile(config, `http://host.docker.internal:${port}`) },
		options.synapse
	);
	apisix.matrixUpstream = synapse.url;
	apisix.matrixAsToken = asToken;
	const db = makeDb(config.databaseUrl);
	await resetDatabase(db);
	const logStream = new PassThrough();
	const chunks: string[] = [];
	logStream.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')));
	const logLines = (): Record<string, unknown>[] =>
		chunks
			.join('')
			.split('\n')
			.filter((line) => line.length > 0)
			.map((line) => JSON.parse(line) as Record<string, unknown>);
	// The api role, replicated as in the deployment: each replica has its own turn worker
	const apps: FastifyInstance[] = [];
	for (let i = 0; i < TEST_REPLICAS; i += 1) {
		const replica = await buildApp({
			config,
			db,
			logStream,
			...(options.clock === undefined ? {} : { clock: options.clock })
		});
		await replica.ready();
		apps.push(replica);
	}
	let workers: JobWorker[] = [];
	const startTurnWorkers = (options: { readonly firstReplicaOnly?: boolean } = {}): void => {
		workers = apps.slice(0, options.firstReplicaOnly === true ? 1 : apps.length).map((replica) =>
			startTurnWorker({
				db,
				agent: replica.agent,
				log: replica.log,
				locale: config.locale,
				turn: config.turn,
				requestLifetimeMs: config.consent.requestLifetimeMs,
				suggestions: { config, space: spaceFromConfig(config, replica.log) },
				pollIntervalMs: 100
			})
		);
	};
	const stopTurnWorkers = async (): Promise<void> => {
		for (const worker of workers) await worker.stop();
		workers = [];
	};
	startTurnWorkers();
	const app = apps[0];
	if (app === undefined) throw new Error('no replica started');
	const startRole = (roleConfig: Config = config): Promise<MatrixRole> =>
		startMatrixRole({
			config: roleConfig,
			db,
			log: app.log,
			port,
			bindAddress: '0.0.0.0',
			pollIntervalMs: 100,
			...(options.pushDeadlineMs === undefined ? {} : { pushDeadlineMs: options.pushDeadlineMs }),
			...(options.statusMaxMs === undefined ? {} : { statusMaxMs: options.statusMaxMs }),
			...(options.retryDelaysMs === undefined ? {} : { retryDelaysMs: options.retryDelaysMs }),
			...(options.clock === undefined ? {} : { clock: options.clock })
		});
	await reserved.release();
	let role = await startRole();
	const api = makeClient({ app, issuer } as Parameters<typeof makeClient>[0]);
	// On a CI runner the only window into a failed Matrix scenario is this summary
	async function printDiagnostics(): Promise<void> {
		const interesting = new Set([
			'message received',
			'turn queued',
			'turn started',
			'turn finished',
			'turn failed',
			'answer sent',
			'welcome queued',
			'invite accepted',
			'decryption failed',
			'job failed',
			'creator command',
			'assistant ignored a foreign sender',
			'assistant ignored an unencrypted message',
			'assistant created',
			'to-device received',
			'encryption ready',
			'cross-signing identity reset',
			'assistant device cross-signed',
			'missed key shares fetched',
			'decryption retry failed',
			'owner device verified',
			'owner device unverified',
			'assistant ignored an unverified device',
			'assistant ignored a copy of earlier words',
			'assistant ignored words of an old session',
			'owner device check failed'
		]);
		const lines = logLines()
			.filter(
				(line) =>
					interesting.has(String(line['msg'])) ||
					Number(line['level']) >= 40 ||
					// With HARNESS_SDK_LOGS=1, what the SDK does with the pushed to-device events
					(line['msg'] === 'matrix sdk' &&
						/to_device|Updating crypto|Processing transaction/.test(JSON.stringify(line['rest'])))
			)
			.map((line) => {
				const { time, pid, hostname, ...rest } = line;
				void pid;
				void hostname;
				return `${String(time)} ${JSON.stringify(rest).slice(0, 300)}`;
			});
		process.stdout.write(
			`\n--- matrix role diagnostics (${lines.length} lines) ---\n${lines.join('\n')}\n`
		);
		const proxy = apisix.matrixCalls
			.filter((c) => /keys|sendToDevice|send\/m\.room|login|devices|sync/.test(c.path))
			.map((c) => `${c.method} ${c.path.slice(0, 110)} -> ${c.status} ${c.ms}ms`);
		process.stdout.write(`--- matrix proxy calls (${proxy.length}) ---\n${proxy.join('\n')}\n`);
		const synapseLog = await synapse.logs().catch(() => '');
		const pushes = synapseLog
			.split('\n')
			.filter((line) =>
				/as-sender|as-recoverer|appservice\.scheduler|to_device|msc2409|send\/m\.room|sendToDevice|keys\/(claim|query|upload)/i.test(
					line
				)
			)
			.slice(-80)
			.map((line) => line.slice(0, 220));
		process.stdout.write(
			`--- synapse appservice log (last ${pushes.length}) ---\n${pushes.join('\n')}\n`
		);
	}

	const harness: MatrixTestHarness = {
		restartRole: async (options = {}) => {
			await role.stop();
			if (options.wipeCryptoStore === true) {
				await rm(config.matrix.cryptoStorePath, { recursive: true, force: true });
				await db.sql`delete from matrix_user_storage`;
			}
			role = await startRole(
				options.env === undefined ? config : loadConfig({ ...settings, ...options.env })
			);
			harness.role = role;
		},
		synapse,
		apisix,
		role,
		config,
		db,
		port,
		hsToken,
		issuer,
		api,
		apps,
		logLines,
		stopTurnWorkers,
		startTurnWorkers,
		decisionOn: async (eventId) => {
			for (let i = 0; i < 120; i += 1) {
				const decision = logLines().find(
					(line) => line['eventId'] === eventId && MESSAGE_DECISIONS.has(String(line['msg']))
				);
				if (decision !== undefined) return decision;
				await new Promise((resolve) => setTimeout(resolve, 250));
			}
			return null;
		},
		close: async () => {
			if (process.env['CI'] !== undefined) await printDiagnostics();
			await stopTurnWorkers();
			await role.stop();
			for (const replica of apps) await replica.close();
			await db.close();
			await synapse.stop();
			await apisix.close();
			await issuer.close();
		}
	};
	return harness;
}
