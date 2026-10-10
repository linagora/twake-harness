import { createHash } from 'node:crypto';

import { wallDayAt } from '../agent/clock.js';
import {
	findAssistant,
	isActiveAssistant,
	listActiveAssistants
} from '../assistants/repository.js';
import { withPrincipal } from '../db/client.js';
import { BRIEF_EVENT_TYPE } from '../wakeups/event-types.js';
import { BRIEF_SOURCE, releaseHeld, wake, type WakeDeps } from '../wakeups/wake.js';
import { BRIEF_WINDOW_MINUTES, fetchBriefSettings, isBriefDate } from './settings.js';

// What a scheduler knows of each owner's brief between its passes: the date it is done with, sent,
// skipped, or not to send, at the time it was due then, which its next passes look no further at
// until the owner's next date or another time they choose; or the date of the brief their hourly
// cap held back, which its next passes try again without saying so again
export type SettledBriefs = Map<
	string,
	{ readonly date: string; readonly time: number; readonly capped: boolean }
>;

// The id of an owner's brief of a date: the same on every pass and every replica, and another for
// every other owner, so that their wake-ups, logs and calls through the gateway tell the briefs
// apart without naming whose they are
export function briefId(owner: string, date: string): string {
	const digest = createHash('sha256')
		.update(JSON.stringify([owner, date]))
		.digest('hex');
	return `brief-${date}-${digest.slice(0, 16)}`;
}

// Whether a pass woke the owner for that brief, which the wake-ups keep for two days at least
async function wasWoken(deps: WakeDeps, owner: string, id: string): Promise<boolean> {
	const rows = await deps.db.sql`
		select 1 from wakeups where source = ${BRIEF_SOURCE} and event_id = ${id} and owner = ${owner}`;
	return rows.length > 0;
}

// One owner's brief at this pass, on their wall clock: from the time they chose, eight unless they
// chose another, on a day they chose, out of a pause and unless they stopped it, their assistant is
// woken for the brief of that date, which wake() keeps from going twice, as it keeps any wake-up,
// and counts in their hourly wake-ups. One their cap held back is tried again at the next pass,
// the first one alone saying so. Three hours past that time, the day is theirs no more: a brief
// that never went is skipped, which a line says. Another time they choose that day opens it again,
// as a restart of the scheduler would. Their settings and their wall clock are read first, as they
// are all most passes need of them.
async function briefOwner(deps: WakeDeps, owner: string, settled: SettledBriefs): Promise<void> {
	const { config, db, clock, log } = deps;
	const brief = await fetchBriefSettings(db, owner, config.timeZone);
	const { timeZone, time } = brief;
	const { date, hour, minute } = wallDayAt(clock.now(), timeZone);
	const minutes = hour * 60 + minute;
	const known = settled.get(owner);
	const done = known?.date === date && known.time === time && !known.capped;
	if (done || !isBriefDate(brief, date) || minutes < time) return;
	const assistant = await withPrincipal(db, { id: owner }, (tx) => findAssistant(tx, owner));
	if (!isActiveAssistant(assistant)) return;
	const id = briefId(owner, date);
	if (minutes >= time + BRIEF_WINDOW_MINUTES) {
		settled.set(owner, { date, time, capped: false });
		if (!(await wasWoken(deps, owner, id))) {
			log.info({ owner, date, timeZone, id }, 'morning brief skipped');
		}
		return;
	}
	const outcome = await wake(
		deps,
		{
			source: BRIEF_SOURCE,
			id,
			type: BRIEF_EVENT_TYPE,
			recipient: { email: owner, uuid: null, reason: 'owner' },
			actor: { email: null, uuid: null },
			shown: { computed: { type: BRIEF_EVENT_TYPE, source: BRIEF_SOURCE, id }, untrusted: {} },
			brief: { date }
		},
		{ logCapped: known?.date !== date }
	);
	settled.set(owner, { date, time, capped: outcome === 'capped' });
}

// One pass over the owners whose assistant is in its room, one after the other: their brief, when
// BRIEF_ENABLED is on, then what their quiet hours held that is due to wake them. An owner whose
// brief could not be looked at, or what their quiet hours held, is skipped with a warning, and the
// pass goes on with the next one. A pass told to stop stops before the next owner.
export async function runBriefPass(
	deps: WakeDeps,
	settled: SettledBriefs = new Map(),
	stopping: () => boolean = () => false
): Promise<void> {
	const owners = [...new Set((await listActiveAssistants(deps.db)).map(({ owner }) => owner))];
	for (const owner of owners.sort((a, b) => a.localeCompare(b))) {
		if (stopping()) break;
		if (deps.config.brief.enabled) {
			try {
				await briefOwner(deps, owner, settled);
			} catch (err: unknown) {
				deps.log.warn({ owner, err }, 'morning brief failed');
			}
		}
		try {
			await releaseHeld(deps, owner);
		} catch (err: unknown) {
			deps.log.warn({ owner, err }, 'quiet hours release failed');
		}
	}
}

export interface BriefScheduler {
	// Stops looking, once the pass under way, if any, is done with its owner of the moment
	stop(): Promise<void>;
}

// Passes at once, then every checkMs. When BRIEF_ENABLED is on, each owner's brief goes out on the
// days and from the time they chose, Monday to Friday from eight unless they chose others, on the
// wall clock of their calendar's zone, the deployment's until a read of it named one. Kept by owner
// and date, as any wake-up, a brief goes out once, whether a pass runs again after a restart or on
// another replica. On or off, what each owner's quiet hours held wakes their assistant once due.
export function startBriefScheduler(deps: WakeDeps, checkMs: number): BriefScheduler {
	if (!deps.config.brief.enabled) {
		deps.log.info({ setting: 'BRIEF_ENABLED' }, 'morning briefs off');
	}
	const settled: SettledBriefs = new Map();
	let running: Promise<void> | null = null;
	let stopped = false;
	const tick = (): void => {
		if (running !== null || stopped) return;
		running = runBriefPass(deps, settled, () => stopped)
			.catch((err: unknown) => {
				deps.log.error({ err }, 'morning briefs failed');
			})
			.finally(() => {
				running = null;
			});
	};
	tick();
	const timer = setInterval(tick, checkMs);
	return {
		stop: async () => {
			stopped = true;
			clearInterval(timer);
			await running;
		}
	};
}
