import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { runBriefPass } from '../src/briefs/schedule.js';
import { withPrincipal } from '../src/db/client.js';
import { lastUser, until } from './helpers/activity.js';
import {
	BRIEF_CATALOG,
	LIST_EMAILS,
	LIST_EVENTS,
	LIST_MAILBOXES,
	LIST_TASKS,
	MAILBOXES
} from './helpers/brief.js';
import { makeSettableClock } from './helpers/clock.js';
import {
	call,
	QUESTION_CONTENT_KEY,
	startConsentRoom,
	type ConsentRoom
} from './helpers/consent-room.js';
import { allowBriefReads } from './helpers/consents.js';
import type { DecryptedMessage } from './helpers/e2ee-client.js';
import type { ChatRequest, ScriptedReply } from './helpers/fake-apisix.js';
import type { MatrixUser } from './helpers/synapse.js';

const ALICE = 'alice@test.local';
const BRIEF_SETTINGS = 'brief_settings';
// Where the content of a brief tells Alice's client that it is one, and of which day
const BRIEF_CONTENT_KEY = 'app.twake.assistant.brief';
// What the model writes as the brief
const WRITTEN = 'Ce matin : rien de prévu, ta journée est libre.';
// What her assistant says once she was not seen in her room for ten working days
const IDLE =
	"Tu n'as rien lu ni écrit ici depuis 10 jours ouvrés : je mets ton brief en pause. Pour le reprendre, dis-moi « reprends le brief ».";

// A literal model: it writes the brief, resumes it when Alice asks, tells what a call gave back,
// and repeats anything else it hears
function model(request: ChatRequest): ScriptedReply {
	const told = lastUser(request);
	if (told.startsWith('[brief]')) return { content: WRITTEN };
	const last = request.messages.at(-1);
	if (last?.role === 'tool') return { content: `Tool: ${last.content ?? ''}` };
	if (told === 'Reprends le brief') {
		return { toolCalls: call(BRIEF_SETTINGS, { action: 'resume' }) };
	}
	return { content: `Heard: ${told}` };
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('my brief pauses once I have neither written nor read in my room for ten working days', () => {
	let r: ConsentRoom;
	// Monday 2 November 2026 at eight in Paris, in winter time
	const clock = makeSettableClock('2026-11-02T07:00:00Z');

	// Everything Alice's client received from her assistant in her room, oldest first
	const said = (): DecryptedMessage[] =>
		r.client.messages.filter((m) => m.roomId === r.room && m.sender === r.assistantId);

	async function nextSaid(seen: number): Promise<DecryptedMessage> {
		await until('a new message of her assistant', () => said().length > seen);
		const message = said()[seen];
		if (message === undefined) throw new Error('no message');
		return message;
	}

	// The model calls of the briefs, by what they tell the model
	const briefCalls = (): ChatRequest[] =>
		r.h.apisix.llm.calls
			.map((call) => call.request)
			.filter((request) => lastUser(request).startsWith('[brief]'));

	// The worker role's pass, as it runs every minute, at the time the clock says
	async function pass(at: string): Promise<void> {
		clock.set(at);
		const app = r.h.apps[0];
		if (app === undefined) throw new Error('no api role');
		await runBriefPass({ config: r.h.config, db: r.h.db, log: app.log, clock });
	}

	// When the harness last saw Alice in her room, as it keeps it
	async function lastSeen(): Promise<string | null> {
		const rows = await withPrincipal(
			r.h.db,
			{ id: ALICE },
			(tx) =>
				tx.sql<{ owner_seen_at: Date | null }[]>`
				select owner_seen_at from owner_settings where owner = ${ALICE}`
		);
		return rows[0]?.owner_seen_at?.toISOString() ?? null;
	}

	async function seenAt(at: string): Promise<void> {
		await withPrincipal(
			r.h.db,
			{ id: ALICE },
			(tx) => tx.sql`update owner_settings set owner_seen_at = ${at} where owner = ${ALICE}`
		);
	}

	// Whether her brief is stopped, until she resumes it
	async function stopped(): Promise<boolean> {
		const rows = await withPrincipal(
			r.h.db,
			{ id: ALICE },
			(tx) =>
				tx.sql<{ brief_stopped: boolean }[]>`
				select brief_stopped from owner_settings where owner = ${ALICE}`
		);
		return rows[0]?.brief_stopped ?? false;
	}

	// A read receipt on an event of a room, as a client sends it, public or private
	async function receipt(
		user: MatrixUser,
		roomId: string,
		eventId: string,
		type: 'm.read' | 'm.read.private',
		query = ''
	): Promise<void> {
		const path = `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/receipt/${type}/${encodeURIComponent(eventId)}${query}`;
		const sent = await r.h.synapse.request(user, 'POST', path, {});
		expect(sent.status).toBe(200);
	}

	// The last message of her assistant in her room, which her client shows her
	function lastSaid(): DecryptedMessage {
		const message = said().at(-1);
		if (message === undefined) throw new Error('no message');
		return message;
	}

	beforeAll(async () => {
		r = await startConsentRoom(
			{
				ASSISTANT_LOCALE: 'fr',
				ASSISTANT_TIMEZONE: 'Europe/Paris',
				BRIEF_ENABLED: 'true',
				ADMISSION_USER_PER_MINUTE: '120'
			},
			{ clock }
		);
		r.h.apisix.contracts.spec = BRIEF_CATALOG;
		for (const app of r.h.apps) expect(await app.agent.contracts.load()).toBeGreaterThan(0);
		// Her brief reads her calendar, her mail and her tasks: a free day, no invitation, an empty
		// inbox and no task
		await allowBriefReads(r.h.db, ALICE);
		r.h.apisix.contracts.handler = (call) => {
			if (call.path === LIST_MAILBOXES) return { status: 200, body: MAILBOXES };
			if (call.path === LIST_EMAILS)
				return { status: 200, body: { emails: [], next_cursor: null } };
			if (call.path === LIST_TASKS) return { status: 200, body: { tasks: [], truncated: false } };
			if (call.path === LIST_EVENTS) {
				return { status: 200, body: { time_zone: 'Europe/Paris', events: [], truncated: false } };
			}
			return { status: 404, body: {} };
		};
		r.h.apisix.llm.script = model;
	}, 240_000);

	// Her brief neither stopped nor paused
	beforeEach(async () => {
		await withPrincipal(
			r.h.db,
			{ id: ALICE },
			(tx) => tx.sql`
				insert into owner_settings (owner, brief_stopped) values (${ALICE}, false)
				on conflict (owner) do update set brief_stopped = false, brief_paused_until = null`
		);
	});

	afterAll(async () => {
		if (r !== undefined) await r.close();
	});

	it('pauses my brief after ten working days without a word or a receipt of mine, says so, sends none after, and resumes it when I ask', async () => {
		// Last seen on Monday 2 November, at eleven
		await seenAt('2026-11-02T10:00:00Z');
		const seen = said().length;
		const calls = briefCalls().length;
		// Monday 16 November at eight: nine working days went by, the brief goes out
		await pass('2026-11-16T07:00:00Z');
		const brief = await nextSaid(seen);
		expect(brief.body).toBe(WRITTEN);
		expect(brief.content[BRIEF_CONTENT_KEY]).toEqual({ date: '2026-11-16' });
		// Tuesday: ten working days went by, the brief stops and says so, with no model call
		await pass('2026-11-17T07:00:00Z');
		const notice = await nextSaid(seen + 1);
		expect(notice.body).toBe(IDLE);
		expect(notice.content[BRIEF_CONTENT_KEY]).toBeUndefined();
		expect(notice.content[QUESTION_CONTENT_KEY]).toBeUndefined();
		expect(briefCalls().slice(calls)).toHaveLength(1);
		expect(await stopped()).toBe(true);
		// Wednesday: nothing
		await pass('2026-11-18T07:00:00Z');
		await sleep(1000);
		expect(said()).toHaveLength(seen + 2);
		// At ten, she resumes it, and Thursday's brief goes out
		clock.set('2026-11-18T09:00:00Z');
		await r.client.sendText(r.room, 'Reprends le brief');
		const resumed = await nextSaid(seen + 2);
		expect(resumed.body).toMatch(/^Tool: /);
		expect(await stopped()).toBe(false);
		await pass('2026-11-19T07:00:00Z');
		const next = await nextSaid(seen + 3);
		expect(next.body).toBe(WRITTEN);
		expect(next.content[BRIEF_CONTENT_KEY]).toEqual({ date: '2026-11-19' });
	}, 120_000);

	it('puts the pause off by a public receipt of mine in my room, as by a message', async () => {
		const seen = said().length;
		// Last seen on Monday 9 November: the brief would stop on Tuesday 24. She reads her room on
		// Monday 23 at one, publicly.
		await seenAt('2026-11-09T10:00:00Z');
		clock.set('2026-11-23T12:00:00Z');
		await receipt(r.alice, r.room, lastSaid().eventId, 'm.read');
		await until('her public receipt counted', async () => {
			return (await lastSeen()) === '2026-11-23T12:00:00.000Z';
		});
		await pass('2026-11-24T07:00:00Z');
		const tuesday = await nextSaid(seen);
		expect(tuesday.content[BRIEF_CONTENT_KEY]).toEqual({ date: '2026-11-24' });
		// Last seen on Tuesday 10 November: the brief would stop on Wednesday 25. She writes on
		// Tuesday 24.
		await seenAt('2026-11-10T10:00:00Z');
		clock.set('2026-11-24T12:00:00Z');
		await r.client.sendText(r.room, 'Bonjour');
		expect((await nextSaid(seen + 1)).body).toBe('Heard: Bonjour');
		expect(await lastSeen()).toBe('2026-11-24T12:00:00.000Z');
		await pass('2026-11-25T07:00:00Z');
		const wednesday = await nextSaid(seen + 2);
		expect(wednesday.content[BRIEF_CONTENT_KEY]).toEqual({ date: '2026-11-25' });
	}, 120_000);

	it('counts neither a private receipt of mine nor the receipts of anyone else in my room, nor my words and receipts in another room', async () => {
		const seen = said().length;
		// Last seen on Wednesday 11 November: the brief stops on Thursday 26
		await seenAt('2026-11-11T10:00:00Z');
		clock.set('2026-11-25T12:00:00Z');
		// Her private receipt in her room, hers alone, which a Synapse before 1.162 still pushes
		await receipt(r.alice, r.room, lastSaid().eventId, 'm.read.private');
		// Her assistant's own receipt in her room
		const assistant: MatrixUser = { userId: r.assistantId, accessToken: r.h.config.matrix.asToken };
		await receipt(
			assistant,
			r.room,
			lastSaid().eventId,
			'm.read',
			`?user_id=${encodeURIComponent(r.assistantId)}`
		);
		// Her words, and her receipt, in another room she opened with her assistant
		const other = await r.client.createDirectRoom(r.assistantId);
		await r.h.synapse.waitForMember(r.alice, other, r.assistantId);
		await r.client.sendText(other, 'Bonjour');
		await r.client.waitForMessage(other, r.assistantId, (t) => t === 'Heard: Bonjour');
		const answer = r.client.messages.find((m) => m.roomId === other && m.sender === r.assistantId);
		if (answer === undefined) throw new Error('no answer');
		await receipt(r.alice, other, answer.eventId, 'm.read');
		await sleep(2000);
		expect(await lastSeen()).toBe('2026-11-11T10:00:00.000Z');
		await pass('2026-11-26T07:00:00Z');
		expect((await nextSaid(seen)).body).toBe(IDLE);
		expect(await stopped()).toBe(true);
	}, 120_000);
});
