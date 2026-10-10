import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { findTimeZone, type TimeZone } from '../src/agent/clock.js';
import { withDatesInWords, withTrueWeekdays } from '../src/agent/weekdays.js';
import { withPrincipal } from '../src/db/client.js';
import { getMessages } from '../src/i18n/messages.js';
import { noteActivity } from '../src/journal/repository.js';
import { fenced } from '../src/llm/data.js';
import { CALENDAR_SOURCE } from '../src/sources/sources.js';
import { INVITED_EVENT_TYPE } from '../src/wakeups/event-types.js';
import { startTestHarness, type TestHarness } from './helpers/app.js';
import { makeClient } from './helpers/client.js';
import { makeSettableClock } from './helpers/clock.js';
import { call, modelUsing } from './helpers/consent-room.js';
import { grantConsent } from './helpers/consents.js';
import { CALENDAR_CATALOG, lastUserContent, type ChatRequest } from './helpers/fake-apisix.js';

// The model works the name of a day out from its date, and gets it wrong: Tuesday 13 October 2026
// once came out as a Monday. The harness names the day of each date the model writes from the
// date itself.
describe('the day of the week of the dates my assistant writes', () => {
	// Friday 9 October 2026, at seven in the morning in Paris
	const clock = makeSettableClock('2026-10-09T05:03:00Z');
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

	it('names the day of a date from the date, whatever day the model wrote, and the conversation keeps it', async () => {
		h.apisix.llm.script = (request: ChatRequest) =>
			request.messages.at(-1)?.content === 'Accepte-la'
				? {
						content:
							"C'est accepté : l'invitation du lundi 13 octobre 2026 de 17:00 à 18:00 est dans ton agenda."
					}
				: { content: 'Avec plaisir.' };
		const c = makeClient(h);
		const res = await c.post<{ answer: string; session_id: string }>('alice', '/v1/chat', {
			message: 'Accepte-la'
		});
		expect(res.body.answer).toBe(
			"C'est accepté : l'invitation du mardi 13 octobre 2026 de 17:00 à 18:00 est dans ton agenda."
		);
		const before = h.apisix.llm.calls.length;
		await c.post('alice', '/v1/chat', { message: 'Merci', session_id: res.body.session_id });
		expect(h.apisix.llm.calls[before]?.request.messages).toContainEqual({
			role: 'assistant',
			content: res.body.answer
		});
	});

	it('names the day of a date written without its year in the year nearest to my day', async () => {
		h.apisix.llm.script = () => ({ content: 'Ta réunion est lundi 13 octobre à 17 h.' });
		const said = async (): Promise<string> =>
			(
				await makeClient(h).post<{ answer: string }>('alice', '/v1/chat', {
					message: 'Quand est ma réunion ?'
				})
			).body.answer;
		expect(await said()).toBe('Ta réunion est mardi 13 octobre à 17 h.');
		// A year earlier, the 13th of October was a Monday
		clock.set('2025-10-09T05:03:00Z');
		try {
			expect(await said()).toBe('Ta réunion est lundi 13 octobre à 17 h.');
		} finally {
			clock.set('2026-10-09T05:03:00Z');
		}
	});

	it('quotes the words the model wrote beside a call that waits for me with the day of each date named from it', async () => {
		h.apisix.contracts.spec = {
			openapi: '3.0.3',
			paths: {
				'/contracts/v1/calendar/invitations/{event_id}/accept': {
					post: {
						operationId: 'accept_invitation',
						summary: 'Accepts an invitation, once the user has said yes to this very invitation',
						tags: ['calendar.invitation.accept.v1'],
						'x-twake-risk': 'low',
						parameters: [
							{ name: 'event_id', in: 'path', required: true, schema: { type: 'string' } }
						]
					}
				}
			}
		};
		for (const app of h.apps) expect(await app.agent.contracts.load()).toBe(1);
		h.apisix.llm.script = () => ({
			content: "J'accepte l'invitation du lundi 13 octobre 2026 de 17 h à 18 h.",
			toolCalls: [
				{
					id: 'call_accept',
					type: 'function',
					function: { name: 'accept_invitation', arguments: '{"event_id":"uid-point"}' }
				}
			]
		});
		const res = await makeClient(h).post<{ answer: string }>('bob', '/v1/chat', {
			message: "Accepte l'invitation au point"
		});
		expect(res.body.answer).toContain(
			"Ton assistant a écrit :\n> J'accepte l'invitation du mardi 13 octobre 2026 de 17 h à 18 h."
		);
		expect(h.apisix.contracts.calls).toHaveLength(0);
	});
});

// What the model read last: the answer of the tool it called, as the harness handed it
function lastToolAnswer(h: TestHarness): unknown {
	const last = h.apisix.llm.calls.at(-1)?.request.messages.at(-1);
	expect(last?.role).toBe('tool');
	return JSON.parse(last?.content ?? 'null');
}

// The data a message gives the model between the fences of a label, or null
function dataIn(text: string, label: string): unknown {
	const fenced = new RegExp(`^<<<${label} ([0-9a-f]{12})\\n([^\\n]+)\\n${label} \\1>>>$`, 'm');
	const data = fenced.exec(text)?.[2];
	return data === undefined ? null : JSON.parse(data);
}

// Bob's invitation to the E2E point, on Tuesday 13 October 2026 at six in the evening in Paris, as
// the calendar listener tells of it
const POINT = {
	uid: 'point',
	start: '2026-10-13T18:00:00+02:00',
	end: '2026-10-13T19:00:00+02:00',
	timezone: 'Europe/Paris'
};
const POINT_ID = 'invitation-point';
const POINT_TOLD = getMessages('fr').events.invited(
	POINT_ID,
	fenced('event-data', {
		type: INVITED_EVENT_TYPE,
		source: CALENDAR_SOURCE,
		id: POINT_ID,
		actor: 'bob@test.local',
		reason: 'invited',
		object: { type: 'event', start: POINT.start, end: POINT.end, organizer: 'bob@test.local' },
		untrusted: { title: 'Point E2E', uid: POINT.uid, timezone: POINT.timezone }
	})
);

// The E2E point as the calendar's contract lists it among Alice's meetings of the day
const POINT_MEETING = {
	uid: POINT.uid,
	recurrence_id: null,
	start: POINT.start,
	end: POINT.end,
	all_day: false,
	status: 'CONFIRMED',
	private: false,
	my_partstat: 'ACCEPTED',
	needs_action: false,
	conflicts: [],
	untrusted: { title: 'Point E2E', location: null, description: null, organizer: 'bob@test.local' }
};

// The model copies the name of a day it reads rather than work it out: the harness writes it beside
// each date it hands the model, in its owner's language and zone
describe('the day of the week beside each date my assistant reads', () => {
	// Friday 9 October 2026, at seven in the morning in Paris
	const clock = makeSettableClock('2026-10-09T05:03:00Z');
	let h: TestHarness;
	beforeAll(async () => {
		h = await startTestHarness({
			env: { ASSISTANT_TIMEZONE: 'Europe/Paris', ASSISTANT_LOCALE: 'fr' },
			clock
		});
		h.apisix.contracts.spec = CALENDAR_CATALOG;
		for (const app of h.apps) expect(await app.agent.contracts.load()).toBe(4);
		await grantConsent(h.db, 'alice', 'calendar', 'read');
	});
	afterAll(async () => {
		await h.close();
	});

	it('names the day and the time of each time a contract gives, in my language and zone, beside it', async () => {
		h.apisix.contracts.handler = () => ({
			status: 200,
			body: {
				time_zone: 'Europe/Paris',
				events: [
					{
						uid: 'point',
						start: '2026-10-13T18:00:00+02:00',
						end: '2026-10-13T19:00:00+02:00',
						untrusted: { title: 'Point E2E' }
					},
					// Late on Tuesday in New York, when it is already Wednesday in Paris
					{
						uid: 'call',
						start: '2026-10-13T20:00:00-04:00',
						end: '2026-10-13T21:00:00-04:00',
						untrusted: { title: 'Appel' }
					}
				],
				truncated: false
			}
		});
		h.apisix.llm.script = modelUsing('list_calendar_events', { from: '2026-10-13', days: 1 });
		const res = await makeClient(h).post('alice', '/v1/chat', { message: "Qu'ai-je mardi ?" });
		expect(res.status).toBe(200);
		expect(lastToolAnswer(h)).toEqual({
			status: 200,
			body: {
				time_zone: 'Europe/Paris',
				events: [
					{
						uid: 'point',
						start: '2026-10-13T18:00:00+02:00',
						start_in_words: 'mardi 13 octobre 2026, 18:00',
						end: '2026-10-13T19:00:00+02:00',
						end_in_words: 'mardi 13 octobre 2026, 19:00',
						untrusted: { title: 'Point E2E' }
					},
					{
						uid: 'call',
						start: '2026-10-13T20:00:00-04:00',
						start_in_words: 'mercredi 14 octobre 2026, 02:00',
						end: '2026-10-13T21:00:00-04:00',
						end_in_words: 'mercredi 14 octobre 2026, 03:00',
						untrusted: { title: 'Appel' }
					}
				],
				truncated: false
			}
		});
	});

	it('names the day and the time of what my listening journal tells, beside each time', async () => {
		await withPrincipal(h.db, { id: 'alice' }, (tx) =>
			noteActivity(tx, 'alice', {
				source: CALENDAR_SOURCE,
				eventId: 'journal-point',
				type: INVITED_EVENT_TYPE,
				receivedAt: new Date('2026-10-09T05:03:00Z'),
				outcome: 'suggested',
				noted: {
					ids: { computed: {}, untrusted: { uid: 'point' } },
					names: {
						computed: { start: POINT.start, end: POINT.end },
						untrusted: { title: 'Point E2E' }
					}
				}
			})
		);
		h.apisix.llm.script = (request: ChatRequest) =>
			request.messages.at(-1)?.role === 'tool'
				? { content: 'Bob t’a invitée au point E2E.' }
				: { toolCalls: call('listening_journal', {}) };
		const res = await makeClient(h).post('alice', '/v1/chat', {
			message: "Qu'as-tu vu aujourd'hui ?"
		});
		expect(res.status).toBe(200);
		expect(lastToolAnswer(h)).toEqual({
			time_zone: 'Europe/Paris',
			since: '2026-10-09T00:00:00+02:00',
			since_in_words: 'vendredi 9 octobre 2026, 00:00',
			activities: [
				{
					source: CALENDAR_SOURCE,
					type: INVITED_EVENT_TYPE,
					received_at: '2026-10-09T07:03:00+02:00',
					received_at_in_words: 'vendredi 9 octobre 2026, 07:03',
					outcome: 'suggested',
					start: POINT.start,
					start_in_words: 'mardi 13 octobre 2026, 18:00',
					end: POINT.end,
					end_in_words: 'mardi 13 octobre 2026, 19:00',
					untrusted: { uid: 'point', title: 'Point E2E' }
				}
			]
		});
	});

	it('names the right day of each meeting my brief lists, its date and times handed in words', async () => {
		// My brief may read all it reads, which it would otherwise ask me first
		for (const domain of ['mail', 'tasks']) await grantConsent(h.db, 'alice', domain, 'read');
		h.apisix.contracts.handler = () => ({
			status: 200,
			body: { time_zone: 'Europe/Paris', events: [POINT_MEETING], truncated: false }
		});
		h.apisix.llm.script = () => ({ content: 'Lundi 13 octobre : le point E2E à 18 h.' });
		const before = h.apisix.llm.calls.length;
		const brief = await h.app.agent.runBrief({
			principal: { id: 'alice' },
			roomId: '!brief:test.local',
			told: '[brief] Ta journée commence.',
			date: '2026-10-13',
			log: h.app.log,
			correlationId: 'brief-2026-10-13'
		});
		expect(brief).toMatchObject({ kind: 'ok', text: 'Mardi 13 octobre : le point E2E à 18 h.' });
		const told = lastUserContent(
			h.apisix.llm.calls[before]?.request ?? { model: '', messages: [] }
		);
		// Its day, and its day's meetings, whatever else the brief reads
		expect(dataIn(told, 'brief-data')).toMatchObject({
			date: '2026-10-13',
			date_in_words: 'mardi 13 octobre 2026',
			calendar: {
				time_zone: 'Europe/Paris',
				meetings: [
					{
						...POINT_MEETING,
						start_in_words: 'mardi 13 octobre 2026, 18:00',
						end_in_words: 'mardi 13 octobre 2026, 19:00'
					}
				],
				truncated: false
			}
		});
	});

	it('names the day and the time of a meeting a wake-up tells of, and of the slot the harness checked, beside each time', async () => {
		h.apisix.contracts.handler = () => ({
			status: 200,
			body: { start: POINT.start, end: POINT.end, free: true, busy: [] }
		});
		h.apisix.llm.script = () => ({ content: "Bob t'invite au point E2E." });
		const before = h.apisix.llm.calls.length;
		const turn = await h.app.agent.runOwnerTurn({
			principal: { id: 'alice' },
			target: { kind: 'new' },
			message: POINT_TOLD,
			log: h.app.log,
			origin: 'event',
			event: { id: POINT_ID, type: INVITED_EVENT_TYPE, invitation: POINT }
		});
		expect(turn.kind).toBe('ok');
		const told = lastUserContent(
			h.apisix.llm.calls[before]?.request ?? { model: '', messages: [] }
		);
		expect(dataIn(told, 'event-data')).toEqual({
			type: INVITED_EVENT_TYPE,
			source: CALENDAR_SOURCE,
			id: POINT_ID,
			actor: 'bob@test.local',
			reason: 'invited',
			object: {
				type: 'event',
				start: POINT.start,
				start_in_words: 'mardi 13 octobre 2026, 18:00',
				end: POINT.end,
				end_in_words: 'mardi 13 octobre 2026, 19:00',
				organizer: 'bob@test.local'
			},
			untrusted: { title: 'Point E2E', uid: POINT.uid, timezone: POINT.timezone }
		});
		expect(dataIn(told, 'calendar-data')).toEqual({
			tool: 'read_freebusy',
			arguments: {
				start: POINT.start,
				start_in_words: 'mardi 13 octobre 2026, 18:00',
				end: POINT.end,
				end_in_words: 'mardi 13 octobre 2026, 19:00',
				exclude: [POINT.uid]
			},
			result: {
				status: 200,
				body: {
					start: POINT.start,
					start_in_words: 'mardi 13 octobre 2026, 18:00',
					end: POINT.end,
					end_in_words: 'mardi 13 octobre 2026, 19:00',
					free: true,
					busy: []
				}
			}
		});
	});
});

// Paris, as the runtime knows it
function paris(): TimeZone {
	const zone = findTimeZone('Europe/Paris');
	if (zone === null) throw new Error('the runtime does not know Europe/Paris');
	return zone;
}

// What the model reads of a tool's answer once the harness has written its dates in words, in Paris
function readInParis(data: unknown): unknown {
	const [read] = withDatesInWords(
		[{ role: 'tool', tool_call_id: 'call', content: JSON.stringify(data) }],
		paris(),
		'fr'
	);
	return JSON.parse(read?.content ?? 'null');
}

// The data the harness hands the model, as it writes each date of it in words
describe('the day of the week the harness writes beside a date it hands the model', () => {
	it('names the day of a date given without its time', () => {
		expect(readInParis({ from: '2026-10-13', days: 1 })).toEqual({
			from: '2026-10-13',
			from_in_words: 'mardi 13 octobre 2026',
			days: 1
		});
	});

	it('leaves what people wrote as they wrote it', () => {
		const event = {
			start: '2026-10-13T18:00:00+02:00',
			untrusted: { title: '2026-10-13', notes: [{ at: '2026-10-13T18:00:00+02:00' }] }
		};
		expect(readInParis(event)).toEqual({
			start: '2026-10-13T18:00:00+02:00',
			start_in_words: 'mardi 13 octobre 2026, 18:00',
			untrusted: event.untrusted
		});
	});

	it('names the day and the time of a time that floats as it is written, whatever my zone', () => {
		expect(readInParis({ start: '2026-10-13T18:00:00' })).toEqual({
			start: '2026-10-13T18:00:00',
			start_in_words: 'mardi 13 octobre 2026, 18:00'
		});
	});

	it('names no day for the end of a whole day’s event, the day after its last', () => {
		// A seminar from Tuesday 6 to Wednesday 7 October, as iCalendar writes it
		expect(readInParis({ start: '2026-10-06', end: '2026-10-08' })).toEqual({
			start: '2026-10-06',
			start_in_words: 'mardi 6 octobre 2026',
			end: '2026-10-08'
		});
	});

	it('gives no words to a date there is not', () => {
		const data = { start: '2026-02-30T10:00:00Z', end: '2026-10-13T25:00:00', day: '2026-04-31' };
		expect(readInParis(data)).toEqual(data);
	});

	it('names the day of each date of a block of data, whatever people wrote in it', () => {
		const told = `Une invitation :\n${fenced('event-data', {
			start: '2026-10-13T18:00:00+02:00',
			untrusted: { title: 'Point E2E' }
		})}`;
		const [read] = withDatesInWords([{ role: 'user', content: told }], paris(), 'fr');
		expect(dataIn(read?.content ?? '', 'event-data')).toEqual({
			start: '2026-10-13T18:00:00+02:00',
			start_in_words: 'mardi 13 octobre 2026, 18:00',
			untrusted: { title: 'Point E2E' }
		});
	});
});

// How the model writes a date, in the languages the harness speaks
describe('the day of the week of a date as the model writes it', () => {
	// Friday 9 October 2026
	const today = '2026-10-09';

	it('names the day of a date written in English, its month first or its day first', () => {
		expect(withTrueWeekdays('See you on Monday, October 13, 2026 at 5 pm.', today)).toBe(
			'See you on Tuesday, October 13, 2026 at 5 pm.'
		);
		expect(withTrueWeekdays('Your meeting is on Monday 13 October.', today)).toBe(
			'Your meeting is on Tuesday 13 October.'
		);
		expect(withTrueWeekdays('It moved to Monday the 2nd of November.', today)).toBe(
			'It moved to Monday the 2nd of November.'
		);
		expect(withTrueWeekdays('It moved to Sunday, November 2nd.', today)).toBe(
			'It moved to Monday, November 2nd.'
		);
	});

	it('writes the day it names in the case the model wrote its own', () => {
		expect(withTrueWeekdays('Lundi 13 octobre 2026 : point E2E.', today)).toBe(
			'Mardi 13 octobre 2026 : point E2E.'
		);
		expect(withTrueWeekdays('LUNDI 13 OCTOBRE', today)).toBe('MARDI 13 OCTOBRE');
		expect(withTrueWeekdays('see you monday, october 13', today)).toBe(
			'see you tuesday, october 13'
		);
	});

	it('reads the first of a month as French writes it', () => {
		expect(withTrueWeekdays('Le bilan était le mercredi 1er octobre 2026.', today)).toBe(
			'Le bilan était le jeudi 1er octobre 2026.'
		);
	});

	it('reads a French date written after its day and a comma', () => {
		expect(withTrueWeekdays('C’est accepté pour lundi, 13 octobre 2026 à 17 h.', today)).toBe(
			'C’est accepté pour mardi, 13 octobre 2026 à 17 h.'
		);
		expect(withTrueWeekdays('Lundi, 13 octobre : point E2E.', today)).toBe(
			'Mardi, 13 octobre : point E2E.'
		);
	});

	it('reads a French date written after its day and « le »', () => {
		expect(withTrueWeekdays('Rendez-vous lundi le 13 octobre à 17 h.', today)).toBe(
			'Rendez-vous mardi le 13 octobre à 17 h.'
		);
		expect(withTrueWeekdays('LUNDI LE 13 OCTOBRE 2026', today)).toBe('MARDI LE 13 OCTOBRE 2026');
		expect(withTrueWeekdays('C’est noté pour lundi, le 13 octobre.', today)).toBe(
			'C’est noté pour mardi, le 13 octobre.'
		);
	});

	it('leaves a day that is right, a date there is not, and a day without a date as written', () => {
		for (const words of [
			'Ta réunion est mardi 13 octobre 2026 à 17 h, et Noël vendredi 25 décembre.',
			'Your meeting is on Tuesday, October 13, 2026.',
			'Le lundi 31 novembre 2026 n’existe pas.',
			'Une réunion jeudi 14h30, puis lundi à 17 h.',
			'Le point du lundi 13 est déplacé.'
		]) {
			expect(withTrueWeekdays(words, today)).toBe(words);
		}
	});

	it('takes the day the model wrote for a date without its year that is half a year away, either way', () => {
		// The 9th of April was a Thursday in 2026, and is a Friday in 2027
		expect(withTrueWeekdays('jeudi 9 avril', today)).toBe('jeudi 9 avril');
		expect(withTrueWeekdays('vendredi 9 avril', today)).toBe('vendredi 9 avril');
		expect(withTrueWeekdays('lundi 9 avril', today)).toBe('vendredi 9 avril');
	});
});
