import {
	dayAfter,
	instantIn,
	quarterHourOf,
	wallDayAt,
	weekdayOf,
	WEEKDAYS,
	type Weekday
} from '../agent/clock.js';
import type { QuietChoices } from '../settings/repository.js';

// The minutes of a day
const DAY_MINUTES = 24 * 60;

// How many days on the end of quiet hours is looked for: the quiet hours of an owner quiet all
// week end a week on
const MAX_QUIET_DAYS = 7;

// An owner's quiet hours, during which their assistant posts nothing on its own, on the wall clock
// of their zone: a daily range, in minutes after midnight, on the quarter hour, which crosses
// midnight when it ends before it starts, or none; and whole days, in the order of the week
export interface QuietHours {
	readonly range: { readonly start: number; readonly end: number } | null;
	readonly days: readonly Weekday[];
}

// A range as a deployment writes it: 20:00-08:00
const RANGE = /^(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$/;

// Quiet hours as a deployment writes them, in QUIET_HOURS_DEFAULT: a range and whole days, such as
// "20:00-08:00 saturday sunday", either alone, or none, which an empty text also means; null for
// anything else, such as a time off the quarter hour or a range that ends as it starts
export function parseQuietHours(text: string): QuietHours | null {
	const words = text.trim().toLowerCase().split(/\s+/);
	if (words.join('') === '' || words.join(' ') === 'none') return { range: null, days: [] };
	let range: QuietHours['range'] = null;
	const days = new Set<string>();
	for (const word of words) {
		const bounds = RANGE.exec(word);
		if (bounds !== null) {
			const start = quarterHourOf(bounds[1] ?? '');
			const end = quarterHourOf(bounds[2] ?? '');
			if (range !== null || start === null || end === null || start === end) return null;
			range = { start, end };
		} else if ((WEEKDAYS as readonly string[]).includes(word)) {
			days.add(word);
		} else {
			return null;
		}
	}
	return { range, days: WEEKDAYS.filter((day) => days.has(day)) };
}

// An owner's quiet hours as they stand: what they chose, the deployment's in place of what they
// did not
export function quietHoursOf(choices: QuietChoices, defaults: QuietHours): QuietHours {
	const { start, end } = choices;
	return {
		range: start === null || end === null ? defaults.range : start === end ? null : { start, end },
		days: choices.days ?? defaults.days
	};
}

export function hasQuietHours(hours: QuietHours): boolean {
	return hours.range !== null || hours.days.length > 0;
}

// The stretches of a day, as dateIn gives it, that are quiet, from a minute after its midnight to
// another, the last of them its next midnight: all of it for a quiet day, or its daily range,
// which a range that crosses midnight splits in two
function stretchesOf(hours: QuietHours, day: string): (readonly [number, number])[] {
	if (hours.days.includes(weekdayOf(day))) return [[0, DAY_MINUTES]];
	if (hours.range === null) return [];
	const { start, end } = hours.range;
	return start < end
		? [[start, end]]
		: [
				[0, end],
				[start, DAY_MINUTES]
			];
}

// The stretch of a day, as stretchesOf gives them, a minute of it falls in
function stretchAt(
	hours: QuietHours,
	day: string,
	minutes: number
): readonly [number, number] | null {
	return stretchesOf(hours, day).find(([from, to]) => from <= minutes && minutes < to) ?? null;
}

// Whether an instant falls in an owner's quiet hours, on the wall clock of their zone
export function isQuietAt(hours: QuietHours, timeZone: string, at: Date): boolean {
	const { date, hour, minute } = wallDayAt(at, timeZone);
	return stretchAt(hours, date, hour * 60 + minute) !== null;
}

// The instant the quiet hours an instant falls in end, on the wall clock of the owner's zone,
// whatever days they run over, a week on at the latest; null for an instant out of them
export function quietEndAfter(hours: QuietHours, timeZone: string, at: Date): Date | null {
	const { date, hour, minute } = wallDayAt(at, timeZone);
	let day = date;
	let minutes = hour * 60 + minute;
	for (let days = 0; days < MAX_QUIET_DAYS; days += 1) {
		const stretch = stretchAt(hours, day, minutes);
		if (stretch === null) return days === 0 ? null : instantIn(day, minutes, timeZone);
		if (stretch[1] < DAY_MINUTES) return instantIn(day, stretch[1], timeZone);
		day = dayAfter(day);
		minutes = 0;
	}
	return instantIn(day, minutes, timeZone);
}
