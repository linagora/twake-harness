import { weekdayOf, type TimeZone, type Weekday } from '../agent/clock.js';
import { withPrincipal, type Db } from '../db/client.js';
import { findOwnerSettings, type BriefChoices } from '../settings/repository.js';

// The time an owner's brief is due unless they chose another, in minutes after midnight on their
// wall clock: eight o'clock
const DEFAULT_TIME = 8 * 60;

// The days it goes out unless they chose others: Monday to Friday
const DEFAULT_DAYS: readonly Weekday[] = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'];

// How long after the time the owner chose the scheduler still sends their brief, in minutes: three
// hours
export const BRIEF_WINDOW_MINUTES = 3 * 60;

// An owner's brief as it stands, the defaults in place of what they did not choose, and the zone
// of their calendar whose wall clock it follows, the deployment's until a read of it named one
export interface BriefSettings {
	readonly timeZone: TimeZone;
	// The time it is due, in minutes after midnight on their wall clock
	readonly time: number;
	readonly days: readonly Weekday[];
	// The date it goes out again after a pause, as dateIn gives it
	readonly pausedUntil: string | null;
	readonly stopped: boolean;
}

export function briefSettingsOf(choices: BriefChoices, timeZone: TimeZone): BriefSettings {
	return {
		timeZone,
		time: choices.time ?? DEFAULT_TIME,
		days: choices.days ?? DEFAULT_DAYS,
		pausedUntil: choices.pausedUntil,
		stopped: choices.stopped
	};
}

// Whether a pause holds the brief back on a date, as dateIn gives it: any date before its end
export function isPausedOn(settings: BriefSettings, date: string): boolean {
	return settings.pausedUntil !== null && date < settings.pausedUntil;
}

// Whether the brief goes out on a date of the owner's wall clock, as dateIn gives it: a day of the
// week they chose, out of a pause, while they have not stopped it
export function isBriefDate(settings: BriefSettings, date: string): boolean {
	return (
		!settings.stopped && settings.days.includes(weekdayOf(date)) && !isPausedOn(settings, date)
	);
}

// An owner's brief as it stands now, read with the zone it follows
export async function fetchBriefSettings(
	db: Db,
	owner: string,
	fallback: TimeZone
): Promise<BriefSettings> {
	const { timeZone, brief } = await withPrincipal(db, { id: owner }, (tx) =>
		findOwnerSettings(tx, owner)
	);
	return briefSettingsOf(brief, timeZone ?? fallback);
}
