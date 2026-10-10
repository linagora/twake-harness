import type { FastifyBaseLogger } from 'fastify';

import type { Config } from '../config.js';
import { withPrincipal, type Db, type Tx } from '../db/client.js';
import { isQuietAt, quietHoursOf } from '../quiet/hours.js';
import { findOwnerSettings } from '../settings/repository.js';
import { dateIn, nextMidnightIn, type Clock } from './clock.js';
import type { TurnOrigin } from './tools.js';

export type RefusalReason =
	'user_queue_full' | 'user_rate' | 'user_budget' | 'global_rate' | 'event_share';

// Why admission refused a turn, and for a user whose day is spent, how long until the next one
// starts and lifts the refusal
export type Refusal =
	| { readonly reason: 'user_budget'; readonly liftsInMs: number }
	| { readonly reason: Exclude<RefusalReason, 'user_budget'> };

// What a turn spends the owner's day on: their own words, or what their assistant does on its own,
// a turn an activity woke, a suggestion or their brief
export type SpendingOrigin = TurnOrigin | 'brief';

// What spends the share of the day the owner's words leave: the turns activities woke and the
// briefs. A suggestion, which no daily cap may cut, spends the day as the owner's words do.
function spendsTheShare(origin: SpendingOrigin): boolean {
	return origin === 'event' || origin === 'brief';
}

// A refusal only the next day lifts, for what the assistant does on its own: the owner's day is
// spent, or the share of it their assistant may spend on its own is
export type SpentReason = Extract<RefusalReason, 'user_budget' | 'event_share'>;

export function spentForTheDay(reason: RefusalReason): reason is SpentReason {
	return reason === 'user_budget' || reason === 'event_share';
}

export type AdmissionDecision =
	{ readonly ok: true; release(): void } | { readonly ok: false; readonly refusal: Refusal };

export interface AdmissionSnapshot {
	readonly inflight: number;
	readonly queued: number;
	readonly refused: Readonly<Record<RefusalReason, number>>;
}

export interface Admission {
	admit(principalId: string, origin: SpendingOrigin): Promise<AdmissionDecision>;
	recordUsage(principalId: string, tokens: number, origin: SpendingOrigin): Promise<void>;
	// True the first time it is asked on the owner's day out of their quiet hours, in the
	// transaction given under their principal: their assistant tells them once a day that it spent
	// its share
	shareNoticeDue(tx: Tx, principalId: string): Promise<boolean>;
	snapshot(): AdmissionSnapshot;
}

interface Waiter {
	readonly principalId: string;
	resolve(): void;
}

export interface AdmissionDeps {
	readonly config: Config;
	readonly db: Db;
	readonly log: FastifyBaseLogger;
	readonly clock: Clock;
}

// Admission runs before any model call. Limits are per user, so one user cannot saturate the
// replica for the others, and the queue of a full replica is served one user at a time rather
// than first come first served. The turns per minute and the daily tokens are counted in the
// database, so they hold across replicas; the turns in flight and the queue are this replica's.
// The turns activities wake and the briefs may spend the share of the day CHAT_RESERVE leaves
// them, the rest being kept for the owner's own words, which may spend the whole day.
export function makeAdmission(deps: AdmissionDeps): Admission {
	const { config, db, log, clock } = deps;
	const limits = config.admission;
	let inflight = 0;
	const running = new Map<string, number>();
	const waiting = new Map<string, number>();
	const queue: Waiter[] = [];
	const refused: Record<RefusalReason, number> = {
		user_queue_full: 0,
		user_rate: 0,
		user_budget: 0,
		global_rate: 0,
		event_share: 0
	};

	// The day a user's tokens count in, which starts at midnight in the deployment's zone,
	// ASSISTANT_TIMEZONE, whatever the zone of their calendar
	function today(): string {
		return dateIn(clock.now(), config.timeZone);
	}

	// The tokens a user spent today, and those of them that spent the share of their assistant
	async function tokensToday(principalId: string): Promise<{ total: number; share: number }> {
		const rows = await withPrincipal(
			db,
			{ id: principalId },
			(tx) => tx.sql<{ tokens: string; share: string }[]>`
				select tokens, event_tokens + brief_tokens as share from usage_daily
				where owner = ${principalId} and day = ${today()}`
		);
		return { total: Number(rows[0]?.tokens ?? 0), share: Number(rows[0]?.share ?? 0) };
	}

	async function userTurnsLastMinute(principalId: string): Promise<number> {
		return withPrincipal(db, { id: principalId }, async (tx) => {
			await tx.sql`delete from usage_window where owner = ${principalId} and at < now() - interval '60 seconds'`;
			const rows = await tx.sql<{ n: string }[]>`
				select coalesce(sum(turns), 0) as n from usage_window where owner = ${principalId}`;
			return Number(rows[0]?.n ?? 0);
		});
	}

	async function globalTurnsLastMinute(): Promise<number> {
		await db.sql`delete from usage_window_global where at < now() - interval '60 seconds'`;
		const rows = await db.sql<{ n: string }[]>`
			select coalesce(sum(turns), 0) as n from usage_window_global`;
		return Number(rows[0]?.n ?? 0);
	}

	async function recordStart(principalId: string): Promise<void> {
		await withPrincipal(
			db,
			{ id: principalId },
			(tx) => tx.sql`
				insert into usage_window (owner, at, turns) values (${principalId}, date_trunc('second', now()), 1)
				on conflict (owner, at) do update set turns = usage_window.turns + 1`
		);
		await db.sql`
			insert into usage_window_global (at, turns) values (date_trunc('second', now()), 1)
			on conflict (at) do update set turns = usage_window_global.turns + 1`;
	}

	function refuse(principalId: string, reason: RefusalReason): AdmissionDecision {
		refused[reason] += 1;
		log.info(
			{ principal: principalId, reason, inflight, queued: queue.length },
			'admission refused'
		);
		if (reason !== 'user_budget') return { ok: false, refusal: { reason } };
		const now = clock.now();
		const liftsInMs = Math.max(0, nextMidnightIn(now, config.timeZone).getTime() - now.getTime());
		return { ok: false, refusal: { reason, liftsInMs } };
	}

	// The next waiter whose user has nothing running goes first; a user with a running turn
	// waits for everyone else before taking a second slot
	function nextWaiter(): Waiter | null {
		const index = queue.findIndex((w) => (running.get(w.principalId) ?? 0) === 0);
		const chosen = index === -1 ? queue.shift() : queue.splice(index, 1)[0];
		return chosen ?? null;
	}

	function start(principalId: string): void {
		inflight += 1;
		running.set(principalId, (running.get(principalId) ?? 0) + 1);
	}

	function release(principalId: string): void {
		inflight -= 1;
		const count = (running.get(principalId) ?? 1) - 1;
		if (count <= 0) running.delete(principalId);
		else running.set(principalId, count);
		const next = nextWaiter();
		if (next !== null) next.resolve();
	}

	return {
		async admit(principalId, origin) {
			if ((await userTurnsLastMinute(principalId)) >= limits.userPerMinute) {
				return refuse(principalId, 'user_rate');
			}
			if ((await globalTurnsLastMinute()) >= limits.globalPerMinute) {
				return refuse(principalId, 'global_rate');
			}
			const spent = await tokensToday(principalId);
			if (spent.total >= limits.userDailyTokens) {
				return refuse(principalId, 'user_budget');
			}
			if (
				spendsTheShare(origin) &&
				spent.share >= (1 - limits.chatReserve) * limits.userDailyTokens
			) {
				return refuse(principalId, 'event_share');
			}
			const busy = (running.get(principalId) ?? 0) + (waiting.get(principalId) ?? 0);
			if (busy > limits.userQueue) return refuse(principalId, 'user_queue_full');
			if (inflight >= limits.maxInflight || (running.get(principalId) ?? 0) > 0) {
				waiting.set(principalId, (waiting.get(principalId) ?? 0) + 1);
				log.info(
					{ principal: principalId, inflight, queued: queue.length + 1 },
					'admission queued'
				);
				await new Promise<void>((resolve) => queue.push({ principalId, resolve }));
				waiting.set(principalId, (waiting.get(principalId) ?? 1) - 1);
			}
			start(principalId);
			await recordStart(principalId);
			log.info({ principal: principalId, inflight, queued: queue.length }, 'admission granted');
			let released = false;
			return {
				ok: true,
				release: () => {
					if (released) return;
					released = true;
					release(principalId);
				}
			};
		},
		async recordUsage(principalId, tokens, origin) {
			if (tokens <= 0) return;
			const of = (counted: SpendingOrigin): number => (origin === counted ? tokens : 0);
			await withPrincipal(
				db,
				{ id: principalId },
				(tx) => tx.sql`
					insert into usage_daily (owner, day, tokens, event_tokens, brief_tokens)
					values (${principalId}, ${today()}, ${tokens}, ${of('event')}, ${of('brief')})
					on conflict (owner, day) do update set
						tokens = usage_daily.tokens + excluded.tokens,
						event_tokens = usage_daily.event_tokens + excluded.event_tokens,
						brief_tokens = usage_daily.brief_tokens + excluded.brief_tokens`
			);
		},
		async shareNoticeDue(tx, principalId) {
			// Never during the owner's quiet hours: the first refusal past them tells them
			const { timeZone, quiet } = await findOwnerSettings(tx, principalId);
			const hours = quietHoursOf(quiet, config.quietHours);
			if (isQuietAt(hours, timeZone ?? config.timeZone, clock.now())) return false;
			const rows = await tx.sql`
				insert into usage_daily (owner, day, share_noticed) values (${principalId}, ${today()}, true)
				on conflict (owner, day) do update set share_noticed = true
				where usage_daily.share_noticed = false
				returning 1`;
			return rows.length > 0;
		},
		snapshot: () => ({ inflight, queued: queue.length, refused: { ...refused } })
	};
}
