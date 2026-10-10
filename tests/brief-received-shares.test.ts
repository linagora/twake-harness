import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runBriefPass } from '../src/briefs/schedule.js';
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
import type { ChatRequest, ContractCall, ScriptedReply } from './helpers/fake-apisix.js';

const ALICE = 'alice@test.local';
// Where the content of a brief tells Alice's client that it is one, and of which day
const BRIEF_CONTENT_KEY = 'app.twake.assistant.brief';
// What the model writes as the brief
const WRITTEN = "Ce matin : Claire t'a partagé le budget 2027.";

// The path the gateway receives the read of the shares other people gave the owner in Drive at
const LIST_SHARES = '/contracts/v1/drive/received-shares';

// The brief's contracts and Drive's list of the shares the owner received, as the contracts
// service publishes them, which name Calendar and Drive to their owners
const CATALOG = {
	...BRIEF_CATALOG,
	paths: {
		...BRIEF_CATALOG.paths,
		[LIST_SHARES]: {
			get: {
				operationId: 'list_received_shares',
				summary: 'List the files and folders other people shared with the user lately',
				tags: ['drive.sharing.read.v1'],
				parameters: [
					{ name: 'since', in: 'query', required: false, schema: { type: 'string' } },
					{ name: 'limit', in: 'query', required: false, schema: { type: 'integer' } }
				]
			}
		}
	},
	'x-twake-domains': {
		calendar: { name: { en: 'Twake Calendar', fr: 'Twake Calendar' } },
		drive: { name: { en: 'Twake Drive', fr: 'Twake Drive' } }
	}
};

// What the harness says once Alice has her assistant listen to her drive, which only her brief
// tells her of
const LISTENING_TO_DRIVE = "J'écoute Twake Drive : ton brief te dit ce qui t'y arrive.";

// What Alice asks her assistant, and the call a literal model makes for each
const ASKS: Readonly<Record<string, { readonly tool: string; readonly args: unknown }>> = {
	"Qu'écoutes-tu ?": { tool: 'listened_sources', args: {} },
	'Écoute mon Drive': { tool: 'listen_to_source', args: { source: 'drive' } }
};

// A literal model: it writes the brief as given, makes the call each of Alice's asks needs and says
// what the call answered, and repeats anything else it hears
function sharesModel(brief: ScriptedReply): (request: ChatRequest) => ScriptedReply {
	return (request) => {
		const last = request.messages.at(-1);
		if (last?.role === 'tool') return { content: `Told: ${last.content ?? ''}` };
		const told = lastUser(request);
		if (told.startsWith('[brief]')) return brief;
		const ask = ASKS[told];
		return ask === undefined
			? { content: `echo: ${told}` }
			: { toolCalls: call(ask.tool, ask.args) };
	};
}

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

// A share another member of Drive gave her, as Drive's contract lists it: its files and folders,
// by their ids and names, and who shared it, by name and address
interface Shared {
	readonly id: string;
	readonly at: string;
	readonly items: readonly {
		readonly id: string;
		readonly folder?: boolean;
		readonly name: string;
	}[];
	readonly by: { readonly name: string | null; readonly email: string | null };
	readonly sharedDrive?: boolean;
}

function shareOf(shared: Shared): Record<string, unknown> {
	return {
		id: shared.id,
		received_at: shared.at,
		read_only: true,
		shared_drive: shared.sharedDrive ?? false,
		items: shared.items.map((item) => ({
			id: item.id,
			type: item.folder === true ? 'directory' : 'file',
			untrusted: { name: item.name }
		})),
		untrusted: { shared_by: shared.by }
	};
}

const CLAIRE = { name: 'Claire Martin', email: 'claire@test.local' };
const BOB = { name: 'Bob Durand', email: '[REDACTED-EMAIL-1db51da4]' };

// Bob's shared drive, and Claire's budget, on Monday afternoon, the newest first
const ATLAS: Shared = {
	id: 'share-atlas',
	at: '2026-10-12T15:00:00Z',
	items: [{ id: 'drive-atlas', folder: true, name: 'Projet Atlas' }],
	by: BOB,
	sharedDrive: true
};
const MONDAY_SHARES: readonly Shared[] = [
	ATLAS,
	{
		id: 'share-budget',
		at: '2026-10-12T14:00:00Z',
		items: [{ id: 'file-budget', name: 'Budget 2027.xlsx' }],
		by: CLAIRE
	}
];

describe('my brief cites the shares made to me since my last brief, while my assistant listens to my drive', () => {
	let r: ConsentRoom;
	const clock = makeSettableClock('2026-10-12T06:00:00Z');
	// What Drive's contract lists of the shares she received
	let shares: readonly Shared[] = [];

	// Everything Alice's client received from her assistant in her room, oldest first
	const said = (): DecryptedMessage[] =>
		r.client.messages.filter((m) => m.roomId === r.room && m.sender === r.assistantId);

	// The briefs Alice's client received from her assistant, oldest first
	const briefs = (): DecryptedMessage[] =>
		said().filter((m) => m.content[BRIEF_CONTENT_KEY] !== undefined);

	async function nextBrief(seen: number): Promise<DecryptedMessage> {
		await until('a new brief', () => briefs().length > seen);
		const brief = briefs()[seen];
		if (brief === undefined) throw new Error('no brief');
		return brief;
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

	// What the model was handed by the first brief since that many
	function handedSince(calls: number): Record<string, unknown> {
		return dataOf(toldSince(calls)) as Record<string, unknown>;
	}

	// The contracts the briefs called since that many calls
	const calledSince = (calls: number): ContractCall[] => r.h.apisix.contracts.calls.slice(calls);

	// The worker role's pass, as it runs every minute, at the time the clock says
	async function pass(at: string): Promise<void> {
		clock.set(at);
		const app = r.h.apps[0];
		if (app === undefined) throw new Error('no api role');
		await runBriefPass({ config: r.h.config, db: r.h.db, log: app.log, clock });
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
		r.h.apisix.contracts.spec = CATALOG;
		for (const app of r.h.apps) expect(await app.agent.contracts.load()).toBeGreaterThan(0);
		await allowBriefReads(r.h.db, ALICE);
		// No meeting in her day, Claire's invitation waiting for her answer, no task and no mail
		r.h.apisix.contracts.handler = (c) => {
			if (c.path === LIST_SHARES) {
				return { status: 200, body: { shares: shares.map(shareOf), truncated: false } };
			}
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
		r.h.apisix.llm.script = sharesModel({ content: WRITTEN });
	}, 240_000);

	afterAll(async () => {
		if (r !== undefined) await r.close();
	});

	it('neither reads my drive nor tells of it while my assistant does not listen there', async () => {
		expect(await told("Qu'écoutes-tu ?")).toEqual({
			listened: ['calendar', 'tasks', 'mail'],
			not_listened: ['drive'],
			not_yet_possible: ['chat']
		});
		shares = MONDAY_SHARES;
		const seen = briefs().length;
		const calls = briefCalls().length;
		const reads = r.h.apisix.contracts.calls.length;
		// Monday 12 October at eight in Paris
		await pass('2026-10-12T06:00:00Z');
		await nextBrief(seen);
		expect(calledSince(reads).map((c) => c.path)).not.toContain(LIST_SHARES);
		const handed = handedSince(calls);
		expect(handed).not.toHaveProperty('shares');
		expect(handed).not.toHaveProperty('not_read');
	});

	it('asks for the read of my drive when I have my assistant listen there, and listens from my yes', async () => {
		// The question of a first read in her drive, in her language
		expect(await answer('Écoute mon Drive', "C'est la première fois")).toContain('Twake Drive');
		expect(await answer('oui', "J'écoute")).toBe(LISTENING_TO_DRIVE);
		expect(await told("Qu'écoutes-tu ?")).toEqual({
			listened: ['calendar', 'tasks', 'mail', 'drive'],
			not_listened: [],
			not_yet_possible: ['chat']
		});
	});

	it('cites in my next brief what was shared with me and by whom, each file by a number my next turn reads', async () => {
		const seen = briefs().length;
		const calls = briefCalls().length;
		const reads = r.h.apisix.contracts.calls.length;
		// Tuesday 13 October at eight: the shares since Monday at eight, her last brief day
		await pass('2026-10-13T06:00:00Z');
		expect((await nextBrief(seen)).body).toBe(WRITTEN);
		expect(
			calledSince(reads)
				.filter((c) => c.path === LIST_SHARES)
				.map((c) => c.query)
		).toEqual([{ since: '2026-10-12T08:00:00+02:00', limit: '20' }]);
		// Each share as Drive gave it, each file or folder numbered after Claire's invitation, but
		// Bob's shared drive, which no other operation of Drive reaches
		const handed = handedSince(calls);
		expect(handed).toMatchObject({
			shares: {
				since: '2026-10-12T08:00:00+02:00',
				shares: [
					{ id: 'share-atlas', shared_drive: true, untrusted: { shared_by: BOB } },
					{ id: 'share-budget', shared_drive: false, untrusted: { shared_by: CLAIRE } }
				],
				truncated: false
			}
		});
		const listed = (handed['shares'] as { shares: { items: unknown[] }[] }).shares;
		expect(listed.map((share) => share.items)).toEqual([
			[{ id: 'drive-atlas', type: 'directory', untrusted: { name: 'Projet Atlas' } }],
			[{ number: 2, id: 'file-budget', type: 'file', untrusted: { name: 'Budget 2027.xlsx' } }]
		]);
		expect(toldSince(calls)).toContain('(shares)');
		// Her next turn reads what the numbers of the brief name: the file by its id
		const turns = r.h.apisix.llm.calls.length;
		await r.client.sendText(r.room, 'Lis la 2');
		await r.nextSaying('echo: Lis la 2', 0);
		expect(referencesIn(r.h.apisix.llm.calls.slice(turns).at(0)?.request)).toEqual([
			{
				invitations: [{ number: 1, uid: 'budget', recurrence_id: null }],
				shares: [{ number: 2, id: 'file-budget', type: 'file' }]
			}
		]);
	});

	it('lays the shares out itself when the model fails, five at most, read since my last brief', async () => {
		r.h.apisix.llm.script = sharesModel({ failWith: 502 });
		// Since Tuesday's brief, the newest first: Bob's shared drive, Claire's plans, Dave's logo, a
		// report from someone Drive does not name, and Claire's budget with its annex
		shares = [
			ATLAS,
			{
				id: 'share-plans',
				at: '2026-10-13T14:00:00Z',
				items: [{ id: 'folder-plans', folder: true, name: 'Plans' }],
				by: CLAIRE
			},
			{
				id: 'share-logo',
				at: '2026-10-13T13:00:00Z',
				items: [{ id: 'file-logo', name: 'Logo.png' }],
				by: { name: null, email: 'dave@test.local' }
			},
			{
				id: 'share-report',
				at: '2026-10-13T12:00:00Z',
				items: [{ id: 'file-report', name: 'Compte rendu.docx' }],
				by: { name: null, email: null }
			},
			{
				id: 'share-budget',
				at: '2026-10-13T11:00:00Z',
				items: [
					{ id: 'file-budget', name: 'Budget 2027.xlsx' },
					{ id: 'file-annex', name: 'Annexe.pdf' }
				],
				by: CLAIRE
			}
		];
		const seen = briefs().length;
		const reads = r.h.apisix.contracts.calls.length;
		// Wednesday 14 October at eight: the shares since Tuesday's brief read them
		await pass('2026-10-14T06:00:00Z');
		const brief = await nextBrief(seen);
		expect(
			calledSince(reads)
				.filter((c) => c.path === LIST_SHARES)
				.map((c) => c.query['since'])
		).toEqual(['2026-10-13T08:00:00+02:00']);
		expect(brief.body.slice(brief.body.indexOf('Partages reçus'))).toBe(
			[
				'Partages reçus :',
				'- Projet Atlas (drive partagé), de Bob Durand',
				'- 2. Plans (dossier), de Claire Martin',
				'- 3. Logo.png, de dave@test.local',
				"- 4. Compte rendu.docx, de quelqu'un",
				'- 5. Budget 2027.xlsx, de Claire Martin',
				'+ 1 autre',
				'',
				'Pour enchaîner, dis-moi par exemple « décline la 1 » ou « lis la 3 ».'
			].join('\n')
		);
		expect(String(brief.content['formatted_body'])).toContain(
			'<li>5. Budget 2027.xlsx, de Claire Martin</li>'
		);
	});
});
