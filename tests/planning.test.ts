import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { startTestHarness, type TestHarness } from './helpers/app.js';
import { grantConsent } from './helpers/consents.js';
import { echoScript, type ScriptedReply, type ToolCall } from './helpers/fake-apisix.js';

// The calendar of these tests: an event and a slot to read, an invitation to accept
const CALENDAR_CATALOG = {
	openapi: '3.1.0',
	paths: {
		'/contracts/v1/events/{event_id}': {
			get: {
				operationId: 'read_event',
				summary: 'Read one event of the user',
				tags: ['events.read.v1'],
				parameters: [{ name: 'event_id', in: 'path', required: true, schema: { type: 'string' } }]
			}
		},
		'/contracts/v1/calendar/freebusy': {
			get: {
				operationId: 'read_freebusy',
				summary: 'Tell whether the user is free over a period',
				tags: ['calendar.freebusy.read.v1'],
				parameters: [
					{ name: 'start', in: 'query', required: true, schema: { type: 'string' } },
					{ name: 'end', in: 'query', required: true, schema: { type: 'string' } },
					{
						name: 'exclude',
						in: 'query',
						required: false,
						schema: { type: 'array', items: { type: 'string' } }
					}
				]
			}
		},
		'/contracts/v1/calendar/invitations/{event_id}/accept': {
			post: {
				operationId: 'accept_invitation',
				summary: 'Accept an invitation, once the user has said yes to this very invitation',
				tags: ['calendar.invitation.accept.v1'],
				'x-twake-risk': 'low',
				parameters: [{ name: 'event_id', in: 'path', required: true, schema: { type: 'string' } }]
			}
		}
	}
};

interface ChatReply {
	readonly answer?: string;
	readonly session_id?: string;
	readonly pending_call?: { readonly id: string };
}

async function chat(
	h: TestHarness,
	message: string,
	sessionId?: string
): Promise<{ status: number; body: ChatReply }> {
	const res = await h.app.inject({
		method: 'POST',
		url: '/v1/chat',
		headers: { authorization: `Bearer ${await h.issuer.mint({ sub: 'alice' })}` },
		payload: { message, ...(sessionId === undefined ? {} : { session_id: sessionId }) }
	});
	return { status: res.statusCode, body: res.json() };
}

function call(id: string, name: string, args: unknown = {}): ToolCall {
	return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

// The calendar once more, with the events to list and an invitation to decline: the invitation
// the owner accepted is planned, the one they did not name is not
const EXTENDED_CATALOG = {
	...CALENDAR_CATALOG,
	paths: {
		...CALENDAR_CATALOG.paths,
		'/contracts/v1/events': {
			get: { operationId: 'list_events', tags: ['events.read.v1'], parameters: [] }
		},
		'/contracts/v1/calendar/invitations/{event_id}/decline': {
			post: {
				operationId: 'decline_invitation',
				summary: 'Decline an invitation, once the user has said yes to this very refusal',
				tags: ['calendar.invitation.decline.v1'],
				'x-twake-risk': 'low',
				parameters: [{ name: 'event_id', in: 'path', required: true, schema: { type: 'string' } }]
			}
		}
	}
};

const READ_EVENT: ScriptedReply = {
	toolCalls: [call('event_1', 'read_event', { event_id: 'evt-9' })]
};
const READ_FREEBUSY: ScriptedReply = {
	toolCalls: [
		call('free_1', 'read_freebusy', { start: '2026-10-20T09:00:00Z', end: '2026-10-20T10:00:00Z' })
	]
};
const ACCEPT: ScriptedReply = {
	toolCalls: [call('accept_1', 'accept_invitation', { event_id: 'evt-9' })]
};

describe('a turn whose request is planned in steps by a decision model', () => {
	let h: TestHarness;
	beforeAll(async () => {
		// Many turns of one owner in a row: admission is the subject of its own suite
		h = await startTestHarness({
			env: { LLM_DECISION_MODEL: 'jev', LLM_CHECK_MODEL: 'fast', ADMISSION_USER_PER_MINUTE: '100' }
		});
		h.apisix.contracts.spec = EXTENDED_CATALOG;
		for (const app of h.apps) await app.agent.contracts.load();
		// These owners let their assistant read their calendar, so that no read waits for a first yes
		for (const owner of ['alice', 'ines', 'carol', 'frank', 'dora', 'erin']) {
			await grantConsent(h.db, owner, 'events', 'read');
			await grantConsent(h.db, owner, 'calendar', 'read');
		}
	});
	afterAll(async () => {
		await h.close();
	});
	beforeEach(() => {
		h.apisix.llm.calls.length = 0;
		h.apisix.llm.checks.length = 0;
		h.apisix.llm.script = echoScript;
		h.apisix.llm.probabilities = {};
		h.apisix.llm.checkProbability = 1;
		h.apisix.llm.checkScript = () => ({ content: '{"claims":[]}' });
		h.apisix.contracts.calls.length = 0;
		h.apisix.contracts.handler = () => ({ status: 200, body: { ok: true } });
	});

	// The system prompt of a model call, where the harness tells the model where its plan stands
	const systemOf = (index: number): string =>
		h.apisix.llm.calls[index]?.request.messages[0]?.content ?? '';

	const writes = (): string[] =>
		h.apisix.contracts.calls.filter((made) => made.method === 'POST').map((made) => made.path);

	const as =
		(sub: string) =>
		async (url: string, payload: unknown): Promise<ChatReply> => {
			const headers = { authorization: `Bearer ${await h.issuer.mint({ sub })}` };
			return (
				await h.app.inject({ method: 'POST', url, headers, payload: payload as object })
			).json();
		};

	it('marks each step done from the result of its call, and adds nothing to the answer', async () => {
		h.apisix.llm.probabilities = { read_event: 0.9, read_freebusy: 0.9 };
		const replies: ScriptedReply[] = [READ_EVENT, READ_FREEBUSY];
		h.apisix.llm.script = (_request, index) => replies[index] ?? { content: 'Both read.' };
		const { status, body } = await chat(h, 'Read the event evt-9 and tell me if I am free');
		expect(status).toBe(200);
		expect(body.answer).toBe('Both read.');
		expect(h.apisix.llm.calls).toHaveLength(3);
		expect(systemOf(0)).toMatch(/1\. \[to do\] Read one event of the user \(read_event\)/);
		expect(systemOf(1)).toMatch(/1\. \[done\] Read one event/);
		expect(systemOf(1)).toMatch(/2\. \[to do\] Tell whether the user is free/);
		expect(systemOf(2)).toMatch(/2\. \[done\] Tell whether the user is free/);
		expect(systemOf(2)).toMatch(/Every step is done/);
	});

	it('takes an answer given before every step, and says nothing of a step left untried', async () => {
		// The plan is a ledger of what was attempted, not an order: the model is not sent back
		h.apisix.llm.probabilities = { read_event: 0.9, read_freebusy: 0.9 };
		const replies: ScriptedReply[] = [READ_EVENT];
		h.apisix.llm.script = (_request, index) => replies[index] ?? { content: 'All done.' };
		const { body } = await chat(h, 'Read the event evt-9 and tell me if I am free');
		expect(body.answer).toBe('All done.');
		expect(h.apisix.llm.calls).toHaveLength(2);
		expect(systemOf(1)).toMatch(/2\. \[to do\] Tell whether the user is free/);
		expect(systemOf(1)).toMatch(/A step that turns out not to apply/);
	});

	it('tells the owner of a step whose call failed', async () => {
		h.apisix.llm.probabilities = { read_event: 0.9, read_freebusy: 0.9 };
		h.apisix.contracts.handler = (made) =>
			made.path.endsWith('/freebusy')
				? { status: 500, body: { error: 'down' } }
				: { status: 200, body: { ok: true } };
		const replies: ScriptedReply[] = [READ_EVENT, READ_FREEBUSY];
		h.apisix.llm.script = (_request, index) => replies[index] ?? { content: 'Done.' };
		const { body } = await chat(h, 'Read the event evt-9 and tell me if I am free');
		expect(body.answer).toMatch(
			/Not done, of what I had planned:\n- Tell whether the user is free/
		);
	});

	it('does not hold a write back for a read whose call failed', async () => {
		h.apisix.llm.probabilities = { read_freebusy: 0.9, accept_invitation: 0.9 };
		h.apisix.contracts.handler = (made) =>
			made.path.endsWith('/freebusy')
				? { status: 500, body: { error: 'down' } }
				: { status: 200, body: { ok: true } };
		const replies: ScriptedReply[] = [READ_FREEBUSY, ACCEPT];
		h.apisix.llm.script = (_request, index) => replies[index] ?? { content: 'Accepted.' };
		const post = as('ines');
		const asked = await post('/v1/chat', { message: 'Accept the invitation evt-9 if I am free' });
		// The read failed, and the write that follows it is not refused for that: it waits for its owner
		expect(h.apisix.llm.calls[2]?.request.messages.at(-1)?.content ?? '').not.toMatch(/step_order/);
		expect(asked.pending_call).toBeDefined();
		const resumed = await post(`/v1/pending-calls/${asked.pending_call?.id}/approve`, {});
		expect(h.apisix.contracts.calls.filter((made) => made.method === 'POST')).toHaveLength(1);
		// The owner reads what was done, and that the read was not
		expect(resumed.answer).toMatch(/Done:\n- Accept an invitation/);
		expect(resumed.answer).toMatch(
			/Not done, of what I had planned:\n- Tell whether the user is free/
		);
	});

	it('makes a step of a write the message did not name, and checks it like any other', async () => {
		// A write that may be asked is not planned: it waits for the owner, whose yes then runs it
		h.apisix.llm.probabilities = { accept_invitation: 0.35 };
		h.apisix.llm.script = (_request, index) => (index === 0 ? ACCEPT : { content: 'Accepted.' });
		const post = as('erin');
		const asked = await post('/v1/chat', { message: 'That invitation evt-9, hm' });
		const resumed = await post(`/v1/pending-calls/${asked.pending_call?.id}/approve`, {});
		// The harness says the write done only once its contract answered with a success
		expect(resumed.answer).toMatch(/^Accepted\.\n\nDone:\n- Accept an invitation/);
		// The contract then fails the same write: the model says it is done, the harness says it is not
		h.apisix.llm.calls.length = 0;
		h.apisix.llm.script = (_request, index) => (index === 0 ? ACCEPT : { content: 'Accepted.' });
		const again = await post('/v1/chat', { message: 'That invitation evt-9, hm, again' });
		h.apisix.contracts.handler = () => ({ status: 500, body: { error: 'down' } });
		const failed = await post(`/v1/pending-calls/${again.pending_call?.id}/approve`, {});
		expect(failed.answer).toMatch(
			/^Accepted\.\n\nNot done, of what I had planned:\n- Accept an invitation/
		);
	});

	it('holds the turn a yes of its owner resumes to the plan it had', async () => {
		h.apisix.llm.probabilities = { read_event: 0.9, accept_invitation: 0.9 };
		const replies: ScriptedReply[] = [READ_EVENT, ACCEPT];
		h.apisix.llm.script = (_request, index) => replies[index] ?? { content: 'Accepted.' };
		const post = as('carol');
		const asked = await post('/v1/chat', { message: 'Read the event evt-9, then accept it' });
		expect(asked.pending_call).toBeDefined();
		const resumed = await post(`/v1/pending-calls/${asked.pending_call?.id}/approve`, {});
		// The resumed walk reads the plan back, with what was done: the read, and the call its
		// owner allowed
		const last = h.apisix.llm.calls.length - 1;
		expect(systemOf(last)).toMatch(/1\. \[done\] Read one event/);
		expect(systemOf(last)).toMatch(/2\. \[done\] Accept an invitation/);
		expect(resumed.answer).toBe(
			'Accepted.\n\nDone:\n- Accept an invitation, once the user has said yes to this very invitation (event_id: evt-9)'
		);
	});

	it('makes a write the plan lacks wait for the owner after a yes, though one was allowed', async () => {
		h.apisix.llm.probabilities = { accept_invitation: 0.9 };
		const decline = call('decline_1', 'decline_invitation', { event_id: 'evt-10' });
		const replies: ScriptedReply[] = [ACCEPT, { toolCalls: [decline] }];
		h.apisix.llm.script = (_request, index) => replies[index] ?? { content: 'Seen.' };
		const post = as('dora');
		const asked = await post('/v1/chat', { message: 'Accept the invitation evt-9' });
		const resumed = await post(`/v1/pending-calls/${asked.pending_call?.id}/approve`, {});
		// The accepted invitation was planned; the other, declined by the model on its own, was not
		expect(resumed.pending_call).toBeDefined();
		expect(resumed.answer).toMatch(/I am not sure your message asks for this/);
		expect(writes()).toEqual(['/contracts/v1/calendar/invitations/evt-9/accept']);
	});

	it('makes a write wait after a yes even when the turn it resumes had no plan', async () => {
		// A write that may be asked is not planned: the first waits, and so does the next after a yes
		h.apisix.llm.probabilities = { accept_invitation: 0.35 };
		const decline = call('decline_1', 'decline_invitation', { event_id: 'evt-10' });
		const replies: ScriptedReply[] = [ACCEPT, { toolCalls: [decline] }];
		h.apisix.llm.script = (_request, index) => replies[index] ?? { content: 'Seen.' };
		const post = as('gabi');
		const asked = await post('/v1/chat', { message: 'That invitation evt-9, hm' });
		const resumed = await post(`/v1/pending-calls/${asked.pending_call?.id}/approve`, {});
		expect(resumed.pending_call).toBeDefined();
		expect(resumed.answer).toMatch(/I am not sure your message asks for this/);
		expect(writes()).toEqual(['/contracts/v1/calendar/invitations/evt-9/accept']);
	});

	it('makes a planned write the decision model was not sure of wait after a yes', async () => {
		// The read waits for a first yes of this owner, who has not allowed their calendar yet
		h.apisix.llm.probabilities = { read_freebusy: 0.9, accept_invitation: 0.45 };
		const replies: ScriptedReply[] = [READ_FREEBUSY, ACCEPT];
		h.apisix.llm.script = (_request, index) => replies[index] ?? { content: 'Seen.' };
		const post = as('hana');
		const asked = await post('/v1/chat', { message: 'Accept the invitation evt-9 if I am free?' });
		expect(asked.pending_call).toBeDefined();
		const resumed = await post(`/v1/pending-calls/${asked.pending_call?.id}/approve`, {});
		// The write is in the plan, but only as likely: the owner's yes to the read is not one to it
		// (their first write there, so it is the first-use question that asks)
		expect(resumed.pending_call).toBeDefined();
		expect(resumed.answer).toMatch(/first time I need to change your data in calendar/);
		expect(writes()).toEqual([]);
	});

	it('keeps out of the answer a call the model wrote in its text', async () => {
		h.apisix.llm.script = () => ({
			content:
				'I can help with your calendar.\n\n<tool_call>\n{"name": "scoped_skills_list", "arguments": {}}\n</tool_call>'
		});
		const { body } = await chat(h, 'Hello');
		expect(body.answer).toBe('I can help with your calendar.');
	});

	it('checks an answer sentence by sentence when the turn could act and did not', async () => {
		// The model says a meeting is scheduled, with no call; asked to check, a model names the sentence
		const said = 'The review was moved to Friday. Your meeting is scheduled for tomorrow.';
		h.apisix.llm.script = () => ({ content: said });
		h.apisix.llm.checkScript = () => ({ content: '{"claims":[2]}' });
		const { body } = await chat(h, 'Put a meeting in my calendar tomorrow');
		// The words stay as the model wrote them, and the harness says below them that nothing was done
		expect(body.answer).toBe(`${said}\n\nNothing was done in your applications for this message.`);
		// The check reads the sentences apart, with what came before the answer, and has no tool
		expect(h.apisix.llm.checks).toHaveLength(1);
		const check = h.apisix.llm.checks[0]?.request;
		expect(check?.tools).toBeUndefined();
		expect(check?.messages[1]?.content).toMatch(/\[user\] Put a meeting in my calendar tomorrow/);
		expect(check?.messages[1]?.content).toMatch(
			/1\. The review was moved to Friday\.\n2\. Your meeting is scheduled for tomorrow\./
		);
	});

	it('leaves an answer as it is when the check names no sentence, or answers anything else', async () => {
		h.apisix.llm.script = () => ({ content: 'The review was moved to Friday.' });
		for (const checked of ['{"claims":[]}', 'I am not sure.']) {
			h.apisix.llm.checkScript = () => ({ content: checked });
			const { body } = await chat(h, 'What about the review?');
			expect(body.answer).toBe('The review was moved to Friday.');
		}
	});

	it('reads the events of the owner itself to check an answer against, asking them nothing', async () => {
		// The owner already lets their assistant read their events: without that, it reads nothing
		h.apisix.contracts.handler = () => ({
			status: 200,
			body: { events: [{ title: 'Budget review', note: 'moved to Friday by Bob' }] }
		});
		h.apisix.llm.script = () => ({ content: 'The budget review was moved to Friday.' });
		const { body } = await chat(h, 'Any news on the budget review meeting?');
		expect(body.answer).toBe('The budget review was moved to Friday.');
		expect(body.pending_call).toBeUndefined();
		expect(h.apisix.contracts.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
			'GET /contracts/v1/events'
		]);
		expect(h.apisix.llm.checks[0]?.request.messages[1]?.content).toMatch(
			/\[result of list_events\].*moved to Friday by Bob/
		);
	});

	it('runs no write before the steps planned ahead of it', async () => {
		h.apisix.llm.probabilities = { read_event: 0.9, accept_invitation: 0.9 };
		const accept = ACCEPT.toolCalls?.[0] as ToolCall;
		const replies: ScriptedReply[] = [
			ACCEPT,
			READ_EVENT,
			{ toolCalls: [{ ...accept, id: 'accept_2' }] }
		];
		h.apisix.llm.script = (_request, index) => replies[index] ?? { content: 'Accepted.' };
		const body = await as('frank')('/v1/chat', {
			message: 'Read the event evt-9, then accept the invitation'
		});
		// The write made too early did not run; made again after its read, it waits for its owner
		const refused = h.apisix.llm.calls[1]?.request.messages.at(-1);
		expect(refused?.content).toMatch(/step_order.*Read one event/);
		expect(h.apisix.llm.calls).toHaveLength(3);
		expect(body.pending_call).toBeDefined();
	});
});

describe('a deployment whose gateway serves a decision model to sort answers', () => {
	let h: TestHarness;
	beforeAll(async () => {
		h = await startTestHarness({
			env: { LLM_DECISION_MODEL: 'jev', LLM_CHECK_MODEL: 'fast', ADMISSION_USER_PER_MINUTE: '100' }
		});
		h.apisix.contracts.spec = CALENDAR_CATALOG;
		for (const app of h.apps) await app.agent.contracts.load();
	});
	afterAll(async () => {
		await h.close();
	});

	it('sends at once an answer that has nothing to do with what it can do, unchecked', async () => {
		h.apisix.llm.checkProbability = 0.01;
		const { body } = await chat(h, 'Bonjour');
		expect(body.answer).toBe('echo: Bonjour');
		expect(h.apisix.llm.checks).toHaveLength(0);
		// The decision model is told the actions the catalog offers, and asked one typed question
		const sort = h.apisix.llm.sorts.at(-1)?.request;
		expect(sort?.model).toBe('jev');
		const asked = JSON.parse(sort?.messages[0]?.content ?? '{}') as {
			state: string;
			questions: { concerns: { type: string } };
		};
		expect(asked.state).toMatch(/accept_invitation: Accept an invitation/);
		expect(asked.state).toMatch(/User: Bonjour\nAssistant: echo: Bonjour/);
		expect(asked.questions.concerns.type).toBe('noul');
	});

	it('has a decision model tell what a message asks for, which becomes the plan', async () => {
		h.apisix.llm.sorts.length = 0;
		h.apisix.llm.calls.length = 0;
		h.apisix.llm.probabilities = {
			read_freebusy: 0.9,
			accept_invitation: 0.8,
			read_event: 0.1
		};
		h.apisix.llm.script = () => ({ content: 'Sure.' });
		const { body } = await chat(h, 'Accept the invitation of Bob if I am free');
		h.apisix.llm.probabilities = {};
		// The decision model is asked about each thing the catalog offers, before the model speaks
		const routed = JSON.parse(h.apisix.llm.sorts[0]?.request.messages[0]?.content ?? '{}') as {
			state: string;
			questions: Record<string, { type: string }>;
		};
		expect(Object.keys(routed.questions).sort()).toEqual([
			'accept_invitation',
			'read_event',
			'read_freebusy'
		]);
		expect(routed.state).toMatch(
			/User's last message to their assistant: Accept the invitation of Bob/
		);
		// What it named is the plan the model reads from its first call, the read before the write
		const system = h.apisix.llm.calls[0]?.request.messages[0]?.content ?? '';
		expect(system).toMatch(
			/1\. \[to do\] .* \(read_freebusy\)\n2\. \[to do\] .* \(accept_invitation\)/
		);
		expect(system).not.toMatch(/read_event\)/);
		// The plan reaches the model by its system prompt alone: written as a call in the
		// conversation, a small model takes it for a step it took and answers without calling
		const sent = h.apisix.llm.calls[0]?.request.messages ?? [];
		expect(sent.some((message) => (message.tool_calls ?? []).length > 0)).toBe(false);
		expect(sent.some((message) => message.role === 'tool')).toBe(false);
		// Sorting and planning are steps of their own, in that order, before the model is asked
		const steps = h
			.logLines()
			.map((line) => line['msg'])
			.filter((msg) => ['message routed', 'turn planned', 'model asked'].includes(String(msg)));
		expect(steps.slice(-3)).toEqual(['message routed', 'turn planned', 'model asked']);
		// A model that does none of it is not sent back: nothing was attempted, nothing failed
		expect(h.apisix.llm.calls).toHaveLength(1);
		expect(body.answer).toBe('Sure.');
	});

	it('leaves a message that asks for nothing it can do to the model, with no plan', async () => {
		h.apisix.llm.calls.length = 0;
		h.apisix.llm.checkProbability = 0.01;
		h.apisix.llm.script = echoScript;
		const { body } = await chat(h, 'Hello there');
		expect(body.answer).toBe('echo: Hello there');
		expect(h.apisix.llm.calls[0]?.request.messages[0]?.content).not.toMatch(/## Plan\n/);
	});

	it('holds a write to what the message asks for: refused, asked about, or run', async () => {
		const headers = { authorization: `Bearer ${await h.issuer.mint({ sub: 'gina' })}` };
		const post = async (url: string, payload: unknown): Promise<ChatReply> =>
			(await h.app.inject({ method: 'POST', url, headers, payload: payload as object })).json();
		const accept: ScriptedReply = {
			toolCalls: [call('accept_1', 'accept_invitation', { event_id: 'evt-9' })]
		};
		h.apisix.llm.checkProbability = 0.01;
		// The model makes the write, then answers once it reads what came of it
		h.apisix.llm.script = (request) =>
			request.messages.at(-1)?.name === 'accept_invitation' ? { content: 'Seen.' } : accept;
		const writes = (): number =>
			h.apisix.contracts.calls.filter((made) => made.method === 'POST').length;
		h.apisix.contracts.calls.length = 0;

		// A message that clearly does not ask for it: the write does not run, and nothing is asked
		h.apisix.llm.probabilities = { accept_invitation: 0.05 };
		h.apisix.llm.calls.length = 0;
		const refused = await post('/v1/chat', { message: 'Nice weather today' });
		expect(refused.pending_call).toBeUndefined();
		expect(h.apisix.llm.calls[1]?.request.messages.at(-1)?.content).toMatch(/not_asked/);
		expect(writes()).toBe(0);

		// A message that asks for it: the first use waits for its owner, whose yes allows the next
		h.apisix.llm.probabilities = { accept_invitation: 0.9 };
		const first = await post('/v1/chat', { message: 'Accept the invitation evt-9' });
		await post(`/v1/pending-calls/${first.pending_call?.id}/approve`, {});
		expect(writes()).toBe(1);
		const allowed = await post('/v1/chat', { message: 'Accept the invitation evt-9 again' });
		expect(allowed.pending_call).toBeUndefined();
		expect(writes()).toBe(2);

		// A message that may ask for it: the write waits for a yes, whatever was allowed before
		h.apisix.llm.probabilities = { accept_invitation: 0.35 };
		const unsure = await post('/v1/chat', { message: 'That invitation, hm' });
		expect(unsure.pending_call).toBeDefined();
		expect(writes()).toBe(2);
		h.apisix.llm.probabilities = {};
		h.apisix.llm.checkProbability = 1;
	});

	it('gives the model the tools of its lane, and no other of the applications', async () => {
		const offered = async (
			message: string,
			probabilities: Record<string, number>
		): Promise<string[]> => {
			h.apisix.llm.probabilities = probabilities;
			h.apisix.llm.calls.length = 0;
			h.apisix.llm.script = () => ({ content: 'Fine.' });
			await chat(h, message);
			const tools = (h.apisix.llm.calls[0]?.request.tools ?? []) as {
				function: { name: string };
			}[];
			return tools
				.map((tool) => tool.function.name)
				.filter((name) =>
					['read_event', 'read_freebusy', 'accept_invitation', 'plan'].includes(name)
				)
				.sort();
		};
		h.apisix.llm.checkProbability = 0.01;
		// Nothing asked: it talks, with none of the applications' tools
		expect(await offered('Hello', {})).toEqual([]);
		// A read asked: it has that read, and no write
		expect(await offered('Am I free?', { read_freebusy: 0.9 })).toEqual(['read_freebusy']);
		// A write asked, with the read before it: it has both
		expect(
			await offered('Accept if I am free', { read_freebusy: 0.8, accept_invitation: 0.9 })
		).toEqual(['accept_invitation', 'read_freebusy']);
		// A write that may be asked: it has every tool, and never the plan, which is not its own
		expect(await offered('That invitation, hm', { accept_invitation: 0.35 })).toEqual([
			'accept_invitation',
			'read_event',
			'read_freebusy'
		]);
		h.apisix.llm.probabilities = {};
		h.apisix.llm.checkProbability = 1;
	});

	it('runs no call to a tool its lane does not give, should the model make one', async () => {
		h.apisix.llm.checkProbability = 0.01;
		h.apisix.llm.probabilities = { read_freebusy: 0.9 };
		h.apisix.llm.calls.length = 0;
		h.apisix.contracts.calls.length = 0;
		h.apisix.llm.script = (request) =>
			request.messages.at(-1)?.name === 'read_event'
				? { content: 'Seen.' }
				: { toolCalls: [call('read_1', 'read_event', { event_id: 'evt-9' })] };
		await chat(h, 'Am I free tomorrow?');
		expect(h.apisix.llm.calls[1]?.request.messages.at(-1)?.content).toMatch(/not_asked/);
		expect(h.apisix.contracts.calls).toHaveLength(0);
		h.apisix.llm.probabilities = {};
		h.apisix.llm.checkProbability = 1;
	});

	it('lets the model ask its way out of a lane that lacks a tool, and then asks the owner', async () => {
		const headers = { authorization: `Bearer ${await h.issuer.mint({ sub: 'hugo' })}` };
		h.apisix.llm.checkProbability = 0.01;
		// The decision model reads nothing to do in the message
		h.apisix.llm.probabilities = {};
		h.apisix.llm.calls.length = 0;
		h.apisix.contracts.calls.length = 0;
		h.apisix.llm.script = (request) => {
			const last = request.messages.at(-1);
			if (last?.name === 'need_tool') {
				return { toolCalls: [call('accept_1', 'accept_invitation', { event_id: 'evt-9' })] };
			}
			return { toolCalls: [call('need_1', 'need_tool', { why: 'to accept the invitation' })] };
		};
		const res = await h.app.inject({
			method: 'POST',
			url: '/v1/chat',
			headers,
			payload: { message: 'Say yes to Bob for me' }
		});
		const body: ChatReply = res.json();
		const names = (index: number): string[] =>
			((h.apisix.llm.calls[index]?.request.tools ?? []) as { function: { name: string } }[]).map(
				(tool) => tool.function.name
			);
		// In its lane it has the way out and not the write; once out, it has the write
		expect(names(0)).toContain('need_tool');
		expect(names(0)).not.toContain('accept_invitation');
		expect(names(1)).toContain('accept_invitation');
		// And the write waits for its owner, whatever the decision model read
		expect(body.pending_call).toBeDefined();
		expect(h.apisix.contracts.calls.filter((made) => made.method === 'POST')).toHaveLength(0);
		h.apisix.llm.checkProbability = 1;
	});

	it('has the other answers checked, by the model set for that', async () => {
		h.apisix.llm.checkProbability = 0.9;
		h.apisix.llm.checks.length = 0;
		h.apisix.llm.checkScript = () => ({ content: '{"claims":[1]}' });
		h.apisix.llm.script = () => ({ content: 'I accepted the invitation. Anything else?' });
		const { body } = await chat(h, 'Accept the invitation of Bob');
		expect(body.answer).toBe(
			'I accepted the invitation. Anything else?\n\nNothing was done in your applications for this message.'
		);
		expect(h.apisix.llm.checks[0]?.request.model).toBe('fast');
	});
});

describe('a deployment without a decision model', () => {
	let h: TestHarness;
	afterAll(async () => {
		await h.close();
	});

	it('gives the model every tool, no plan, and sorts nothing', async () => {
		h = await startTestHarness({});
		h.apisix.contracts.spec = CALENDAR_CATALOG;
		for (const app of h.apps) await app.agent.contracts.load();
		await chat(h, 'Bonjour');
		const request = h.apisix.llm.calls[0]?.request;
		const names = ((request?.tools ?? []) as { function: { name: string } }[]).map(
			(tool) => tool.function.name
		);
		expect(names).toEqual(
			expect.arrayContaining(['read_event', 'read_freebusy', 'accept_invitation'])
		);
		expect(names).not.toContain('plan');
		expect(request?.messages[0]?.content).not.toMatch(/## Plan|plan/);
		expect(h.apisix.llm.sorts).toHaveLength(0);
	});
});
