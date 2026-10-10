import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startWorkerRole, type WorkerRole } from '../src/worker/role.js';
import {
	ACTIVITY,
	activityEvent,
	ASSIGNED,
	HARNESS_PASSWORD,
	HARNESS_USER,
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
	type CalendarFanout
} from './helpers/activity.js';
import { call, startConsentRoom, type ConsentRoom } from './helpers/consent-room.js';
import {
	CALENDAR_CATALOG,
	toolsOf,
	type ChatRequest,
	type ScriptedReply
} from './helpers/fake-apisix.js';
import type { TestBroker } from './helpers/rabbitmq.js';

const ALICE = 'alice@test.local';

// The tools by which Alice chooses what her assistant listens to
const LISTEN = 'listen_to_source';
const STOP = 'stop_listening_to_source';
const LISTENED = 'listened_sources';

// The calendar contracts, which name Calendar and Mail to their owners
const CATALOG = {
	...CALENDAR_CATALOG,
	'x-twake-domains': {
		calendar: { name: { en: 'Twake Calendar', fr: 'Twake Calendar' } },
		mail: { name: { en: 'Twake Mail', fr: 'Twake Mail' } }
	}
};

// What the harness says once Alice chose whether her assistant listens to her calendar, and to her
// mail, which only her brief reads
const LISTENING_TO_CALENDAR =
	'I am listening to Twake Calendar: I will let you know what arrives for you there.';
const NOT_LISTENING_TO_CALENDAR =
	'I am no longer listening to Twake Calendar: I will no longer let you know what arrives for you there, but I can still look at it when you ask me.';
const LISTENING_TO_MAIL =
	'I am listening to Twake Mail: your brief will tell you what arrives for you there.';
const NOT_LISTENING_TO_MAIL =
	'I am no longer listening to Twake Mail: your brief will no longer tell you what arrives for you there, but I can still look at it when you ask me.';

// The applications Alice may have her assistant listen to
const LISTENABLE = ['calendar', 'tasks', 'mail', 'drive'];

// The line that tells the operator of an activity from a source the harness does not know
const UNKNOWN_SOURCE = 'activity of an unknown source, listened to by nobody';

// What Alice asks her assistant, and the call a literal model makes for each
const ASKS: Readonly<Record<string, { readonly tool: string; readonly args: unknown }>> = {
	'What do you listen to?': { tool: LISTENED, args: {} },
	'Listen to my calendar': { tool: LISTEN, args: { source: 'calendar' } },
	'Stop listening to my calendar': { tool: STOP, args: { source: 'calendar' } },
	'Stop listening to my tasks': { tool: STOP, args: { source: 'tasks' } },
	'Listen to my mail': { tool: LISTEN, args: { source: 'mail' } },
	'Stop listening to my mail': { tool: STOP, args: { source: 'mail' } },
	'Listen to my chat': { tool: LISTEN, args: { source: 'chat' } },
	'Listen to my notes': { tool: LISTEN, args: { source: 'notes' } },
	'What did you see today?': { tool: 'listening_journal', args: {} },
	'Am I free tomorrow at nine?': {
		tool: 'read_freebusy',
		args: { start: '2026-10-10T07:00:00Z', end: '2026-10-10T08:00:00Z' }
	}
};

// A literal model: it makes the call each of Alice's asks needs and says what the call answered,
// names the activity its turn was told of, and repeats anything else it hears
function listeningModel(request: ChatRequest): ScriptedReply {
	const last = request.messages.at(-1);
	if (last?.role === 'tool') return { content: `Told: ${last.content ?? ''}` };
	const told = lastUser(request);
	const id = /\(id ([^)]+)\)/.exec(told)?.[1];
	if (id !== undefined) return { content: `Told of ${id}` };
	const ask = ASKS[told];
	return ask === undefined
		? { content: `Heard: ${told}` }
		: { toolCalls: call(ask.tool, ask.args) };
}

// Bob's invitation to a review on Saturday at nine in Paris, as Calendar's side service notifies
// Alice of it
function invitation(uid: string): Record<string, unknown> {
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
			'DTSTART;TZID=Europe/Paris:20261010T090000',
			'DTEND;TZID=Europe/Paris:20261010T100000',
			'ORGANIZER;CN=Bob:mailto:bob@test.local',
			'DTSTAMP:20261005T091422Z',
			'END:VEVENT',
			'END:VCALENDAR'
		].join('\r\n')}\r\n`,
		eventPath: `/calendars/a/b/${uid}.ics`,
		isNewEvent: true
	};
}

let broker: TestBroker;
// Calendar's fanout, where its side service notifies each invitee
let calendar: CalendarFanout;
let r: ConsentRoom;
let worker: WorkerRole;
// The lines the worker role writes
const logs = logSink();

beforeAll(async () => {
	broker = await startActivityBroker();
	calendar = await startCalendarFanout(broker);
	r = await startConsentRoom({
		ACTIVITY_ENABLED: 'true',
		ACTIVITY_AMQP_URL: broker.urlFor(HARNESS_USER, HARNESS_PASSWORD),
		ACTIVITY_TYPES: [ASSIGNED, MAIL_RECEIVED].join(','),
		...calendar.settings,
		RABBITMQ_PREFIX: PREFIX,
		// Many turns of one owner in a row: admission is the subject of its own suite
		ADMISSION_USER_PER_MINUTE: '100'
	});
	r.h.apisix.llm.script = listeningModel;
	r.h.apisix.contracts.spec = CATALOG;
	r.h.apisix.contracts.handler = () => ({ status: 200, body: { busy: [] } });
	for (const app of r.h.apps) expect(await app.agent.contracts.load()).toBeGreaterThan(0);
	worker = await whenListening(
		await startWorkerRole({
			config: { ...r.h.config, role: 'worker' },
			db: r.h.db,
			logStream: logs.stream
		})
	);
}, 240_000);

afterAll(async () => {
	if (worker !== undefined) await worker.stop();
	if (r !== undefined) await r.close();
	if (broker !== undefined) await broker.stop();
});

// Publishes an event as its application does on the activity exchange
function publish(event: ActivityEvent): Promise<void> {
	return broker.publish(ACTIVITY, event.type, event, event.id);
}

// What Alice's assistant says next in her room after her words, starting as told
async function answer(words: string, prefix: string): Promise<string> {
	const seen = r.saying(prefix).length;
	await r.client.sendText(r.room, words);
	return r.nextSaying(prefix, seen);
}

// What the call Alice's words led to answered, as the model says it
async function told(words: string): Promise<unknown> {
	return JSON.parse((await answer(words, 'Told: ')).slice('Told: '.length)) as unknown;
}

// The line the worker role gives once it handled an event
function handled(id: string): Record<string, unknown>[] {
	return logs.lines().filter((line) => line['msg'] === 'event handled' && line['eventId'] === id);
}

// The lines of every role of the harness with this message
function linesSaying(msg: string): Record<string, unknown>[] {
	return [...logs.lines(), ...r.h.logLines()].filter((line) => line['msg'] === msg);
}

// Publishes Bob's invitation to Alice on Calendar's fanout, once the worker role handled it
async function invite(uid: string): Promise<string> {
	const id = invitationId(uid, ALICE);
	await calendar.publish(invitation(uid));
	await until('the invitation was handled', () => handled(id).length > 0);
	return id;
}

describe('what my assistant listens to, which I choose', () => {
	it('listens to my calendar and my tasks unless I say otherwise, to my mail and my drive only once I say so, and to nothing else yet', async () => {
		expect(await told('What do you listen to?')).toEqual({
			listened: ['calendar', 'tasks'],
			not_listened: ['mail', 'drive'],
			not_yet_possible: ['chat']
		});
		expect(await told('Listen to my chat')).toEqual({
			success: false,
			error: 'not yet possible',
			listenable: LISTENABLE
		});
		expect(await told('Listen to my notes')).toEqual({
			success: false,
			error: 'unknown source',
			listenable: LISTENABLE
		});
		// Nothing was asked, and no choice kept
		expect(r.questions()).toHaveLength(0);
		expect(linesSaying('listened source set')).toEqual([]);
	});

	it('stops listening to my calendar when I say so: an invitation then reaches neither my room nor my journal', async () => {
		r.h.apisix.contracts.calls.length = 0;
		expect(await answer('Stop listening to my calendar', 'I am no longer')).toBe(
			NOT_LISTENING_TO_CALENDAR
		);
		expect(await told('What do you listen to?')).toEqual({
			listened: ['tasks'],
			not_listened: ['calendar', 'mail', 'drive'],
			not_yet_possible: ['chat']
		});
		const said = r.saying('').length;
		const quiet = await invite('quiet-review');
		expect(handled(quiet)).toEqual([
			expect.objectContaining({ level: 30, outcome: 'unlistened', outcomes: { unlistened: 1 } })
		]);
		expect(turnCalls(r.h.apisix.llm.calls, quiet)).toHaveLength(0);
		expect(r.h.apisix.contracts.calls).toHaveLength(0);
		expect(await told('What did you see today?')).toMatchObject({ activities: [] });
		// Nothing reached my room but the answer to my question, and nothing told the operator
		expect(r.saying('').slice(said)).toEqual([
			expect.objectContaining({ body: expect.stringMatching(/^Told: /) })
		]);
		expect(linesSaying(UNKNOWN_SOURCE)).toEqual([]);
	});

	it('asks before it listens to my calendar, which it never read, and listens from my yes', async () => {
		const set = linesSaying('listened source set').length;
		const seen = r.questions().length;
		await r.client.sendText(r.room, 'Listen to my calendar');
		const questionId = await r.nextQuestion(seen);
		expect(r.client.messages.find((m) => m.eventId === questionId)?.body).toBe(
			[
				'This is the first time I need to read your data in Twake Calendar. Do you allow it?',
				'Answer yes or no in your next message.'
			].join('\n\n')
		);
		expect(linesSaying('listening waits for its owner')).toEqual([
			expect.objectContaining({ level: 30, tool: LISTEN, domain: 'calendar', consentLevel: 'read' })
		]);
		// Until I answer, it does not listen: an invitation wakes nothing
		expect(linesSaying('listened source set').slice(set)).toEqual([]);
		const early = await invite('early-review');
		expect(handled(early)).toEqual([expect.objectContaining({ outcome: 'unlistened' })]);
		expect(turnCalls(r.h.apisix.llm.calls, early)).toHaveLength(0);
		// My yes lets it read my calendar and listen to it, which the harness tells me in its words
		expect(await answer('yes', 'I am listening')).toBe(LISTENING_TO_CALENDAR);
		expect(linesSaying('listened source set').slice(set)).toEqual([
			expect.objectContaining({ level: 30, source: 'calendar', listening: true })
		]);
		// From then on, an invitation wakes it
		const first = await invite('first-review');
		await r.client.waitForMessage(r.room, r.assistantId, (text) => text === `Told of ${first}`);
		expect(handled(first)).toEqual([expect.objectContaining({ outcome: 'woken' })]);
	});

	it('still reads my calendar when I ask, though it no longer listens to it', async () => {
		expect(await answer('Stop listening to my calendar', 'I am no longer')).toBe(
			NOT_LISTENING_TO_CALENDAR
		);
		r.h.apisix.contracts.calls.length = 0;
		expect(await told('Am I free tomorrow at nine?')).toMatchObject({ status: 200 });
		expect(r.h.apisix.contracts.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
			'GET /contracts/v1/calendar/freebusy'
		]);
	});

	it('listens to my calendar again when I ask, without asking me twice', async () => {
		const questions = r.questions().length;
		expect(await answer('Listen to my calendar', 'I am listening')).toBe(LISTENING_TO_CALENDAR);
		expect(r.questions()).toHaveLength(questions);
		const loud = await invite('loud-review');
		await r.client.waitForMessage(r.room, r.assistantId, (text) => text === `Told of ${loud}`);
		expect(handled(loud)).toEqual([expect.objectContaining({ outcome: 'woken' })]);
	});

	it('never offers a turn an activity woke the tools that choose what my assistant listens to', async () => {
		const [woken] = await toldOf(r.h.apisix, invitationId('loud-review', ALICE), 1);
		for (const tool of [LISTEN, STOP, LISTENED])
			expect(toolsOf(woken?.request)).not.toContain(tool);
		const mine = r.h.apisix.llm.calls.filter(
			(c) => lastUser(c.request) === 'What do you listen to?'
		);
		expect(mine.length).toBeGreaterThan(0);
		for (const turn of mine) {
			expect(toolsOf(turn.request)).toEqual(expect.arrayContaining([LISTEN, STOP, LISTENED]));
		}
	});

	it('stops listening to my tasks when I say so: an assignment then wakes nothing', async () => {
		expect(await answer('Stop listening to my tasks', 'I am no longer')).toBe(
			'I am no longer listening to tasks: I will no longer let you know what arrives for you there, but I can still look at it when you ask me.'
		);
		const assignment = activityEvent({ id: 'assignment-unlistened', recipient: ALICE });
		await publish(assignment);
		await until('the assignment was handled', () => handled(assignment.id).length > 0);
		expect(handled(assignment.id)).toEqual([
			expect.objectContaining({ outcome: 'unlistened', outcomes: { unlistened: 1 } })
		]);
		expect(turnCalls(r.h.apisix.llm.calls, assignment.id)).toHaveLength(0);
		expect(linesSaying(UNKNOWN_SOURCE)).toEqual([]);
	});

	it('listens to no application the harness does not know, and tells its operator which', async () => {
		const mail = mailEvent('mail-unlistened', ALICE);
		await publish(mail);
		await until('the mail was handled', () => handled(mail.id).length > 0);
		expect(handled(mail.id)).toEqual([
			expect.objectContaining({ outcome: 'unlistened', outcomes: { unlistened: 1 } })
		]);
		expect(linesSaying(UNKNOWN_SOURCE)).toEqual([
			expect.objectContaining({ level: 40, source: 'twake://mail', eventId: mail.id, owner: ALICE })
		]);
		expect(turnCalls(r.h.apisix.llm.calls, mail.id)).toHaveLength(0);
	});

	it('listens to my mail from my yes to reading it there, for my brief alone, and stops when I say so', async () => {
		const seen = r.questions().length;
		await r.client.sendText(r.room, 'Listen to my mail');
		await r.nextQuestion(seen);
		expect(await answer('yes', 'I am listening')).toBe(LISTENING_TO_MAIL);
		expect(await told('What do you listen to?')).toEqual({
			listened: ['calendar', 'mail'],
			not_listened: ['tasks', 'drive'],
			not_yet_possible: ['chat']
		});
		expect(await answer('Stop listening to my mail', 'I am no longer')).toBe(NOT_LISTENING_TO_MAIL);
	});
});
