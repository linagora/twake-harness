import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withPrincipal } from '../src/db/client.js';
import { buildRegistration } from '../src/matrix/registration.js';
import { makeSpaceNotifications } from '../src/suggestions/space.js';
import { grantConsent } from './helpers/consents.js';
import { eventually } from './helpers/feedback.js';
import { startE2eeClient, type E2eeClient } from './helpers/e2ee-client.js';
import {
	MEETING_CATALOG,
	toolsOf,
	type ChatRequest,
	type ContractCall,
	type ScriptedReply,
	type ToolCall
} from './helpers/fake-apisix.js';
import { startMatrixHarness, type MatrixTestHarness } from './helpers/matrix-harness.js';
import { startFakeSpace, type FakeSpace } from './helpers/space.js';
import type { MatrixUser } from './helpers/synapse.js';

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function until<T>(
	read: () => T | null | undefined | false | Promise<T | null | undefined | false>,
	ms = 30_000
): Promise<T> {
	const end = Date.now() + ms;
	for (;;) {
		const found = await read();
		if (found !== null && found !== undefined && found !== false) return found;
		if (Date.now() > end) throw new Error('timed out');
		await sleep(150);
	}
}

const ALICE = 'alice@test.local';
const BOB = 'bob@test.local';
const CAROL = 'carol@test.local';
const DAVE = 'dave@test.local';

// The model, as a literal one: for the owner whose assistant it speaks as, it prepares a meeting on
// Monday with the other person, then says nothing more
let proposals = 0;
const proposeMonday = (request: ChatRequest): ScriptedReply => {
	const system = request.messages[0]?.content ?? '';
	const owner = /whose address is (\S+?)\.\s/.exec(system)?.[1] ?? '';
	if (request.messages.at(-1)?.role === 'tool') return { content: 'NONE' };
	proposals += 1;
	// Told that the user declined the slot, it chooses the next one
	const declined = request.messages.some((m) => (m.content ?? '').includes('<<<declined-proposal'));
	const other = (system.match(/[\w.-]+@test\.local/g) ?? []).find((p) => p !== owner) ?? BOB;
	return {
		content: 'Vous avez un créneau lundi.',
		toolCalls: [
			{
				id: `call_${proposals}`,
				type: 'function',
				function: {
					name: 'create_meeting',
					arguments: JSON.stringify({
						body: {
							title: 'Point lundi',
							start: declined ? '2026-10-12T10:00:00+02:00' : '2026-10-12T09:30:00+02:00',
							end: declined ? '2026-10-12T10:15:00+02:00' : '2026-10-12T09:45:00+02:00',
							attendees: [other]
						}
					})
				}
			}
		]
	};
};

describe('the assistant proposes from the messages of channels', () => {
	let h: MatrixTestHarness;
	let space: FakeSpace;
	const users = new Map<string, MatrixUser>();
	let alice: MatrixUser;
	let bob: MatrixUser;
	let aliceClient: E2eeClient;
	let bobClient: E2eeClient;
	let channel: string;

	const llmCalls = (): number => h.apisix.llm.calls.length;
	const say = (user: MatrixUser, room: string, text: string): Promise<string> =>
		h.synapse.sendText(user, room, text);
	let space_: string;
	const LISTENER = '@twake-assistant:test.local';
	const ENCRYPTION = {
		type: 'm.room.encryption',
		state_key: '',
		content: { algorithm: 'm.megolm.v1.aes-sha2' }
	};
	const PARENT = (): Record<string, unknown> => ({
		type: 'm.space.parent',
		state_key: space_,
		content: { via: ['test.local'], canonical: true }
	});
	const create = async (owner: MatrixUser, body: Record<string, unknown>): Promise<string> =>
		(await h.synapse.request(owner, 'POST', '/_matrix/client/v3/createRoom', body)).body[
			'room_id'
		] as string;
	// Whether the listener is in the room, once it had time to answer an invite
	async function listenerJoined(owner: MatrixUser, room: string, wait = 6000): Promise<boolean> {
		const end = Date.now() + wait;
		while (Date.now() < end) {
			if ((await h.synapse.joinedMembers(owner, room)).includes(LISTENER)) return true;
			await sleep(300);
		}
		return false;
	}
	// Whether the listener is still in a room it was invited to once it had time to join and leave
	async function listenerStays(owner: MatrixUser, room: string): Promise<boolean> {
		await sleep(5000);
		return (await h.synapse.joinedMembers(owner, room)).includes(LISTENER);
	}
	// Whether a user left a room it was invited to: polled until the harness handled the event
	async function leftRoom(
		viewer: MatrixUser,
		room: string,
		userId: string,
		wait = 20_000
	): Promise<boolean> {
		const end = Date.now() + wait;
		while (Date.now() < end) {
			const state = await h.synapse.request(
				viewer,
				'GET',
				`/_matrix/client/v3/rooms/${encodeURIComponent(room)}/state/m.room.member/${encodeURIComponent(userId)}`
			);
			if (['leave', 'ban'].includes(String(state.body['membership']))) return true;
			await sleep(300);
		}
		return false;
	}
	const isJoined = async (viewer: MatrixUser, room: string, userId: string): Promise<boolean> =>
		(await h.synapse.joinedMembers(viewer, room)).includes(userId);
	const invite = (owner: MatrixUser, room: string): Promise<unknown> =>
		h.synapse.request(
			owner,
			'POST',
			`/_matrix/client/v3/rooms/${encodeURIComponent(room)}/invite`,
			{ user_id: LISTENER }
		);
	// A channel: a room inside a space, as Twake Chat writes it (m.space.parent on the room), where
	// the listener was invited and joined
	async function openChannel(owner: MatrixUser, members: MatrixUser[]): Promise<string> {
		const room = await create(owner, {
			preset: 'public_chat',
			name: 'general',
			initial_state: [PARENT()]
		});
		for (const member of members) await h.synapse.joinRoom(member, room);
		await invite(owner, room);
		expect(await listenerJoined(owner, room, 30_000)).toBe(true);
		return room;
	}
	async function becomeAssistantOwner(localpart: string): Promise<MatrixUser> {
		const user = await h.synapse.registerUser(localpart);
		users.set(localpart, user);
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
				ASSISTANT_TIMEZONE: 'Europe/Paris'
			}
		});
		h.apisix.contracts.spec = MEETING_CATALOG;
		for (const app of h.apps) expect(await app.agent.contracts.load()).toBe(6);
		h.apisix.llm.script = proposeMonday;
		alice = await becomeAssistantOwner('alice');
		bob = await becomeAssistantOwner('bob');
		const parent = await h.synapse.request(bob, 'POST', '/_matrix/client/v3/createRoom', {
			preset: 'public_chat',
			name: 'space',
			creation_content: { type: 'm.space' }
		});
		space_ = parent.body['room_id'] as string;
		channel = await openChannel(bob, [alice]);
		aliceClient = await startE2eeClient(h.synapse.url, alice);
		bobClient = await startE2eeClient(h.synapse.url, bob);
		// The assistants' rooms are settled by now: Alice and Bob have none, for Space alone
		await sleep(3000);
		await h.db.sql`update assistants set room_id = null where owner in (${ALICE}, ${BOB})`;
	}, 300_000);
	afterAll(async () => {
		if (aliceClient !== undefined) await aliceClient.stop();
		if (bobClient !== undefined) await bobClient.stop();
		if (h !== undefined) await h.close();
		if (space !== undefined) await space.close();
	});

	it('asks Synapse for no room, but for the listener user among the exclusive ones', async () => {
		const registration = buildRegistration(h.config, 'http://harness');
		expect(registration.namespaces.rooms).toEqual([]);
		const users = registration.namespaces.users.map((u) => u.regex).join(' ');
		expect(users).toContain('twake-assistant');
		expect(registration.namespaces.users.every((u) => u.exclusive)).toBe(true);
		expect((await h.synapse.joinedMembers(bob, channel)).sort()).toEqual([
			'@alice:test.local',
			'@bob:test.local',
			LISTENER
		]);
		expect(await h.synapse.displayName(LISTENER)).toBe('Twake Assistant');
	});

	it('sends nothing to the model for a message that is no arrangement to meet', async () => {
		const before = llmCalls();
		await say(alice, channel, 'merci pour le document');
		await say(bob, channel, 'lundi je suis en congé');
		await sleep(3000);
		expect(llmCalls()).toBe(before);
		expect(space.calls).toHaveLength(0);
	});

	it('proposes to the sender and to the author of the message before, in their Space only, and keeps no quote', async () => {
		await say(alice, channel, 'On se voit quand ?');
		await say(bob, channel, 'ok on parle lundi');
		const calls = await until(() => (space.calls.length >= 2 ? space.calls : null));
		const byUser = new Map(calls.map((c) => [c.body['matrixUserId'] as string, c]));
		expect([...byUser.keys()].sort()).toEqual(['@alice:test.local', '@bob:test.local']);
		const forAlice = byUser.get('@alice:test.local');
		expect(forAlice?.path).toBe('/api/notifications/suggestions');
		expect(forAlice?.authorization).toBe('Bearer tws_secret');
		const pendingCallId = forAlice?.body['pendingCallId'];
		expect(forAlice?.body).toEqual({
			matrixUserId: '@alice:test.local',
			externalId: pendingCallId,
			text: expect.stringContaining('bob@test.local'),
			pendingCallId,
			matrixRoomId: channel
		});
		expect(String(forAlice?.body['text'])).toContain('Point lundi');
		expect(String(forAlice?.body['text']).length).toBeLessThanOrEqual(500);
		// The model read both messages, marked as data, with their authors
		const asked = h.apisix.llm.calls.map((c) =>
			c.request.messages.map((m) => m.content ?? '').join('\n')
		);
		expect(
			asked.some(
				(t) =>
					t.includes('<<<channel-messages') &&
					t.includes('On se voit quand') &&
					t.includes('ok on parle lundi')
			)
		).toBe(true);
		// ...and nothing of them is kept: no session, no memory, no job
		expect(await h.db.sql`select 1 from sessions`).toHaveLength(0);
		expect(await h.db.sql`select 1 from memory_entries`).toHaveLength(0);
		await until(
			async () => (await h.db.sql`select 1 from jobs where kind = 'suggest'`).length === 0
		);
		expect(JSON.stringify(await h.db.sql`select payload from jobs`)).not.toContain(
			'ok on parle lundi'
		);
		// Nothing was written in the calendar, and no assistant joined the channel, the listener alone
		expect(h.apisix.contracts.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
		expect(
			(await h.synapse.joinedMembers(bob, channel)).filter((m) =>
				m.startsWith('@twake-space-assistant')
			)
		).toEqual([]);
		// The write waits for its owner whatever they allowed, asked in their room too once the
		// question went out there: a yes from Space then resumes it in that room
		type Waiting = { id: string; reasons: string[]; channel: string };
		const waiting = await eventually(async () => {
			const { body } = await h.api.get<{ pending_calls: Waiting[] }>(ALICE, '/v1/pending-calls');
			return body.pending_calls[0]?.channel === 'room' ? body.pending_calls : undefined;
		}).then((calls) => calls ?? []);
		expect(waiting).toHaveLength(1);
		expect(waiting[0]?.reasons).toContain('high_risk');
	});

	it('creates the meeting on one click of the owner, in their name', async () => {
		const call = space.calls.find((c) => c.body['matrixUserId'] === '@alice:test.local');
		const id = call?.body['pendingCallId'] as string;
		h.apisix.contracts.handler = (c: ContractCall) => ({
			status: 200,
			body: { uid: 'm-1', echo: c.method }
		});
		const approved = await h.api.post(ALICE, `/v1/pending-calls/${id}/approve`, {});
		expect(approved.status).toBe(202);
		// The resumed turn runs the call in the owner's room
		const isPost = (c: ContractCall): boolean => c.method === 'POST';
		await eventually(() => h.apisix.contracts.calls.some(isPost));
		const posted = h.apisix.contracts.calls.filter(isPost);
		expect(posted).toHaveLength(1);
		expect(posted[0]?.path).toBe('/contracts/v1/calendar/meetings');
		expect(posted[0]?.headers['x-twake-on-behalf-of']).toBe(ALICE);
		expect(posted[0]?.body).toMatchObject({ title: 'Point lundi', attendees: [BOB] });
	});

	it("offers the turn the owner's yes resumed the suggestion's two tools alone", async () => {
		// That turn is still the channel's: after the meeting, the model is offered none of the tools
		// of the owner's own turns, their other contracts, sessions, memory, listening journal or the
		// choice of what their assistant listens to
		const resumed = await eventually(() =>
			h.apisix.llm.calls.find((c) => (c.request.messages.at(-1)?.content ?? '').includes('m-1'))
		);
		expect(toolsOf(resumed?.request).sort()).toEqual(['create_meeting', 'find_meeting_slots']);
	});

	it("reaches nothing else of the owner's in that turn, and those two tools for the people of the meeting alone", async () => {
		interface Waiting {
			id: string;
			channel: string;
		}
		const waiting = await eventually(async () => {
			const { body } = await h.api.get<{ pending_calls: Waiting[] }>(BOB, '/v1/pending-calls');
			return body.pending_calls[0]?.channel === 'room' ? body.pending_calls[0] : undefined;
		});
		// What the owner keeps for their own turns: a note and a skill
		const noted = await h.api.post(BOB, '/v1/tool', {
			tool: 'memory',
			arguments: { action: 'add', target: 'memory', content: 'Bob garde ses vendredis' }
		});
		expect(noted.status).toBe(200);
		const skill = await h.api.post(BOB, '/v1/skills', {
			name: 'weekly-review',
			description: 'How Bob runs his weekly review',
			content: 'List what the week brought.'
		});
		expect(skill.status).toBe(201);
		h.apisix.contracts.handler = (c: ContractCall) => ({
			status: 200,
			body: c.method === 'POST' ? { uid: 'm-3' } : { slots: [] }
		});
		// Once the meeting is made, the model reaches for the owner's events, their conversations, and
		// the calendar of a person the meeting does not invite
		const reach = (name: string, args: Record<string, unknown>): ToolCall => ({
			id: `reach_${name}`,
			type: 'function',
			function: { name, arguments: JSON.stringify(args) }
		});
		h.apisix.llm.script = (request) =>
			(request.messages.at(-1)?.content ?? '').includes('m-3')
				? {
						content: null,
						toolCalls: [
							reach('list_calendar_events', { from: '2026-10-12' }),
							reach('scoped_sessions_list', {}),
							reach('find_meeting_slots', {
								email: [CAROL, BOB],
								duration: 30,
								start: '2026-10-12T08:00:00+02:00',
								end: '2026-10-12T18:00:00+02:00'
							})
						]
					}
				: proposeMonday(request);
		try {
			const calls = h.apisix.contracts.calls.length;
			const approved = await h.api.post(BOB, `/v1/pending-calls/${waiting?.id ?? ''}/approve`, {});
			expect(approved.status).toBe(202);
			// What the model reads of its calls: none of them ran
			const answered = await eventually(() =>
				h.apisix.llm.calls.find((c) =>
					c.request.messages.some((m) => m.tool_call_id === 'reach_find_meeting_slots')
				)
			);
			const results = (answered?.request.messages ?? [])
				.filter((m) => (m.tool_call_id ?? '').startsWith('reach_'))
				.map((m) => m.content);
			expect(results).toEqual([
				expect.stringContaining('unknown tool list_calendar_events'),
				expect.stringContaining('unknown tool scoped_sessions_list'),
				expect.stringContaining('people_not_allowed')
			]);
			// The meeting its owner allowed is all that reached the calendar
			expect(h.apisix.contracts.calls.slice(calls).map((c) => `${c.method} ${c.path}`)).toEqual([
				'POST /contracts/v1/calendar/meetings'
			]);
			// ...and the model read neither the owner's note nor their skill
			const system = answered?.request.messages[0]?.content ?? '';
			expect(system).not.toContain('Bob garde ses vendredis');
			expect(system).not.toContain('weekly-review');
		} finally {
			h.apisix.llm.script = proposeMonday;
		}
	});

	it('ends that turn at the four calls a suggestion may make', async () => {
		const tag = Math.random().toString(36).slice(2, 7);
		const owner = `g${tag}@test.local`;
		const user = await h.synapse.registerUser(`g${tag}`);
		const other = await h.synapse.registerUser(`h${tag}`);
		// An owner who keeps the room their assistant opened with them, where a yes from Space resumes
		// the turn, and someone without an assistant
		expect((await h.api.post(owner, '/v1/assistants', { name: 'Ada' })).status).toBe(201);
		await grantConsent(h.db, owner, 'calendar', 'read');
		const room = await openChannel(user, [other]);
		await say(other, room, 'On se voit quand ?');
		await say(user, room, 'on se voit lundi à 10h ?');
		interface Waiting {
			id: string;
			channel: string;
		}
		const waiting = await until(async () => {
			const { body } = await h.api.get<{ pending_calls: Waiting[] }>(owner, '/v1/pending-calls');
			return body.pending_calls[0]?.channel === 'room' ? body.pending_calls[0] : null;
		});
		h.apisix.contracts.handler = (c: ContractCall) => ({
			status: 200,
			body: c.method === 'POST' ? { uid: 'm-4' } : { slots: [] }
		});
		// Once the meeting is made, the model asks for five searches at once, with the people of the
		// meeting
		const search = (i: number): ToolCall => ({
			id: `search_${i}`,
			type: 'function',
			function: {
				name: 'find_meeting_slots',
				arguments: JSON.stringify({
					email: [owner, `h${tag}@test.local`],
					duration: 30,
					start: '2026-10-12T08:00:00+02:00',
					end: '2026-10-12T18:00:00+02:00'
				})
			}
		});
		h.apisix.llm.script = (request) =>
			(request.messages.at(-1)?.content ?? '').includes('m-4')
				? { content: null, toolCalls: [1, 2, 3, 4, 5].map(search) }
				: proposeMonday(request);
		try {
			const searches = (): number =>
				h.apisix.contracts.calls.filter(
					(c) => c.path === '/contracts/v1/calendar/availability/slots'
				).length;
			const before = searches();
			const logged = h.logLines().length;
			const approved = await h.api.post(owner, `/v1/pending-calls/${waiting.id}/approve`, {});
			expect(approved.status).toBe(202);
			await until(() =>
				h
					.logLines()
					.slice(logged)
					.some((line) => line['msg'] === 'turn finished' && line['principal'] === owner)
			);
			expect(searches() - before).toBe(4);
		} finally {
			h.apisix.llm.script = proposeMonday;
		}
	});

	it("offers every tool still to a turn of the owner's own, and to the one their yes resumes", async () => {
		// Every tool of the registry, those a suggestion's turn goes without among them
		const every = (h.apps[0]?.agent.tools.definitions ?? []).map((d) => d.function.name).sort();
		expect(every).toEqual(
			expect.arrayContaining([
				'create_meeting',
				'find_meeting_slots',
				'list_calendar_events',
				'listening_journal',
				'memory',
				'scoped_sessions_list'
			])
		);
		h.apisix.contracts.handler = () => ({ status: 200, body: { uid: 'm-5' } });
		const asked = llmCalls();
		const chat = await h.api.post<{ pending_call?: { id: string } }>(BOB, '/v1/chat', {
			message: 'Prépare un point lundi'
		});
		expect(chat.status).toBe(200);
		const id = chat.body.pending_call?.id ?? '';
		expect((await h.api.post(BOB, `/v1/pending-calls/${id}/approve`, {})).status).toBe(200);
		const calls = h.apisix.llm.calls.slice(asked);
		const own = calls.find((c) => c.request.messages.at(-1)?.content === 'Prépare un point lundi');
		const resumed = calls.find((c) => (c.request.messages.at(-1)?.content ?? '').includes('m-5'));
		expect([toolsOf(own?.request).sort(), toolsOf(resumed?.request).sort()]).toEqual([
			every,
			every
		]);
		// ...and what the owner keeps for them
		expect(own?.request.messages[0]?.content).toContain('Bob garde ses vendredis');
		expect(own?.request.messages[0]?.content).toContain('weekly-review');
	});

	it('proposes once a day at most three times, and once per room per twelve hours', async () => {
		const logged = h.logLines().length;
		// Alice's suggestion from this exchange of hers, which a cap kept from her
		const skipped = (reason: string) => (): boolean =>
			h
				.logLines()
				.slice(logged)
				.some(
					(line) =>
						line['msg'] === 'suggestion skipped' &&
						line['owner'] === ALICE &&
						line['reason'] === reason
				);
		// Alice has one suggestion from the channel now: another exchange of hers in it proposes
		// nothing to her
		const before = space.calls.length;
		await say(alice, channel, 'Et toi ?');
		await say(bob, channel, 'on se voit mardi à 10h ?');
		await until(skipped('room_window'));
		// Three in a day is the most: an exchange of hers in another channel proposes nothing to her,
		// and still to Bob, who has one
		await withPrincipal(h.db, { id: ALICE }, async (tx) => {
			for (let i = 0; i < 2; i += 1) {
				await tx.sql`insert into suggestions (pending_call_id, owner, room_id, starts_at, ends_at)
					values (gen_random_uuid(), ${ALICE}, ${`!other${i}:test.local`}, now(), now())`;
			}
		});
		const other = await openChannel(bob, [alice]);
		await say(alice, other, 'On se voit quand ?');
		await say(bob, other, 'on se voit mercredi à 10h ?');
		await until(skipped('daily_cap'));
		await until(() =>
			space.calls
				.slice(before)
				.some(
					(c) => c.body['matrixUserId'] === '@bob:test.local' && c.body['matrixRoomId'] === other
				)
		);
		expect(
			space.calls.slice(before).filter((c) => c.body['matrixUserId'] === '@alice:test.local')
		).toHaveLength(0);
	});

	it('leaves alone a room muted by its member, and the words of a member who opted out', async () => {
		const settings = await h.api.get<{ enabled: boolean; mutedRooms: string[] }>(
			CAROL,
			'/v1/suggestions/settings'
		);
		expect(settings.body).toEqual({ enabled: true, mutedRooms: [] });
		const carol = await becomeAssistantOwner('carol');
		const dave = await becomeAssistantOwner('dave');
		const room = await openChannel(carol, [dave]);
		expect(
			(await h.api.put(DAVE, '/v1/suggestions/settings', { enabled: true, mutedRooms: [room] }))
				.body
		).toEqual({
			enabled: true,
			mutedRooms: [room]
		});
		const before = space.calls.length;
		await say(dave, room, 'On se voit quand ?');
		await say(carol, room, 'on se voit lundi à 10h ?');
		await until(() => space.calls.length > before);
		await sleep(1500);
		// Dave muted the room: only Carol hears of it
		const carolOnly = space.calls.slice(before);
		expect(carolOnly.map((c) => c.body['matrixUserId'])).toEqual(['@carol:test.local']);
		// Carol turns suggestions off: her messages are read no more, nor quoted for Dave
		await h.api.put(CAROL, '/v1/suggestions/settings', { enabled: false, mutedRooms: [] });
		await h.api.put(DAVE, '/v1/suggestions/settings', { enabled: true, mutedRooms: [] });
		const calls = llmCalls();
		await say(dave, room, 'Quand ?');
		await say(carol, room, 'on se call mardi à 14h ?');
		await sleep(3000);
		expect(llmCalls()).toBe(calls);
	});

	it('tries another time once, and mutes the room for a week when it is not useful', async () => {
		const erin = await becomeAssistantOwner('erin');
		const room = await openChannel(erin, [bob]);
		const before = space.calls.length;
		await say(bob, room, 'On se voit quand ?');
		await say(erin, room, 'on se voit lundi à 10h ?');
		const first = await until(() =>
			space.calls.slice(before).find((c) => c.body['matrixUserId'] === '@erin:test.local')
		);
		const firstId = first.body['pendingCallId'] as string;
		const asked = llmCalls();
		const refused = await h.api.post('erin@test.local', `/v1/pending-calls/${firstId}/refuse`, {
			reason: 'another_time'
		});
		expect(refused.status).toBe(200);
		const retry = await until(() =>
			space.calls
				.slice(before)
				.find(
					(c) =>
						c.body['matrixUserId'] === '@erin:test.local' && c.body['pendingCallId'] !== firstId
				)
		);
		const retryRequest = h.apisix.llm.calls
			.slice(asked)
			.map((c) => c.request.messages.map((m) => m.content ?? '').join('\n'));
		expect(retryRequest.some((t) => t.includes('<<<declined-proposal'))).toBe(true);
		// A second refusal for another time is not tried again
		const calls = llmCalls();
		await h.api.post(
			'erin@test.local',
			`/v1/pending-calls/${retry.body['pendingCallId'] as string}/refuse`,
			{
				reason: 'another_time'
			}
		);
		await sleep(3000);
		expect(llmCalls()).toBe(calls);
		// Not useful still mutes the room of a suggestion already answered
		const late = await h.api.post(
			'erin@test.local',
			`/v1/pending-calls/${retry.body['pendingCallId'] as string}/refuse`,
			{ reason: 'not_useful' }
		);
		expect(late.status).toBe(409);
		// Not useful: the room is muted for that member
		const other = await openChannel(erin, [bob]);
		await withPrincipal(h.db, { id: 'erin@test.local' }, (tx) => tx.sql`delete from suggestions`);
		await say(bob, other, 'On se voit quand ?');
		await say(erin, other, 'on se voit jeudi à 10h ?');
		const third = await until(() =>
			space.calls.find(
				(c) => c.body['matrixRoomId'] === other && c.body['matrixUserId'] === '@erin:test.local'
			)
		);
		await h.api.post(
			'erin@test.local',
			`/v1/pending-calls/${third.body['pendingCallId'] as string}/refuse`,
			{
				reason: 'not_useful'
			}
		);
		const settings = await h.api.get<{ mutedRooms: string[] }>(
			'erin@test.local',
			'/v1/suggestions/settings'
		);
		expect([...settings.body.mutedRooms].sort()).toEqual([other, room].sort());
		const muted = await withPrincipal(
			h.db,
			{ id: 'erin@test.local' },
			(tx) => tx.sql<{ days: number }[]>`
				select round(extract(epoch from until - now()) / 86400)::int as days
				from suggestion_mutes where room_id = ${other}`
		);
		expect(muted[0]?.days).toBe(7);
	});

	it("also asks in the owner's room with their assistant, where a yes creates the meeting", async () => {
		const fred = await h.synapse.registerUser('fred');
		const created = await h.api.post<{ roomId: string }>('fred@test.local', '/v1/assistants', {
			name: 'Jarvis'
		});
		const dm = created.body.roomId;
		await grantConsent(h.db, 'fred@test.local', 'calendar', 'read');
		const client = await startE2eeClient(h.synapse.url, fred);
		try {
			await until(async () => (await h.synapse.pendingInvites(fred)).some((i) => i.roomId === dm));
			await client.joinRoom(dm);
			await client.waitForMessage(dm, '@twake-space-assistant-fred:test.local', (t) =>
				t.includes('Jarvis')
			);
			const room = await openChannel(bob, [fred]);
			await say(bob, room, 'On se voit quand ?');
			await say(fred, room, 'on se voit lundi à 10h ?');
			await client.waitForMessage(dm, '@twake-space-assistant-fred:test.local', (t) =>
				t.includes('> Vous avez un créneau lundi.')
			);
			h.apisix.contracts.handler = () => ({ status: 200, body: { uid: 'm-2' } });
			const posts = (): number =>
				h.apisix.contracts.calls.filter((c) => c.method === 'POST').length;
			const before = posts();
			await client.client.sendText(dm, 'oui');
			await until(() => posts() > before);
			const meeting = h.apisix.contracts.calls.filter((c) => c.method === 'POST').at(-1);
			expect(meeting?.body).toMatchObject({ attendees: [BOB] });
			expect(meeting?.headers['x-twake-on-behalf-of']).toBe('fred@test.local');
		} finally {
			await client.stop();
		}
	});

	describe('which rooms the listener accepts', () => {
		async function heardBy(room: string, from: MatrixUser[], text: string): Promise<boolean> {
			const calls = llmCalls();
			for (const user of from)
				await say(user, room, user === from.at(-1) ? text : 'On se voit quand ?');
			await sleep(3500);
			return llmCalls() > calls;
		}
		async function pair(): Promise<[MatrixUser, MatrixUser]> {
			const tag = Math.random().toString(36).slice(2, 7);
			return [await becomeAssistantOwner(`p${tag}`), await becomeAssistantOwner(`q${tag}`)];
		}
		const matching = 'ok on parle lundi à 10h';

		// The invite of a direct room carries is_direct; a direct room of Twake Chat is also
		// encrypted, which the stripped state shows
		it('declines an invite to a direct room', async () => {
			const [one] = await pair();
			const dm = await create(one, {
				preset: 'trusted_private_chat',
				is_direct: true,
				invite: [LISTENER]
			});
			expect(await listenerStays(one, dm)).toBe(false);
		});

		it('accepts a room outside any space, stays, and reads it', async () => {
			const [one, two] = await pair();
			const room = await create(one, { preset: 'public_chat', name: 'loose' });
			await h.synapse.joinRoom(two, room);
			await invite(one, room);
			expect(await listenerStays(one, room)).toBe(true);
			expect(await heardBy(room, [two, one], matching)).toBe(true);
		});

		it('accepts a room inside a space, and reads it', async () => {
			const [one, two] = await pair();
			const room = await openChannel(one, [two]);
			expect(await heardBy(room, [two, one], matching)).toBe(true);
		});

		it('accepts a space itself, and reads it', async () => {
			const [one, two] = await pair();
			const room = await create(one, {
				preset: 'public_chat',
				creation_content: { type: 'm.space' }
			});
			await h.synapse.joinRoom(two, room);
			await invite(one, room);
			expect(await listenerJoined(one, room)).toBe(true);
			expect(await heardBy(room, [two, one], matching)).toBe(true);
		});

		it('declines an encrypted space and an encrypted room inside a space', async () => {
			const [one, two] = await pair();
			const space = await create(one, {
				preset: 'public_chat',
				creation_content: { type: 'm.space' },
				initial_state: [ENCRYPTION]
			});
			await invite(one, space);
			expect(await listenerStays(one, space)).toBe(false);
			const inside = await create(one, {
				preset: 'public_chat',
				initial_state: [PARENT(), ENCRYPTION]
			});
			await h.synapse.joinRoom(two, inside);
			await invite(one, inside);
			expect(await listenerStays(one, inside)).toBe(false);
			expect(await heardBy(inside, [two, one], matching)).toBe(false);
		});

		it('leaves a room at once when it turns encrypted', async () => {
			const [one, two] = await pair();
			const room = await openChannel(one, [two]);
			await h.synapse.request(
				one,
				'PUT',
				`/_matrix/client/v3/rooms/${encodeURIComponent(room)}/state/m.room.encryption`,
				ENCRYPTION.content
			);
			const end = Date.now() + 15_000;
			while (Date.now() < end && (await h.synapse.joinedMembers(one, room)).includes(LISTENER)) {
				await sleep(300);
			}
			expect(await h.synapse.joinedMembers(one, room)).not.toContain(LISTENER);
			expect(await heardBy(room, [two, one], matching)).toBe(false);
		});

		it('stops reading a room once the listener is kicked, which is its switch', async () => {
			const [one, two] = await pair();
			const room = await openChannel(one, [two]);
			await h.synapse.request(
				one,
				'POST',
				`/_matrix/client/v3/rooms/${encodeURIComponent(room)}/kick`,
				{ user_id: LISTENER }
			);
			await sleep(1500);
			expect(await heardBy(room, [two, one], matching)).toBe(false);
		});

		it('never posts anything in a channel', async () => {
			const messages = await h.synapse.messagesFrom(bob, channel, LISTENER);
			expect(messages).toEqual([]);
		});
	});

	// D128 of Twake Chat: the owner of an encrypted direct conversation invites their assistant,
	// warned first; it reads both sides for its owner alone and never writes there
	describe('an assistant its owner invites into an encrypted direct conversation', () => {
		interface Conversation {
			readonly owner: MatrixUser;
			readonly other: MatrixUser;
			readonly ownerClient: E2eeClient;
			readonly otherClient: E2eeClient;
			readonly room: string;
			readonly assistant: string;
			// The rows that name the room among the conversations an assistant reads
			listened(): Promise<number>;
			// As Twake Chat writes them: each keyed by its sender, the assistant in the content
			ask(requested?: boolean): Promise<string>;
			answer(accepted: boolean): Promise<string>;
			// What the assistant wrote in the room, as the other person's client received it
			written(): readonly unknown[];
			stop(): Promise<void>;
		}

		// An encrypted direct conversation of two people, each with their own assistant, the first
		// one's not invited yet
		async function encryptedConversation(): Promise<Conversation> {
			const tag = Math.random().toString(36).slice(2, 7);
			const owner = await becomeAssistantOwner(`o${tag}`);
			const other = await becomeAssistantOwner(`t${tag}`);
			const ownerClient = await startE2eeClient(h.synapse.url, owner);
			const otherClient = await startE2eeClient(h.synapse.url, other);
			const room = await ownerClient.createDirectRoom(other.userId);
			await otherClient.joinRoom(room);
			const principal = `o${tag}@test.local`;
			const rows = await withPrincipal(
				h.db,
				{ id: principal },
				(tx) => tx.sql<{ user_id: string }[]>`
					select user_id from assistants where owner = ${principal}`
			);
			const assistant = rows[0]?.user_id ?? '';
			return {
				owner,
				other,
				ownerClient,
				otherClient,
				room,
				assistant,
				listened: async () =>
					(await h.db.sql`select 1 from assistant_listened_rooms where room_id = ${room}`).length,
				ask: (requested = true) =>
					ownerClient.client.sendStateEvent(
						room,
						'app.twake.chat.assistant_request',
						owner.userId,
						{
							assistant_id: assistant,
							requested,
							ts: Date.now()
						}
					),
				answer: (accepted) =>
					otherClient.client.sendStateEvent(
						room,
						'app.twake.chat.assistant_consent',
						other.userId,
						{
							assistant_id: assistant,
							accepted,
							ts: Date.now()
						}
					),
				written: () =>
					otherClient.events.filter(
						(e) => e.roomId === room && e.sender === assistant && e.type === 'm.room.message'
					),
				stop: async () => {
					await ownerClient.stop();
					await otherClient.stop();
				}
			};
		}

		// The conversation once the other person said yes and the owner invited their assistant in
		async function listenedConversation(): Promise<Conversation> {
			const c = await encryptedConversation();
			await c.ask();
			await c.answer(true);
			await c.ownerClient.client.inviteUser(c.assistant, c.room);
			await until(async () => ((await c.listened()) === 1 ? true : null));
			return c;
		}

		// Once something made it go: the room forgotten, the assistant out of it, without a word
		async function goneWithoutAWord(c: Conversation, viewer: MatrixUser): Promise<void> {
			await until(async () => ((await c.listened()) === 0 ? true : null));
			await until(async () =>
				(await h.synapse.joinedMembers(viewer, c.room)).includes(c.assistant) ? null : true
			);
			expect(c.written()).toHaveLength(0);
		}

		it('comes only on the yes of the other person, proposes to its owner alone, never writes, and leaves on a no', async () => {
			const c = await encryptedConversation();
			try {
				// Invited before the other person said yes: it leaves without a word
				await c.ask();
				await c.ownerClient.client.inviteUser(c.assistant, c.room);
				expect(await leftRoom(c.owner, c.room, c.assistant)).toBe(true);
				expect(await c.listened()).toBe(0);

				// Asked, then accepted: it comes and stays
				await c.ask();
				await c.answer(true);
				await c.ownerClient.client.inviteUser(c.assistant, c.room);
				await until(async () => ((await c.listened()) === 1 ? true : null));
				expect(await isJoined(c.owner, c.room, c.assistant)).toBe(true);

				// The other person writes: a proposal goes to the owner, none to the other person
				const before = space.calls.length;
				await c.otherClient.sendText(c.room, 'ok on parle lundi à 10h');
				const call = await until(() =>
					space.calls.slice(before).find((made) => made.body['matrixRoomId'] === c.room)
				);
				expect(call.body['matrixUserId']).toBe(c.owner.userId);
				await sleep(3000);
				expect(
					space.calls.slice(before).filter((made) => made.body['matrixUserId'] === c.other.userId)
				).toHaveLength(0);
				// Not a word from the assistant in the conversation
				expect(c.written()).toHaveLength(0);

				// The other person says no: it leaves without a word, and the room is forgotten
				await c.answer(false);
				await goneWithoutAWord(c, c.owner);
			} finally {
				await c.stop();
			}
		});

		it('keeps the yes of a person who changes their display name', async () => {
			const c = await listenedConversation();
			try {
				await sleep(1100);
				await c.otherClient.client.setDisplayName('Renamed person');
				await until(async () => {
					const state = await h.synapse.request(
						c.owner,
						'GET',
						`/_matrix/client/v3/rooms/${encodeURIComponent(c.room)}/state/m.room.member/${encodeURIComponent(c.other.userId)}`
					);
					return state.body['displayname'] === 'Renamed person' ? true : null;
				});
				await sleep(4000);
				expect(await c.listened()).toBe(1);
				expect(await isJoined(c.owner, c.room, c.assistant)).toBe(true);
			} finally {
				await c.stop();
			}
		});

		it('leaves without a word once its owner leaves the conversation', async () => {
			const c = await listenedConversation();
			try {
				await c.ownerClient.client.leaveRoom(c.room);
				await goneWithoutAWord(c, c.other);
			} finally {
				await c.stop();
			}
		});

		it('leaves without a word once a third person is invited', async () => {
			const c = await listenedConversation();
			try {
				const third = await h.synapse.registerUser(`x${Math.random().toString(36).slice(2, 7)}`);
				await c.ownerClient.client.inviteUser(third.userId, c.room);
				await goneWithoutAWord(c, c.owner);
			} finally {
				await c.stop();
			}
		});

		it('leaves without a word once its owner withdraws the request', async () => {
			const c = await listenedConversation();
			try {
				await c.ask(false);
				await goneWithoutAWord(c, c.owner);
			} finally {
				await c.stop();
			}
		});

		interface Pair {
			readonly owner: MatrixUser;
			readonly other: MatrixUser;
			readonly ownerClient: E2eeClient;
			readonly otherClient: E2eeClient;
			readonly room: string;
			readonly ownerAssistant: string;
			readonly otherAssistant: string;
			listened(): Promise<number>;
			stop(): Promise<void>;
		}

		// Two people in an encrypted room, each with their own assistant, both brought in on the other's
		// yes: a direct conversation, or a channel of the two
		async function pairWithTwoAssistants(direct: boolean): Promise<Pair> {
			const tag = Math.random().toString(36).slice(2, 7);
			const owner = await becomeAssistantOwner(`o${tag}`);
			const other = await becomeAssistantOwner(`t${tag}`);
			const ownerClient = await startE2eeClient(h.synapse.url, owner);
			const otherClient = await startE2eeClient(h.synapse.url, other);
			const assistantOf = async (localpart: string): Promise<string> => {
				const principal = `${localpart}@test.local`;
				const rows = await withPrincipal(
					h.db,
					{ id: principal },
					(tx) => tx.sql<{ user_id: string }[]>`
						select user_id from assistants where owner = ${principal}`
				);
				return rows[0]?.user_id ?? '';
			};
			const ownerAssistant = await assistantOf(`o${tag}`);
			const otherAssistant = await assistantOf(`t${tag}`);
			const room = direct
				? await ownerClient.createDirectRoom(other.userId)
				: await ownerClient.client.createRoom({
						preset: 'private_chat',
						name: 'pair channel',
						invite: [other.userId],
						initial_state: [ENCRYPTION],
						power_level_content_override: {
							events: {
								'app.twake.chat.assistant_consent': 0,
								'app.twake.chat.assistant_request': 0
							}
						}
					});
			await otherClient.joinRoom(room);
			const request = (client: E2eeClient, assistant: string): Promise<string> =>
				client.client.sendStateEvent(room, 'app.twake.chat.assistant_request', client.userId, {
					assistant_id: assistant,
					requested: true,
					ts: Date.now()
				});
			const yes = (client: E2eeClient, assistant: string): Promise<string> =>
				client.client.sendStateEvent(room, 'app.twake.chat.assistant_consent', client.userId, {
					assistant_id: assistant,
					accepted: true,
					ts: Date.now()
				});
			const listened = async (): Promise<number> =>
				(await h.db.sql`select 1 from assistant_listened_rooms where room_id = ${room}`).length;
			await request(ownerClient, ownerAssistant);
			await yes(otherClient, ownerAssistant);
			await ownerClient.client.inviteUser(ownerAssistant, room);
			await until(async () => ((await listened()) === 1 ? true : null));
			await request(otherClient, otherAssistant);
			await yes(ownerClient, otherAssistant);
			await otherClient.client.inviteUser(otherAssistant, room);
			await until(async () => ((await listened()) === 2 ? true : null));
			return {
				owner,
				other,
				ownerClient,
				otherClient,
				room,
				ownerAssistant,
				otherAssistant,
				listened,
				stop: async () => {
					await ownerClient.stop();
					await otherClient.stop();
				}
			};
		}

		it('lets two assistants read one direct conversation, and every message reaches both owners with the same context', async () => {
			const p = await pairWithTwoAssistants(true);
			try {
				expect(await isJoined(p.owner, p.room, p.ownerAssistant)).toBe(true);
				expect(await isJoined(p.owner, p.room, p.otherAssistant)).toBe(true);
				const before = space.calls.length;
				await p.otherClient.sendText(p.room, 'bonjour');
				await sleep(1500);
				await p.ownerClient.sendText(p.room, 'ok on parle lundi à 10h');
				// Each owner is offered a proposal, and the second one too has the message before it
				const reached = await until(() => {
					const users = new Set(
						space.calls
							.slice(before)
							.filter((made) => made.body['matrixRoomId'] === p.room)
							.map((made) => made.body['matrixUserId'])
					);
					return users.has(p.owner.userId) && users.has(p.other.userId) ? users : null;
				});
				expect(reached.size).toBe(2);
				const quotes = h.apisix.llm.calls
					.slice(-2)
					.map((call) => JSON.stringify(call.request.messages));
				for (const quote of quotes) expect(quote).toContain('bonjour');
			} finally {
				await p.stop();
			}
		});

		it('makes both assistants leave once a member leaves a channel of the two', async () => {
			const p = await pairWithTwoAssistants(false);
			try {
				await p.otherClient.client.leaveRoom(p.room);
				await until(async () => ((await p.listened()) === 0 ? true : null));
				expect(await leftRoom(p.owner, p.room, p.ownerAssistant)).toBe(true);
				expect(await leftRoom(p.owner, p.room, p.otherAssistant)).toBe(true);
			} finally {
				await p.stop();
			}
		});

		it('makes the assistant leave when the check of the room cannot complete', async () => {
			const c = await listenedConversation();
			try {
				const stateOfRoom = (path: string): boolean => {
					const bare = decodeURIComponent(path).split('?')[0] ?? '';
					return bare.endsWith(`/rooms/${c.room}/state`);
				};
				h.apisix.matrixFault = (call) =>
					call.method === 'GET' && stateOfRoom(call.path) ? 500 : null;
				// An event that makes it check the room again
				await c.answer(true);
				await goneWithoutAWord(c, c.owner);
				expect(h.logLines().some((line) => line['msg'] === 'listened room not checked')).toBe(true);
			} finally {
				h.apisix.matrixFault = null;
				await c.stop();
			}
		});

		it('keeps both assistants of a channel of three people when each person answers both, in one consent', async () => {
			const tag = Math.random().toString(36).slice(2, 7);
			const a = await becomeAssistantOwner(`a${tag}`);
			const b = await becomeAssistantOwner(`b${tag}`);
			const c = await h.synapse.registerUser(`p${tag}`);
			const [ac, bc, cc] = await Promise.all(
				[a, b, c].map((user) => startE2eeClient(h.synapse.url, user))
			);
			try {
				const room = await ac!.client.createRoom({
					preset: 'private_chat',
					name: 'three',
					invite: [b.userId, c.userId],
					initial_state: [ENCRYPTION],
					power_level_content_override: {
						events: { 'app.twake.chat.assistant_consent': 0, 'app.twake.chat.assistant_request': 0 }
					}
				});
				await bc!.joinRoom(room);
				await cc!.joinRoom(room);
				const assistantOf = async (localpart: string): Promise<string> => {
					const principal = `${localpart}@test.local`;
					const rows = await withPrincipal(
						h.db,
						{ id: principal },
						(tx) => tx.sql<{ user_id: string }[]>`
							select user_id from assistants where owner = ${principal}`
					);
					return rows[0]?.user_id ?? '';
				};
				const aa = await assistantOf(`a${tag}`);
				const ba = await assistantOf(`b${tag}`);
				const request = (client: E2eeClient, assistant: string): Promise<string> =>
					client.client.sendStateEvent(room, 'app.twake.chat.assistant_request', client.userId, {
						assistant_id: assistant,
						requested: true,
						ts: Date.now()
					});
				await request(ac!, aa);
				await request(bc!, ba);
				await sleep(1100);
				// Each person answers both assistants in one event, keyed by themselves
				const answers = {
					[aa]: { accepted: true, ts: Date.now() },
					[ba]: { accepted: true, ts: Date.now() }
				};
				for (const client of [ac!, bc!, cc!]) {
					await client.client.sendStateEvent(
						room,
						'app.twake.chat.assistant_consent',
						client.userId,
						{ answers }
					);
				}
				await ac!.client.inviteUser(aa, room);
				await bc!.client.inviteUser(ba, room);
				const listened = async (): Promise<number> =>
					(await h.db.sql`select 1 from assistant_listened_rooms where room_id = ${room}`).length;
				await until(async () => ((await listened()) === 2 ? true : null));
				await sleep(3000);
				expect(await listened()).toBe(2);
				expect(await isJoined(a, room, aa)).toBe(true);
				expect(await isJoined(a, room, ba)).toBe(true);
			} finally {
				for (const client of [ac!, bc!, cc!]) await client.stop();
			}
		});

		it('in an encrypted channel, comes only once every other person said yes, and leaves when a newcomer has not', async () => {
			const tag = Math.random().toString(36).slice(2, 7);
			const owner = await becomeAssistantOwner(`c${tag}`);
			const first = await becomeAssistantOwner(`f${tag}`);
			const second = await becomeAssistantOwner(`s${tag}`);
			const clients = await Promise.all(
				[owner, first, second].map((user) => startE2eeClient(h.synapse.url, user))
			);
			const [ownerClient, firstClient, secondClient] = clients as [
				E2eeClient,
				E2eeClient,
				E2eeClient
			];
			try {
				const room = await ownerClient.client.createRoom({
					preset: 'private_chat',
					name: 'secret channel',
					invite: [first.userId, second.userId],
					initial_state: [ENCRYPTION],
					// As Twake Chat opens a channel: every member may answer a request
					power_level_content_override: { events: { 'app.twake.chat.assistant_consent': 0 } }
				});
				await firstClient.joinRoom(room);
				await secondClient.joinRoom(room);
				const principal = `c${tag}@test.local`;
				const rows = await withPrincipal(
					h.db,
					{ id: principal },
					(tx) => tx.sql<{ user_id: string }[]>`
						select user_id from assistants where owner = ${principal}`
				);
				const assistant = rows[0]?.user_id ?? '';
				const listened = async (): Promise<number> =>
					(await h.db.sql`select 1 from assistant_listened_rooms where room_id = ${room}`).length;
				const ask = (): Promise<string> =>
					ownerClient.client.sendStateEvent(
						room,
						'app.twake.chat.assistant_request',
						owner.userId,
						{
							assistant_id: assistant,
							requested: true,
							ts: Date.now()
						}
					);
				const answer = (client: E2eeClient, accepted: boolean): Promise<string> =>
					client.client.sendStateEvent(room, 'app.twake.chat.assistant_consent', client.userId, {
						assistant_id: assistant,
						accepted,
						ts: Date.now()
					});

				// One yes of two: it leaves without a word
				await ask();
				await answer(firstClient, true);
				await ownerClient.client.inviteUser(assistant, room);
				expect(await leftRoom(owner, room, assistant)).toBe(true);
				expect(await listened()).toBe(0);

				// Both said yes: it stays
				await ask();
				await answer(firstClient, true);
				await answer(secondClient, true);
				await ownerClient.client.inviteUser(assistant, room);
				await until(async () => ((await listened()) === 1 ? true : null));
				expect(await isJoined(owner, room, assistant)).toBe(true);

				// A newcomer who has not said yes: it leaves, and the room is forgotten
				const newcomer = await h.synapse.registerUser(`n${tag}`);
				await ownerClient.client.inviteUser(newcomer.userId, room);
				await until(async () => ((await listened()) === 0 ? true : null));
				await until(async () =>
					(await h.synapse.joinedMembers(owner, room)).includes(assistant) ? null : true
				);
			} finally {
				for (const client of clients) await client.stop();
			}
		});
	});
});

describe('the notification to Twake Space', () => {
	const suggestion = {
		matrixUserId: '@alice:test.local',
		externalId: 'c-1',
		text: 'x'.repeat(600),
		pendingCallId: 'c-1',
		matrixRoomId: '!r:test.local'
	};
	const reply = (status: number, body: unknown): typeof fetch =>
		(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
	const log = { warn: () => undefined } as never;
	const make = (fetchImpl: typeof fetch) =>
		makeSpaceNotifications({
			apiUrl: new URL('http://space.test/api'),
			apiToken: 'tws_x',
			log,
			fetchImpl
		});

	it('takes 201 for done, and 200 with no id for a user who turned suggestions off in Space', async () => {
		expect(await make(reply(201, { id: 'n' })).suggest(suggestion)).toBe('created');
		expect(await make(reply(200, { id: null })).suggest(suggestion)).toBe('off');
		expect(await make(reply(200, { id: 'n' })).suggest(suggestion)).toBe('created');
	});

	it('logs, and fails, on an unknown user, a session token or a broken Space', async () => {
		expect(await make(reply(404, { error: 'unknown_user' })).suggest(suggestion)).toBe('failed');
		expect(await make(reply(403, {})).suggest(suggestion)).toBe('failed');
		const down = (async () => {
			throw new Error('connect ECONNREFUSED');
		}) as unknown as typeof fetch;
		expect(await make(down).suggest(suggestion)).toBe('failed');
	});

	it('cuts the text at 500 characters', async () => {
		let sent = '';
		const spy = (async (_url: URL, init: RequestInit) => {
			sent = (JSON.parse(String(init.body)) as { text: string }).text;
			return new Response('{}', { status: 201 });
		}) as unknown as typeof fetch;
		await make(spy).suggest(suggestion);
		expect(sent).toHaveLength(500);
	});
});
