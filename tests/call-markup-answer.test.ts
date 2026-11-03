import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { startTestHarness, type TestHarness } from './helpers/app.js';
import type { ChatRequest, ToolCall } from './helpers/fake-apisix.js';

const CALL_MARKUP = '<tool_call>\n{"name": "consents_list", "arguments": {}}\n</tool_call>';
const READ: ToolCall = {
	id: 'call_read',
	type: 'function',
	function: { name: 'consents_list', arguments: '{}' }
};
const NOTHING_FOR_YOU =
	'I did 0 actions for your request, but my last words were not meant for you. Ask me what you want to know.';

interface ChatReply {
	readonly status: number;
	readonly body: { session_id?: string; answer?: string; error?: string };
}

// A turn no decision model sorts: the deployment names none, as the default does
describe('a turn the model ends on a call written in its text', () => {
	let h: TestHarness;
	beforeAll(async () => {
		h = await startTestHarness();
	});
	afterAll(async () => {
		await h.close();
	});
	beforeEach(() => {
		h.apisix.llm.calls.length = 0;
	});

	async function chat(message: string, session?: string): Promise<ChatReply> {
		const res = await h.app.inject({
			method: 'POST',
			url: '/v1/chat',
			headers: { authorization: `Bearer ${await h.issuer.mint({ sub: 'alice' })}` },
			payload: { message, ...(session === undefined ? {} : { session_id: session }) }
		});
		return { status: res.statusCode, body: res.json() as ChatReply['body'] };
	}

	it('keeps the words of the model and leaves the call out', async () => {
		h.apisix.llm.script = () => ({ content: `Here is what I found.\n${CALL_MARKUP}` });
		const { status, body } = await chat('What do I have?');
		expect(status).toBe(200);
		expect(body.answer).toBe('Here is what I found.');
	});

	it('asks the model once more for words, without tools, when it wrote nothing else', async () => {
		h.apisix.llm.script = (request: ChatRequest) =>
			request.tools === undefined ? { content: 'Nothing yet.' } : { content: CALL_MARKUP };
		const { status, body } = await chat('What do I have?');
		expect(status).toBe(200);
		expect(body.answer).toBe('Nothing yet.');
		expect(h.apisix.llm.calls.map((call) => call.request.tools === undefined)).toEqual([
			false,
			true
		]);
	});

	it('tells the owner what was done itself when the model writes no words again, and keeps the turn', async () => {
		h.apisix.llm.script = () => ({ content: CALL_MARKUP });
		const { status, body } = await chat('What do I have?');
		expect(status).toBe(200);
		expect(body.answer).toBe(NOTHING_FOR_YOU);
		// The conversation keeps the notice as the assistant's answer, for the model's next turn
		h.apisix.llm.script = () => ({ content: 'Still here.' });
		const calls = h.apisix.llm.calls.length;
		await chat('And now?', body.session_id);
		const next = h.apisix.llm.calls[calls]?.request.messages ?? [];
		expect(next.at(-2)).toMatchObject({ role: 'assistant', content: NOTHING_FOR_YOU });
	});

	it('counts the actions done before it, and keeps the call out of the words beside a call made', async () => {
		h.apisix.llm.script = (request: ChatRequest, index: number) =>
			index === 0
				? { content: `Let me look.\n${CALL_MARKUP}`, toolCalls: [READ] }
				: { content: CALL_MARKUP };
		const { status, body } = await chat('What do I have?');
		expect(status).toBe(200);
		expect(body.answer).toBe(
			'I did 1 action for your request, but my last words were not meant for you. Ask me what you want to know.'
		);
		// What the model wrote beside its call stays in the conversation, the call written out of it
		const second = h.apisix.llm.calls[1]?.request.messages ?? [];
		expect(second.find((m) => m.role === 'assistant' && m.tool_calls !== undefined)).toMatchObject({
			content: 'Let me look.'
		});
	});
});
