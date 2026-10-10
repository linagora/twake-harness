import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.js';
import { startTestHarness, type TestHarness } from './helpers/app.js';
import { makeClient } from './helpers/client.js';
import { makeSettableClock } from './helpers/clock.js';
import { modelUsing } from './helpers/consent-room.js';
import { grantConsent } from './helpers/consents.js';
import {
	CALENDAR_CATALOG,
	echoScript,
	type ContractCall,
	type ContractReply
} from './helpers/fake-apisix.js';

// The system prompt of the first model call after the `before` first ones
function systemPromptAfter(h: TestHarness, before: number): string {
	const system = h.apisix.llm.calls[before]?.request.messages[0];
	expect(system?.role).toBe('system');
	return system?.content ?? '';
}

// The system prompt the scripted model received for one chat turn of this user
async function systemPromptOfTurn(h: TestHarness, sub: string, message: string): Promise<string> {
	h.apisix.llm.script = echoScript;
	const before = h.apisix.llm.calls.length;
	expect((await makeClient(h).post(sub, '/v1/chat', { message })).status).toBe(200);
	return systemPromptAfter(h, before);
}

// The calendar of an owner whose settings put it in this zone: both reads of their events answer
// in it, and name it in time_zone
function calendarIn(timeZone: unknown): (call: ContractCall) => ContractReply {
	return (call) => ({
		status: 200,
		body:
			call.path === '/contracts/v1/calendar/events'
				? { time_zone: timeZone, events: [], truncated: false }
				: { time_zone: timeZone, uid: call.query['uid'] }
	});
}

// One chat turn of this user in which the model reads their calendar with one call, then tells
// what it found
async function readCalendar(
	h: TestHarness,
	sub: string,
	tool: string,
	args: Record<string, unknown>
): Promise<void> {
	h.apisix.llm.script = modelUsing(tool, args);
	const res = await makeClient(h).post<{ answer: string }>(sub, '/v1/chat', {
		message: 'Que dit mon agenda ?'
	});
	expect(res.status).toBe(200);
	// The literal model tells what it found only once the contract answered the read with success
	expect(res.body.answer).toMatch(/^Found: /);
}

// The block of the system prompt that states the present: the prompt's parts are separated by
// blank lines, and the persona comes first
function nowBlock(prompt: string): string | undefined {
	return prompt.split('\n\n')[1];
}

// That block in French, for this date and time in words, this zone and this ISO 8601 instant
function frenchNow(words: string, timeZone: string, iso: string): string {
	return [
		'## Maintenant',
		`Date et heure : ${words}, fuseau ${timeZone}.`,
		`En ISO 8601 : ${iso}.`,
		"Sers-t'en pour situer « aujourd'hui », « demain » ou « cet après-midi », et donne aux contrats des heures RFC 3339 avec ce décalage.",
		"Chaque date qu'on te donne en données est écrite en toutes lettres à côté d'elle, jour de la semaine compris, sous une clé qui finit par _in_words : reprends ce jour plutôt que de le déduire de la date."
	].join('\n');
}

describe('the present moment in the system prompt', () => {
	describe('a French deployment in Europe/Paris', () => {
		const clock = makeSettableClock('2026-10-06T11:26:00Z');
		let h: TestHarness;
		beforeAll(async () => {
			h = await startTestHarness({
				env: { ASSISTANT_TIMEZONE: 'Europe/Paris', ASSISTANT_LOCALE: 'fr' },
				clock
			});
		});
		afterAll(async () => {
			await h.close();
		});

		it("tells the model the date, the time and the offset of the deployment's zone, in French", async () => {
			clock.set('2026-10-06T11:26:00Z');
			const prompt = await systemPromptOfTurn(h, 'alice', 'Suis-je libre à 14h ?');
			expect(prompt).toContain('mardi 6 octobre 2026');
			expect(prompt).toContain('13:26');
			expect(prompt).toContain('2026-10-06T13:26:00+02:00');
			expect(prompt).toContain('Europe/Paris');
		});

		it('states the moment in a block of its own, right after the persona', async () => {
			clock.set('2026-10-06T11:26:00Z');
			const prompt = await systemPromptOfTurn(h, 'alice', 'Et demain ?');
			expect(nowBlock(prompt)).toBe(
				frenchNow('mardi 6 octobre 2026, 13:26', 'Europe/Paris', '2026-10-06T13:26:00+02:00')
			);
		});

		it('gives the winter offset in winter', async () => {
			clock.set('2026-01-15T09:05:00Z');
			const prompt = await systemPromptOfTurn(h, 'alice', 'Quelle heure est-il ?');
			expect(prompt).toContain('jeudi 15 janvier 2026, 10:05');
			expect(prompt).toContain('2026-01-15T10:05:00+01:00');
		});

		it('follows the switch to summer time within the same night', async () => {
			clock.set('2026-03-29T00:30:00Z');
			expect(await systemPromptOfTurn(h, 'alice', 'Avant')).toContain('2026-03-29T01:30:00+01:00');
			clock.set('2026-03-29T01:30:00Z');
			expect(await systemPromptOfTurn(h, 'alice', 'Après')).toContain('2026-03-29T03:30:00+02:00');
		});

		it('reads the clock again at the start of every turn', async () => {
			clock.set('2026-10-06T11:26:00Z');
			expect(await systemPromptOfTurn(h, 'bob', 'Premier')).toContain('13:26');
			clock.set('2026-10-06T22:30:00Z');
			const later = await systemPromptOfTurn(h, 'bob', 'Second');
			expect(later).toContain('mercredi 7 octobre 2026, 00:30');
			expect(later).not.toContain('13:26');
		});
	});

	describe('a deployment left on its defaults', () => {
		const clock = makeSettableClock('2026-10-06T11:26:00Z');
		let h: TestHarness;
		beforeAll(async () => {
			h = await startTestHarness({ clock });
		});
		afterAll(async () => {
			await h.close();
		});

		it('states the moment in English, in UTC, with an explicit +00:00 offset', async () => {
			const prompt = await systemPromptOfTurn(h, 'alice', 'Am I free at 2pm?');
			expect(prompt).toContain(
				[
					'## Now',
					'Date and time: Tuesday, October 6, 2026, 11:26, time zone UTC.',
					'In ISO 8601: 2026-10-06T11:26:00+00:00.'
				].join('\n')
			);
		});
	});

	describe("a deployment in Europe/Paris, its owners' calendars in other zones", () => {
		const clock = makeSettableClock('2026-10-06T23:30:00Z');
		let h: TestHarness;
		beforeAll(async () => {
			h = await startTestHarness({
				env: {
					ASSISTANT_TIMEZONE: 'Europe/Paris',
					ASSISTANT_LOCALE: 'fr',
					// Alice takes more turns in a minute than an owner may by default
					ADMISSION_USER_PER_MINUTE: '100'
				},
				clock
			});
			h.apisix.contracts.spec = CALENDAR_CATALOG;
			for (const app of h.apps) expect(await app.agent.contracts.load()).toBe(4);
			// These owners already let their assistant read their calendar
			for (const owner of ['alice', 'bob']) await grantConsent(h.db, owner, 'calendar', 'read');
		});
		afterAll(async () => {
			await h.close();
		});

		it('states the present in the zone a list of my events returned, from my next turn on', async () => {
			clock.set('2026-10-06T23:30:00Z');
			h.apisix.contracts.handler = calendarIn('America/New_York');
			await readCalendar(h, 'alice', 'list_calendar_events', {
				from: '2026-10-07',
				days: 1
			});
			// Still Tuesday evening in New York, when it is already Wednesday in Paris
			expect(nowBlock(await systemPromptOfTurn(h, 'alice', 'Et demain ?'))).toBe(
				frenchNow('mardi 6 octobre 2026, 19:30', 'America/New_York', '2026-10-06T19:30:00-04:00')
			);
		});

		it("keeps an owner's zone to them: one whose calendar no read named yet has the deployment's", async () => {
			clock.set('2026-10-06T23:30:00Z');
			h.apisix.contracts.handler = calendarIn('America/New_York');
			await readCalendar(h, 'alice', 'list_calendar_events', {
				from: '2026-10-07',
				days: 1
			});
			expect(nowBlock(await systemPromptOfTurn(h, 'bob', 'Et demain ?'))).toBe(
				frenchNow('mercredi 7 octobre 2026, 01:30', 'Europe/Paris', '2026-10-07T01:30:00+02:00')
			);
		});

		it('follows the zone of my calendar to the last read of an event that named it', async () => {
			clock.set('2026-10-06T23:30:00Z');
			h.apisix.contracts.handler = calendarIn('America/New_York');
			await readCalendar(h, 'alice', 'list_calendar_events', {
				from: '2026-10-07',
				days: 1
			});
			// Alice moved her calendar to Tokyo since
			h.apisix.contracts.handler = calendarIn('Asia/Tokyo');
			await readCalendar(h, 'alice', 'read_calendar_event', { uid: 'uid-standup' });
			expect(nowBlock(await systemPromptOfTurn(h, 'alice', 'Et demain ?'))).toBe(
				frenchNow('mercredi 7 octobre 2026, 08:30', 'Asia/Tokyo', '2026-10-07T08:30:00+09:00')
			);
		});

		it('keeps the zone it had when a read names one the runtime does not know, and a known one by its canonical name', async () => {
			clock.set('2026-10-06T23:30:00Z');
			h.apisix.contracts.handler = calendarIn('america/new_york');
			await readCalendar(h, 'alice', 'list_calendar_events', {
				from: '2026-10-07',
				days: 1
			});
			const newYork = frenchNow(
				'mardi 6 octobre 2026, 19:30',
				'America/New_York',
				'2026-10-06T19:30:00-04:00'
			);
			expect(nowBlock(await systemPromptOfTurn(h, 'alice', 'Et demain ?'))).toBe(newYork);
			for (const named of ['Mars/Olympus', '', 7, null]) {
				h.apisix.contracts.handler = calendarIn(named);
				await readCalendar(h, 'alice', 'read_calendar_event', { uid: 'uid-standup' });
				expect(nowBlock(await systemPromptOfTurn(h, 'alice', 'Et demain ?'))).toBe(newYork);
			}
		});

		it('keeps the zone it had when a read of my calendar fails, whatever zone its error names', async () => {
			clock.set('2026-10-06T23:30:00Z');
			h.apisix.contracts.handler = calendarIn('America/New_York');
			await readCalendar(h, 'alice', 'list_calendar_events', { from: '2026-10-07', days: 1 });
			// The event is gone, and the contract's error names a zone all the same
			h.apisix.contracts.handler = () => ({
				status: 404,
				body: { error: 'not_found', time_zone: 'Asia/Tokyo' }
			});
			const failed = await makeClient(h).tool('alice', 'read_calendar_event', { uid: 'uid-gone' });
			expect(failed.body).toMatchObject({ status: 404 });
			expect(nowBlock(await systemPromptOfTurn(h, 'alice', 'Et demain ?'))).toBe(
				frenchNow('mardi 6 octobre 2026, 19:30', 'America/New_York', '2026-10-06T19:30:00-04:00')
			);
		});

		it('checks an all-day invitation from midnight to midnight in the zone of my calendar', async () => {
			// Alice's calendar is in Auckland, eleven hours ahead of Paris in October
			h.apisix.contracts.handler = calendarIn('Pacific/Auckland');
			await readCalendar(h, 'alice', 'list_calendar_events', { from: '2026-10-07', days: 1 });
			h.apisix.llm.script = echoScript;
			const before = h.apisix.contracts.calls.length;
			// An invitation to two whole days wakes her assistant, as the turn worker hands it over
			const turn = await h.app.agent.runOwnerTurn({
				principal: { id: 'alice' },
				target: { kind: 'new' },
				message: '[event] An invitation has been sent to me.',
				log: h.app.log,
				origin: 'event',
				event: {
					id: 'invitation-all-day',
					type: 'com.twake.calendar.event.invited.v1',
					invitation: { uid: 'all-day', start: '2026-10-06', end: '2026-10-08', timezone: null }
				}
			});
			expect(turn.kind).toBe('ok');
			const slot = h.apisix.contracts.calls
				.slice(before)
				.filter((call) => call.path === '/contracts/v1/calendar/freebusy');
			expect(slot.map((call) => call.query)).toEqual([
				{ start: '2026-10-06T00:00:00+13:00', end: '2026-10-08T00:00:00+13:00', exclude: 'all-day' }
			]);
		});

		it('states the present in the zone of the first read of my calendar, in the turn my yes resumes', async () => {
			clock.set('2026-10-06T23:30:00Z');
			h.apisix.contracts.handler = calendarIn('America/New_York');
			h.apisix.llm.script = modelUsing('list_calendar_events', { from: '2026-10-07', days: 1 });
			const client = makeClient(h);
			// Carol never let her assistant read her calendar: its first read waits for her
			const asked = await client.post<{ pending_call: { id: string } }>('carol', '/v1/chat', {
				message: "Qu'ai-je demain ?"
			});
			expect(asked.status).toBe(200);
			const before = h.apisix.llm.calls.length;
			const resumed = await client.post(
				'carol',
				`/v1/pending-calls/${asked.body.pending_call.id}/approve`,
				{}
			);
			expect(resumed.status).toBe(200);
			// The model read the events with the present of their zone
			expect(nowBlock(systemPromptAfter(h, before))).toBe(
				frenchNow('mardi 6 octobre 2026, 19:30', 'America/New_York', '2026-10-06T19:30:00-04:00')
			);
		});

		it('logs at info the days each list of my events reads, as it gives them, and none of its other arguments', async () => {
			h.apisix.contracts.handler = calendarIn('America/New_York');
			const before = h.logLines().length;
			await readCalendar(h, 'alice', 'list_calendar_events', {
				from: '2026-10-08',
				days: 2,
				limit: 17
			});
			// A list that gives no number of days reads the contract's own
			await readCalendar(h, 'alice', 'list_calendar_events', { from: '2026-10-09' });
			await readCalendar(h, 'alice', 'read_calendar_event', { uid: 'uid-standup' });
			const lines = h.logLines().slice(before);
			const windows = lines.filter((line) => 'from' in line || 'days' in line);
			expect(windows).toEqual([
				expect.objectContaining({
					level: 30,
					msg: 'contract called',
					principal: 'alice',
					from: '2026-10-08',
					days: '2'
				}),
				expect.objectContaining({
					level: 30,
					msg: 'contract called',
					principal: 'alice',
					from: '2026-10-09'
				})
			]);
			expect(windows[1]).not.toHaveProperty('days');
			expect(lines.filter((line) => 'limit' in line || 'uid' in line)).toEqual([]);
		});
	});

	describe('the time zone setting', () => {
		const base = {
			HARNESS_ROLE: 'api',
			DATABASE_URL: 'postgres://x@localhost/x',
			AUTH_JWKS_URL: 'https://example.test/jwks',
			AUTH_ISSUER: 'https://example.test/',
			AUTH_AUDIENCE: 'twake-harness',
			APISIX_BASE_URL: 'http://apisix.test',
			APISIX_CONSUMER_KEY: 'k'
		};

		it('refuses a zone the runtime does not know, at startup', () => {
			expect(() => loadConfig({ ...base, ASSISTANT_TIMEZONE: 'Mars/Olympus' })).toThrow(
				'invalid configuration: ASSISTANT_TIMEZONE "Mars/Olympus" is not a time zone the runtime knows'
			);
		});

		it('keeps the canonical name of the zone it is given', () => {
			expect(loadConfig({ ...base, ASSISTANT_TIMEZONE: 'europe/paris' }).timeZone).toBe(
				'Europe/Paris'
			);
			expect(loadConfig(base).timeZone).toBe('UTC');
		});
	});
});
