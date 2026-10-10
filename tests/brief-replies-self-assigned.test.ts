import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runBriefPass } from '../src/briefs/schedule.js';
import { withPrincipal } from '../src/db/client.js';
import { noteActivity, type Activity, type Noted } from '../src/journal/repository.js';
import { CALENDAR_SOURCE } from '../src/sources/sources.js';
import { REPLIED_EVENT_TYPE, TASK_ASSIGNED_EVENT_TYPE } from '../src/wakeups/event-types.js';
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
import { call, startConsentRoom, type ConsentRoom } from './helpers/consent-room.js';
import { allowBriefReads } from './helpers/consents.js';
import type { DecryptedMessage } from './helpers/e2ee-client.js';
import type { ChatRequest, ScriptedReply } from './helpers/fake-apisix.js';

const ALICE = 'alice@test.local';
const TASKS_SOURCE = 'twake://tasks';
// Where the content of a brief tells Alice's client that it is one, and of which day
const BRIEF_CONTENT_KEY = 'app.twake.assistant.brief';
// What the model writes as the brief
const WRITTEN = 'Ce matin : Bob et Carol déclinent le séminaire.';

// What Alice asks her assistant, and the call a literal model makes for each
const ASKS: Readonly<Record<string, { readonly tool: string; readonly args: unknown }>> = {
	"Qu'as-tu vu aujourd'hui ?": { tool: 'listening_journal', args: {} }
};

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

// What her listening journal keeps of an invitee's answer to the seminar she organizes: its UID,
// its title and times, the invitee and their answer
function aboutReply(attendee: string, answer: string): Noted {
	return {
		ids: { computed: {}, untrusted: { uid: 'seminar' } },
		names: {
			computed: {
				start: '2026-10-16T09:00:00+02:00',
				end: '2026-10-16T18:00:00+02:00',
				attendee,
				answer
			},
			untrusted: { title: 'Séminaire' }
		}
	};
}

// What it keeps of a task assigned to her: its id and its key, and its title
function aboutTask(id: string, key: string, title: string): Noted {
	return {
		ids: { computed: { object: { type: 'task', id, key } }, untrusted: {} },
		names: { computed: {}, untrusted: { title } }
	};
}

// The answers to her invitation to the seminar, in the order they arrived on Monday morning
const ANSWERS: readonly (readonly [string, string])[] = [
	['[REDACTED-EMAIL-df8b79ef]', 'ACCEPTED'],
	['[REDACTED-EMAIL-1db51da4]', 'DECLINED'],
	['[REDACTED-EMAIL-f7d0da4e]', 'ACCEPTED'],
	['[REDACTED-EMAIL-2d32bc1b]', 'TENTATIVE'],
	['[REDACTED-EMAIL-cfa49d8c]', 'DECLINED'],
	['[REDACTED-EMAIL-a5b6a9f6]', 'ACCEPTED']
];

describe('my brief cites the answers to my invitations and the tasks I assigned myself', () => {
	let r: ConsentRoom;
	const clock = makeSettableClock('2026-10-12T06:00:00Z');
	// What the model answers the brief with
	let brief: ScriptedReply = { content: WRITTEN };

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
		const sent = briefs()[seen];
		if (sent === undefined) throw new Error('no brief');
		return sent;
	}

	// The model calls of the briefs, by what they tell the model
	const briefCalls = (): ChatRequest[] =>
		r.h.apisix.llm.calls
			.map((c) => c.request)
			.filter((request) => lastUser(request).startsWith('[brief]'));

	// What the model was told by the first brief since that many
	function toldSince(calls: number): string {
		return lastUser(briefCalls().slice(calls).at(0));
	}

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

	// Notes the answers to her seminar, a minute apart from the instant given, under the prefix given
	async function noteAnswers(prefix: string, from: string): Promise<void> {
		for (const [index, [attendee, answer]] of ANSWERS.entries()) {
			await note(
				`${prefix}-${index}`,
				REPLIED_EVENT_TYPE,
				new Date(Date.parse(from) + index * 60_000).toISOString(),
				'for_brief',
				aboutReply(attendee, answer)
			);
		}
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
		await allowBriefReads(r.h.db, ALICE);
		// No meeting in her day, Claire's invitation waiting for her answer, no task and no mail
		r.h.apisix.contracts.handler = (c) => {
			if (c.path === LIST_MAILBOXES) return { status: 200, body: MAILBOXES };
			if (c.path === LIST_EMAILS) return { status: 200, body: { emails: [], next_cursor: null } };
			if (c.path === LIST_TASKS) return { status: 200, body: { tasks: [], truncated: false } };
			if (c.path !== LIST_EVENTS) return { status: 404, body: {} };
			const date = String(c.query['from']);
			return {
				status: 200,
				body:
					c.query['needs_action'] === 'true'
						? pendingOf(date)
						: { time_zone: 'Europe/Paris', events: [], truncated: false }
			};
		};
		// A literal model: it writes the brief as given, makes the call each of Alice's asks needs
		// and says what the call answered, and repeats anything else it hears
		r.h.apisix.llm.script = (request) => {
			const last = request.messages.at(-1);
			if (last?.role === 'tool') return { content: `Told: ${last.content ?? ''}` };
			const said = lastUser(request);
			if (said.startsWith('[brief]')) return brief;
			const ask = ASKS[said];
			return ask === undefined
				? { content: `echo: ${said}` }
				: { toolCalls: call(ask.tool, ask.args) };
		};
	}, 240_000);

	afterAll(async () => {
		if (r !== undefined) await r.close();
	});

	it('names the declines and the maybe first and counts the acceptances, each meeting by a number my next turn reads', async () => {
		const seen = briefs().length;
		const calls = briefCalls().length;
		// Monday morning in Paris, before her brief: six answers to her seminar
		await noteAnswers('replied', '2026-10-12T05:00:00Z');
		// Monday 12 October at eight
		await pass('2026-10-12T06:00:00Z');
		expect((await nextBrief(seen)).body).toBe(WRITTEN);
		const told = toldSince(calls);
		const data = dataOf(told) as Record<string, unknown>;
		// The seminar numbered after Claire's invitation, the declines then the maybe first, the
		// acceptances last, which the model counts
		const replied = (attendee: string, answered: string): Record<string, unknown> => ({
			number: 2,
			source: CALENDAR_SOURCE,
			type: REPLIED_EVENT_TYPE,
			outcome: 'for_brief',
			attendee,
			answer: answered,
			untrusted: { uid: 'seminar', title: 'Séminaire' }
		});
		expect(data).toMatchObject({
			replies: [
				replied('[REDACTED-EMAIL-1db51da4]', 'DECLINED'),
				replied('[REDACTED-EMAIL-cfa49d8c]', 'DECLINED'),
				replied('[REDACTED-EMAIL-2d32bc1b]', 'TENTATIVE'),
				replied('[REDACTED-EMAIL-df8b79ef]', 'ACCEPTED'),
				replied('[REDACTED-EMAIL-f7d0da4e]', 'ACCEPTED'),
				replied('[REDACTED-EMAIL-a5b6a9f6]', 'ACCEPTED')
			]
		});
		expect(data).not.toHaveProperty('since_last_brief');
		expect(told).toContain('(replies)');
		// Her next turn reads the seminar by its number
		const turns = r.h.apisix.llm.calls.length;
		await answer('Relance la 2', 'echo: Relance la 2');
		expect(referencesIn(r.h.apisix.llm.calls.slice(turns).at(0)?.request)).toEqual([
			{
				invitations: [{ number: 1, uid: 'budget', recurrence_id: null }],
				replies: [{ number: 2, uid: 'seminar', recurrence_id: null }]
			}
		]);
	});

	it('shows no longer their names once my brief named them, when I ask what my assistant saw today', async () => {
		const seen = (await told("Qu'as-tu vu aujourd'hui ?")) as {
			readonly activities: readonly Record<string, unknown>[];
		};
		expect(seen.activities.filter((activity) => activity['type'] === REPLIED_EVENT_TYPE)).toEqual(
			ANSWERS.map(() => ({
				source: CALENDAR_SOURCE,
				type: REPLIED_EVENT_TYPE,
				outcome: 'for_brief'
			}))
		);
	});

	it('cites by a number the task I assigned myself, which my next turn reads', async () => {
		const seen = briefs().length;
		const calls = briefCalls().length;
		// Monday afternoon, she assigned herself the demo
		await note(
			'assigned-demo',
			TASK_ASSIGNED_EVENT_TYPE,
			'2026-10-12T14:00:00Z',
			'for_brief',
			aboutTask('task-demo', 'WEB-12', 'Préparer la démo')
		);
		// Tuesday 13 October at eight
		await pass('2026-10-13T06:00:00Z');
		await nextBrief(seen);
		const told = toldSince(calls);
		const data = dataOf(told) as Record<string, unknown>;
		expect(data).toMatchObject({
			self_assigned: [
				{
					number: 2,
					key: 'WEB-12',
					source: TASKS_SOURCE,
					type: TASK_ASSIGNED_EVENT_TYPE,
					outcome: 'for_brief',
					object: { type: 'task', id: 'task-demo', key: 'WEB-12' },
					untrusted: { title: 'Préparer la démo' }
				}
			]
		});
		expect(data).not.toHaveProperty('since_last_brief');
		expect(data).not.toHaveProperty('replies');
		expect(told).toContain('(self_assigned)');
		// « Mets la 2 à vendredi » is then an ordinary turn, which reads the task by its number
		const turns = r.h.apisix.llm.calls.length;
		await answer('Mets la 2 à vendredi', 'echo: Mets la 2 à vendredi');
		expect(referencesIn(r.h.apisix.llm.calls.slice(turns).at(0)?.request)).toEqual([
			{
				invitations: [{ number: 1, uid: 'budget', recurrence_id: null }],
				self_assigned: [{ number: 2, key: 'WEB-12', task_id: 'task-demo' }]
			}
		]);
	});

	it('lays the same sections out itself when the model fails', async () => {
		const seen = briefs().length;
		brief = { failWith: 502 };
		// Tuesday: the same six answers, then a review she assigned herself
		await noteAnswers('replied-again', '2026-10-13T15:00:00Z');
		await note(
			'assigned-review',
			TASK_ASSIGNED_EVENT_TYPE,
			'2026-10-13T16:00:00Z',
			'for_brief',
			aboutTask('task-review', 'WEB-15', 'Relire le plan')
		);
		// Wednesday 14 October at eight
		await pass('2026-10-14T06:00:00Z');
		const sent = await nextBrief(seen);
		expect(sent.body.slice(sent.body.indexOf('Réponses à tes invitations'))).toBe(
			[
				'Réponses à tes invitations :',
				'- 2. Séminaire : [REDACTED-EMAIL-1db51da4] décline',
				'- 2. Séminaire : [REDACTED-EMAIL-cfa49d8c] décline',
				'- 2. Séminaire : [REDACTED-EMAIL-2d32bc1b] répond « peut-être »',
				'3 acceptations',
				'',
				"Tâches que tu t'es assignées :",
				'- 3. Relire le plan (WEB-15)',
				'',
				'Pour enchaîner, dis-moi par exemple « décline la 1 ».'
			].join('\n')
		);
		expect(String(sent.content['formatted_body'])).toContain('<li>3. Relire le plan (WEB-15)</li>');
	});
});
