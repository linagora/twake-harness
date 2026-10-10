import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { findTimeZone } from '../src/agent/clock.js';
import { insertPendingCall } from '../src/consents/repository.js';
import { withPrincipal } from '../src/db/client.js';
import { enqueueJob } from '../src/jobs/queue.js';
import { findOwnerTimeZone, saveOwnerTimeZone } from '../src/settings/repository.js';
import { suggestGroup } from '../src/suggestions/job.js';
import {
	DAY_MS,
	muteRoomFor,
	recordSuggestion,
	writeSettings
} from '../src/suggestions/repository.js';
import {
	activityEvent,
	lastUser,
	startActivityExchange,
	turnCalls,
	until,
	type ActivityEvent,
	type ActivityExchange
} from './helpers/activity.js';
import { makeSettableClock } from './helpers/clock.js';
import { call, readCatalog, startConsentRoom, type ConsentRoom } from './helpers/consent-room.js';
import { startE2eeClient, type DecryptedMessage, type E2eeClient } from './helpers/e2ee-client.js';
import type { ChatRequest, ScriptedReply } from './helpers/fake-apisix.js';

const ALICE = 'alice@test.local';
const CAROL = 'carol@test.local';
const CAROLS_ASSISTANT = '@twake-space-assistant-carol:test.local';

// What I tell my assistant and keep for it, which no assistant of mine finds once I deleted it
const WORDS = 'My cat is called Tigrou';
const NOTE = 'Alice drinks green tea';
const SKILL = {
	name: 'Quarterly digest',
	description: 'How Alice wants her quarterly digest',
	content: '# Quarterly digest\nThree bullet points.'
};
const PROPOSAL = {
	name: 'Monday plan',
	description: 'How Alice plans her Mondays',
	content: '# Monday plan\nTasks first.'
};

// The zone a read of my calendar returned, which the harness keeps for me until I delete my
// assistant
const ZONE = 'Asia/Tokyo';

// What the harness asks me the first time my assistant needs to read an application
function firstRead(domain: string): string {
	return `This is the first time I need to read your data in ${domain}.`;
}

// What the assistant says when my day is spent
const DAY_SPENT = 'I have reached my limit for the day';

// What the assistant tells me of a session of mine that I never verified, whose words it takes
const UNVERIFIED_REPORT =
	'This session of yours is not verified. I act on what you write from it for now; verify it so that I keep doing so: in another of your Twake Chat sessions, open Settings > Devices, find this one marked Unverified and tap Verify.';

// What the assistant asks me once my words came from a session that an identity of mine it does
// not know signed
const IDENTITY_QUESTION =
	'Your encryption identity is not the one I know. Did you reset your identity yourself? Answer yes or no in your next message.';

// A literal model: it tells of the event a turn names, says what it remembers of me, searches our
// past conversations or the application I name, tells what a search found, and repeats anything
// else it hears
function literal(request: ChatRequest): ScriptedReply {
	const last = request.messages.at(-1);
	if (last?.role === 'tool') return { content: `Found: ${last.content ?? ''}` };
	const said = lastUser(request);
	const event = /\(id ([^)]+)\)/.exec(said)?.[1];
	if (event !== undefined) return { content: `Told of ${event}` };
	if (said === 'What do you remember?') {
		const prompt = request.messages[0]?.content ?? '';
		const remembered = [NOTE, SKILL.description].filter((thing) => prompt.includes(thing));
		return { content: `I remember: ${remembered.join(' and ') || 'nothing'}` };
	}
	const query = /^Search our conversations for (.+)$/.exec(said)?.[1];
	if (query !== undefined) return { toolCalls: call('session_search', { query }) };
	const domain = /^Search my (\w+)$/.exec(said)?.[1];
	if (domain !== undefined) return { toolCalls: call(`search_${domain}`, { q: 'budget' }) };
	return { content: `Heard: ${said}` };
}

interface PendingCalls {
	readonly pending_calls: { readonly id: string; readonly domain: string }[];
}

interface CreatedAssistant {
	readonly userId: string;
	readonly roomId: string;
}

// An event of a room as the homeserver lists it
interface TimelineEvent {
	readonly type: string;
	readonly sender: string;
	readonly state_key?: string;
	readonly content: Record<string, unknown>;
}

describe('deleting my assistant erases what the harness keeps of it', () => {
	let activity: ActivityExchange;
	let r: ConsentRoom;
	let creatorId: string;
	// My conversation with the creator
	let creatorRoom: string;
	// The room I opened with the assistant myself, besides the one it opened
	let secondRoom: string;
	// The room of the assistant I created after deleting Jarvis
	let irisRoom: string;
	// The request that waited for my answer when I deleted Jarvis
	let waiting: string;
	// What the harness held of my identity before I deleted Jarvis
	let pinned: unknown;
	// Another session of mine, opened anew in a browser and never verified
	let other: E2eeClient | undefined;
	// An event my assistant told me of before I deleted it, which wakes none of my next ones
	const toldBefore = activityEvent({ id: 'erasure-told-before', recipient: ALICE });

	beforeAll(async () => {
		activity = await startActivityExchange();
		// My words come faster than an owner's rate allows by default
		r = await startConsentRoom({ ...activity.settings, ADMISSION_USER_PER_MINUTE: '120' });
		await activity.listen(r.h);
		r.h.apisix.llm.script = literal;
		r.h.apisix.contracts.spec = readCatalog(['mail', 'drive']);
		for (const app of r.h.apps) expect(await app.agent.contracts.load()).toBe(2);
		r.h.apisix.contracts.handler = () => ({ status: 200, body: { items: ['Budget 2027'] } });
		creatorId = r.h.role.creatorUserId;
		creatorRoom = await r.client.createDirectRoom(creatorId);
		await r.client.waitForMessage(creatorRoom, creatorId, (t) => t.includes('/newbot'));
	}, 240_000);
	afterAll(async () => {
		if (other !== undefined) await other.stop();
		if (activity !== undefined) await activity.close();
		if (r !== undefined) await r.close();
	});

	// What the creator wrote me in our conversation, so far
	function fromCreator(): DecryptedMessage[] {
		return r.client.messages.filter((m) => m.roomId === creatorRoom && m.sender === creatorId);
	}

	// What the creator answers me next, once I wrote it a message: when I say what its answer looks
	// like, the first of its messages since then that does, as it may tell me something else first
	async function answerTo(
		text: string,
		answer: (body: string) => boolean = () => true
	): Promise<string> {
		const seen = fromCreator().length;
		await r.client.sendText(creatorRoom, text);
		let answered: string | undefined;
		await until(`the creator answered « ${text} »`, () => {
			answered = fromCreator()
				.slice(seen)
				.find((m) => answer(m.body))?.body;
			return answered !== undefined;
		});
		return answered ?? '';
	}

	// What my assistant answers me in a room once I wrote it a message: the first of its messages
	// since then that looks like the answer
	async function ask(
		room: string,
		text: string,
		answer: (body: string) => boolean
	): Promise<string> {
		const said = (): DecryptedMessage[] =>
			r.client.messages.filter((m) => m.roomId === room && m.sender === r.assistantId);
		const seen = said().length;
		await r.client.sendText(room, text);
		let answered: string | undefined;
		await until(`my assistant answered « ${text} »`, () => {
			answered = said()
				.slice(seen)
				.find((m) => answer(m.body))?.body;
			return answered !== undefined;
		});
		return answered ?? '';
	}

	// Joins the room my new assistant invited me to, none of the rooms I knew, and waits for it to
	// greet me there
	async function meetNewAssistant(name: string, known: readonly string[]): Promise<string> {
		const mine = await r.h.api.get<CreatedAssistant>(ALICE, '/v1/assistants/me');
		const room = mine.body.roomId;
		expect(known).not.toContain(room);
		await r.client.joinRoom(room);
		await r.client.waitForMessage(room, r.assistantId, (t) => t.includes(name));
		return room;
	}

	// The accounts whose sends failed for good, as the queue keeps them, each payload the JSON text
	// of its fields: no route shows them, so the test reads them in the database
	async function failedSends(): Promise<string[]> {
		const rows = await r.h.db.sql<{ as_user_id: string }[]>`
			select (payload #>> '{}')::jsonb ->> 'asUserId' as as_user_id from jobs
			where status = 'failed' and kind = 'send' order by id`;
		return rows.map((row) => row.as_user_id);
	}

	// The zone of my calendar as the harness keeps it, which no route shows either: read under my
	// principal, as my turns read it
	async function myZone(): Promise<string | null> {
		return withPrincipal(r.h.db, { id: ALICE }, (tx) => findOwnerTimeZone(tx, ALICE));
	}

	// Everything my owner routes show of what I told my assistant and kept for it
	async function myRoutes(): Promise<Record<string, unknown>> {
		const [sessions, memory, skills, proposals, consents, pending] = await Promise.all(
			[
				'/v1/sessions',
				'/v1/memory',
				'/v1/skills',
				'/v1/skills/proposals',
				'/v1/consents',
				'/v1/pending-calls'
			].map((path) => r.h.api.get(ALICE, path))
		);
		return {
			sessions: sessions?.body['sessions'],
			memory: memory?.body,
			skills: skills?.body['skills'],
			proposals: proposals?.body['proposals'],
			consents: consents?.body['consents'],
			pending: pending?.body['pending_calls']
		};
	}

	// What my routes show once the harness keeps nothing of what I told my assistant
	const NOTHING = {
		sessions: [],
		memory: { memory: [], user: [] },
		skills: [],
		proposals: [],
		consents: [],
		pending: []
	};

	// What I keep for my assistant besides our conversations: a note, a skill, a skill it
	// proposed, and my permission to read my drive
	async function keepForMyAssistant(): Promise<void> {
		const kept = await r.h.api.tool(ALICE, 'memory', {
			action: 'add',
			target: 'user',
			content: NOTE
		});
		expect(kept.body['success']).toBe(true);
		expect((await r.h.api.post(ALICE, '/v1/skills', SKILL)).status).toBe(201);
		expect((await r.h.api.tool(ALICE, 'skills_propose', PROPOSAL)).status).toBe(200);
		expect((await r.h.api.put(ALICE, '/v1/consents/drive/read', {})).status).toBe(201);
	}

	it('remembers our conversations, what I keep for it and what I allowed, while I have it', async () => {
		await keepForMyAssistant();
		await ask(r.room, WORDS, (t) => t === `Heard: ${WORDS}`);
		expect(await ask(r.room, 'What do you remember?', (t) => t.startsWith('I remember:'))).toBe(
			`I remember: ${NOTE} and ${SKILL.description}`
		);
		expect(
			await ask(r.room, 'Search our conversations for Tigrou', (t) => t.startsWith('Found:'))
		).toContain(WORDS);
		// Allowed through the API: it reads my drive without asking
		expect(await ask(r.room, 'Search my drive', (t) => t.startsWith('Found:'))).toContain(
			'Budget 2027'
		);
		await activity.publish(toldBefore);
		await r.client.waitForMessage(
			r.room,
			r.assistantId,
			(t) => t === `Told of ${toldBefore.id}`,
			60_000
		);
		// A room I opened with it myself
		secondRoom = await r.client.createDirectRoom(r.assistantId);
		await r.h.synapse.waitForMember(r.alice, secondRoom, r.assistantId);
		await ask(secondRoom, 'Are you here too?', (t) => t === 'Heard: Are you here too?');
		// Last, since my next words would answer it: a request that waits for my answer
		await ask(r.room, 'Search my mail', (t) => t.startsWith(firstRead('mail')));
		const pending = await r.h.api.get<PendingCalls>(ALICE, '/v1/pending-calls');
		expect(pending.body.pending_calls.map((p) => p.domain)).toEqual(['mail']);
		waiting = pending.body.pending_calls[0]?.id ?? '';
		const routes = await myRoutes();
		expect(routes['sessions']).toHaveLength(2);
		expect(routes['memory']).toEqual({ memory: [], user: [NOTE] });
		expect(routes['skills']).toHaveLength(1);
		expect(routes['proposals']).toHaveLength(1);
		expect(routes['consents']).toHaveLength(1);
		pinned = (await r.h.api.get(ALICE, '/v1/assistants/me/owner-identity')).body['pinned'];
		expect(pinned).toMatchObject({ pinned_by: 'first_use' });
		// The zone a read of my calendar returned, kept as such a read keeps it
		const zone = findTimeZone(ZONE);
		if (zone === null) throw new Error(`the runtime does not know ${ZONE}`);
		await withPrincipal(r.h.db, { id: ALICE }, (tx) => saveOwnerTimeZone(tx, ALICE, zone));
		expect(await myZone()).toBe(ZONE);
	});

	it('tells me once that a session of mine is not verified, while I have it', async () => {
		other = await startE2eeClient(r.h.synapse.url, await r.h.synapse.login('alice'), {
			session: 'unsigned'
		});
		await other.sendText(secondRoom, 'Hello from my other browser');
		await r.client.waitForMessage(
			secondRoom,
			r.assistantId,
			(t) => t === 'Heard: Hello from my other browser'
		);
		await r.client.waitForMessage(secondRoom, r.assistantId, (t) => t === UNVERIFIED_REPORT);
	});

	it('stays in a room it could not leave once someone else came in, while I have it', async () => {
		const logged = r.h.logLines().length;
		const bob = await r.h.synapse.registerUser('bob');
		// The homeserver refuses my assistant's leave of the room I opened with it
		r.h.apisix.matrixFault = (c) =>
			c.method === 'POST' && decodeURIComponent(c.path).includes(`/rooms/${secondRoom}/leave`)
				? 500
				: null;
		try {
			const invited = await r.h.synapse.request(
				r.alice,
				'POST',
				`/_matrix/client/v3/rooms/${encodeURIComponent(secondRoom)}/invite`,
				{ user_id: bob.userId }
			);
			expect(invited.status).toBe(200);
			await until('my assistant tried to leave the room', () =>
				r.h
					.logLines()
					.slice(logged)
					.some((line) => line['msg'] === 'room not left' && line['roomId'] === secondRoom)
			);
		} finally {
			r.h.apisix.matrixFault = null;
		}
		expect(await r.h.synapse.joinedMembers(r.alice, secondRoom)).toContain(r.assistantId);
	});

	it('erases our conversations, what I kept for it, what I allowed and what waited for me, once I confirm /delete', async () => {
		expect(await answerTo('/delete')).toContain('Delete Jarvis?');
		expect(await answerTo('yes')).toBe(
			'Your assistant is deleted. Send /newbot when you want a new one.'
		);
		expect((await r.h.api.get(ALICE, '/v1/assistants/me')).status).toBe(404);
		expect(await myRoutes()).toEqual(NOTHING);
		// The request that waited for my answer can no longer be allowed
		expect((await r.h.api.post(ALICE, `/v1/pending-calls/${waiting}/approve`, {})).status).toBe(
			404
		);
	});

	it('leaves every room it is in, the one it could not leave before included', async () => {
		for (const room of [r.room, secondRoom]) {
			await until(
				`the assistant left ${room}`,
				async () => !(await r.h.synapse.joinedMembers(r.alice, room)).includes(r.assistantId)
			);
		}
	});

	it('gives me a new assistant under the same Matrix identifier, which greets me in a new room and remembers nothing', async () => {
		expect(await answerTo('/newbot')).toBe('Which name do you want for your assistant?');
		expect(await answerTo('Iris')).toContain(`Done. Your assistant Iris is ${r.assistantId}`);
		irisRoom = await meetNewAssistant('Iris', [r.room, secondRoom]);
		expect(await ask(irisRoom, 'What do you remember?', (t) => t.startsWith('I remember:'))).toBe(
			'I remember: nothing'
		);
		expect(
			await ask(irisRoom, 'Search our conversations for Tigrou', (t) => t.startsWith('Found:'))
		).toBe('Found: {"sessions":[]}');
		// It asks again before it reads my drive
		await ask(irisRoom, 'Search my drive', (t) => t.startsWith(firstRead('drive')));
	});

	it('tells me again, in its new room, that a session of mine is not verified', async () => {
		await other?.sendText(irisRoom, 'Hello again from my other browser');
		await r.client.waitForMessage(
			irisRoom,
			r.assistantId,
			(t) => t === 'Heard: Hello again from my other browser'
		);
		await r.client.waitForMessage(irisRoom, r.assistantId, (t) => t === UNVERIFIED_REPORT);
	});

	it("keeps the identity it holds of me, and erases the zone of my calendar: the turns of my new assistant state the present in the deployment's", async () => {
		expect((await r.h.api.get(ALICE, '/v1/assistants/me/owner-identity')).body['pinned']).toEqual(
			pinned
		);
		expect(await myZone()).toBeNull();
		const turns = r.h.apisix.llm.calls.length;
		await ask(irisRoom, 'What time is it?', (t) => t === 'Heard: What time is it?');
		const prompt =
			r.h.apisix.llm.calls.slice(turns).find((c) => lastUser(c.request) === 'What time is it?')
				?.request.messages[0]?.content ?? '';
		expect(prompt).toContain(`time zone ${r.h.config.timeZone}.`);
		expect(prompt).not.toContain(ZONE);
	});

	it('wakes my new assistant for no event it already told me of, however often the event comes again', async () => {
		await activity.publish(toldBefore);
		// Published after it: once my assistant tells me of this one, the replay was read
		const next = activityEvent({ id: 'erasure-told-after', recipient: ALICE });
		await activity.publish(next);
		await r.client.waitForMessage(
			irisRoom,
			r.assistantId,
			(t) => t === `Told of ${next.id}`,
			60_000
		);
		expect(turnCalls(r.h.apisix.llm.calls, toldBefore.id)).toHaveLength(1);
	});

	it('erases the same through the API, with no question', async () => {
		// A conversation through the API, beside the room, and the request about my drive that
		// waits for my answer in the room of Iris
		const chat = await r.h.api.post(ALICE, '/v1/chat', { message: 'My dog is called Rex' });
		expect(chat.status).toBe(200);
		await keepForMyAssistant();
		const pending = await r.h.api.get<PendingCalls>(ALICE, '/v1/pending-calls');
		expect(pending.body.pending_calls.map((p) => p.domain)).toEqual(['drive']);
		expect((await r.h.api.delete(ALICE, '/v1/assistants/me')).status).toBe(204);
		expect(await myRoutes()).toEqual(NOTHING);
		const id = pending.body.pending_calls[0]?.id ?? '';
		expect((await r.h.api.post(ALICE, `/v1/pending-calls/${id}/approve`, {})).status).toBe(404);
		const again = await r.h.api.post<CreatedAssistant>(ALICE, '/v1/assistants', { name: 'Iris' });
		expect(again.status).toBe(201);
		expect(again.body.userId).toBe(r.assistantId);
		const room = await meetNewAssistant('Iris', [r.room, secondRoom, irisRoom]);
		expect(await ask(room, 'What do you remember?', (t) => t.startsWith('I remember:'))).toBe(
			'I remember: nothing'
		);
		expect(await ask(room, 'Search our conversations for Rex', (t) => t.startsWith('Found:'))).toBe(
			'Found: {"sessions":[]}'
		);
	});

	it('keeps nothing of my words that waited for my turn before them while I deleted my assistant', async () => {
		const room = (await r.h.api.get<CreatedAssistant>(ALICE, '/v1/assistants/me')).body.roomId;
		// What the harness logs from my turn on
		const logged = r.h.logLines().length;
		const since = (): Record<string, unknown>[] => r.h.logLines().slice(logged);
		let reached = (): void => undefined;
		const asked = new Promise<void>((resolve) => {
			reached = resolve;
		});
		let release = (): void => undefined;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		// The model keeps my turn through the API waiting
		r.h.apisix.llm.script = (request) => {
			if (lastUser(request) !== 'Plan my week') return literal(request);
			reached();
			return { content: 'Heard: Plan my week', hold: held };
		};
		// My words in the room run where my turn through the API runs, so that they wait for it
		await r.h.stopTurnWorkers();
		r.h.startTurnWorkers({ firstReplicaOnly: true });
		try {
			const chat = r.h.api.post(ALICE, '/v1/chat', { message: 'Plan my week' });
			await asked;
			await r.client.sendText(room, 'Remember that I moved to Nantes');
			await until('my words waited for my turn', () =>
				since().some((line) => line['msg'] === 'admission queued' && line['principal'] === ALICE)
			);
			expect(await answerTo('/delete')).toContain('Delete Iris?');
			expect(await answerTo('yes')).toBe(
				'Your assistant is deleted. Send /newbot when you want a new one.'
			);
			release();
			await chat;
			// What it would have answered my words as the assistant I deleted goes nowhere
			await until('the answer to my words was dropped', () =>
				since().some(
					(line) =>
						line['msg'] === 'send dropped: no assistant for this room' && line['roomId'] === room
				)
			);
		} finally {
			release();
			r.h.apisix.llm.script = literal;
			await r.h.stopTurnWorkers();
			r.h.startTurnWorkers();
		}
		expect(await myRoutes()).toEqual(NOTHING);
		expect(await answerTo('/newbot')).toBe('Which name do you want for your assistant?');
		expect(await answerTo('Iris')).toContain(`Done. Your assistant Iris is ${r.assistantId}`);
		const next = await meetNewAssistant('Iris', [room]);
		expect(await ask(next, 'What do you remember?', (t) => t.startsWith('I remember:'))).toBe(
			'I remember: nothing'
		);
		expect(
			await ask(next, 'Search our conversations for Nantes', (t) => t.startsWith('Found:'))
		).toBe('Found: {"sessions":[]}');
	});

	it('keeps nothing of a turn that ran while I deleted my assistant, and sends nothing as it', async () => {
		const room = (await r.h.api.get<CreatedAssistant>(ALICE, '/v1/assistants/me')).body.roomId;
		const words = 'Remember that I moved to Lyon';
		// What the harness logs from my words on
		const logged = r.h.logLines().length;
		const since = (): Record<string, unknown>[] => r.h.logLines().slice(logged);
		let reached = (): void => undefined;
		const asked = new Promise<void>((resolve) => {
			reached = resolve;
		});
		let release = (): void => undefined;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		// The model keeps the turn waiting before it asks to remember what I said, proposes a skill
		// and reads my mail, which I never allowed
		r.h.apisix.llm.script = (request) => {
			if (lastUser(request) !== words || request.messages.at(-1)?.role !== 'user') {
				return literal(request);
			}
			reached();
			return {
				toolCalls: [
					...call('memory', { action: 'add', target: 'user', content: 'Alice moved to Lyon' }),
					...call('skills_propose', PROPOSAL),
					...call('search_mail', { q: 'budget' })
				],
				hold: held
			};
		};
		// The room of the assistant I create again while the turn waits
		let next = '';
		try {
			const sent = await r.client.sendText(room, words);
			await asked;
			// The eyes the harness put on my words as it queued my turn reach the room first: sent
			// while the assistant leaves the room, the homeserver may place them after the leave
			expect(await r.client.waitForReactions(room, sent, r.assistantId, 1)).toEqual(['👀']);
			expect((await r.h.api.delete(ALICE, '/v1/assistants/me')).status).toBe(204);
			expect((await r.h.api.post(ALICE, '/v1/assistants', { name: 'Iris' })).status).toBe(201);
			next = await meetNewAssistant('Iris', [room]);
		} finally {
			release();
		}
		await until('the turn ended', () =>
			since().some((line) => line['msg'] === 'turn did not succeed' && line['roomId'] === room)
		);
		expect(await myRoutes()).toEqual(NOTHING);
		// What it would have answered as the assistant I deleted goes nowhere
		await until('its answer was dropped', () =>
			since().some(
				(line) =>
					line['msg'] === 'send dropped: no assistant for this room' && line['roomId'] === room
			)
		);
		r.h.apisix.llm.script = literal;
		// Nor does anything else reach the room it left or its new room, where it only greeted me
		await new Promise((resolve) => setTimeout(resolve, 3000));
		const timeline = await r.h.synapse.request(
			r.alice,
			'GET',
			`/_matrix/client/v3/rooms/${encodeURIComponent(room)}/messages?dir=b&limit=100`
		);
		const newestFirst = timeline.body['chunk'] as TimelineEvent[];
		const left = newestFirst.findIndex(
			(event) =>
				event.type === 'm.room.member' &&
				event.state_key === r.assistantId &&
				event.content['membership'] === 'leave'
		);
		expect(left).toBeGreaterThanOrEqual(0);
		expect(newestFirst.slice(0, left).filter((event) => event.sender === r.assistantId)).toEqual(
			[]
		);
		expect(
			r.client.messages.filter((m) => m.roomId === next && m.sender === r.assistantId)
		).toHaveLength(1);
	});

	it("erases my jobs that failed for good, and keeps Carol's", async () => {
		const room = (await r.h.api.get<CreatedAssistant>(ALICE, '/v1/assistants/me')).body.roomId;
		const carol = await r.h.synapse.registerUser('carol');
		// The homeserver refuses what my assistant and Carol's send
		const failing = new Set([r.assistantId, CAROLS_ASSISTANT]);
		r.h.apisix.matrixFault = (c) =>
			c.method === 'PUT' &&
			/\/rooms\/[^/]+\/send\/m\.room\./.test(c.path) &&
			failing.has(new URL(c.path, 'http://synapse').searchParams.get('user_id') ?? '')
				? 500
				: null;
		try {
			await r.client.sendText(room, 'Can you hear me?');
			const carols = await r.h.api.post<CreatedAssistant>(CAROL, '/v1/assistants', {
				name: 'Friday'
			});
			expect(carols.status).toBe(201);
			await r.h.synapse.joinRoom(carol, carols.body.roomId);
			await until('both sends failed for good', async () => (await failedSends()).length === 2);
		} finally {
			r.h.apisix.matrixFault = null;
		}
		expect((await failedSends()).sort()).toEqual([CAROLS_ASSISTANT, r.assistantId].sort());
		expect((await r.h.api.delete(ALICE, '/v1/assistants/me')).status).toBe(204);
		expect(await failedSends()).toEqual([CAROLS_ASSISTANT]);
	});

	it('asks me again, in its new room, about an identity of mine it does not know, and keeps the one it holds', async () => {
		expect((await r.h.api.post(ALICE, '/v1/assistants', { name: 'Iris' })).status).toBe(201);
		const room = await meetNewAssistant('Iris', []);
		// My words from this session, which my new identity signed, raise the question
		const after = await r.client.resetIdentity();
		await ask(room, 'Hello after my reset', (t) => t === IDENTITY_QUESTION);
		// The creator may tell me first that my identity changed
		await answerTo('/delete', (t) => t.includes('Delete Iris?'));
		expect(await answerTo('yes', (t) => t.startsWith('Your assistant is deleted'))).toBe(
			'Your assistant is deleted. Send /newbot when you want a new one.'
		);
		// The identity it holds stays, and so does the one it saw last, before my next words show it
		// again
		expect((await r.h.api.get(ALICE, '/v1/assistants/me/owner-identity')).body).toMatchObject({
			pinned,
			published: { master_key: after }
		});
		await answerTo('/newbot', (t) => t === 'Which name do you want for your assistant?');
		expect(await answerTo('Iris', (t) => t.startsWith('Done.'))).toContain(
			`Done. Your assistant Iris is ${r.assistantId}`
		);
		const next = await meetNewAssistant('Iris', [room]);
		await ask(next, 'Hello again after my reset', (t) => t === IDENTITY_QUESTION);
	});

	it("erases the suggestions it made me and those it was still to make, forgets the conversations it read for me, and keeps the channels I took out of them, and Carol's", async () => {
		// A suggestion still to make, with the messages of a channel it quotes
		const toMake = (owner: string) => ({
			kind: 'suggest' as const,
			payload: {
				owner,
				roomId: '!channel:test.local',
				eventId: `$lunch-${owner}`,
				at: Date.now(),
				quoted: [{ author: '@bob:test.local', email: 'bob@test.local', text: 'Lunch on Friday?' }]
			},
			groupKey: suggestGroup(owner)
		});
		// No worker takes them while the test looks at them
		await r.h.stopTurnWorkers();
		try {
			// A suggestion made from the channel: its call, which waits for my answer, and the
			// suggestion that names it; and the channels I took out of them, for good or a while
			await withPrincipal(r.h.db, { id: ALICE }, async (tx) => {
				const id = await insertPendingCall(tx, {
					owner: ALICE,
					tool: 'create_meeting',
					contract: 'calendar',
					domain: 'calendar',
					level: 'write',
					reasons: ['event_turn', 'high_risk'],
					arguments: { body: { title: 'Lunch', start: '2026-10-09T10:00:00Z' } },
					previewDigest: null,
					correlationId: null,
					origin: 'suggestion',
					sessionId: null,
					request: 'Create the meeting?'
				});
				await recordSuggestion(tx, ALICE, {
					pendingCallId: id,
					roomId: '!channel:test.local',
					startsAt: new Date('2026-10-09T10:00:00Z'),
					endsAt: new Date('2026-10-09T11:00:00Z'),
					attempt: 0
				});
				await writeSettings(tx, ALICE, { enabled: true, mutedRooms: ['!quiet:test.local'] });
				await muteRoomFor(tx, ALICE, '!noisy:test.local', DAY_MS);
			});
			// An encrypted conversation of mine it read for me, and one Carol's assistant reads for her
			await r.h.db.sql`
				insert into assistant_listened_rooms (room_id, owner, user_id) values
					('!pair:test.local', ${ALICE}, ${r.assistantId}),
					('!pair-carol:test.local', ${CAROL}, '@bot_carol:test.local')`;
			expect(await enqueueJob(r.h.db, toMake(ALICE))).toBe(true);
			expect(await enqueueJob(r.h.db, toMake(CAROL))).toBe(true);
			expect((await r.h.api.delete(ALICE, '/v1/assistants/me')).status).toBe(204);
			const listened = await r.h.db.sql<{ owner: string }[]>`
				select owner from assistant_listened_rooms`;
			expect(listened.map((row) => row.owner)).toEqual([CAROL]);
			expect(
				await withPrincipal(r.h.db, { id: ALICE }, async (tx) => ({
					suggestions: await tx.sql`select 1 from suggestions`,
					calls: await tx.sql`select 1 from pending_calls`
				}))
			).toEqual({ suggestions: [], calls: [] });
			const owners = await r.h.db.sql<{ owner: string }[]>`
				select (payload #>> '{}')::jsonb ->> 'owner' as owner from jobs where kind = 'suggest'`;
			expect(owners.map((row) => row.owner)).toEqual([CAROL]);
			expect((await r.h.api.get(ALICE, '/v1/suggestions/settings')).body).toEqual({
				enabled: true,
				mutedRooms: ['!noisy:test.local', '!quiet:test.local']
			});
		} finally {
			await r.h.db.sql`delete from jobs where kind = 'suggest'`;
			await r.h.db.sql`delete from assistant_listened_rooms`;
			r.h.startTurnWorkers();
		}
	});
});

describe('deleting my assistant once my day is spent', () => {
	// The present as the harness reads it: the day stays the same until a test moves it
	const clock = makeSettableClock('2026-10-08T09:00:00Z');
	let activity: ActivityExchange;
	let r: ConsentRoom;
	// The room of the assistant I created after deleting Jarvis
	let second: string;

	beforeAll(async () => {
		activity = await startActivityExchange();
		// A day of one turn
		r = await startConsentRoom(
			{ ...activity.settings, ADMISSION_USER_DAILY_TOKENS: '1' },
			{ clock }
		);
		await activity.listen(r.h);
		r.h.apisix.llm.script = literal;
	}, 240_000);
	afterAll(async () => {
		if (activity !== undefined) await activity.close();
		if (r !== undefined) await r.close();
	});

	// Gives me a new assistant through the API, whose room I join
	async function newAssistant(): Promise<string> {
		const created = await r.h.api.post<CreatedAssistant>(ALICE, '/v1/assistants', {
			name: 'Iris'
		});
		expect(created.status).toBe(201);
		const room = created.body.roomId;
		await r.client.joinRoom(room);
		await r.client.waitForMessage(room, r.assistantId, (t) => t.includes('Iris'));
		return room;
	}

	// The turns I started this minute, as admission counts them: past my turns per minute, ten by
	// default, my turns are refused until the minute passes, or until I started none
	async function rush(turns: number): Promise<void> {
		await withPrincipal(r.h.db, { id: ALICE }, async (tx) => {
			await tx.sql`delete from usage_window where owner = ${ALICE}`;
			if (turns === 0) return;
			await tx.sql`
				insert into usage_window (owner, at, turns)
				values (${ALICE}, date_trunc('second', now()), ${turns})`;
		});
	}

	// The lines by which the turn workers deferred the turn of an event, so far
	function deferrals(event: ActivityEvent): Record<string, unknown>[] {
		return r.h
			.logLines()
			.filter((line) => line['msg'] === 'event turn deferred' && line['reqId'] === event.id);
	}

	// What my assistant answers me next in a room, whatever it says
	async function answerIn(room: string, text: string): Promise<string> {
		const said = (): DecryptedMessage[] =>
			r.client.messages.filter((m) => m.roomId === room && m.sender === r.assistantId);
		const seen = said().length;
		await r.client.sendText(room, text);
		await until(`my assistant answered « ${text} »`, () => said().length > seen);
		return said()[seen]?.body ?? '';
	}

	it('keeps my day spent for the assistant I create again', async () => {
		await r.client.sendText(r.room, 'Hello');
		await r.client.waitForMessage(r.room, r.assistantId, (t) => t === 'Heard: Hello');
		expect((await r.h.api.delete(ALICE, '/v1/assistants/me')).status).toBe(204);
		second = await newAssistant();
		await r.client.sendText(second, 'Hello again');
		await r.client.waitForMessage(second, r.assistantId, (t) => t.startsWith(DAY_SPENT));
	});

	it('never runs the turn of an event deferred before I deleted my assistant, even once the next one is back in the room the event was for', async () => {
		// My minute is spent: the turn of this assignment waits for the next one. My day is spent
		// too, which alone would keep the activity for my brief rather than wait.
		await rush(10);
		const deferred = activityEvent({ id: 'erasure-deferred', recipient: ALICE });
		await activity.publish(deferred);
		await until('the turn of the event was deferred', () => deferrals(deferred).length > 0);
		// The turn workers stop while I delete my assistant and bring the next one back into the room
		// the event was for, so that no retry of the turn finds it gone meanwhile
		await r.h.stopTurnWorkers();
		expect((await r.h.api.delete(ALICE, '/v1/assistants/me')).status).toBe(204);
		await newAssistant();
		const invited = await r.h.synapse.request(
			r.alice,
			'POST',
			`/_matrix/client/v3/rooms/${encodeURIComponent(second)}/invite`,
			{ user_id: r.assistantId }
		);
		expect(invited.status).toBe(200);
		await until('the assistant is back in the room', () =>
			r.h
				.logLines()
				.some(
					(line) =>
						line['msg'] === 'assistant room opened by its owner' && line['roomId'] === second
				)
		);
		// Due again once its last delay passed: the turn workers, back, would queue it ahead of my words
		const last = deferrals(deferred).at(-1);
		const due = Number(last?.['time']) + Number(last?.['retryInMs']) + 1000;
		await until('the turn of the event is due again', () => Date.now() > due);
		// The next day, my minute past: the turn of the event would now be admitted, and spend the day
		// before my words
		clock.set('2026-10-09T09:00:00Z');
		await rush(0);
		r.h.startTurnWorkers();
		expect(await answerIn(second, 'Still there?')).toBe('Heard: Still there?');
		expect(turnCalls(r.h.apisix.llm.calls, deferred.id)).toHaveLength(0);
		expect(r.client.messages.some((m) => m.body === `Told of ${deferred.id}`)).toBe(false);
	}, 180_000);
});
