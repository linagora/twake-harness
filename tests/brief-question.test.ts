import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { runBriefPass } from '../src/briefs/schedule.js';
import { withPrincipal } from '../src/db/client.js';
import { lastUser, until } from './helpers/activity.js';
import {
	BRIEF_CATALOG,
	dataOf,
	LIST_EMAILS,
	LIST_EVENTS,
	LIST_MAILBOXES,
	LIST_TASKS,
	MAILBOXES,
	seenEveryDay
} from './helpers/brief.js';
import { makeSettableClock } from './helpers/clock.js';
import {
	QUESTION_CONTENT_KEY,
	startConsentRoom,
	type ConsentRoom
} from './helpers/consent-room.js';
import { grantConsent, withdrawConsent } from './helpers/consents.js';
import type { DecryptedMessage } from './helpers/e2ee-client.js';
import type { ChatRequest } from './helpers/fake-apisix.js';

const ALICE = 'alice@test.local';
// Where the content of a brief tells Alice's client that it is one, and of which day
const BRIEF_CONTENT_KEY = 'app.twake.assistant.brief';
// What the model writes as the brief
const WRITTEN = 'Ce matin : rien de prévu, ta journée est libre.';
// The applications her brief reads
const DOMAINS = ['calendar', 'mail', 'tasks'];

// Her first brief presents itself, when it goes out and how to set it, then asks for the reads it
// lacks, in her language
function asking(reads: string, when = 'du lundi au vendredi à 08:00'): string {
	return [
		`Je t'enverrai un brief de ta journée : tes réunions, tes invitations en attente, tes mails importants et tes tâches. Il part ${when} ; pour le régler, dis-moi par exemple « brief à 7:30 » ou « pas de brief le mercredi ».`,
		`Pour l'écrire, puis-je lire ${reads} ? Réponds par oui ou non dans ton prochain message. Tu pourras retirer chaque lecture à part.`
	].join('\n');
}
const ALL_THREE = asking('ton agenda, tes mails et tes tâches');
// What her assistant says once she said no, and once she did not answer twice
const REFUSED =
	"D'accord, je n'enverrai pas de brief. Pour le reprendre, dis-moi « reprends le brief ».";
const PAUSED =
	"Tu n'as pas répondu : je mets ton brief en pause. Pour le reprendre, dis-moi « reprends le brief ».";
// What the brief after she took back the read of her mail says of it
const NO_MORE_MAIL =
	'Je ne lis plus tes mails : pour que je les lise de nouveau, dis-moi « lis mes mails ».';

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('my first brief asks me, in one question, to read my calendar, my mail and my tasks', () => {
	let r: ConsentRoom;
	const clock = makeSettableClock('2026-10-12T06:00:00Z');

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

	// The applications she allowed her assistant to read, as she reads them through the API
	async function allowed(): Promise<string[]> {
		const listed = await r.h.api.get<{ consents: { domain: string; level: string }[] }>(
			ALICE,
			'/v1/consents'
		);
		expect(listed.status).toBe(200);
		return listed.body.consents.filter((c) => c.level === 'read').map((c) => c.domain);
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
		// A free day, no invitation, an empty inbox and no task
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
	}, 240_000);

	// Each case is a first brief again: none of her reads allowed, her brief neither stopped nor
	// paused, no question of it waiting, and nothing said yet of a read taken back
	beforeEach(async () => {
		await seenEveryDay(r.h.db, ALICE);
		for (const domain of DOMAINS) await withdrawConsent(r.h.db, ALICE, domain, 'read');
		await withPrincipal(r.h.db, { id: ALICE }, async (tx) => {
			await tx.sql`delete from brief_questions where owner = ${ALICE}`;
			await tx.sql`update pending_calls set status = 'expired' where owner = ${ALICE}
				and status = 'open'`;
			await tx.sql`update owner_settings set brief_reads_settled = false, brief_reads_told = '{}',
				brief_stopped = false, brief_paused_until = null, brief_time = null, brief_days = null
				where owner = ${ALICE}`;
		});
		r.h.apisix.llm.script = (request) =>
			lastUser(request).startsWith('[brief]')
				? { content: WRITTEN }
				: { content: `echo: ${lastUser(request)}` };
	});

	afterAll(async () => {
		if (r !== undefined) await r.close();
	});

	it('presents my brief on its first morning and asks me, in one marked question, to read my calendar, my mail and my tasks, then sends it at once when I say yes', async () => {
		const seen = said().length;
		const calls = briefCalls().length;
		const reads = r.h.apisix.contracts.calls.length;
		// Monday 12 October at eight in Paris
		await pass('2026-10-12T06:00:00Z');
		const question = await nextSaid(seen);
		expect(question.body).toBe(ALL_THREE);
		// A request that waits a day for her answer, marked as any of the harness's questions, and no
		// brief: nothing was read, nor written
		await r.requestAskedIn(question.eventId, 'brief');
		expect(question.content[BRIEF_CONTENT_KEY]).toBeUndefined();
		expect(r.h.apisix.contracts.calls.slice(reads)).toHaveLength(0);
		expect(briefCalls().slice(calls)).toHaveLength(0);
		// She says yes at half past nine: one read for each application, and that day's brief
		clock.set('2026-10-12T07:30:00Z');
		await r.client.sendText(r.room, 'oui');
		const brief = await nextSaid(seen + 1);
		expect(brief.body).toBe(WRITTEN);
		expect(brief.content[BRIEF_CONTENT_KEY]).toEqual({ date: '2026-10-12' });
		expect(brief.content[QUESTION_CONTENT_KEY]).toBeUndefined();
		expect((await allowed()).sort()).toEqual(DOMAINS);
		expect(dataOf(lastUser(briefCalls().slice(calls).at(0)))).toMatchObject({
			date: '2026-10-12',
			mails: { unread: [] }
		});
		// Her yes started no turn of its own: the brief is all her assistant said
		await sleep(1000);
		expect(said().slice(seen)).toEqual([question, brief]);
		// She takes back one of them, which leaves the others
		expect((await r.h.api.delete(ALICE, '/v1/consents/mail/read')).status).toBe(204);
		expect((await allowed()).sort()).toEqual(['calendar', 'tasks']);
	});

	it('asks only for the reads I have not given, and nothing once I gave all three', async () => {
		const seen = said().length;
		await grantConsent(r.h.db, ALICE, 'calendar', 'read');
		// Tuesday at eight
		await pass('2026-10-13T06:00:00Z');
		const question = await nextSaid(seen);
		expect(question.body).toBe(asking('tes mails et tes tâches'));
		await r.requestAskedIn(question.eventId, 'brief');
		// She allows the other two elsewhere: Wednesday's brief asks nothing, and the question closed
		await grantConsent(r.h.db, ALICE, 'mail', 'read');
		await grantConsent(r.h.db, ALICE, 'tasks', 'read');
		await pass('2026-10-14T06:00:00Z');
		const brief = await nextSaid(seen + 1);
		expect(brief.body).toBe(WRITTEN);
		expect(brief.content[BRIEF_CONTENT_KEY]).toEqual({ date: '2026-10-14' });
		expect(brief.content[QUESTION_CONTENT_KEY]).toBeUndefined();
		expect((await r.callsTo('brief')).at(-1)?.status).toBe('expired');
	});

	it('stops my brief when I say no, and tells me how to resume it', async () => {
		const seen = said().length;
		// Thursday at eight
		await pass('2026-10-15T06:00:00Z');
		const question = await nextSaid(seen);
		expect(question.body).toBe(ALL_THREE);
		await r.requestAskedIn(question.eventId, 'brief');
		await r.client.sendText(r.room, 'non');
		const notice = await nextSaid(seen + 1);
		expect(notice.body).toBe(REFUSED);
		expect(notice.content[QUESTION_CONTENT_KEY]).toBeUndefined();
		expect(await allowed()).toEqual([]);
		expect(await stopped()).toBe(true);
		// Friday at eight, nothing
		await pass('2026-10-16T06:00:00Z');
		await sleep(1000);
		expect(said().slice(seen)).toEqual([question, notice]);
	});

	it('asks me once more on my next brief day when I do not answer, then pauses my brief and says so', async () => {
		const seen = said().length;
		// Monday 19 October at eight, then Tuesday, unanswered
		await pass('2026-10-19T06:00:00Z');
		const first = await nextSaid(seen);
		expect(first.body).toBe(ALL_THREE);
		await pass('2026-10-20T06:00:00Z');
		const again = await nextSaid(seen + 1);
		expect(again.body).toBe(ALL_THREE);
		await r.requestAskedIn(again.eventId, 'brief');
		// Wednesday: her brief pauses, and says so, asking nothing
		await pass('2026-10-21T06:00:00Z');
		const paused = await nextSaid(seen + 2);
		expect(paused.body).toBe(PAUSED);
		expect(paused.content[QUESTION_CONTENT_KEY]).toBeUndefined();
		expect(paused.content[BRIEF_CONTENT_KEY]).toBeUndefined();
		expect(await stopped()).toBe(true);
		// The second question superseded the first, and closed with the pause: a yes now runs nothing
		expect((await r.callsTo('brief')).slice(-2).map((call) => call.status)).toEqual([
			'superseded',
			'expired'
		]);
		// Thursday at eight, nothing
		await pass('2026-10-22T06:00:00Z');
		await sleep(1000);
		expect(said().slice(seen)).toEqual([first, again, paused]);
		expect(await allowed()).toEqual([]);
	});

	it('says once, on the brief after I took back a read, that it no longer reads it and how to give it back, then nothing', async () => {
		for (const domain of DOMAINS) await grantConsent(r.h.db, ALICE, domain, 'read');
		const seen = said().length;
		const calls = briefCalls().length;
		// Friday 23 October at eight: her brief, all three read
		await pass('2026-10-23T06:00:00Z');
		expect((await nextSaid(seen)).body).toBe(WRITTEN);
		// She takes back her mail: Monday's brief, in winter time, says so once, after the model's
		await withdrawConsent(r.h.db, ALICE, 'mail', 'read');
		await pass('2026-10-26T07:00:00Z');
		const monday = await nextSaid(seen + 1);
		expect(monday.body).toBe(`${WRITTEN}\n\n${NO_MORE_MAIL}`);
		expect(monday.content[BRIEF_CONTENT_KEY]).toEqual({ date: '2026-10-26' });
		expect(String(monday.content['formatted_body'])).toContain(`<p>${NO_MORE_MAIL}</p>`);
		// The model is handed nothing of her mail, not even that it was not read
		const told = dataOf(lastUser(briefCalls().slice(calls).at(1)));
		expect(told).not.toHaveProperty('mails');
		expect(told).not.toHaveProperty('not_read');
		// Tuesday: nothing of it
		await pass('2026-10-27T07:00:00Z');
		expect((await nextSaid(seen + 2)).body).toBe(WRITTEN);
		// Given back on Wednesday, then taken back again: Thursday says so once more
		await grantConsent(r.h.db, ALICE, 'mail', 'read');
		await pass('2026-10-28T07:00:00Z');
		expect((await nextSaid(seen + 3)).body).toBe(WRITTEN);
		await withdrawConsent(r.h.db, ALICE, 'mail', 'read');
		await pass('2026-10-29T07:00:00Z');
		expect((await nextSaid(seen + 4)).body).toBe(`${WRITTEN}\n\n${NO_MORE_MAIL}`);
		await sleep(1000);
		expect(said().slice(seen)).toHaveLength(5);
	});

	it('stops my brief as well when I refuse it through the API, and presents it with the days and time I chose', async () => {
		const seen = said().length;
		await withPrincipal(r.h.db, { id: ALICE }, async (tx) => {
			await tx.sql`update owner_settings set brief_time = 450,
				brief_days = array['monday', 'wednesday', 'friday'] where owner = ${ALICE}`;
		});
		// Friday 30 October at half past seven, in winter time
		await pass('2026-10-30T06:30:00Z');
		const question = await nextSaid(seen);
		expect(question.body).toBe(
			asking('ton agenda, tes mails et tes tâches', 'le lundi, le mercredi et le vendredi à 07:30')
		);
		const request = await r.requestAskedIn(question.eventId, 'brief');
		const refused = await r.h.api.post(ALICE, `/v1/pending-calls/${request.id}/refuse`, {});
		expect(refused.status).toBe(200);
		const notice = await nextSaid(seen + 1);
		expect(notice.body).toBe(REFUSED);
		expect(await stopped()).toBe(true);
	});
});
