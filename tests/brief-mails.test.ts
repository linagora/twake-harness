import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { findTimeZone } from '../src/agent/clock.js';
import { mailsSince } from '../src/briefs/mails.js';
import { runBriefPass } from '../src/briefs/schedule.js';
import type { BriefSettings } from '../src/briefs/settings.js';
import { lastUser, until } from './helpers/activity.js';
import {
	BRIEF_CATALOG,
	dataOf,
	emailOf,
	INBOX,
	LIST_EMAILS,
	LIST_EVENTS,
	LIST_MAILBOXES,
	LIST_TASKS,
	MAILBOXES,
	referencesIn,
	seenEveryDay,
	type Mail
} from './helpers/brief.js';
import { makeSettableClock } from './helpers/clock.js';
import { startConsentRoom, type ConsentRoom } from './helpers/consent-room.js';
import { allowBriefReads, grantConsent, withdrawConsent } from './helpers/consents.js';
import type { DecryptedMessage } from './helpers/e2ee-client.js';
import type { ChatRequest, ContractCall } from './helpers/fake-apisix.js';

const ALICE = 'alice@test.local';
// Where the content of a brief tells Alice's client that it is one, and of which day
const BRIEF_CONTENT_KEY = 'app.twake.assistant.brief';
// What the model writes as the brief
const WRITTEN = 'Ce matin : Claire attend ta relecture du budget avant la revue de 10 h.';
// What the model is told of the mails it keeps, in her language
const RULE =
	"Parmi mes mails, garde d'abord ceux qui sont signalés (flagged), puis ceux qui me sont adressés (to_me) et qui posent une question, font une demande ou donnent une échéance, ou qui viennent d'une personne de mes réunions du jour (participants) ; dis ensuite combien d'autres non lus il reste, comme « + 3 autres non lus ».";

// What her calendar's contract lists for a day: the stand-up Bob organizes, the review of the
// budget Claire organizes, and a meeting she organizes herself, which her calendar wrote her
// address of in capitals
function dayOf(date: string): Record<string, unknown> {
	const offset = date < '2026-10-25' ? '+02:00' : '+01:00';
	const meeting = (
		uid: string,
		start: string,
		end: string,
		title: string,
		organizer: string
	): Record<string, unknown> => ({
		uid,
		recurrence_id: null,
		start: `${date}T${start}:00${offset}`,
		end: `${date}T${end}:00${offset}`,
		all_day: false,
		status: 'CONFIRMED',
		private: false,
		my_partstat: 'ACCEPTED',
		needs_action: false,
		conflicts: [],
		untrusted: { title, location: null, description: null, organizer }
	});
	return {
		time_zone: 'Europe/Paris',
		events: [
			meeting('standup', '09:00', '09:15', 'Stand-up', 'bob@test.local'),
			meeting('budget', '10:00', '11:00', 'Revue du budget', 'claire@test.local'),
			meeting('product', '14:00', '14:30', 'Point produit', 'Alice@Test.Local')
		],
		truncated: false
	};
}

// The people of her day's meetings but her, as the model is handed them
const PARTICIPANTS = ['bob@test.local', 'claire@test.local'];

// Her first Monday's unread mail, newest first: Claire asks her to read the budget before the
// review, a newsletter sent in bulk, and photos Dave sent her in copy, which she flagged
const CLAIRE_ASKS: Mail = {
	id: 'mail-claire-asks',
	at: '2026-10-12T05:40:00Z',
	from: 'claire@test.local',
	name: 'Claire Martin',
	subject: 'Budget 2027',
	preview: 'Peux-tu relire le tableau avant la revue ?',
	toMe: true
};
const NEWSLETTER: Mail = {
	id: 'mail-newsletter',
	at: '2026-10-12T05:30:00Z',
	from: 'news@twake.example',
	name: 'Twake',
	subject: 'Les nouveautés du mois',
	bulk: true
};
const PHOTOS: Mail = {
	id: 'mail-photos',
	at: '2026-10-10T09:00:00Z',
	from: 'dave@test.local',
	name: 'Dave',
	subject: 'Photos du séminaire',
	flagged: true
};

// A later morning's unread mail, newest first: one with no name that writes markup in its
// subject, a notice sent in bulk, a quote Bob asks her to approve, a contract Claire signed and
// Alice flagged, minutes sent to her, an invoice sent to her that she flagged, and two in copy
const LATEST: Mail = {
	id: 'mail-latest',
	at: '2026-10-20T05:55:00Z',
	from: 'gabriel@test.local',
	subject: '<b>Re: Planning</b>'
};
const NOTICE: Mail = {
	id: 'mail-notice',
	at: '2026-10-20T05:50:00Z',
	from: 'noreply@tasks.example',
	subject: 'Rappel automatique',
	bulk: true
};
const QUOTE: Mail = {
	id: 'mail-quote',
	at: '2026-10-20T05:00:00Z',
	from: 'bob@test.local',
	name: 'Bob',
	subject: 'Validation du devis',
	toMe: true
};
const SIGNED: Mail = {
	id: 'mail-signed',
	at: '2026-10-20T04:00:00Z',
	from: 'claire@test.local',
	name: 'Claire Martin',
	subject: 'Contrat signé',
	flagged: true
};
const MINUTES: Mail = {
	id: 'mail-minutes',
	at: '2026-10-19T09:00:00Z',
	from: 'dave@test.local',
	name: 'Dave',
	subject: 'Compte rendu',
	toMe: true
};
const INVOICE: Mail = {
	id: 'mail-invoice',
	at: '2026-10-19T08:00:00Z',
	from: 'fanny@test.local',
	name: 'Fanny',
	subject: 'Facture urgente',
	flagged: true,
	toMe: true
};
const TEAM: Mail = {
	id: 'mail-team',
	at: '2026-10-19T07:00:00Z',
	from: 'hugo@test.local',
	name: 'Hugo',
	subject: 'Info équipe'
};
const FAREWELL: Mail = {
	id: 'mail-farewell',
	at: '2026-10-19T06:30:00Z',
	from: 'ines@test.local',
	name: 'Inès',
	subject: 'Pot de départ'
};
const MORNING = [LATEST, NOTICE, QUOTE, SIGNED, MINUTES, INVOICE, TEAM, FAREWELL];

describe('my brief keeps the mails that matter, since my last brief', () => {
	let r: ConsentRoom;
	const clock = makeSettableClock('2026-10-12T06:00:00Z');
	// What her inbox holds unread, newest first, and whether Mail has more past the first ones
	let inbox: { readonly mails: readonly Mail[]; readonly more: boolean } = {
		mails: [],
		more: false
	};

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

	// The reads of her mailboxes, then of her mail, that reached the gateway
	const mailboxReads = (): ContractCall[] =>
		r.h.apisix.contracts.calls.filter((call) => call.path === LIST_MAILBOXES);
	const mailReads = (): ContractCall[] =>
		r.h.apisix.contracts.calls.filter((call) => call.path === LIST_EMAILS);

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

	// The model fails, so that the harness lays out the brief itself
	function modelFails(): void {
		r.h.apisix.llm.script = (request) =>
			lastUser(request).startsWith('[brief]')
				? { failWith: 502 }
				: { content: `echo: ${lastUser(request)}` };
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
		// Her day, no invitation waiting for her answer, no task, and her inbox as the test sets it
		r.h.apisix.contracts.handler = (call) => {
			if (call.path === LIST_MAILBOXES) return { status: 200, body: MAILBOXES };
			if (call.path === LIST_EMAILS) {
				return {
					status: 200,
					body: { emails: inbox.mails.map(emailOf), next_cursor: inbox.more ? 'more' : null }
				};
			}
			if (call.path === LIST_TASKS) return { status: 200, body: { tasks: [], truncated: false } };
			if (call.path !== LIST_EVENTS) return { status: 404, body: {} };
			const date = String(call.query['from']);
			return {
				status: 200,
				body:
					call.query['needs_action'] === 'true'
						? { time_zone: 'Europe/Paris', events: [], truncated: false }
						: dayOf(date)
			};
		};
	}, 240_000);

	beforeEach(async () => {
		await seenEveryDay(r.h.db, ALICE);
		await allowBriefReads(r.h.db, ALICE);
		inbox = { mails: [], more: false };
		r.h.apisix.llm.script = (request) =>
			lastUser(request).startsWith('[brief]')
				? { content: WRITTEN }
				: { content: `echo: ${lastUser(request)}` };
	});

	afterAll(async () => {
		if (r !== undefined) await r.close();
	});

	it('reads, on my first brief, a Monday, the unread mail of my inbox since Friday at the same time, fifty at most, and hands the model none sent in bulk, with the rule of the five it keeps and the people of my day’s meetings', async () => {
		const seen = briefs().length;
		const calls = briefCalls().length;
		const mailboxes = mailboxReads().length;
		const emails = mailReads().length;
		inbox = { mails: [CLAIRE_ASKS, NEWSLETTER, PHOTOS], more: false };
		// Monday 12 October at eight in Paris
		await pass('2026-10-12T06:00:00Z');
		const brief = await nextBrief(seen);
		expect(brief.body).toBe(WRITTEN);
		// Her mailboxes, to find her inbox, then its unread mail since Friday at eight, for Alice,
		// under the brief's own correlation id
		const read = [...mailboxReads().slice(mailboxes), ...mailReads().slice(emails)];
		expect(read.map((call) => [call.method, call.path, call.query])).toEqual([
			['GET', LIST_MAILBOXES, {}],
			[
				'GET',
				LIST_EMAILS,
				{ mailbox: INBOX, unread: 'true', after: '2026-10-09T08:00:00+02:00', limit: '50' }
			]
		]);
		for (const call of read) {
			expect(call.headers['x-twake-on-behalf-of']).toBe(ALICE);
			expect(call.headers['x-correlation-id']).toMatch(/^brief-2026-10-12-[0-9a-f]{16}$/);
		}
		// The model is handed her unread mail as Mail listed it, the newsletter left out, in the order
		// the harness lays it out, the flagged photos first, with the people of her day's meetings,
		// and told which five to keep; each time written in words beside it, in her language and zone
		const told = lastUser(briefCalls().slice(calls).at(0));
		expect(dataOf(told)).toHaveProperty('mails', {
			since: '2026-10-09T08:00:00+02:00',
			since_in_words: 'vendredi 9 octobre 2026, 08:00',
			unread: [
				{ ...emailOf(PHOTOS), received_at_in_words: 'samedi 10 octobre 2026, 11:00' },
				{ ...emailOf(CLAIRE_ASKS), received_at_in_words: 'lundi 12 octobre 2026, 07:40' }
			],
			truncated: false,
			participants: PARTICIPANTS
		});
		expect(told).not.toContain(NEWSLETTER.subject);
		expect(told).toContain(RULE);
		expect(logged('brief written')).toContainEqual(
			expect.objectContaining({ principal: ALICE, by: 'model', mails: 2 })
		);
	});

	it('reads my mail since my last brief, and on a Monday since Friday’s', async () => {
		const seen = briefs().length;
		const emails = mailReads().length;
		// Tuesday at eight, Friday at half past nine, then Monday at eight
		await pass('2026-10-13T06:00:00Z');
		await nextBrief(seen);
		await pass('2026-10-16T07:30:00Z');
		await nextBrief(seen + 1);
		await pass('2026-10-19T06:00:00Z');
		await nextBrief(seen + 2);
		expect(
			mailReads()
				.slice(emails)
				.map((call) => call.query['after'])
		).toEqual([
			'2026-10-12T08:00:00+02:00',
			'2026-10-13T08:00:00+02:00',
			'2026-10-16T09:30:00+02:00'
		]);
	});

	it('lays out five of my mails itself when the model fails, flagged ones first, then those sent to me, then the latest, and says how many more are unread', async () => {
		const seen = briefs().length;
		modelFails();
		inbox = { mails: MORNING, more: false };
		// Tuesday 20 October at eight
		await pass('2026-10-20T06:00:00Z');
		const tuesday = await nextBrief(seen);
		expect(tuesday.body).toBe(
			[
				'Tes réunions du jour, mardi 20 octobre 2026 :',
				'- 09:00–09:15 Stand-up',
				'- 10:00–11:00 Revue du budget',
				'- 14:00–14:30 Point produit',
				'',
				'Tes mails non lus depuis lundi 19 octobre à 08:00 :',
				'- Fanny : Facture urgente (signalé)',
				'- Claire Martin : Contrat signé (signalé)',
				'- Bob : Validation du devis',
				'- Dave : Compte rendu',
				'- gabriel@test.local : <b>Re: Planning</b>',
				'+ 2 autres non lus',
				'',
				'Pour enchaîner, dis-moi par exemple « résume le premier mail ».'
			].join('\n')
		);
		const html = String(tuesday.content['formatted_body']);
		expect(html).toContain('<li>Fanny : Facture urgente (signalé)</li>');
		expect(html).toContain('<li>gabriel@test.local : &lt;b&gt;Re: Planning&lt;/b&gt;</li>');
		expect(html).not.toContain('<b>');
		// Wednesday, Mail has more unread mail than the brief read
		inbox = { mails: MORNING, more: true };
		await pass('2026-10-21T06:00:00Z');
		const wednesday = await nextBrief(seen + 1);
		expect(wednesday.body).toContain('Tes mails non lus depuis mardi 20 octobre à 08:00 :');
		expect(wednesday.body).toContain('+ au moins 2 autres non lus');
	});

	it('gives my next turn the id and sender of each mail my brief was handed, as data, in the order it lays them out', async () => {
		const seen = briefs().length;
		inbox = { mails: MORNING, more: false };
		// Thursday 22 October at eight
		await pass('2026-10-22T06:00:00Z');
		await nextBrief(seen);
		const turns = r.h.apisix.llm.calls.length;
		await r.client.sendText(r.room, 'Résume le mail de Claire');
		await r.nextSaying('echo: Résume le mail de Claire', 0);
		const sender = (mail: Mail): Record<string, unknown> => ({
			id: mail.id,
			from: { name: mail.name ?? null, email: mail.from }
		});
		expect(referencesIn(r.h.apisix.llm.calls.slice(turns).at(0)?.request)).toEqual([
			{ mails: [INVOICE, SIGNED, QUOTE, MINUTES, LATEST, TEAM, FAREWELL].map(sender) }
		]);
	});

	it('leaves out my mail once I took it back, which the brief says in one line, and reads it, once I allow it again, since the last brief that did', async () => {
		const seen = briefs().length;
		const calls = briefCalls().length;
		const mailboxes = mailboxReads().length;
		const emails = mailReads().length;
		const pending = (await r.callsTo('mail')).length;
		await withdrawConsent(r.h.db, ALICE, 'mail', 'read');
		modelFails();
		inbox = { mails: MORNING, more: false };
		// Friday 23 October at eight
		await pass('2026-10-23T06:00:00Z');
		const friday = await nextBrief(seen);
		expect(mailboxReads().slice(mailboxes)).toHaveLength(0);
		expect(mailReads().slice(emails)).toHaveLength(0);
		const told = lastUser(briefCalls().slice(calls).at(0));
		expect(dataOf(told)).toMatchObject({ date: '2026-10-23' });
		expect(dataOf(told)).not.toHaveProperty('mails');
		expect(dataOf(told)).not.toHaveProperty('not_read');
		expect(friday.body).toMatch(
			/\n\nJe ne lis plus tes mails : pour que je les lise de nouveau, dis-moi « lis mes mails »\.$/
		);
		expect(friday.body).not.toContain("Je n'ai pas pu lire tes mails");
		expect(friday.body).not.toContain('Tes mails non lus');
		// No call waits for her, and the log says why
		expect(await r.callsTo('mail')).toHaveLength(pending);
		expect(logged('brief application skipped')).toContainEqual(
			expect.objectContaining({
				domain: 'mail',
				section: 'mails',
				reason: 'consent',
				principal: ALICE
			})
		);
		// Monday 26 October at eight, in winter time, her mail allowed again: since Thursday's brief
		await grantConsent(r.h.db, ALICE, 'mail', 'read');
		await pass('2026-10-26T07:00:00Z');
		await nextBrief(seen + 1);
		expect(
			mailReads()
				.slice(emails)
				.map((call) => call.query['after'])
		).toEqual(['2026-10-22T08:00:00+02:00']);
	});

	it('says Mail has more unread mail when all it read was sent in bulk', async () => {
		const seen = briefs().length;
		modelFails();
		inbox = { mails: [NEWSLETTER, NOTICE], more: true };
		// Tuesday 27 October at eight, in winter time
		await pass('2026-10-27T07:00:00Z');
		const tuesday = await nextBrief(seen);
		expect(tuesday.body).toContain(
			['Tes mails non lus depuis lundi 26 octobre à 08:00 :', "+ d'autres non lus"].join('\n')
		);
		expect(tuesday.body).not.toContain('Pour enchaîner');
		expect(String(tuesday.content['formatted_body'])).not.toContain('<ul></ul>');
	});
});

describe('my first brief reads my mail since the same time of the last day it goes out on', () => {
	// Her brief at half past seven in Paris, on weekdays
	function weekdays(): BriefSettings {
		const timeZone = findTimeZone('Europe/Paris');
		if (timeZone === null) throw new Error('no zone');
		return {
			timeZone,
			time: 450,
			days: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
			pausedUntil: null,
			stopped: false
		};
	}

	it('reads it, on the Monday after the clocks went back, from Friday at the same time of my wall clock', () => {
		// Monday 26 October at half past seven in winter time, Friday 23 October at half past seven
		// in summer time
		expect(mailsSince(null, new Date('2026-10-26T06:30:00Z'), weekdays()).toISOString()).toBe(
			'2026-10-23T05:30:00.000Z'
		);
	});

	it('reads it, on the Monday after the clocks went forward, from Friday at the same time of my wall clock', () => {
		// Monday 30 March at half past seven in summer time, Friday 27 March at half past seven in
		// winter time
		expect(mailsSince(null, new Date('2026-03-30T05:30:00Z'), weekdays()).toISOString()).toBe(
			'2026-03-27T06:30:00.000Z'
		);
	});
});
