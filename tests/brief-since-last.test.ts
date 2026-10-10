import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { runBriefPass } from '../src/briefs/schedule.js';
import { withPrincipal } from '../src/db/client.js';
import {
	listActivitiesSince,
	noteActivity,
	type Activity,
	type Noted
} from '../src/journal/repository.js';
import { CALENDAR_SOURCE } from '../src/sources/sources.js';
import {
	CANCELLED_EVENT_TYPE,
	INVITED_EVENT_TYPE,
	MOVED_EVENT_TYPE,
	RENAMED_EVENT_TYPE,
	REPLIED_EVENT_TYPE,
	TASK_ASSIGNED_EVENT_TYPE
} from '../src/wakeups/event-types.js';
import { lastUser, until } from './helpers/activity.js';
import {
	BRIEF_CATALOG,
	dataOf,
	LIST_EMAILS,
	LIST_EVENTS,
	LIST_MAILBOXES,
	LIST_TASKS,
	MAILBOXES,
	referencesIn
} from './helpers/brief.js';
import { makeSettableClock } from './helpers/clock.js';
import { startConsentRoom, type ConsentRoom } from './helpers/consent-room.js';
import { allowBriefReads } from './helpers/consents.js';
import type { DecryptedMessage } from './helpers/e2ee-client.js';
import type { ChatRequest } from './helpers/fake-apisix.js';

const ALICE = 'alice@test.local';
const TASKS_SOURCE = 'twake://tasks';
// Where the content of a brief tells Alice's client that it is one, and of which day
const BRIEF_CONTENT_KEY = 'app.twake.assistant.brief';
// What the model writes as the brief
const WRITTEN = 'Ce matin : la revue du budget à 10 h, et la démo à préparer.';

// What her calendar's contract lists of the invitations that wait for her answer, over the seven
// days from a date: Claire's review of the budget, that day
function pendingOf(date: string): Record<string, unknown> {
	return {
		time_zone: 'Europe/Paris',
		events: [
			{
				uid: 'budget',
				recurrence_id: null,
				start: `${date}T10:00:00+02:00`,
				end: `${date}T11:00:00+02:00`,
				all_day: false,
				status: 'CONFIRMED',
				private: false,
				my_partstat: 'NEEDS-ACTION',
				needs_action: true,
				conflicts: [],
				untrusted: {
					title: 'Revue du budget',
					location: null,
					description: null,
					organizer: 'claire@test.local'
				}
			}
		],
		truncated: false
	};
}

// What her listening journal keeps of an activity about a meeting: its UID and its occurrence, its
// title and its times
function aboutMeeting(
	uid: string,
	recurrenceId: string | null,
	title: string,
	start: string,
	end: string
): Noted {
	return {
		ids: {
			computed: recurrenceId === null ? {} : { recurrence_id: recurrenceId },
			untrusted: { uid }
		},
		names: { computed: { start, end }, untrusted: { title } }
	};
}

// What it keeps of a task assigned to her: its id and its key, and its title
function aboutTask(id: string, key: string, title: string): Noted {
	return {
		ids: { computed: { object: { type: 'task', id, key } }, untrusted: {} },
		names: { computed: {}, untrusted: { title } }
	};
}

describe('my brief names what reached me since my last brief that my assistant told me nothing of', () => {
	let r: ConsentRoom;
	const clock = makeSettableClock('2026-10-12T06:00:00Z');

	// The briefs Alice's client received from her assistant, oldest first
	const briefs = (): DecryptedMessage[] =>
		r.client.messages.filter(
			(m) =>
				m.roomId === r.room &&
				m.sender === r.assistantId &&
				m.content[BRIEF_CONTENT_KEY] !== undefined
		);

	async function nextBrief(seen: number): Promise<DecryptedMessage> {
		await until('a new brief', () => briefs().length > seen);
		const brief = briefs()[seen];
		if (brief === undefined) throw new Error('no brief');
		return brief;
	}

	// The model calls of the briefs, by what they tell the model
	const briefCalls = (): ChatRequest[] =>
		r.h.apisix.llm.calls
			.map((call) => call.request)
			.filter((request) => lastUser(request).startsWith('[brief]'));

	// What the model was told by the first brief since that many
	function toldSince(calls: number): string {
		return lastUser(briefCalls().slice(calls).at(0));
	}

	// The lines the api role logged with that message
	const logged = (msg: string): Record<string, unknown>[] =>
		r.h.logLines().filter((line) => line['msg'] === msg);

	// The worker role's pass, as it runs every minute, at the time the clock says
	async function pass(at: string): Promise<void> {
		clock.set(at);
		const app = r.h.apps[0];
		if (app === undefined) throw new Error('no api role');
		await runBriefPass({ config: r.h.config, db: r.h.db, log: app.log, clock });
	}

	// Notes an activity in her listening journal, as her assistant's listener does
	async function note(
		eventId: string,
		type: string,
		receivedAt: string,
		outcome: Activity['outcome'],
		noted: Noted
	): Promise<void> {
		const source = type === TASK_ASSIGNED_EVENT_TYPE ? TASKS_SOURCE : CALENDAR_SOURCE;
		await withPrincipal(r.h.db, { id: ALICE }, (tx) =>
			noteActivity(tx, ALICE, {
				source,
				eventId,
				type,
				receivedAt: new Date(receivedAt),
				outcome,
				noted
			})
		);
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
		// No meeting in her day, Claire's invitation waiting for her answer, no task and no mail
		r.h.apisix.contracts.handler = (call) => {
			if (call.path === LIST_MAILBOXES) return { status: 200, body: MAILBOXES };
			if (call.path === LIST_EMAILS) {
				return { status: 200, body: { emails: [], next_cursor: null } };
			}
			if (call.path === LIST_TASKS) return { status: 200, body: { tasks: [], truncated: false } };
			if (call.path !== LIST_EVENTS) return { status: 404, body: {} };
			const date = String(call.query['from']);
			return {
				status: 200,
				body:
					call.query['needs_action'] === 'true'
						? pendingOf(date)
						: { time_zone: 'Europe/Paris', events: [], truncated: false }
			};
		};
	}, 240_000);

	beforeEach(async () => {
		await allowBriefReads(r.h.db, ALICE);
		r.h.apisix.llm.script = (request) =>
			lastUser(request).startsWith('[brief]')
				? { content: WRITTEN }
				: { content: `echo: ${lastUser(request)}` };
	});

	afterAll(async () => {
		if (r !== undefined) await r.close();
	});

	it('hands the model what had no turn, a meeting by the number of its invitation or the next one, a task by its key, and gives my next turn what they name', async () => {
		const seen = briefs().length;
		const calls = briefCalls().length;
		// Over the weekend: Claire's invitation, which her hourly cap held back, the stand-up's new
		// title, kept for her brief, its move, which waited too long for admission, a meeting her
		// assistant told her of, and on Monday morning a task assigned to her once the share of
		// her day her assistant spends on its own was spent
		await note(
			'invited-budget',
			INVITED_EVENT_TYPE,
			'2026-10-11T16:00:00Z',
			'capped',
			aboutMeeting(
				'budget',
				null,
				'Revue du budget',
				'2026-10-12T10:00:00+02:00',
				'2026-10-12T11:00:00+02:00'
			)
		);
		await note(
			'renamed-standup',
			RENAMED_EVENT_TYPE,
			'2026-10-11T17:00:00Z',
			'for_brief',
			aboutMeeting(
				'standup',
				'2026-10-13T09:00:00+02:00',
				'Point équipe',
				'2026-10-13T09:00:00+02:00',
				'2026-10-13T09:15:00+02:00'
			)
		);
		await note(
			'moved-standup',
			MOVED_EVENT_TYPE,
			'2026-10-11T18:00:00Z',
			'abandoned',
			aboutMeeting(
				'standup',
				'2026-10-13T09:00:00+02:00',
				'Point équipe',
				'2026-10-13T09:30:00+02:00',
				'2026-10-13T09:45:00+02:00'
			)
		);
		await note(
			'invited-product',
			INVITED_EVENT_TYPE,
			'2026-10-11T19:00:00Z',
			'suggested',
			aboutMeeting(
				'product',
				null,
				'Point produit',
				'2026-10-14T14:00:00+02:00',
				'2026-10-14T14:30:00+02:00'
			)
		);
		await note(
			'assigned-demo',
			TASK_ASSIGNED_EVENT_TYPE,
			'2026-10-12T05:00:00Z',
			'share_spent',
			aboutTask('task-demo', 'WEB-12', 'Préparer la démo')
		);
		// Monday 12 October at eight in Paris
		await pass('2026-10-12T06:00:00Z');
		const brief = await nextBrief(seen);
		expect(brief.body).toBe(WRITTEN);
		// The first ones that arrived, as the listening journal shows them, Claire's review with the
		// number of its invitation, the stand-up with the next one, the meeting she was told of left
		// out
		const told = toldSince(calls);
		expect(dataOf(told)).toHaveProperty('since_last_brief', {
			activities: [
				{
					number: 1,
					source: CALENDAR_SOURCE,
					type: INVITED_EVENT_TYPE,
					received_at: '2026-10-11T18:00:00+02:00',
					received_at_in_words: 'dimanche 11 octobre 2026, 18:00',
					outcome: 'capped',
					start: '2026-10-12T10:00:00+02:00',
					start_in_words: 'lundi 12 octobre 2026, 10:00',
					end: '2026-10-12T11:00:00+02:00',
					end_in_words: 'lundi 12 octobre 2026, 11:00',
					untrusted: { uid: 'budget', title: 'Revue du budget' }
				},
				{
					number: 2,
					source: CALENDAR_SOURCE,
					type: RENAMED_EVENT_TYPE,
					received_at: '2026-10-11T19:00:00+02:00',
					received_at_in_words: 'dimanche 11 octobre 2026, 19:00',
					outcome: 'for_brief',
					recurrence_id: '2026-10-13T09:00:00+02:00',
					recurrence_id_in_words: 'mardi 13 octobre 2026, 09:00',
					start: '2026-10-13T09:00:00+02:00',
					start_in_words: 'mardi 13 octobre 2026, 09:00',
					end: '2026-10-13T09:15:00+02:00',
					end_in_words: 'mardi 13 octobre 2026, 09:15',
					untrusted: { uid: 'standup', title: 'Point équipe' }
				},
				{
					number: 2,
					source: CALENDAR_SOURCE,
					type: MOVED_EVENT_TYPE,
					received_at: '2026-10-11T20:00:00+02:00',
					received_at_in_words: 'dimanche 11 octobre 2026, 20:00',
					outcome: 'abandoned',
					recurrence_id: '2026-10-13T09:00:00+02:00',
					recurrence_id_in_words: 'mardi 13 octobre 2026, 09:00',
					start: '2026-10-13T09:30:00+02:00',
					start_in_words: 'mardi 13 octobre 2026, 09:30',
					end: '2026-10-13T09:45:00+02:00',
					end_in_words: 'mardi 13 octobre 2026, 09:45',
					untrusted: { uid: 'standup', title: 'Point équipe' }
				},
				{
					key: 'WEB-12',
					source: TASKS_SOURCE,
					type: TASK_ASSIGNED_EVENT_TYPE,
					received_at: '2026-10-12T07:00:00+02:00',
					received_at_in_words: 'lundi 12 octobre 2026, 07:00',
					outcome: 'share_spent',
					object: { type: 'task', id: 'task-demo', key: 'WEB-12' },
					untrusted: { title: 'Préparer la démo' }
				}
			],
			truncated: false
		});
		expect(told).not.toContain('Point produit');
		expect(told).toContain('(since_last_brief), chaque réunion par son numéro');
		expect(logged('brief written')).toContainEqual(
			expect.objectContaining({ principal: ALICE, by: 'model', activities: 4 })
		);
		// Her next turn reads each meeting once, by its number, and the task by its key
		const turns = r.h.apisix.llm.calls.length;
		await r.client.sendText(r.room, 'Accepte la 1');
		await r.nextSaying('echo: Accepte la 1', 0);
		expect(referencesIn(r.h.apisix.llm.calls.slice(turns).at(0)?.request)).toEqual([
			{
				invitations: [{ number: 1, uid: 'budget', recurrence_id: null }],
				since_last_brief: [
					{ number: 1, uid: 'budget', recurrence_id: null },
					{
						number: 2,
						uid: 'standup',
						recurrence_id: '2026-10-13T09:00:00+02:00',
						recurrence_id_in_words: 'mardi 13 octobre 2026, 09:00'
					},
					{ key: 'WEB-12', task_id: 'task-demo' }
				]
			}
		]);
	});

	it('names each of them in one brief alone: the brief that names them erases their title and times', async () => {
		const seen = briefs().length;
		const calls = briefCalls().length;
		// Tuesday 13 October at eight
		await pass('2026-10-13T06:00:00Z');
		await nextBrief(seen);
		expect(dataOf(toldSince(calls))).not.toHaveProperty('since_last_brief');
		// Her journal keeps the title and the times of the meeting she was told of alone
		const journal = await withPrincipal(r.h.db, { id: ALICE }, (tx) =>
			listActivitiesSince(tx, ALICE, new Date('2026-10-11T00:00:00Z'))
		);
		expect(
			Object.fromEntries(journal.map(({ eventId, names }) => [eventId, names === null]))
		).toEqual({
			'invited-budget': true,
			'renamed-standup': true,
			'moved-standup': true,
			'invited-product': false,
			'assigned-demo': true
		});
	});

	it('lays them out itself when the model fails, last, each by its number or its key, its title and what it was', async () => {
		const seen = briefs().length;
		r.h.apisix.llm.script = (request) =>
			lastUser(request).startsWith('[brief]')
				? { failWith: 502 }
				: { content: `echo: ${lastUser(request)}` };
		// Tuesday: the sprint review cancelled, Dave's answer to her invitation to the seminar and
		// a review of the spec assigned to her
		await note(
			'cancelled-sprint',
			CANCELLED_EVENT_TYPE,
			'2026-10-13T15:00:00Z',
			'capped',
			aboutMeeting(
				'sprint',
				null,
				'Revue de sprint',
				'2026-10-15T16:00:00+02:00',
				'2026-10-15T17:00:00+02:00'
			)
		);
		await note('replied-seminar', REPLIED_EVENT_TYPE, '2026-10-13T16:00:00Z', 'for_brief', {
			ids: { computed: {}, untrusted: { uid: 'seminar' } },
			names: {
				computed: {
					start: '2026-10-16T09:00:00+02:00',
					end: '2026-10-16T18:00:00+02:00',
					attendee: '[REDACTED-EMAIL-c19b85e2]',
					answer: 'DECLINED'
				},
				untrusted: { title: 'Séminaire' }
			}
		});
		await note(
			'assigned-spec',
			TASK_ASSIGNED_EVENT_TYPE,
			'2026-10-13T17:00:00Z',
			'capped',
			aboutTask('task-spec', 'WEB-14', 'Relire la spec')
		);
		// Wednesday 14 October at eight
		await pass('2026-10-14T06:00:00Z');
		const brief = await nextBrief(seen);
		expect(brief.body.slice(brief.body.indexOf('Depuis ton dernier brief'))).toBe(
			[
				'Depuis ton dernier brief :',
				'- 2. Revue de sprint : annulée',
				"- WEB-14 Relire la spec : tâche qui t'est assignée",
				'',
				'Réponses à tes invitations :',
				'- 3. Séminaire : [REDACTED-EMAIL-c19b85e2] décline',
				'',
				'Pour enchaîner, dis-moi par exemple « décline la 1 ».'
			].join('\n')
		);
		expect(String(brief.content['formatted_body'])).toContain(
			'<li>2. Revue de sprint : annulée</li>'
		);
	});

	it('hands the model twenty of them at most, the first that arrived, and the next brief names the others', async () => {
		const seen = briefs().length;
		const calls = briefCalls().length;
		// Wednesday, twenty-one tasks assigned to her that her hourly cap held back
		for (let index = 1; index <= 21; index++) {
			await note(
				`assigned-ops-${index}`,
				TASK_ASSIGNED_EVENT_TYPE,
				new Date(Date.parse('2026-10-14T10:00:00Z') + index * 60_000).toISOString(),
				'capped',
				aboutTask(`task-ops-${index}`, `OPS-${index}`, `Tâche ${index}`)
			);
		}
		// Thursday 15 October at eight, then Friday
		await pass('2026-10-15T06:00:00Z');
		await nextBrief(seen);
		expect(dataOf(toldSince(calls))).toMatchObject({
			since_last_brief: {
				activities: Array.from({ length: 20 }, (_, index) => ({ key: `OPS-${index + 1}` })),
				truncated: true
			}
		});
		await pass('2026-10-16T06:00:00Z');
		await nextBrief(seen + 1);
		expect(dataOf(toldSince(calls + 1))).toMatchObject({
			since_last_brief: { activities: [{ key: 'OPS-21' }], truncated: false }
		});
	});
});
