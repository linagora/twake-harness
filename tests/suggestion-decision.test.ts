import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { grantConsent } from './helpers/consents.js';
import { MEETING_CATALOG } from './helpers/fake-apisix.js';
import { startMatrixHarness, type MatrixTestHarness } from './helpers/matrix-harness.js';
import { startFakeSpace, type FakeSpace } from './helpers/space.js';
import type { MatrixUser } from './helpers/synapse.js';

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function until<T>(read: () => T | null | false, ms = 30_000): Promise<T> {
	const end = Date.now() + ms;
	for (;;) {
		const found = read();
		if (found !== null && found !== false) return found;
		if (Date.now() > end) throw new Error('timed out');
		await sleep(150);
	}
}

const LISTENER = '@twake-assistant:test.local';

// A deployment whose gateway serves a decision model: it, and no longer the words the harness
// looks for without one, tells the messages of a channel that arrange a meeting
describe('a decision model tells the messages of channels that arrange a meeting', () => {
	let h: MatrixTestHarness;
	let space: FakeSpace;
	let alice: MatrixUser;
	let bob: MatrixUser;
	let channel: string;

	const say = (user: MatrixUser, text: string): Promise<string> =>
		h.synapse.sendText(user, channel, text);
	// What the decision model was last asked, as it read it
	const lastAsked = (): string =>
		(
			JSON.parse(h.apisix.llm.sorts.at(-1)?.request.messages[0]?.content ?? '{}') as {
				state?: string;
			}
		).state ?? '';

	async function becomeAssistantOwner(localpart: string): Promise<MatrixUser> {
		const user = await h.synapse.registerUser(localpart);
		const principal = `${localpart}@test.local`;
		const created = await h.api.post(principal, '/v1/assistants', {
			name: `Assistant ${localpart}`
		});
		expect(created.status).toBe(201);
		// No room of its own with its owner: the suggestion reaches Space alone
		await h.db.sql`update assistants set room_id = null where owner = ${principal}`;
		await grantConsent(h.db, principal, 'calendar', 'read');
		return user;
	}

	beforeAll(async () => {
		space = await startFakeSpace();
		h = await startMatrixHarness({
			env: {
				SUGGESTIONS_ENABLED: 'true',
				SPACE_API_URL: space.url,
				SPACE_API_TOKEN: 'tws_secret',
				ASSISTANT_TIMEZONE: 'Europe/Paris',
				LLM_DECISION_MODEL: 'nox-4b'
			}
		});
		h.apisix.contracts.spec = MEETING_CATALOG;
		for (const app of h.apps) await app.agent.contracts.load();
		// The model that reads what the decision model lets through proposes nothing: the subject
		// is what reaches it
		h.apisix.llm.script = () => ({ content: 'NONE' });
		alice = await becomeAssistantOwner('alice');
		bob = await becomeAssistantOwner('bob');
		const parent = await h.synapse.request(bob, 'POST', '/_matrix/client/v3/createRoom', {
			preset: 'public_chat',
			name: 'space',
			creation_content: { type: 'm.space' }
		});
		const created = await h.synapse.request(bob, 'POST', '/_matrix/client/v3/createRoom', {
			preset: 'public_chat',
			name: 'general',
			initial_state: [
				{
					type: 'm.space.parent',
					state_key: parent.body['room_id'] as string,
					content: { via: ['test.local'], canonical: true }
				}
			]
		});
		channel = created.body['room_id'] as string;
		await h.synapse.joinRoom(alice, channel);
		await h.synapse.request(
			bob,
			'POST',
			`/_matrix/client/v3/rooms/${encodeURIComponent(channel)}/invite`,
			{ user_id: LISTENER }
		);
		const end = Date.now() + 30_000;
		while (!(await h.synapse.joinedMembers(bob, channel)).includes(LISTENER)) {
			if (Date.now() > end) throw new Error('the listener did not join');
			await sleep(300);
		}
		await sleep(3000);
		await h.db
			.sql`update assistants set room_id = null where owner in ('alice@test.local', 'bob@test.local')`;
	}, 300_000);
	afterAll(async () => {
		if (h !== undefined) await h.close();
		if (space !== undefined) await space.close();
	});

	it('sends the model a message the words would not catch, when the decision model takes it for one', async () => {
		h.apisix.llm.probabilities = { meeting: 0.9 };
		const before = h.apisix.llm.calls.length;
		await say(alice, 'Il faut qu’on parle du budget.');
		await say(bob, 'On voit ça lundi à 8h ?');
		// One turn for each of the two who wrote: both are owners of an assistant
		await until(() => h.apisix.llm.calls.length >= before + 2);
		// It read the message and the one before it, each author a letter, and nobody's name
		expect(h.apisix.llm.sorts.at(-1)?.request.model).toBe('nox-4b');
		expect(lastAsked()).toMatch(/A: Il faut qu’on parle du budget\.\nB: On voit ça lundi à 8h \?$/);
		expect(lastAsked()).not.toMatch(/alice|bob|test\.local/);
	});

	it('sends the model nothing for a message the words would catch, when the decision model does not', async () => {
		h.apisix.llm.probabilities = { meeting: 0.05 };
		const sorted = h.apisix.llm.sorts.length;
		const before = h.apisix.llm.calls.length;
		await say(alice, 'Marie a une réunion avec la direction lundi à 10h');
		await until(() => h.apisix.llm.sorts.length > sorted);
		await sleep(3000);
		expect(h.apisix.llm.calls.length).toBe(before);
	});

	it('falls back on the words when the decision model answers what was not asked', async () => {
		// A probability out of bounds is no answer
		h.apisix.llm.probabilities = { meeting: 3 };
		const before = h.apisix.llm.calls.length;
		await say(bob, 'On parle du budget lundi à 10h ?');
		await until(() => h.apisix.llm.calls.length >= before + 1);
		expect(
			h.logLines().some((line) => line['msg'] === 'channel sorted' && line['probability'] === null)
		).toBe(true);
	});

	it('has no model read the message of whoever turned suggestions off', async () => {
		const off = await h.api.put('alice@test.local', '/v1/suggestions/settings', {
			enabled: false,
			mutedRooms: []
		});
		expect(off.status).toBe(200);
		h.apisix.llm.probabilities = { meeting: 0.05 };
		const sorted = h.apisix.llm.sorts.length;
		await say(alice, 'On se voit mardi à 9h ?');
		await say(bob, 'Et mercredi ?');
		// Bob's message is sorted alone: Alice's is neither sorted nor read as its context
		await until(() => h.apisix.llm.sorts.length > sorted);
		await sleep(1000);
		expect(h.apisix.llm.sorts.length).toBe(sorted + 1);
		expect(lastAsked()).toMatch(/^Messages of a conversation between people:\nA: Et mercredi \?$/);
	});

	it('has no model read a message nobody could be offered anything from', async () => {
		// Alice turned suggestions off; Bob mutes the room
		const muted = await h.api.put('bob@test.local', '/v1/suggestions/settings', {
			enabled: true,
			mutedRooms: [channel]
		});
		expect(muted.status).toBe(200);
		const sorted = h.apisix.llm.sorts.length;
		await say(bob, 'On se cale jeudi à 15h ?');
		await until(() =>
			h
				.logLines()
				.some((line) => line['msg'] === 'channel ignored' && line['reason'] === 'no_recipient')
		);
		expect(h.apisix.llm.sorts.length).toBe(sorted);
	});
});
