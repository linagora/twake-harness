import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { TransactionSql } from 'postgres';

import { withPrincipal, type Db } from '../src/db/client.js';
import { getMessages } from '../src/i18n/messages.js';
import { startTestHarness, type TestHarness } from './helpers/app.js';
import { makeClient, type TestClient } from './helpers/client.js';
import { readCatalog, startConsentRoom, type ConsentRoom } from './helpers/consent-room.js';
import { grantConsent } from './helpers/consents.js';
import {
	BROKER_CONSENT_URL,
	brokerRefusal,
	type ChatRequest,
	type ScriptedReply,
	type ToolCall
} from './helpers/fake-apisix.js';

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

const DOMAINS = [
	'mail',
	'drive',
	'calendar',
	'notes',
	'tasks',
	'wiki',
	'boards',
	'contacts',
	'forms'
];

// The harness's question about a first read, all the API shows of its request
function question(domain: string): string {
	return `This is the first time I need to read your data in ${domain}. Do you allow it?`;
}

// The whole request, as the room and the chat through the API show it: the question, under which
// a first read shows no call, and how to answer
function requestFor(domain: string): string {
	return [question(domain), 'Answer yes or no in your next message.'].join('\n\n');
}

function call(name: string, args: unknown): ToolCall[] {
	return [
		{ id: `call_${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }
	];
}

// A literal model: it searches the application its owner names, and tells what the search
// returned
function searchingModel(request: ChatRequest): ScriptedReply {
	const last = request.messages.at(-1);
	if (last?.role === 'tool') return { content: `Told: ${last.content ?? ''}` };
	const domain = /in my (\w+)/.exec(last?.content ?? '')?.[1] ?? 'mail';
	return { toolCalls: call(`search_${domain}`, { q: 'budget' }) };
}

// A pending call as the API shows it, frozen in a turn through the API in a session
function pendingInTurn(domain: string, sessionId: string): Record<string, unknown> {
	return {
		id: expect.stringMatching(/^[0-9a-f-]{36}$/),
		channel: 'api_chat',
		session_id: sessionId,
		tool: `search_${domain}`,
		contract: `${domain}.items.read.v1`,
		domain,
		level: 'read',
		reasons: ['consent'],
		request: question(domain),
		created_at: expect.any(String),
		expires_at: expect.any(String)
	};
}

// What the harness keeps of one of an owner's pending calls: the arguments it would send, and the
// question asked about it
async function keptOf(
	db: Db,
	owner: string,
	id: string
): Promise<{ arguments: unknown; request: unknown }> {
	const rows = await withPrincipal(
		db,
		{ id: owner },
		(tx) =>
			tx.sql<{ arguments: unknown; request_text: unknown }[]>`
			select arguments, request_text from pending_calls where id = ${id}`
	);
	return { arguments: rows[0]?.arguments ?? null, request: rows[0]?.request_text ?? null };
}

// What an approval through the API leaves when its replica dies before the call runs: the call
// approved by that answer, never run, its arguments kept
async function leftUnrun(db: Db, owner: string, id: string, minutesAgo: number): Promise<void> {
	await withPrincipal(
		db,
		{ id: owner },
		(tx) => tx.sql`
			update pending_calls set status = 'approved', answer_event_id = 'api:lost-replica',
				decided_at = now() - make_interval(mins => ${minutesAgo})
			where id = ${id}`
	);
}

// Holds a lock in a transaction of its own until released, so that two answers meet in the order
// a race could give them
async function holdLock(
	db: Db,
	owner: string,
	take: (sql: TransactionSql) => Promise<unknown>
): Promise<{ release(): Promise<void> }> {
	let release = (): void => undefined;
	const released = new Promise<void>((resolve) => {
		release = resolve;
	});
	let held = (): void => undefined;
	const taken = new Promise<void>((resolve) => {
		held = resolve;
	});
	const done = db.sql.begin(async (sql) => {
		await sql`select set_config('app.principal', ${owner}, true)`;
		await take(sql);
		held();
		await released;
	});
	await taken;
	return {
		release: async () => {
			release();
			await done;
		}
	};
}

// Waits until this many of the harness's statements that read like the pattern wait for a lock
async function untilWaiting(db: Db, pattern: string, count: number): Promise<void> {
	for (let i = 0; i < 120; i += 1) {
		const rows = await db.sql<{ n: number }[]>`
			select count(*)::int as n from pg_stat_activity
			where wait_event_type = 'Lock' and query ilike ${pattern}`;
		if ((rows[0]?.n ?? 0) >= count) return;
		await sleep(250);
	}
	throw new Error(`no ${count} statements like ${pattern} waiting for a lock`);
}

// What the api replicas count, as a dashboard sums them
async function countedLines(h: Pick<TestHarness, 'apps'>): Promise<string[]> {
	const lines: string[] = [];
	for (const app of h.apps) {
		lines.push(...(await app.inject({ method: 'GET', url: '/metrics' })).body.split('\n'));
	}
	return lines;
}

// What a client reads of a turn through the API that stopped on the harness's question
interface WaitingTurn {
	readonly session_id: string;
	readonly pending_call: { readonly id: string };
}

describe('my consents through the API', () => {
	let h: TestHarness;
	let c: TestClient;
	beforeAll(async () => {
		// Many turns of one owner in a row: admission is the subject of its own suite below
		h = await startTestHarness({ env: { ADMISSION_USER_PER_MINUTE: '100' } });
		c = makeClient(h);
		h.apisix.contracts.spec = readCatalog(DOMAINS);
		for (const app of h.apps) expect(await app.agent.contracts.load()).toBe(DOMAINS.length);
		h.apisix.llm.script = searchingModel;
	});
	afterAll(async () => {
		if (h !== undefined) await h.close();
	});
	beforeEach(() => {
		h.apisix.contracts.calls.length = 0;
		h.apisix.contracts.handler = (c) => ({ status: 200, body: { found: c.path } });
	});

	it('lists, grants and withdraws my consents with my own token, and my assistant follows', async () => {
		expect(await c.get('alice', '/v1/consents')).toEqual({
			status: 200,
			body: { consents: [] }
		});
		const granted = await c.put('alice', '/v1/consents/mail/read', {});
		expect(granted).toEqual({
			status: 201,
			body: {
				domain: 'mail',
				level: 'read',
				granted_by: 'api',
				granted_at: expect.any(String),
				label: 'mail'
			}
		});
		expect((await c.put('alice', '/v1/consents/mail/read', {})).status).toBe(200);
		expect((await c.get('alice', '/v1/consents')).body).toEqual({
			consents: [granted.body]
		});
		// The grant is logged once, at info, with the level it grants
		const grants = h.logLines().filter((line) => line['msg'] === 'consent granted');
		expect(grants).toHaveLength(1);
		expect(grants[0]).toMatchObject({
			level: 30,
			principal: 'alice',
			domain: 'mail',
			consentLevel: 'read'
		});
		// My assistant reads my mail without asking me first
		const read = await c.post<{ answer: string }>('alice', '/v1/chat', {
			message: 'Find the budget in my mail'
		});
		expect(read.body.answer).toBe(
			'Told: {"status":200,"body":{"found":"/contracts/v1/mail/items"}}'
		);
		expect(h.apisix.contracts.calls).toHaveLength(1);
		expect((await c.delete('alice', '/v1/consents/mail/read')).status).toBe(204);
		expect((await c.delete('alice', '/v1/consents/mail/read')).status).toBe(404);
		// and asks me again once I withdrew it
		const asked = await c.post<{ answer: string }>('alice', '/v1/chat', {
			message: 'Find the budget in my mail'
		});
		expect(asked.body.answer).toBe(requestFor('mail'));
		expect(h.apisix.contracts.calls).toHaveLength(1);
	});
	it('lists, grants and withdraws my availability sharing, which no contract offers', async () => {
		// No contract of the catalog offers it, yet the API grants it at reading and lists it with
		// the harness's own label
		const granted = await c.put('alice', '/v1/consents/availability/read', {});
		expect(granted).toEqual({
			status: 201,
			body: {
				domain: 'availability',
				level: 'read',
				granted_by: 'api',
				granted_at: expect.any(String),
				label: 'Sharing your availability'
			}
		});
		// A second yes changes nothing
		expect((await c.put('alice', '/v1/consents/availability/read', {})).status).toBe(200);
		const listed = await c.get<{ consents: unknown[] }>('alice', '/v1/consents');
		expect(listed.body.consents).toContainEqual(granted.body);
		// Only reading: the harness shares the free/busy of my calendar, never writes there
		expect(await c.put('alice', '/v1/consents/availability/write', {})).toEqual({
			status: 404,
			body: { error: 'resource unavailable' }
		});
		// I withdraw it, and it leaves the list
		expect((await c.delete('alice', '/v1/consents/availability/read')).status).toBe(204);
		expect((await c.delete('alice', '/v1/consents/availability/read')).status).toBe(404);
		const after = await c.get<{ consents: unknown[] }>('alice', '/v1/consents');
		expect(after.body.consents).not.toContainEqual(granted.body);
	});
	it('keeps my availability sharing apart from the reading of my calendar', async () => {
		// The sharing reads only the free/busy of my calendar: granting it never lets my assistant
		// read my calendar, and allowing that reading never shares my availability
		expect((await c.put('alice', '/v1/consents/availability/read', {})).status).toBe(201);
		let domains = (
			await c.get<{ consents: { domain: string; level: string }[] }>('alice', '/v1/consents')
		).body.consents;
		expect(domains.map((consent) => `${consent.domain} ${consent.level}`)).toEqual([
			'availability read'
		]);
		expect((await c.put('alice', '/v1/consents/calendar/read', {})).status).toBe(201);
		domains = (
			await c.get<{ consents: { domain: string; level: string }[] }>('alice', '/v1/consents')
		).body.consents;
		expect(domains.map((consent) => `${consent.domain} ${consent.level}`).sort()).toEqual([
			'availability read',
			'calendar read'
		]);
		// Taking the availability sharing back leaves the calendar reading in place
		expect((await c.delete('alice', '/v1/consents/availability/read')).status).toBe(204);
		domains = (
			await c.get<{ consents: { domain: string; level: string }[] }>('alice', '/v1/consents')
		).body.consents;
		expect(domains.map((consent) => `${consent.domain} ${consent.level}`)).toEqual([
			'calendar read'
		]);
		// Leaves the suite as it found it
		expect((await c.delete('alice', '/v1/consents/calendar/read')).status).toBe(204);
	});
	it("keeps my consents out of everyone else's reach", async () => {
		expect((await c.put('alice', '/v1/consents/drive/read', {})).status).toBe(201);
		expect((await c.get('bob', '/v1/consents')).body).toEqual({ consents: [] });
		expect((await c.delete('bob', '/v1/consents/drive/read')).status).toBe(404);
		expect((await c.put('bob', '/v1/consents/notes/read', {})).status).toBe(201);
		const mine = await c.get<{ consents: { domain: string; level: string }[] }>(
			'alice',
			'/v1/consents'
		);
		expect(mine.body.consents.map((consent) => `${consent.domain} ${consent.level}`)).toEqual([
			'drive read'
		]);
		// Without my token, nothing is listed
		const anonymous = await h.app.inject({ method: 'GET', url: '/v1/consents' });
		expect(anonymous.statusCode).toBe(401);
		expect(anonymous.json()).toEqual({ error: 'invalid token' });
	});

	it('asks of my token the rights the other owner routes ask', async () => {
		// Erin may no longer chat with her assistant; Frank may, but not withdraw what he allowed
		for (const [id, actions] of [
			['erin', ['contracts.call']],
			['frank', ['chat', 'contracts.call']]
		] as const) {
			await h.db.sql.begin(async (sql) => {
				await sql`select set_config('app.principal', ${id}, true)`;
				await sql`insert into principals (id, actions) values (${id}, ${sql.json([...actions])})`;
			});
		}
		const someCall = '00000000-0000-4000-8000-000000000000';
		const refused = { status: 403, body: { error: 'forbidden' } };
		expect(await c.get('erin', '/v1/consents')).toEqual(refused);
		expect(await c.put('erin', '/v1/consents/mail/read', {})).toEqual(refused);
		expect(await c.get('erin', '/v1/pending-calls')).toEqual(refused);
		expect(await c.post('erin', `/v1/pending-calls/${someCall}/approve`, {})).toEqual(refused);
		expect(await c.post('erin', `/v1/pending-calls/${someCall}/refuse`, {})).toEqual(refused);
		expect((await c.put('frank', '/v1/consents/mail/read', {})).status).toBe(201);
		expect(await c.delete('frank', '/v1/consents/mail/read')).toEqual(refused);
		expect((await c.get('frank', '/v1/consents')).status).toBe(200);
	});

	it('grants only what the catalog offers, and builds nothing in, the reading of events no more', async () => {
		// No application of the catalog is called photos or events, no mail contract writes, and
		// admin is no level
		for (const path of ['photos/read', 'events/read', 'mail/write', 'mail/admin']) {
			expect(await c.put('alice', `/v1/consents/${path}`, {})).toEqual({
				status: 404,
				body: { error: 'resource unavailable' }
			});
		}
		expect((await c.delete('alice', '/v1/consents/mail/admin')).status).toBe(404);
		expect(await c.delete('alice', '/v1/consents/events/read')).toEqual({
			status: 404,
			body: { error: 'resource unavailable' }
		});
	});
	it('returns the pending call of a turn through the API, and the gateway receives nothing', async () => {
		const turn = await h.app.inject({
			method: 'POST',
			url: '/v1/chat',
			headers: {
				authorization: `Bearer ${await h.issuer.mint({ sub: 'alice' })}`,
				'x-request-id': 'corr-chat-tasks'
			},
			payload: { message: 'Find the budget in my tasks' }
		});
		expect(turn.statusCode).toBe(200);
		const body = turn.json<{
			session_id: string;
			pending_call: { created_at: string; expires_at: string };
		}>();
		expect(body).toEqual({
			session_id: expect.any(String),
			answer: requestFor('tasks'),
			model: 'qwen3.8',
			pending_call: pendingInTurn('tasks', body.session_id)
		});
		// It waits for a day, as a question in the room does
		expect(
			Date.parse(body.pending_call.expires_at) - Date.parse(body.pending_call.created_at)
		).toBe(86_400_000);
		expect(h.apisix.contracts.calls).toHaveLength(0);
	});
	it("lists what waits for my answer, and nothing of anyone else's", async () => {
		const turn = await c.post<{ session_id: string; pending_call: { id: string } }>(
			'alice',
			'/v1/chat',
			{ message: 'Find the budget in my wiki' }
		);
		const waiting = await c.get<{ pending_calls: { id: string }[] }>('alice', '/v1/pending-calls');
		expect(waiting.status).toBe(200);
		expect(waiting.body.pending_calls).toContainEqual(pendingInTurn('wiki', turn.body.session_id));
		expect(await c.get('bob', '/v1/pending-calls')).toEqual({
			status: 200,
			body: { pending_calls: [] }
		});
	});
	it('runs the call of a turn through the API once I approve it, and the conversation goes on', async () => {
		const turn = await h.app.inject({
			method: 'POST',
			url: '/v1/chat',
			headers: {
				authorization: `Bearer ${await h.issuer.mint({ sub: 'alice' })}`,
				'x-request-id': 'corr-chat-boards'
			},
			payload: { message: 'Find the budget in my boards' }
		});
		const { session_id: sessionId, pending_call: pending } = turn.json<WaitingTurn>();
		// Nobody else answers for me
		expect((await c.post('bob', `/v1/pending-calls/${pending.id}/approve`, {})).status).toBe(404);
		expect(h.apisix.contracts.calls).toHaveLength(0);
		expect(await c.post('alice', `/v1/pending-calls/${pending.id}/approve`, {})).toEqual({
			status: 200,
			body: {
				session_id: sessionId,
				answer: 'Told: {"status":200,"body":{"found":"/contracts/v1/boards/items"}}',
				model: 'qwen3.8'
			}
		});
		// The call ran as it was frozen, in my name, linked to the turn that froze it
		expect(h.apisix.contracts.calls).toHaveLength(1);
		const ran = h.apisix.contracts.calls[0];
		expect(ran?.query).toEqual({ q: 'budget' });
		expect(ran?.headers['x-twake-on-behalf-of']).toBe('alice');
		expect(ran?.headers['x-correlation-id']).toBe('corr-chat-boards');
		// A second answer finds it decided, and runs nothing
		expect(await c.post('alice', `/v1/pending-calls/${pending.id}/approve`, {})).toEqual({
			status: 409,
			body: { error: 'pending call closed', state: 'decided' }
		});
		expect(h.apisix.contracts.calls).toHaveLength(1);
		// My yes allowed the application, through the API
		const consents = await c.get<{ consents: { domain: string }[] }>('alice', '/v1/consents');
		expect(consents.body.consents.find((consent) => consent.domain === 'boards')).toMatchObject({
			level: 'read',
			granted_by: 'api'
		});
		// An operator sees one answer through the API, which decided the call
		expect(await countedLines(h)).toContain(
			'harness_consent_answers_total{domain="boards",level="read",reason="consent",answer="yes",via="api",outcome="decided"} 1'
		);
	});
	it('returns the pending call of a direct tool call, and runs the call once I approve it', async () => {
		const frozen = await h.app.inject({
			method: 'POST',
			url: '/v1/tool',
			headers: {
				authorization: `Bearer ${await h.issuer.mint({ sub: 'alice' })}`,
				'x-request-id': 'corr-tool-contacts'
			},
			payload: { tool: 'search_contacts', arguments: { q: 'Paul' } }
		});
		expect(frozen.statusCode).toBe(202);
		const { pending_call: pending } = frozen.json<{ pending_call: { id: string } }>();
		expect(pending).toEqual({
			...pendingInTurn('contacts', ''),
			channel: 'api_tool',
			session_id: null
		});
		expect(h.apisix.contracts.calls).toHaveLength(0);
		// My yes runs the call as it was frozen, and answers as the tool call would have
		expect(await c.post('alice', `/v1/pending-calls/${pending.id}/approve`, {})).toEqual({
			status: 200,
			body: { status: 200, body: { found: '/contracts/v1/contacts/items' } }
		});
		expect(h.apisix.contracts.calls).toHaveLength(1);
		expect(h.apisix.contracts.calls[0]?.query).toEqual({ q: 'Paul' });
		expect(h.apisix.contracts.calls[0]?.headers['x-correlation-id']).toBe('corr-tool-contacts');
		expect(await keptOf(h.db, 'alice', pending.id)).toEqual({ arguments: null, request: null });
		expect(await c.post('alice', `/v1/pending-calls/${pending.id}/approve`, {})).toEqual({
			status: 409,
			body: { error: 'pending call closed', state: 'decided' }
		});
		expect(h.apisix.contracts.calls).toHaveLength(1);
	});
	it('keeps the rights to call contracts above my answer through the API', async () => {
		const frozen = await c.tool<{ pending_call: { id: string } }>('carol', 'search_forms', {
			q: 'leave'
		});
		expect(frozen.status).toBe(202);
		// An administrator cuts Carol's assistant off from the contracts before she answers
		await h.db.sql.begin(async (sql) => {
			await sql`select set_config('app.principal', 'carol', true)`;
			await sql`update principals set actions = ${sql.json(['chat'])} where id = 'carol'`;
		});
		expect(
			await c.post('carol', `/v1/pending-calls/${frozen.body.pending_call.id}/approve`, {})
		).toEqual({ status: 403, body: { error: 'forbidden' } });
		expect(h.apisix.contracts.calls).toHaveLength(0);
	});

	it('drops a pending call when I refuse it, and keeps nothing of what it would have sent', async () => {
		const turn = await c.post<WaitingTurn>('alice', '/v1/chat', {
			message: 'Find the budget in my notes'
		});
		const { id } = turn.body.pending_call;
		expect((await c.post('bob', `/v1/pending-calls/${id}/refuse`, {})).status).toBe(404);
		expect(await c.post('alice', `/v1/pending-calls/${id}/refuse`, {})).toEqual({
			status: 200,
			body: { id, status: 'refused' }
		});
		expect(await c.post('alice', `/v1/pending-calls/${id}/approve`, {})).toEqual({
			status: 409,
			body: { error: 'pending call closed', state: 'decided' }
		});
		expect(h.apisix.contracts.calls).toHaveLength(0);
		const waiting = await c.get<{ pending_calls: { id: string }[] }>('alice', '/v1/pending-calls');
		expect(waiting.body.pending_calls.map((call) => call.id)).not.toContain(id);
		expect(await keptOf(h.db, 'alice', id)).toEqual({ arguments: null, request: null });
		expect(await countedLines(h)).toContain(
			'harness_consent_answers_total{domain="notes",level="read",reason="consent",answer="no",via="api",outcome="decided"} 1'
		);
	});
	it('shows through the API the question alone, never the call nor what the model wrote with it', async () => {
		const script = h.apisix.llm.script;
		// The model writes a few words with the call, and the call holds what I keep to myself
		h.apisix.llm.script = (request, index) =>
			request.messages.at(-1)?.content === 'Search my notes for the reorganisation'
				? {
						content: 'Searching your notes for the Q3 reorganisation memo',
						toolCalls: call('search_notes', { q: 'Q3 reorganisation memo' })
					}
				: script(request, index);
		try {
			const turn = await c.post<{ answer: string; pending_call: unknown }>('alice', '/v1/chat', {
				message: 'Search my notes for the reorganisation'
			});
			// I read the whole request, as my room would show it: what the model wrote, then the
			// question, under which a first read shows no call
			expect(turn.body.answer).toContain('Searching your notes for the Q3 reorganisation memo');
			expect(turn.body.answer).toContain(requestFor('notes'));
			expect(turn.body.answer).not.toContain('"q": "Q3 reorganisation memo"');
			// What waits for my answer shows the question alone
			const waiting = await c.get('alice', '/v1/pending-calls');
			for (const shown of [JSON.stringify(turn.body.pending_call), JSON.stringify(waiting.body)]) {
				expect(shown).toContain(question('notes'));
				expect(shown).not.toContain('Q3 reorganisation');
			}
		} finally {
			h.apisix.llm.script = script;
		}
	});

	it('answers a conflict to my yes on a call a withdrawal closed', async () => {
		const turn = await c.post<WaitingTurn>('alice', '/v1/chat', {
			message: 'Find the budget in my wiki'
		});
		const { id } = turn.body.pending_call;
		// I tell my assistant to stop using my wiki, which closes what waited there
		expect((await c.tool('alice', 'consents_withdraw', { domain: 'wiki' })).status).toBe(200);
		for (const answer of ['approve', 'refuse']) {
			expect(await c.post('alice', `/v1/pending-calls/${id}/${answer}`, {})).toEqual({
				status: 409,
				body: { error: 'pending call closed', state: 'superseded' }
			});
		}
		expect(h.apisix.contracts.calls).toHaveLength(0);
	});

	it('runs a call a lost replica left approved, once I approve it again past its lease', async () => {
		const turn = await c.post<WaitingTurn>('alice', '/v1/chat', {
			message: 'Find the budget in my mail'
		});
		const { session_id: sessionId, pending_call: pending } = turn.body;
		// My yes through the API took the call, then its replica died before the call ran
		await leftUnrun(h.db, 'alice', pending.id, 1);
		// While that replica could still be running it, a second yes gets a conflict
		expect(await c.post('alice', `/v1/pending-calls/${pending.id}/approve`, {})).toEqual({
			status: 409,
			body: { error: 'pending call closed', state: 'decided' }
		});
		expect(h.apisix.contracts.calls).toHaveLength(0);
		// Once a replica would have let go of it, my yes runs it, once
		await leftUnrun(h.db, 'alice', pending.id, 20);
		expect(await c.post('alice', `/v1/pending-calls/${pending.id}/approve`, {})).toEqual({
			status: 200,
			body: {
				session_id: sessionId,
				answer: 'Told: {"status":200,"body":{"found":"/contracts/v1/mail/items"}}',
				model: 'qwen3.8'
			}
		});
		expect(h.apisix.contracts.calls).toHaveLength(1);
		expect(await c.post('alice', `/v1/pending-calls/${pending.id}/approve`, {})).toEqual({
			status: 409,
			body: { error: 'pending call closed', state: 'decided' }
		});
		expect(h.apisix.contracts.calls).toHaveLength(1);
	});
});

describe('the label of my consents in my language', () => {
	let h: TestHarness;
	let c: TestClient;
	beforeAll(async () => {
		// The owner reads French: every label the API shows them is French
		h = await startTestHarness({ env: { ASSISTANT_LOCALE: 'fr' } });
		c = makeClient(h);
		h.apisix.contracts.spec = readCatalog(['mail']);
		for (const app of h.apps) expect(await app.agent.contracts.load()).toBe(1);
	});
	afterAll(async () => {
		if (h !== undefined) await h.close();
	});

	it('shows the availability label in French, and an application label as the catalog names it', async () => {
		// Both labels the harness owns are in the owner's language
		expect(getMessages('en').availabilitySharing).toBe('Sharing your availability');
		expect(getMessages('fr').availabilitySharing).toBe('Partage de tes disponibilités');
		// The API shows the French label for the availability the owner shares
		const availability = await c.put<{ label: string }>(
			'alice',
			'/v1/consents/availability/read',
			{}
		);
		expect(availability.body.label).toBe('Partage de tes disponibilités');
		// And an application the catalog does not describe keeps its id, in every language
		const mail = await c.put<{ label: string }>('alice', '/v1/consents/mail/read', {});
		expect(mail.body.label).toBe('mail');
		const listed = await c.get<{ consents: { domain: string; label: string }[] }>(
			'alice',
			'/v1/consents'
		);
		expect(
			Object.fromEntries(listed.body.consents.map((consent) => [consent.domain, consent.label]))
		).toEqual({ availability: 'Partage de tes disponibilités', mail: 'mail' });
	});
});

describe('my answer through the API to a call left unanswered too long', () => {
	let h: TestHarness;
	let c: TestClient;
	beforeAll(async () => {
		// A request's lifetime is a second here, and a day by default
		h = await startTestHarness({ env: { CONSENT_REQUEST_LIFETIME_MS: '1000' } });
		c = makeClient(h);
		h.apisix.contracts.spec = readCatalog(['mail']);
		for (const app of h.apps) expect(await app.agent.contracts.load()).toBe(1);
		h.apisix.llm.script = searchingModel;
	});
	afterAll(async () => {
		if (h !== undefined) await h.close();
	});

	it('answers a conflict to my yes on a call that expired, and runs nothing', async () => {
		const turn = await c.post<WaitingTurn>('alice', '/v1/chat', {
			message: 'Find the budget in my mail'
		});
		const { id } = turn.body.pending_call;
		await sleep(1500);
		expect(await c.post('alice', `/v1/pending-calls/${id}/approve`, {})).toEqual({
			status: 409,
			body: { error: 'pending call closed', state: 'expired' }
		});
		expect(await c.get('alice', '/v1/pending-calls')).toEqual({
			status: 200,
			body: { pending_calls: [] }
		});
		expect(h.apisix.contracts.calls).toHaveLength(0);
		// An operator sees an answer that came too late
		expect(await countedLines(h)).toContain(
			'harness_consent_answers_total{domain="mail",level="read",reason="consent",answer="yes",via="api",outcome="expired"} 1'
		);
	});
});

describe("my answer through the API to the broker's request", () => {
	let h: TestHarness;
	let c: TestClient;
	beforeAll(async () => {
		h = await startTestHarness({ env: { BROKER_CONSENT_URL } });
		c = makeClient(h);
		h.apisix.contracts.spec = readCatalog(['mail']);
		for (const app of h.apps) expect(await app.agent.contracts.load()).toBe(1);
		h.apisix.llm.script = searchingModel;
		// Alice let her assistant read her mail; the platform's broker lacks her delegation
		await grantConsent(h.db, 'alice', 'mail', 'read');
	});
	afterAll(async () => {
		if (h !== undefined) await h.close();
	});

	it('shows me the call the broker refused, with its consent link, and runs it again on my yes', async () => {
		let refusals = 1;
		h.apisix.contracts.handler = (c) =>
			refusals-- > 0
				? brokerRefusal('delegation_missing')
				: { status: 200, body: { found: c.path } };
		const turn = await c.post<{ answer: string; pending_call: { id: string } }>(
			'alice',
			'/v1/chat',
			{
				message: 'Find the budget in my mail'
			}
		);
		const request = `To read your data in mail, I need your permission to act on your behalf, and you have not given it yet. Give it here: ${BROKER_CONSENT_URL}?owner=alice\nOnce that is done, shall I try again? Answer yes or no in your next message.`;
		expect(turn.body.answer).toBe(request);
		expect(turn.body.pending_call).toMatchObject({
			channel: 'api_chat',
			domain: 'mail',
			level: 'read',
			reasons: ['delegation'],
			request
		});
		expect(
			await c.post('alice', `/v1/pending-calls/${turn.body.pending_call.id}/approve`, {})
		).toMatchObject({
			status: 200,
			body: { answer: 'Told: {"status":200,"body":{"found":"/contracts/v1/mail/items"}}' }
		});
		expect(h.apisix.contracts.calls).toHaveLength(2);
	});
});

describe('my answer through the API is admitted like any turn', () => {
	let h: TestHarness;
	let c: TestClient;
	beforeAll(async () => {
		// One turn a minute: the question takes it, so the answer comes over the limit
		h = await startTestHarness({ env: { ADMISSION_USER_PER_MINUTE: '1' } });
		c = makeClient(h);
		h.apisix.contracts.spec = readCatalog(['mail']);
		for (const app of h.apps) expect(await app.agent.contracts.load()).toBe(1);
		h.apisix.llm.script = searchingModel;
	});
	afterAll(async () => {
		if (h !== undefined) await h.close();
	});

	it('tells me it is busy when my answer comes over my limit, and keeps the call waiting', async () => {
		const turn = await c.post<WaitingTurn>('alice', '/v1/chat', {
			message: 'Find the budget in my mail'
		});
		expect(turn.status).toBe(200);
		const { id } = turn.body.pending_call;
		expect(await c.post('alice', `/v1/pending-calls/${id}/approve`, {})).toEqual({
			status: 429,
			body: { error: 'busy', reason: 'user_rate' }
		});
		expect(h.apisix.contracts.calls).toHaveLength(0);
		const waiting = await c.get<{ pending_calls: { id: string }[] }>('alice', '/v1/pending-calls');
		expect(waiting.body.pending_calls.map((call) => call.id)).toEqual([id]);
	});
});

describe('my answer through the API to a question in my room', () => {
	let r: ConsentRoom;
	beforeAll(async () => {
		r = await startConsentRoom({ ADMISSION_USER_PER_MINUTE: '100' });
		r.h.apisix.contracts.spec = readCatalog(DOMAINS);
		for (const app of r.h.apps) expect(await app.agent.contracts.load()).toBe(DOMAINS.length);
		r.h.apisix.llm.script = searchingModel;
	}, 240_000);
	afterAll(async () => {
		if (r !== undefined) await r.close();
	});
	beforeEach(() => {
		r.h.apisix.contracts.calls.length = 0;
		r.h.apisix.contracts.handler = (c) => ({ status: 200, body: { found: c.path } });
	});

	// I ask in my room for something the assistant needs an application for, and the API shows
	// the call that waits: resolves to its id, my message's event and the question's event
	async function askInRoom(
		text: string
	): Promise<{ id: string; messageId: string; questionId: string }> {
		const seen = r.questions().length;
		const messageId = await r.client.sendText(r.room, text);
		const questionId = await r.nextQuestion(seen);
		const waiting = await r.h.api.get<{
			pending_calls: { id: string; channel: string; request: string }[];
		}>('alice@test.local', '/v1/pending-calls');
		const call = waiting.body.pending_calls.at(-1);
		if (call === undefined) throw new Error('nothing waits for my answer');
		// The API shows the question as my room does
		expect(call.channel).toBe('room');
		expect(r.questions().at(-1)?.body.startsWith(call.request)).toBe(true);
		return { id: call.id, messageId, questionId };
	}

	it('resumes a call asked in my room when I approve it through the API, as a ✅ would', async () => {
		const { id, messageId } = await askInRoom('Find the budget in my mail');
		const told = r.saying('Told:').length;
		expect(await r.h.api.post('alice@test.local', `/v1/pending-calls/${id}/approve`, {})).toEqual({
			status: 202,
			body: { id, status: 'approved' }
		});
		expect(await r.nextSaying('Told:', told)).toBe(
			'Told: {"status":200,"body":{"found":"/contracts/v1/mail/items"}}'
		);
		expect(r.h.apisix.contracts.calls).toHaveLength(1);
		expect(r.h.apisix.contracts.calls[0]?.headers['x-correlation-id']).toBe(messageId);
		const consents = await r.h.api.get<{ consents: { domain: string }[] }>(
			'alice@test.local',
			'/v1/consents'
		);
		expect(consents.body.consents.find((consent) => consent.domain === 'mail')).toMatchObject({
			level: 'read',
			granted_by: 'api'
		});
	});

	it('drops a call asked in my room when I refuse it through the API, as a ❌ would', async () => {
		const { id } = await askInRoom('Find the budget in my drive');
		const acknowledged = r.saying('All right').length;
		const modelCalls = r.h.apisix.llm.calls.length;
		expect(await r.h.api.post('alice@test.local', `/v1/pending-calls/${id}/refuse`, {})).toEqual({
			status: 200,
			body: { id, status: 'refused' }
		});
		expect(await r.nextSaying('All right', acknowledged)).toBe('All right, I will not do it.');
		expect(r.h.apisix.llm.calls).toHaveLength(modelCalls);
		expect(r.h.apisix.contracts.calls).toHaveLength(0);
	});

	it('runs a call once when I answer it in my room, then through the API', async () => {
		const { id, questionId } = await askInRoom('Find the budget in my tasks');
		const told = r.saying('Told:').length;
		await r.client.react(r.room, questionId, '✅');
		await r.nextSaying('Told:', told);
		for (const answer of ['approve', 'refuse']) {
			expect(
				await r.h.api.post('alice@test.local', `/v1/pending-calls/${id}/${answer}`, {})
			).toEqual({ status: 409, body: { error: 'pending call closed', state: 'decided' } });
		}
		expect(r.h.apisix.contracts.calls).toHaveLength(1);
	});

	it('runs a call once when I answer it through the API, then in my room', async () => {
		const { id, questionId } = await askInRoom('Find the budget in my wiki');
		const told = r.saying('Told:').length;
		expect(
			(await r.h.api.post('alice@test.local', `/v1/pending-calls/${id}/approve`, {})).status
		).toBe(202);
		await r.nextSaying('Told:', told);
		await r.client.react(r.room, questionId, '✅');
		// My second answer finds the call decided, and changes nothing
		let closed = false;
		for (let i = 0; i < 120 && !closed; i += 1) {
			closed = r.h
				.logLines()
				.some(
					(l) =>
						l['msg'] === 'answer to a closed request' &&
						l['pendingCallId'] === id &&
						l['state'] === 'decided'
				);
			if (!closed) await sleep(250);
		}
		expect(closed).toBe(true);
		expect(r.h.apisix.contracts.calls).toHaveLength(1);
		expect(r.saying('Told:')).toHaveLength(told + 1);
	});
	it('lets my yes through the API win over a ✅ that read the question as open just before', async () => {
		const { id, questionId } = await askInRoom('Find the budget in my contacts');
		const told = r.saying('Told:').length;
		// My ✅ reads the question as open, then waits to queue the turn that would run the call
		const jobs = await holdLock(
			r.h.db,
			'alice@test.local',
			(sql) => sql`lock table jobs in exclusive mode`
		);
		await r.client.react(r.room, questionId, '✅');
		await untilWaiting(r.h.db, '%insert into jobs%', 1);
		// Meanwhile my yes through the API decides the call, and waits as well to queue its turn
		const approving = r.h.api.post('alice@test.local', `/v1/pending-calls/${id}/approve`, {});
		await untilWaiting(r.h.db, '%insert into jobs%', 2);
		await jobs.release();
		expect(await approving).toEqual({ status: 202, body: { id, status: 'approved' } });
		expect(await r.nextSaying('Told:', told)).toBe(
			'Told: {"status":200,"body":{"found":"/contracts/v1/contacts/items"}}'
		);
		// The ✅ comes second: it decides nothing, and is not counted as the answer
		let reaction: Record<string, unknown> | undefined;
		for (let i = 0; i < 120 && reaction === undefined; i += 1) {
			reaction = r.h
				.logLines()
				.find(
					(l) =>
						l['msg'] === 'owner answered' && l['pendingCallId'] === id && l['via'] === 'reaction'
				);
			if (reaction === undefined) await sleep(250);
		}
		expect(reaction?.['decided']).toBe(false);
		expect(r.h.apisix.contracts.calls).toHaveLength(1);
		const counted = await countedLines(r.h);
		expect(counted).toContain(
			'harness_consent_answers_total{domain="contacts",level="read",reason="consent",answer="yes",via="api",outcome="decided"} 1'
		);
		expect(
			counted.some((l) => l.includes('domain="contacts"') && l.includes('via="reaction"'))
		).toBe(false);
	});

	it('lets a ✅ win over my yes through the API that read the call as open just before', async () => {
		const { id, questionId } = await askInRoom('Find the budget in my forms');
		const told = r.saying('Told:').length;
		// Something holds the call, so that both answers wait for it, the ✅ first
		const row = await holdLock(
			r.h.db,
			'alice@test.local',
			(sql) => sql`select id from pending_calls where id = ${id} for update`
		);
		// The ✅'s decision keeps the time of a decision already taken; the API's records the time
		// it answers, with its answer's id
		await r.client.react(r.room, questionId, '✅');
		await untilWaiting(r.h.db, '%coalesce(decided_at, now()),%answer_event_id%', 1);
		const approving = r.h.api.post('alice@test.local', `/v1/pending-calls/${id}/approve`, {});
		await untilWaiting(r.h.db, '%decided_at = now(),%answer_event_id%', 1);
		await row.release();
		expect(await approving).toEqual({
			status: 409,
			body: { error: 'pending call closed', state: 'decided' }
		});
		expect(await r.nextSaying('Told:', told)).toBe(
			'Told: {"status":200,"body":{"found":"/contracts/v1/forms/items"}}'
		);
		expect(r.h.apisix.contracts.calls).toHaveLength(1);
	});
});
