import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runBriefPass } from '../src/briefs/schedule.js';
import { withPrincipal } from '../src/db/client.js';
import { saveBriefChoices } from '../src/settings/repository.js';
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
	PREFIX,
	startActivityBroker,
	startCalendarFanout,
	turnCalls,
	until,
	whenListening,
	type ActivityEvent,
	type CalendarFanout,
	type LogSink
} from './helpers/activity.js';
import {
	BRIEF_CATALOG,
	dataOf,
	LIST_EMAILS,
	LIST_EVENTS,
	LIST_MAILBOXES,
	LIST_TASKS,
	MAILBOXES
} from './helpers/brief.js';
import { makeSettableClock, type SettableClock } from './helpers/clock.js';
import { call, startConsentRoom, type ConsentRoom } from './helpers/consent-room.js';
import { allowBriefReads } from './helpers/consents.js';
import type { DecryptedMessage } from './helpers/e2ee-client.js';
import { toolsOf, type ChatRequest, type ScriptedReply } from './helpers/fake-apisix.js';
import type { TestBroker } from './helpers/rabbitmq.js';

const ALICE = 'alice@test.local';
const QUIET = 'quiet_hours';
// The quiet hours of an owner who chose none, as the harness has them unless a deployment says
// otherwise: from 20:00 to 08:00, and all of Saturday and Sunday
const DEFAULT_QUIET = '20:00-08:00 saturday sunday';
// Where the content of a brief tells Alice's client that it is one
const BRIEF_CONTENT_KEY = 'app.twake.assistant.brief';
// What the model writes as the brief
const WRITTEN = 'Ce matin : rien de pressé.';

// What Alice's assistant answers once she has no quiet hours, in each language
const NO_QUIET_FR =
	"Tu n'as pas d'heures calmes : je te préviens à toute heure de ce qui t'arrive.";
const NO_QUIET_EN =
	'You have no quiet hours: I will let you know what arrives for you at any hour.';
// What it adds once it told her what her quiet hours are
const HELD_FR =
	"Ce qui t'arrive pendant ce temps attend ton brief ou leur fin, sauf une réunion qui commence avant.";
const HELD_EN =
	'What arrives for you meanwhile waits for your brief or their end, unless it is a meeting that starts before.';

// What Alice reads once her assistant spent the share of her day kept for what it does on its own
const SHARE_SPENT =
	"I have used the part of today's quota kept for what I do on my own, so I will not react to your activities on my own again until midnight. My next brief will name what comes in until then, and I still answer whenever you write to me.";
// The title of a meeting whose turn takes three hundred tokens, more than the share of a day of a
// thousand that a reserve of three quarters leaves to what the assistant does on its own
const HEAVY = 'Read the whole board';

// What Alice asks of her quiet hours, and the call the model makes of each
const ASKS: Readonly<Record<string, Record<string, unknown>>> = {
	'Rien après 19 h': { action: 'hours', start: '19:00' },
	'Calme le samedi': { action: 'days', days: ['saturday'] },
	"Pas d'heures calmes": { action: 'none' },
	'Quiet from 22:00 to 07:00': { action: 'hours', start: '22:00', end: '07:00' },
	'No quiet hours': { action: 'none' }
};

// A literal model: it names the activity its turn was told of, three hundred tokens for a heavy
// one, writes the brief, calls the quiet hours tool on what Alice asks of them, says what a tool
// answered it, and repeats anything else it hears
function quietModel(request: ChatRequest): ScriptedReply {
	const last = request.messages.at(-1);
	if (last?.role === 'tool') return { content: `Tool said: ${String(last.content)}` };
	const told = lastUser(request);
	if (told.startsWith('[brief]')) return { content: WRITTEN };
	const id = /\(id ([^)]+)\)/.exec(told)?.[1];
	if (id !== undefined) {
		return {
			content: `Told of ${id}`,
			...(told.includes(HEAVY) ? { usage: { promptTokens: 290, completionTokens: 10 } } : {})
		};
	}
	const asked = ASKS[told];
	if (asked !== undefined) return { toolCalls: call(QUIET, asked) };
	return { content: `Heard: ${told}` };
}

function vcalendar(...lines: readonly string[]): string {
	return `${['BEGIN:VCALENDAR', 'VERSION:2.0', ...lines, 'END:VCALENDAR'].join('\r\n')}\r\n`;
}

// Bob's invitation of Alice to a meeting, at wall times of Paris, as Calendar's side service
// notifies her of it
function invitation(
	uid: string,
	title: string,
	start: string,
	end: string
): Record<string, unknown> {
	return {
		senderEmail: 'bob@test.local',
		recipientEmail: ALICE,
		method: 'REQUEST',
		event: vcalendar(
			'BEGIN:VEVENT',
			`UID:${uid}`,
			`SUMMARY:${title}`,
			`DTSTART;TZID=Europe/Paris:${start}`,
			`DTEND;TZID=Europe/Paris:${end}`,
			'ORGANIZER;CN=Bob:mailto:bob@test.local',
			'DTSTAMP:20261005T091422Z',
			'END:VEVENT'
		),
		eventPath: `/calendars/a/b/${uid}.ics`,
		isNewEvent: true
	};
}

// Bob's cancellation of a meeting Alice was invited to, at wall times of Paris
function cancellation(
	uid: string,
	title: string,
	start: string,
	end: string
): Record<string, unknown> {
	return {
		senderEmail: 'bob@test.local',
		recipientEmail: ALICE,
		method: 'CANCEL',
		event: vcalendar(
			'METHOD:CANCEL',
			'BEGIN:VEVENT',
			`UID:${uid}`,
			`SUMMARY:${title}`,
			`DTSTART;TZID=Europe/Paris:${start}`,
			`DTEND;TZID=Europe/Paris:${end}`,
			'ORGANIZER;CN=Bob:mailto:bob@test.local',
			`ATTENDEE;PARTSTAT=ACCEPTED:mailto:${ALICE}`,
			'SEQUENCE:1',
			'STATUS:CANCELLED',
			'DTSTAMP:20261008T091422Z',
			'END:VEVENT'
		),
		eventPath: `/calendars/a/b/${uid}.ics`
	};
}

let serial = 0;

// A task Bob assigns Alice, as Twake Tasks publishes it on the activity exchange
function assignment(title = 'Write the quarterly report'): ActivityEvent {
	serial += 1;
	return activityEvent({
		id: `0199b6f5-${String(serial).padStart(4, '0')}-7c3e-8a1f-6d2b4e8c9a07`,
		recipient: ALICE,
		object: { type: 'task', id: `task-${serial}`, key: `WEB-${serial}`, title }
	});
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

// Alice in her assistant's room, in Paris, both roles reading the present of one clock, and the
// worker role listening on queues of the suite's own to the activity exchange and to Calendar's
// fanout. Its scheduler passes once as it starts: the tests pass it themselves.
interface Quiet {
	readonly r: ConsentRoom;
	publish(event: ActivityEvent): Promise<void>;
	// What Alice's assistant told her of an activity, in her room
	answerTo(id: string): Promise<string>;
	// What it answers her next, whatever it says
	answer(text: string): Promise<string>;
	// The lines saying what came of an activity, from either role
	noted(id: string): Record<string, unknown>[];
	// The worker role's scheduler, as it passes every minute, at the time given
	pass(at: string): Promise<void>;
	// The activities held for Alice, by their ids
	held(): Promise<string[]>;
	close(): Promise<void>;
}

async function startQuiet(
	suite: string,
	clock: SettableClock,
	env: Record<string, string>
): Promise<Quiet> {
	const r = await startConsentRoom(
		{
			ACTIVITY_ENABLED: 'true',
			ACTIVITY_AMQP_URL: broker.urlFor(HARNESS_USER, HARNESS_PASSWORD),
			...calendar.settings,
			RABBITMQ_PREFIX: `${PREFIX}.${suite}`,
			ASSISTANT_TIMEZONE: 'Europe/Paris',
			QUIET_HOURS_DEFAULT: DEFAULT_QUIET,
			ADMISSION_USER_PER_MINUTE: '100',
			...env
		},
		{ clock }
	);
	r.h.apisix.llm.script = quietModel;
	const logs: LogSink = logSink();
	const worker: WorkerRole = await whenListening(
		await startWorkerRole({
			config: { ...r.h.config, role: 'worker' },
			db: r.h.db,
			logStream: logs.stream,
			clock,
			briefCheckMs: 3_600_000
		})
	);
	return {
		r,
		publish: (event) => broker.publish(ACTIVITY, event.type, event, event.id),
		answerTo: (id) =>
			r.client.waitForMessage(r.room, r.assistantId, (text) => text === `Told of ${id}`),
		answer: async (text) => {
			const said = r.saying('').length;
			await r.client.sendText(r.room, text);
			await until(`an answer to « ${text} »`, () => r.saying('').length > said);
			return r.saying('')[said]?.body ?? '';
		},
		noted: (id) =>
			[...logs.lines(), ...r.h.logLines()].filter(
				(line) => line['msg'] === 'activity noted' && line['eventId'] === id
			),
		pass: async (at) => {
			clock.set(at);
			const app = r.h.apps[0];
			if (app === undefined) throw new Error('no api role');
			await runBriefPass({ config: r.h.config, db: r.h.db, log: app.log, clock });
		},
		held: async () =>
			(
				await withPrincipal(
					r.h.db,
					{ id: ALICE },
					(tx) => tx.sql<{ event_id: string }[]>`
						select event_id from held_activities where owner = ${ALICE}
						order by held_at, event_id`
				)
			).map((row) => row.event_id),
		close: async () => {
			await worker.stop();
			await r.close();
		}
	};
}

describe('my quiet hours, from 20:00 to 08:00 and all weekend unless I choose others', () => {
	let q: Quiet;
	// Monday 12 October 2026 at nine in the evening in Paris
	const clock = makeSettableClock('2026-10-12T19:00:00Z');

	// The briefs Alice's client received from her assistant, oldest first
	const briefs = (): DecryptedMessage[] =>
		q.r.client.messages.filter(
			(m) =>
				m.roomId === q.r.room &&
				m.sender === q.r.assistantId &&
				m.content[BRIEF_CONTENT_KEY] !== undefined
		);

	// What the model was told by the brief its pass at that time sent
	async function briefAt(at: string): Promise<Record<string, unknown>> {
		const seen = briefs().length;
		const calls = q.r.h.apisix.llm.calls.length;
		await q.pass(at);
		await until('a new brief', () => briefs().length > seen);
		const told = q.r.h.apisix.llm.calls
			.slice(calls)
			.map((call) => lastUser(call.request))
			.find((text) => text.startsWith('[brief]'));
		return dataOf(told ?? '') as Record<string, unknown>;
	}

	beforeAll(async () => {
		q = await startQuiet('quiet', clock, { ASSISTANT_LOCALE: 'fr', BRIEF_ENABLED: 'true' });
		q.r.h.apisix.contracts.spec = BRIEF_CATALOG;
		for (const app of q.r.h.apps) expect(await app.agent.contracts.load()).toBeGreaterThan(0);
		// No meeting in her day, no invitation waiting for her answer, no task and no mail
		q.r.h.apisix.contracts.handler = (call) => {
			if (call.path === LIST_MAILBOXES) return { status: 200, body: MAILBOXES };
			if (call.path === LIST_EMAILS) {
				return { status: 200, body: { emails: [], next_cursor: null } };
			}
			if (call.path === LIST_TASKS) return { status: 200, body: { tasks: [], truncated: false } };
			if (call.path !== LIST_EVENTS) return { status: 404, body: {} };
			return { status: 200, body: { time_zone: 'Europe/Paris', events: [], truncated: false } };
		};
		await allowBriefReads(q.r.h.db, ALICE);
	}, 240_000);

	afterAll(async () => {
		if (q !== undefined) await q.close();
	});

	it('holds an invitation that reaches me at night until my brief, which names it, but tells me at once of a meeting that starts before, and answers me', async () => {
		// Monday at eleven in the evening: Bob invites me to a review on Tuesday at ten
		clock.set('2026-10-12T21:00:00Z');
		await calendar.publish(
			invitation('roadmap', 'Revue de la feuille de route', '20261013T100000', '20261013T110000')
		);
		const invited = invitationId('roadmap', ALICE);
		await until('the invitation noted', () => q.noted(invited).length > 0);
		expect(q.noted(invited)).toEqual([
			expect.objectContaining({ type: INVITED, owner: ALICE, outcome: 'quiet_hours' })
		]);
		expect(await q.held()).toEqual([invited]);
		// Then he cancels the stand-up at half past seven, which cannot wait for my brief
		const told = q.r.saying('Told of ').length;
		await calendar.publish(
			cancellation('standup', 'Stand-up', '20261013T073000', '20261013T074500')
		);
		await q.r.nextSaying('Told of ', told);
		// My own words are answered at night all the same
		expect(await q.answer('Bonsoir')).toBe('Heard: Bonsoir');
		// Tuesday at eight, my brief names the invitation as the listening journal shows it
		expect(await briefAt('2026-10-13T06:00:00Z')).toMatchObject({
			since_last_brief: {
				activities: [
					{
						number: 1,
						type: INVITED,
						outcome: 'quiet_hours',
						untrusted: { uid: 'roadmap', title: 'Revue de la feuille de route' }
					}
				],
				truncated: false
			}
		});
		// and lifts its hold: no pass wakes it, even once the brief could go out no more
		expect(await q.held()).toEqual([]);
		await q.pass('2026-10-13T09:30:00Z');
		expect(turnCalls(q.r.h.apisix.llm.calls, invited)).toEqual([]);
	});

	it('wakes my assistant at the end of my quiet hours for what they held, when my brief is stopped', async () => {
		await withPrincipal(q.r.h.db, { id: ALICE }, (tx) =>
			saveBriefChoices(tx, ALICE, { time: null, days: null, pausedUntil: null, stopped: true })
		);
		// Tuesday at eleven in the evening
		clock.set('2026-10-13T21:00:00Z');
		const task = assignment('Préparer la démo');
		await q.publish(task);
		await until('the task noted', () => q.noted(task.id).length > 0);
		expect(q.noted(task.id)).toEqual([
			expect.objectContaining({ type: ASSIGNED, outcome: 'quiet_hours' })
		]);
		// Still nothing at a quarter to eight, then its turn at eight
		await q.pass('2026-10-14T05:45:00Z');
		expect(await q.held()).toEqual([task.id]);
		await q.pass('2026-10-14T06:00:00Z');
		await q.answerTo(task.id);
		expect(await q.held()).toEqual([]);
		await withPrincipal(q.r.h.db, { id: ALICE }, (tx) =>
			saveBriefChoices(tx, ALICE, { time: null, days: null, pausedUntil: null, stopped: false })
		);
	});

	it('names on Monday’s brief what reached me on Saturday, and keeps 20:00 and 08:00 on my wall clock once the clocks went back', async () => {
		// Saturday 24 October at three in the afternoon, in summer time
		clock.set('2026-10-24T13:00:00Z');
		const saturday = assignment('Relire le budget');
		await q.publish(saturday);
		await until('the Saturday task noted', () => q.noted(saturday.id).length > 0);
		// Monday 26 October at a quarter to eight, in winter time
		clock.set('2026-10-26T06:45:00Z');
		const early = assignment('Signer le devis');
		await q.publish(early);
		await until('the early task noted', () => q.noted(early.id).length > 0);
		expect(await q.held()).toEqual([saturday.id, early.id]);
		// Monday at eight in winter time, the brief names both
		expect(await briefAt('2026-10-26T07:00:00Z')).toMatchObject({
			since_last_brief: {
				activities: [
					{ outcome: 'quiet_hours', untrusted: { title: 'Relire le budget' } },
					{ outcome: 'quiet_hours', untrusted: { title: 'Signer le devis' } }
				],
				truncated: false
			}
		});
		// At a quarter to eight in the evening, in winter time, a task tells me at once
		clock.set('2026-10-26T18:45:00Z');
		const evening = assignment('Envoyer le compte rendu');
		await q.publish(evening);
		await q.answerTo(evening.id);
	});

	it('changes my quiet hours on my word alone, and says so in my language', async () => {
		const turns = q.r.h.apisix.llm.calls.length;
		expect(await q.answer('Rien après 19 h')).toBe(
			`Tes heures calmes : chaque jour de 19:00 à 08:00, et tout le samedi et le dimanche. ${HELD_FR}`
		);
		expect(await q.answer('Calme le samedi')).toBe(
			`Tes heures calmes : chaque jour de 19:00 à 08:00, et tout le samedi. ${HELD_FR}`
		);
		expect(await q.answer("Pas d'heures calmes")).toBe(NO_QUIET_FR);
		expect(await q.answer("Pas d'heures calmes")).toBe(NO_QUIET_FR);
		// The tool is offered to my own turns, never to one an activity woke
		const owned = q.r.h.apisix.llm.calls
			.slice(turns)
			.find((call) => lastUser(call.request) === 'Rien après 19 h');
		expect(toolsOf(owned?.request)).toContain(QUIET);
		const woken = q.r.h.apisix.llm.calls.find((call) =>
			lastUser(call.request).includes('Préparer la démo')
		);
		expect(toolsOf(woken?.request).length).toBeGreaterThan(0);
		expect(toolsOf(woken?.request)).not.toContain(QUIET);
		// With no quiet hours, a task at night tells me at once
		clock.set('2026-10-26T22:00:00Z');
		const night = assignment('Corriger la facture');
		await q.publish(night);
		await q.answerTo(night.id);
	});
});

describe('my quiet hours when no brief goes out', () => {
	let q: Quiet;
	// Monday 12 October 2026 at nine in the evening in Paris
	const clock = makeSettableClock('2026-10-12T19:00:00Z');

	beforeAll(async () => {
		q = await startQuiet('quiet-no-brief', clock, {
			BRIEF_ENABLED: 'false',
			WAKEUPS_PER_HOUR: '2'
		});
	}, 240_000);

	afterAll(async () => {
		if (q !== undefined) await q.close();
	});

	it('wakes my assistant at their end for what they held, within my hourly cap, the rest at a later pass', async () => {
		// Monday at eleven in the evening, three tasks
		clock.set('2026-10-12T21:00:00Z');
		const tasks = [assignment(), assignment(), assignment()];
		for (const task of tasks) await q.publish(task);
		await until('the three tasks noted', () => tasks.every((task) => q.noted(task.id).length > 0));
		const [first, second, third] = tasks.map((task) => task.id);
		if (first === undefined || second === undefined || third === undefined) throw new Error();
		// Tuesday a minute before eight, then at eight
		await q.pass('2026-10-13T05:59:00Z');
		expect(await q.held()).toEqual([first, second, third]);
		await q.pass('2026-10-13T06:00:00Z');
		await q.answerTo(first);
		await q.answerTo(second);
		// The third waits past the next pass, the cap reached
		await q.pass('2026-10-13T06:01:00Z');
		expect(await q.held()).toEqual([third]);
	});

	it('changes my quiet hours on my word, and says so in English', async () => {
		expect(await q.answer('Quiet from 22:00 to 07:00')).toBe(
			`Your quiet hours: every day from 22:00 to 07:00, and all of Saturday and Sunday. ${HELD_EN}`
		);
		expect(await q.answer('No quiet hours')).toBe(NO_QUIET_EN);
	});
});

describe('the notice of a spent share during my quiet hours', () => {
	let q: Quiet;
	// Tuesday 13 October 2026 at seven in the morning in Paris
	const clock = makeSettableClock('2026-10-13T05:00:00Z');

	beforeAll(async () => {
		q = await startQuiet('quiet-reserve', clock, {
			// A day of a thousand tokens, three quarters of them kept for Alice's own words
			ADMISSION_USER_DAILY_TOKENS: '1000',
			CHAT_RESERVE: '0.75'
		});
	}, 240_000);

	afterAll(async () => {
		if (q !== undefined) await q.close();
	});

	it('comes at the first refusal past my quiet hours, never during them', async () => {
		const refused = (): Record<string, unknown>[] =>
			q.r.h
				.logLines()
				.filter((line) => line['msg'] === 'activity noted' && line['outcome'] === 'share_spent');
		// At seven, the cancellation of a meeting at half past seven spends the share, and the one
		// of a meeting at a quarter to eight is refused, which says nothing
		await calendar.publish(cancellation('review', HEAVY, '20261013T073000', '20261013T080000'));
		await q.r.nextSaying('Told of ', 0);
		await calendar.publish(cancellation('sync', 'Sync', '20261013T074500', '20261013T080000'));
		await until('the second cancellation refused', () => refused().length > 0);
		expect(q.r.saying(SHARE_SPENT)).toHaveLength(0);
		// At half past eight, the next refusal tells me
		clock.set('2026-10-13T06:30:00Z');
		await q.publish(assignment());
		expect(await q.r.nextSaying(SHARE_SPENT, 0)).toBe(SHARE_SPENT);
	});
});
