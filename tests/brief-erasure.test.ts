import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { findTimeZone } from '../src/agent/clock.js';
import { runBriefPass } from '../src/briefs/schedule.js';
import { withPrincipal } from '../src/db/client.js';
import { saveOwnerTimeZone } from '../src/settings/repository.js';
import { lastUser, until } from './helpers/activity.js';
import {
	BRIEF_CATALOG,
	LIST_EMAILS,
	LIST_EVENTS,
	LIST_MAILBOXES,
	LIST_TASKS,
	MAILBOXES,
	seenEveryDay
} from './helpers/brief.js';
import { makeSettableClock } from './helpers/clock.js';
import { startConsentRoom, type ConsentRoom } from './helpers/consent-room.js';
import { allowBriefReads } from './helpers/consents.js';
import type { DecryptedMessage } from './helpers/e2ee-client.js';
import type { ChatRequest, ScriptedReply } from './helpers/fake-apisix.js';

const ALICE = 'alice@test.local';
// Where the content of a brief tells Alice's client that it is one, and of which day
const BRIEF_CONTENT_KEY = 'app.twake.assistant.brief';
// The zone a read of her calendar returned, which the assistant she creates next does not follow
const ZONE = 'Asia/Tokyo';
// How the question of a first brief tells its days and its time when she kept the defaults
const BY_DEFAULT =
	'I will send you a brief of your day: your meetings, your invitations awaiting your answer, your important emails and your tasks. It goes out Monday to Friday at 08:00; to change it, tell me for instance "brief at 7:30" or "no brief on Wednesdays".';

// A literal model: it writes the brief, and repeats anything else it hears
function model(request: ChatRequest): ScriptedReply {
	const told = lastUser(request);
	if (told.startsWith('[brief]')) return { content: 'Here is your brief.' };
	return { content: `Heard: ${told}` };
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('deleting my assistant erases what I chose of my brief and the zone of my calendar', () => {
	let r: ConsentRoom;
	let creatorId: string;
	// My conversation with the creator
	let creatorRoom: string;
	// The room of the assistant I have
	let room: string;
	// Monday 2 November 2026 at seven in Paris, in winter time
	const clock = makeSettableClock('2026-11-02T06:00:00Z');

	beforeAll(async () => {
		r = await startConsentRoom(
			{
				ASSISTANT_TIMEZONE: 'Europe/Paris',
				BRIEF_ENABLED: 'true',
				ADMISSION_USER_PER_MINUTE: '120'
			},
			{ clock }
		);
		r.h.apisix.contracts.spec = BRIEF_CATALOG;
		for (const app of r.h.apps) expect(await app.agent.contracts.load()).toBeGreaterThan(0);
		// A day without meetings, no invitation waiting for her answer, an empty inbox and no task
		r.h.apisix.contracts.handler = (call) => {
			if (call.path === LIST_MAILBOXES) return { status: 200, body: MAILBOXES };
			if (call.path === LIST_EMAILS)
				return { status: 200, body: { emails: [], next_cursor: null } };
			if (call.path === LIST_TASKS) return { status: 200, body: { tasks: [], truncated: false } };
			if (call.path !== LIST_EVENTS) return { status: 404, body: {} };
			return { status: 200, body: { time_zone: 'Europe/Paris', events: [], truncated: false } };
		};
		r.h.apisix.llm.script = model;
		room = r.room;
		creatorId = r.h.role.creatorUserId;
		creatorRoom = await r.client.createDirectRoom(creatorId);
		await r.client.waitForMessage(creatorRoom, creatorId, (t) => t.includes('/newbot'));
	}, 240_000);
	afterAll(async () => {
		if (r !== undefined) await r.close();
	});

	// Everything my assistant said in a room, oldest first
	const saidIn = (where: string): DecryptedMessage[] =>
		r.client.messages.filter((m) => m.roomId === where && m.sender === r.assistantId);

	// The worker role's pass, as it runs every minute, at the time the clock says
	async function pass(at: string): Promise<void> {
		clock.set(at);
		const app = r.h.apps[0];
		if (app === undefined) throw new Error('no api role');
		await runBriefPass({ config: r.h.config, db: r.h.db, log: app.log, clock });
	}

	// The first message the creator writes me, once I wrote it a message, that its answer starts with,
	// as it may tell me something else first
	async function answerTo(text: string, answer: string): Promise<void> {
		const fromCreator = (): DecryptedMessage[] =>
			r.client.messages.filter((m) => m.roomId === creatorRoom && m.sender === creatorId);
		const seen = fromCreator().length;
		await r.client.sendText(creatorRoom, text);
		await until(`the creator answered « ${text} »`, () =>
			fromCreator()
				.slice(seen)
				.some((m) => m.body.startsWith(answer))
		);
	}

	// Deletes my assistant through the creator, creates the next one under the name given, and joins
	// the room it opens, where it greets me
	async function createAgain(deleted: string, name: string): Promise<void> {
		await answerTo('/delete', `Delete ${deleted}?`);
		await answerTo('yes', 'Your assistant is deleted.');
		await answerTo('/newbot', 'Which name do you want for your assistant?');
		await answerTo(name, `Done. Your assistant ${name} is ${r.assistantId}`);
		const mine = await r.h.api.get<{ roomId: string }>(ALICE, '/v1/assistants/me');
		expect(mine.body.roomId).not.toBe(room);
		room = mine.body.roomId;
		await r.client.joinRoom(room);
		await r.client.waitForMessage(room, r.assistantId, (t) => t.includes(name));
	}

	it('sends no second brief the day I create my assistant again after its brief', async () => {
		await seenEveryDay(r.h.db, ALICE);
		await allowBriefReads(r.h.db, ALICE);
		// Monday at eight, the brief of Jarvis goes out
		await pass('2026-11-02T07:00:00Z');
		await until('the brief of Monday', () =>
			saidIn(room).some((m) => m.content[BRIEF_CONTENT_KEY] !== undefined)
		);
		// At nine, she deletes Jarvis and creates Iris, whose first brief would ask for its reads
		clock.set('2026-11-02T08:00:00Z');
		await createAgain('Jarvis', 'Iris');
		const greeted = saidIn(room).length;
		// The passes of that morning send Iris's room nothing
		await pass('2026-11-02T08:15:00Z');
		await pass('2026-11-02T09:30:00Z');
		await sleep(1000);
		expect(saidIn(room)).toHaveLength(greeted);
	});

	it("goes out by default for the assistant I create next, on the deployment's wall clock, which its turns state the present on", async () => {
		const zone = findTimeZone(ZONE);
		if (zone === null) throw new Error(`the runtime does not know ${ZONE}`);
		// Iris's brief at nine on Wednesdays, paused until the 20th, then stopped, on the wall clock of
		// Tokyo, as a read of her calendar returned it
		await withPrincipal(r.h.db, { id: ALICE }, async (tx) => {
			await tx.sql`
				insert into owner_settings (owner, brief_time, brief_days, brief_paused_until, brief_stopped)
				values (${ALICE}, 540, '{wednesday}', '2026-11-20', true)
				on conflict (owner) do update set brief_time = excluded.brief_time,
					brief_days = excluded.brief_days, brief_paused_until = excluded.brief_paused_until,
					brief_stopped = excluded.brief_stopped`;
			await saveOwnerTimeZone(tx, ALICE, zone);
		});
		// Monday at ten, she deletes Iris and creates Kim
		clock.set('2026-11-02T09:00:00Z');
		await createAgain('Iris', 'Kim');
		// Kim's turns state the present in the deployment's zone
		const turns = r.h.apisix.llm.calls.length;
		await r.client.sendText(room, 'Hello');
		await r.client.waitForMessage(room, r.assistantId, (t) => t === 'Heard: Hello');
		const prompt =
			r.h.apisix.llm.calls.slice(turns).find((c) => lastUser(c.request) === 'Hello')?.request
				.messages[0]?.content ?? '';
		expect(prompt).toContain('time zone Europe/Paris.');
		expect(prompt).not.toContain(ZONE);
		// Tuesday at eight in Paris, Kim's first brief goes out, asking for its reads, Monday to Friday
		// at eight
		const seen = saidIn(room).length;
		await pass('2026-11-03T07:00:00Z');
		await until('the first brief of Kim', () => saidIn(room).length > seen);
		expect(saidIn(room)[seen]?.body.split('\n')[0]).toBe(BY_DEFAULT);
	});
});
