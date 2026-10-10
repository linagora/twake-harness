import { PassThrough } from 'node:stream';
import type { FastifyInstance } from 'fastify';

import type { Clock } from '../../src/agent/clock.js';
import { buildApp } from '../../src/app.js';
import { loadConfig, type Config } from '../../src/config.js';
import { makeDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { startFakeApisix, type FakeApisix } from './fake-apisix.js';
import { startTestIssuer, type TestIssuer } from './jwks-server.js';

// The container's own user is a superuser, which bypasses row-level security. Tests therefore run
// the harness as a plain role, created here once, exactly like the production role will be.
const ADMIN_DATABASE_URL: string =
	process.env['TEST_ADMIN_DATABASE_URL'] ?? 'postgres://harness:harness@127.0.0.1:5433/harness';
const APP_ROLE = 'harness_app';
const APP_PASSWORD = 'harness_app';

function appDatabaseUrl(adminUrl: string): string {
	const url = new URL(adminUrl);
	url.username = APP_ROLE;
	url.password = APP_PASSWORD;
	return url.toString();
}

export const TEST_DATABASE_URL: string = appDatabaseUrl(ADMIN_DATABASE_URL);

let appRoleReady = false;

export async function ensureAppRole(keepSchema: boolean): Promise<void> {
	if (appRoleReady || keepSchema) return;
	const admin = makeDb(ADMIN_DATABASE_URL);
	try {
		await admin.sql.unsafe(`do $$ begin
			if not exists (select 1 from pg_roles where rolname = '${APP_ROLE}') then
				create role ${APP_ROLE} login password '${APP_PASSWORD}' nosuperuser nobypassrls;
			end if;
		end $$`);
		const database = new URL(ADMIN_DATABASE_URL).pathname.slice(1);
		await admin.sql.unsafe(`grant all on database "${database}" to ${APP_ROLE}`);
		// A fresh schema owned by the application role: its tables are then its own, and the
		// forced row-level security applies to it as it will to the production role.
		await admin.sql.unsafe('drop schema public cascade');
		await admin.sql.unsafe(`create schema public authorization ${APP_ROLE}`);
	} finally {
		await admin.close();
	}
	appRoleReady = true;
}

// How many api replicas serve the suite, all on the same database; the client spreads its
// requests over them, so every suite also runs as it would behind a load balancer
export const TEST_REPLICAS: number = Math.max(1, Number(process.env['TEST_REPLICAS'] ?? '1'));

export interface TestHarness {
	readonly app: FastifyInstance;
	// Every replica, the first being `app`
	readonly apps: readonly FastifyInstance[];
	readonly db: Db;
	readonly issuer: TestIssuer;
	readonly apisix: FakeApisix;
	readonly config: Config;
	logLines(): Record<string, unknown>[];
	close(): Promise<void>;
}

export async function resetDatabase(db: Db): Promise<void> {
	await runMigrations(db);
	await db.sql.unsafe(
		'truncate table principals, sessions, memory_entries, matrix_transactions, matrix_registered_users, assistants, creator_dialogs, jobs, assistant_rooms, skills, principal_index, usage_daily, usage_window, usage_window_global, matrix_user_storage, wakeups, assistant_escrow, assistant_cross_signing, assistant_provisioned, consents, pending_calls, owner_cross_signing, owner_device_notices, owner_words_received, owner_megolm_sessions, owner_settings, delegation_reminders, suggestion_settings, suggestion_mutes, suggestions, listening_journal, listened_sources, brief_delegation_waits, held_activities'
	);
}

export interface StartOptions {
	// Keep the rows of a previous harness, to check what survives a restart
	readonly keepData?: boolean;
	// Settings of this harness, over the defaults
	readonly env?: Record<string, string>;
	// The present the agent reads, set by the test instead of the system clock
	readonly clock?: Clock;
}

export async function startTestHarness(options: StartOptions = {}): Promise<TestHarness> {
	await ensureAppRole(options.keepData === true);
	const issuer = await startTestIssuer();
	const apisix = await startFakeApisix();
	const config = loadConfig({
		HARNESS_ROLE: 'api',
		DATABASE_URL: TEST_DATABASE_URL,
		AUTH_JWKS_URL: issuer.jwksUrl.toString(),
		AUTH_ISSUER: issuer.issuer,
		AUTH_AUDIENCE: issuer.audience,
		APISIX_BASE_URL: apisix.baseUrl,
		APISIX_CONSUMER_KEY: apisix.consumerKey,
		LLM_MODEL: 'qwen3.8',
		CONTRACTS_REFRESH_MS: '0',
		LOG_LEVEL: 'info',
		// Quiet hours only where a test sets them: the others run at any hour of the system clock
		QUIET_HOURS_DEFAULT: 'none',
		...(options.env ?? {})
	});
	const db = makeDb(config.databaseUrl);
	if (options.keepData === true) {
		await runMigrations(db);
	} else {
		await resetDatabase(db);
	}
	const logStream = new PassThrough();
	const chunks: string[] = [];
	logStream.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')));
	const apps: FastifyInstance[] = [];
	for (let i = 0; i < TEST_REPLICAS; i += 1) {
		const app = await buildApp({
			config,
			db,
			logStream,
			...(options.clock === undefined ? {} : { clock: options.clock })
		});
		await app.ready();
		apps.push(app);
	}
	const app = apps[0];
	if (app === undefined) throw new Error('no replica started');
	return {
		app,
		apps,
		db,
		issuer,
		apisix,
		config,
		logLines: () =>
			chunks
				.join('')
				.split('\n')
				.filter((line) => line.length > 0)
				.map((line) => JSON.parse(line) as Record<string, unknown>),
		close: async () => {
			for (const replica of apps) await replica.close();
			await db.close();
			await issuer.close();
			await apisix.close();
		}
	};
}
