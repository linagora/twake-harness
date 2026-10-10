import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withPrincipal } from '../src/db/client.js';
import { startWorkerRole, type WorkerRole } from '../src/worker/role.js';
import {
	ACTIVITY,
	activityEvent,
	ASSIGNED,
	HARNESS_PASSWORD,
	HARNESS_USER,
	INVITED,
	invitationId,
	lastUser,
	logSink,
	MAIL_RECEIVED,
	mailEvent,
	PREFIX,
	startActivityBroker,
	startCalendarFanout,
	toldOf,
	turnCalls,
	until,
	whenListening,
	type ActivityEvent,
	type CalendarFanout,
	type LogSink
} from './helpers/activity.js';
import { makeSettableClock, type SettableClock } from './helpers/clock.js';
import { call, startConsentRoom, type ConsentRoom } from './helpers/consent-room.js';
import { toolsOf, type ChatRequest, type ScriptedReply } from './helpers/fake-apisix.js';
import type { TestBroker } from './helpers/rabbitmq.js';

const ALICE = 'alice@test.local';
const ASKED = 'What did you see today?';
const JOURNAL = 'listening_journal';

// Thursday 8 October 2026 at 23:50 in Paris, then Friday 9 October there: just after midnight, a
// few minutes later, and at half past nine
const THURSDAY_LATE = '2026-10-08T21:50:00Z';
const FRIDAY_EARLY = '2026-10-08T22:10:00Z';
const FRIDAY_LATER = '2026-10-08T22:15:00Z';
const FRIDAY_MORNING = '2026-10-09T07:30:00Z';

// What the organizer of the budget review wrote of its place and agenda, which the journal never
// keeps
const PLACE = 'Salle 42, Tour Twake';
const AGENDA = 'Salary review of Bob, who leaves in June';

// Bob's invitation to Alice's budget review, on Friday at nine in Paris, as Calendar's side service
// notifies her of it
function budgetReview(uid: string): Record<string, unknown> {
	return {
		senderEmail: 'bob@test.local',
		recipientEmail: ALICE,
		method: 'REQUEST',
		event: `${[
			'BEGIN:VCALENDAR',
			'VERSION:2.0',
			'BEGIN:VEVENT',
			`UID:${uid}`,
			'SUMMARY:Budget review',
			'DTSTART;TZID=Europe/Paris:20261009T090000',
			'DTEND;TZID=Europe/Paris:20261009T100000',
			`LOCATION:${PLACE.replace(',', '\\,')}`,
			`DESCRIPTION:${AGENDA.replace(',', '\\,')}`,
			'ORGANIZER;CN=Bob:mailto:bob@test.local',
			'DTSTAMP:20261005T091422Z',
			'END:VEVENT',
			'END:VCALENDAR'
		].join('\r\n')}\r\n`,
		eventPath: `/calendars/a/b/${uid}.ics`,
		isNewEvent: true
	};
}

let serial = 0;

// A task Bob assigns Alice, as Twake Tasks publishes it on the activity exchange: ROAD-12 of the
// Roadmap board unless told otherwise
function assignment(object?: Record<string, unknown>): ActivityEvent {
	serial += 1;
	return activityEvent({
		id: `0199b6f3-${String(serial).padStart(4, '0')}-7c3e-8a1f-6d2b4e8c9a07`,
		recipient: ALICE,
		...(object === undefined ? {} : { object })
	});
}

// The title of a task whose turn the model fails
const BREAKING = 'Breaks the model';
// The title of a task the model finds nothing useful to say of
const NOTHING_USEFUL = 'Nothing worth a word';
// The title of a task the model runs out of budget on, before it writes a word
const CUT_OFF = 'Cut off before a word';
// What a turn an activity woke is told it may answer, when nothing in it is useful
const SILENCE_ALLOWED = 'answer with nothing at all';
// The notice of a failed turn, as Alice reads it
const FAILED = 'Something went wrong on my side';

// A literal model: it names the activity its turn was told of, reads the journal when its owner
// asks what it saw, then says what the journal answered, and repeats anything else it hears. Its
// provider fails on a task of the breaking title, it answers nothing on one of the quiet title, and
// it runs out of budget before a word on one of the cut-off title.
function listeningModel(request: ChatRequest): ScriptedReply {
	const last = request.messages.at(-1);
	if (last?.role === 'tool' && last.name === JOURNAL) return { content: `Saw: ${last.content}` };
	const told = lastUser(request);
	if (told.includes(BREAKING)) return { failWith: 502 };
	if (told.includes(NOTHING_USEFUL)) return { content: '' };
	if (told.includes(CUT_OFF)) return { content: '', finishReason: 'length' };
	const id = /\(id ([^)]+)\)/.exec(told)?.[1];
	if (id !== undefined) return { content: `Told of ${id}` };
	if (told === ASKED) return { toolCalls: call(JOURNAL, {}) };
	return { content: `Heard: ${told}` };
}

// The system prompt of a request to the model
function systemOf(request: ChatRequest | undefined): string {
	const first = request?.messages[0];
	return first?.role === 'system' && typeof first.content === 'string' ? first.content : '';
}

interface Journal {
	readonly time_zone: string;
	readonly since: string;
	readonly activities: readonly Record<string, unknown>[];
}

let broker: TestBroker;
// Calendar's fanout, which gives every suite's queue each notification
let calendar: CalendarFanout;

beforeAll(async () => {
	broker = await startActivityBroker();
	calendar = await startCalendarFanout(broker);
}, 120_000);

afterAll(async () => {
	if (broker !== undefined) await broker.stop();
});

// Alice in her assistant's room, in Paris, the worker role listening on queues of the suite's own
// to the activity exchange and to Calendar's fanout, at the present of its own clock
interface Listening {
	readonly r: ConsentRoom;
	// The lines the worker roles of the suite wrote
	readonly logs: LogSink;
	listen(): Promise<WorkerRole>;
	publish(event: ActivityEvent): Promise<void>;
	// What Alice's assistant told her of an activity, in her room
	answerTo(id: string): Promise<string>;
	// What the journal answered the turn in which Alice asked what her assistant saw
	ask(): Promise<Journal>;
	// The lines saying what came of an activity, from either role
	noted(id: string): Record<string, unknown>[];
	close(): Promise<void>;
}

async function startListening(
	suite: string,
	clocks: { readonly api: SettableClock; readonly worker: SettableClock },
	env: Record<string, string> = {}
): Promise<Listening> {
	const prefix = `${PREFIX}.${suite}`;
	const r = await startConsentRoom(
		{
			ACTIVITY_ENABLED: 'true',
			ACTIVITY_AMQP_URL: broker.urlFor(HARNESS_USER, HARNESS_PASSWORD),
			...calendar.settings,
			RABBITMQ_PREFIX: prefix,
			ASSISTANT_TIMEZONE: 'Europe/Paris',
			// The pinned clocks put every turn of the suite in one minute
			ADMISSION_USER_PER_MINUTE: '100',
			...env
		},
		{ clock: clocks.api }
	);
	r.h.apisix.llm.script = listeningModel;
	const logs = logSink();
	return {
		r,
		logs,
		listen: async () =>
			whenListening(
				await startWorkerRole({
					config: { ...r.h.config, role: 'worker' },
					db: r.h.db,
					logStream: logs.stream,
					clock: clocks.worker
				})
			),
		publish: (event) => broker.publish(ACTIVITY, event.type, event, event.id),
		answerTo: (id) =>
			r.client.waitForMessage(r.room, r.assistantId, (text) => text === `Told of ${id}`),
		ask: async () => {
			const said = r.saying('Saw: ').length;
			await r.client.sendText(r.room, ASKED);
			const answer = await r.nextSaying('Saw: ', said);
			return JSON.parse(answer.slice('Saw: '.length)) as Journal;
		},
		noted: (id) =>
			[...logs.lines(), ...r.h.logLines()].filter(
				(line) => line['msg'] === 'activity noted' && line['eventId'] === id
			),
		close: () => r.close()
	};
}

describe('what my assistant saw today', () => {
	let l: Listening;
	let worker: WorkerRole;
	// Both roles read the same present, and the worker listens to the mails that arrive too
	const clock = makeSettableClock(THURSDAY_LATE);
	beforeAll(async () => {
		l = await startListening(
			'today',
			{ api: clock, worker: clock },
			{ ACTIVITY_TYPES: [ASSIGNED, MAIL_RECEIVED].join(',') }
		);
		worker = await l.listen();
	}, 240_000);
	afterAll(async () => {
		if (worker !== undefined) await worker.stop();
		if (l !== undefined) await l.close();
	});

	it('shows me what arrived since midnight in my zone and what my assistant made of it, by their titles', async () => {
		// Bob assigns me a task late on Thursday in Paris
		clock.set(THURSDAY_LATE);
		const thursday = assignment({
			type: 'task',
			id: 'task-road-11',
			key: 'ROAD-11',
			title: 'Book the venue'
		});
		await l.publish(thursday);
		await l.answerTo(thursday.id);
		// Just after midnight, he invites me to the budget review, then assigns me ROAD-12
		clock.set(FRIDAY_EARLY);
		await calendar.publish(budgetReview('budget-review'));
		await l.answerTo(invitationId('budget-review', ALICE));
		clock.set(FRIDAY_LATER);
		const road12 = assignment();
		await l.publish(road12);
		await l.answerTo(road12.id);
		// I ask at half past nine
		clock.set(FRIDAY_MORNING);
		// Each time written in words beside it, in my zone
		expect(await l.ask()).toEqual({
			time_zone: 'Europe/Paris',
			since: '2026-10-09T00:00:00+02:00',
			since_in_words: 'Friday, October 9, 2026, 00:00',
			activities: [
				{
					source: 'twake://calendar',
					type: INVITED,
					received_at: '2026-10-09T00:10:00+02:00',
					received_at_in_words: 'Friday, October 9, 2026, 00:10',
					outcome: 'suggested',
					start: '2026-10-09T09:00:00+02:00',
					start_in_words: 'Friday, October 9, 2026, 09:00',
					end: '2026-10-09T10:00:00+02:00',
					end_in_words: 'Friday, October 9, 2026, 10:00',
					untrusted: { uid: 'budget-review', title: 'Budget review' }
				},
				{
					source: 'twake://tasks',
					type: ASSIGNED,
					received_at: '2026-10-09T00:15:00+02:00',
					received_at_in_words: 'Friday, October 9, 2026, 00:15',
					outcome: 'suggested',
					object: { type: 'task', id: '1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e', key: 'ROAD-12' },
					untrusted: { title: 'Write the quarterly report' }
				}
			]
		});
		// One info line for each activity, with what identifies it and what came of it, and nothing
		// anyone wrote
		for (const [id, source, type] of [
			[thursday.id, 'twake://tasks', ASSIGNED],
			[invitationId('budget-review', ALICE), 'twake://calendar', INVITED],
			[road12.id, 'twake://tasks', ASSIGNED]
		] as const) {
			const lines = l.noted(id);
			expect(lines).toEqual([
				expect.objectContaining({ level: 30, source, type, owner: ALICE, outcome: 'suggested' })
			]);
			const said = JSON.stringify(lines);
			for (const written of ['venue', 'Budget review', 'quarterly', PLACE, AGENDA]) {
				expect(said).not.toContain(written);
			}
		}
	});

	it('offers the journal to my own turns alone, never to a turn an activity woke', async () => {
		const woke = assignment();
		await l.publish(woke);
		await l.answerTo(woke.id);
		const [woken] = await toldOf(l.r.h.apisix, woke.id, 1);
		expect(toolsOf(woken?.request)).not.toContain(JOURNAL);
		await l.ask();
		const mine = l.r.h.apisix.llm.calls.filter((c) => lastUser(c.request) === ASKED);
		expect(mine.length).toBeGreaterThan(0);
		for (const turn of mine) expect(toolsOf(turn.request)).toContain(JOURNAL);
	});

	it('tells me of an activity my assistant failed to tell me of', async () => {
		const broken = assignment({ type: 'task', id: 'task-13', key: 'ROAD-13', title: BREAKING });
		await l.publish(broken);
		await until('the turn failed', () => l.noted(broken.id).length > 0);
		expect(l.noted(broken.id)).toEqual([
			expect.objectContaining({ level: 30, source: 'twake://tasks', outcome: 'failed' })
		]);
		expect((await l.ask()).activities).toContainEqual(
			expect.objectContaining({
				object: { type: 'task', id: 'task-13', key: 'ROAD-13' },
				outcome: 'failed',
				untrusted: { title: BREAKING }
			})
		);
	});

	it('says nothing of an activity it found nothing useful in, which my journal tells me', async () => {
		const said = l.r.saying('').length;
		const quiet = assignment({
			type: 'task',
			id: 'task-14',
			key: 'ROAD-14',
			title: NOTHING_USEFUL
		});
		await l.publish(quiet);
		await until('the turn ended', () => l.noted(quiet.id).length > 0);
		expect(l.noted(quiet.id)).toEqual([
			expect.objectContaining({ level: 30, source: 'twake://tasks', outcome: 'nothing_useful' })
		]);
		// The turn the activity woke was told it may say nothing
		const [woken] = await toldOf(l.r.h.apisix, quiet.id, 1);
		expect(systemOf(woken?.request)).toContain(SILENCE_ALLOWED);
		expect((await l.ask()).activities).toContainEqual(
			expect.objectContaining({
				object: { type: 'task', id: 'task-14', key: 'ROAD-14' },
				outcome: 'nothing_useful',
				untrusted: { title: NOTHING_USEFUL }
			})
		);
		// Nothing reached my room but the answer to my question, and my own turn is neither told it
		// may say nothing nor shown an empty answer of my assistant
		expect(l.r.saying('').slice(said)).toEqual([
			expect.objectContaining({ body: expect.stringMatching(/^Saw: /) })
		]);
		const mine = l.r.h.apisix.llm.calls.filter((c) => lastUser(c.request) === ASKED).at(-1);
		expect(systemOf(mine?.request)).not.toContain(SILENCE_ALLOWED);
		expect(mine?.request.messages).not.toContainEqual(
			expect.objectContaining({ role: 'assistant', content: '' })
		);
		// Nor does my conversation keep what my assistant was told of the activity
		const asked = l.r.h.apisix.llm.calls
			.filter((c) => c.request.messages.at(-1)?.role === 'user' && lastUser(c.request) === ASKED)
			.at(-1);
		expect(JSON.stringify(asked?.request.messages)).not.toContain(quiet.id);
	});

	it('tells me it failed, rather than say nothing, when its model ran out of budget before a word', async () => {
		const notices = l.r.saying(FAILED).length;
		const cut = assignment({ type: 'task', id: 'task-15', key: 'ROAD-15', title: CUT_OFF });
		await l.publish(cut);
		await until('the turn ended', () => l.noted(cut.id).length > 0);
		expect(l.noted(cut.id)).toEqual([
			expect.objectContaining({ level: 30, source: 'twake://tasks', outcome: 'failed' })
		]);
		expect(await l.r.nextSaying(FAILED, notices)).toBe(`${FAILED}. Please try again in a moment.`);
	});

	it('keeps a task I assign myself for my brief, which my journal tells me, and nothing of my other actions', async () => {
		const said = l.r.saying('').length;
		const handled = (id: string): Record<string, unknown>[] =>
			l.logs.lines().filter((line) => line['msg'] === 'event handled' && line['eventId'] === id);
		// I assign myself ROAD-16, which comes twice, then send myself a mail
		const mine = {
			...assignment({ type: 'task', id: 'task-16', key: 'ROAD-16', title: 'Renew my badge' }),
			twakeactor: ALICE
		};
		const myMail = { ...mailEvent(`mail-${mine.id}`, ALICE), twakeactor: ALICE };
		await l.publish(mine);
		await l.publish(mine);
		await l.publish(myMail);
		await until('my mail was handled', () => handled(myMail.id).length > 0);
		expect(handled(mine.id).map((line) => line['outcome'])).toEqual(['for_brief', 'duplicate']);
		expect(handled(myMail.id).map((line) => line['outcome'])).toEqual(['ignored']);
		expect(l.noted(mine.id)).toEqual([
			expect.objectContaining({
				level: 30,
				source: 'twake://tasks',
				type: ASSIGNED,
				owner: ALICE,
				outcome: 'for_brief'
			})
		]);
		expect(l.noted(myMail.id)).toEqual([]);
		expect(turnCalls(l.r.h.apisix.llm.calls, mine.id)).toHaveLength(0);
		const { activities } = await l.ask();
		expect(activities).toContainEqual(
			expect.objectContaining({
				object: { type: 'task', id: 'task-16', key: 'ROAD-16' },
				outcome: 'for_brief',
				untrusted: { title: 'Renew my badge' }
			})
		);
		expect(activities.filter((activity) => activity['source'] === 'twake://mail')).toEqual([]);
		// Nothing reached my room but the answer to my question
		expect(l.r.saying('').slice(said)).toEqual([
			expect.objectContaining({ body: expect.stringMatching(/^Saw: /) })
		]);
	});
});

describe('the outcome of each activity, and what is kept of it', () => {
	let l: Listening;
	let worker: WorkerRole;
	// The api role reads Friday morning throughout; the worker role's present moves on, to purge
	// what it keeps
	const clock = makeSettableClock(FRIDAY_MORNING);
	const workerClock = makeSettableClock(FRIDAY_EARLY);

	// The turns Alice started this minute, as admission counts them: past her turns per minute, her
	// turns are refused until the minute passes, or until she started none
	async function rush(turns: number): Promise<void> {
		await withPrincipal(l.r.h.db, { id: ALICE }, async (tx) => {
			await tx.sql`delete from usage_window where owner = ${ALICE}`;
			if (turns === 0) return;
			await tx.sql`
				insert into usage_window (owner, at, turns)
				values (${ALICE}, date_trunc('second', now()), ${turns})`;
		});
	}

	// Starts the worker role again, which purges what it keeps at once, at the present of its clock
	async function restartWorker(at: string): Promise<void> {
		await worker.stop();
		workerClock.set(at);
		const seen = l.logs.lines().filter((line) => line['msg'] === 'listening journal purged').length;
		worker = await l.listen();
		await until(
			'the worker purged the journal',
			() =>
				l.logs.lines().filter((line) => line['msg'] === 'listening journal purged').length > seen
		);
	}

	beforeAll(async () => {
		l = await startListening(
			'outcomes',
			{ api: clock, worker: workerClock },
			{
				// Two wake-ups an hour, and three seconds for a woken turn admission refused to start
				WAKEUPS_PER_HOUR: '2',
				TURN_EVENT_MAX_DELAY_MS: '3000'
			}
		);
		worker = await l.listen();
	}, 240_000);
	afterAll(async () => {
		if (worker !== undefined) await worker.stop();
		if (l !== undefined) await l.close();
	});

	it('tells me what my assistant told me of, what it gave up on and what my hourly cap held back, each once, then forgets their names after a week and them after a month', async () => {
		// Told at once
		workerClock.set('2026-10-09T06:00:00Z');
		const told = assignment({ type: 'task', id: 'task-1', key: 'ROAD-1', title: 'Told' });
		await l.publish(told);
		await l.answerTo(told.id);
		// My minute is spent: the turn of the next one waits, then is given up
		await rush(100);
		workerClock.set('2026-10-09T06:05:00Z');
		const given = assignment({ type: 'task', id: 'task-2', key: 'ROAD-2', title: 'Given up' });
		await l.publish(given);
		await until('the turn given up', () =>
			l.r.h
				.logLines()
				.some((line) => line['msg'] === 'event turn abandoned' && line['reqId'] === given.id)
		);
		await rush(0);
		// Past my two wake-ups of the hour, and delivered twice
		workerClock.set('2026-10-09T06:10:00Z');
		const held = assignment({ type: 'task', id: 'task-3', key: 'ROAD-3', title: 'Held back' });
		await l.publish(held);
		await l.publish(held);
		await until(
			'both deliveries handled',
			() =>
				l.logs
					.lines()
					.filter((line) => line['msg'] === 'event handled' && line['eventId'] === held.id)
					.length === 2
		);
		expect(turnCalls(l.r.h.apisix.llm.calls, held.id)).toEqual([]);
		expect((await l.ask()).activities).toEqual([
			{
				source: 'twake://tasks',
				type: ASSIGNED,
				received_at: '2026-10-09T08:00:00+02:00',
				received_at_in_words: 'Friday, October 9, 2026, 08:00',
				outcome: 'suggested',
				object: { type: 'task', id: 'task-1', key: 'ROAD-1' },
				untrusted: { title: 'Told' }
			},
			{
				source: 'twake://tasks',
				type: ASSIGNED,
				received_at: '2026-10-09T08:05:00+02:00',
				received_at_in_words: 'Friday, October 9, 2026, 08:05',
				outcome: 'abandoned',
				object: { type: 'task', id: 'task-2', key: 'ROAD-2' },
				untrusted: { title: 'Given up' }
			},
			{
				source: 'twake://tasks',
				type: ASSIGNED,
				received_at: '2026-10-09T08:10:00+02:00',
				received_at_in_words: 'Friday, October 9, 2026, 08:10',
				outcome: 'capped',
				object: { type: 'task', id: 'task-3', key: 'ROAD-3' },
				untrusted: { title: 'Held back' }
			}
		]);
		expect(l.noted(given.id)).toEqual([expect.objectContaining({ outcome: 'abandoned' })]);
		expect(l.noted(held.id)).toEqual([expect.objectContaining({ outcome: 'capped' })]);
		// Eight days on, the worker keeps what each was and what came of it, nothing to name it by
		await restartWorker('2026-10-17T06:00:00Z');
		expect((await l.ask()).activities).toEqual([
			{ source: 'twake://tasks', type: ASSIGNED, outcome: 'suggested' },
			{ source: 'twake://tasks', type: ASSIGNED, outcome: 'abandoned' },
			{ source: 'twake://tasks', type: ASSIGNED, outcome: 'capped' }
		]);
		// And past the wake-ups' retention, nothing
		await restartWorker('2026-11-09T06:00:00Z');
		expect((await l.ask()).activities).toEqual([]);
	});
});
