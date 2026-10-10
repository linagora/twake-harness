import type { Locale } from '../i18n/messages.js';

// The present instant, as the harness asks for it: production reads the system clock, tests pass
// a clock they set by hand
export interface Clock {
	now(): Date;
}

export const SYSTEM_CLOCK: Clock = { now: () => new Date() };

// The canonical name of an IANA time zone the runtime knows, as only findTimeZone gives one: a zone
// read elsewhere, in a setting or a contract's answer, becomes one there
export type TimeZone = string & { readonly __brand: 'TimeZone' };

// The canonical name of an IANA time zone the runtime knows, or null for any other name
export function findTimeZone(zone: string): TimeZone | null {
	try {
		const { timeZone } = new Intl.DateTimeFormat('en-US', { timeZone: zone }).resolvedOptions();
		return timeZone as TimeZone;
	} catch {
		return null;
	}
}

// One instant, as a person in the zone reads it and as a contract expects it
export interface Moment {
	// The date and time in words, in the owner's language: "mardi 6 octobre 2026, 13:26"
	readonly words: string;
	// Its date and its time apart, for a sentence of its own: "mardi 6 octobre 2026" and "13:26"
	readonly date: string;
	readonly time: string;
	// The same instant in ISO 8601 with the zone's offset at that instant, never Z:
	// "2026-10-06T13:26:00+02:00"
	readonly iso: string;
	readonly timeZone: string;
}

function pad(value: number): string {
	return String(value).padStart(2, '0');
}

// An offset in minutes as RFC 3339 writes it: "+02:00", "-04:00", never Z
export function formatOffset(minutes: number): string {
	const sign = minutes < 0 ? '-' : '+';
	const absolute = Math.abs(minutes);
	return `${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;
}

// The wall clock of a zone at an instant, as the parts a person there reads
function wallClock(
	instant: Date,
	timeZone: string
): (type: Intl.DateTimeFormatPartTypes) => string {
	const parts = new Map(
		new Intl.DateTimeFormat('en-US', {
			timeZone,
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit',
			hourCycle: 'h23'
		})
			.formatToParts(instant)
			.map((part) => [part.type, part.value])
	);
	return (type) => parts.get(type) ?? '00';
}

// The date a person in the zone reads at an instant, as ISO 8601 writes it: "2026-10-06"
export function dateIn(instant: Date, timeZone: string): string {
	const field = wallClock(instant, timeZone);
	return `${field('year')}-${field('month')}-${field('day')}`;
}

// The instant a day of the zone starts, at its midnight, daylight saving time included: the day as
// ISO 8601 writes it, "2026-10-06"
function startOfDayIn(day: string, timeZone: string): Date {
	return new Date(wallTimeIn(`${day}T00:00:00`, timeZone) ?? `${day}T00:00:00Z`);
}

// The instant the day starts in the zone, at its midnight, daylight saving time included
export function midnightIn(instant: Date, timeZone: string): Date {
	return startOfDayIn(dateIn(instant, timeZone), timeZone);
}

// The instant the next day starts in the zone, at its midnight, daylight saving time included
export function nextMidnightIn(instant: Date, timeZone: string): Date {
	return startOfDayIn(dayAfter(dateIn(instant, timeZone)), timeZone);
}

// The day after a day, both as dateIn gives them
export function dayAfter(day: string): string {
	return new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

// The instant a time of a day of the zone names on its wall clock, daylight saving time included:
// the day as dateIn gives it, and the time in minutes after midnight, under a day's
export function instantIn(day: string, minutes: number, timeZone: string): Date {
	const wall = `${day}T${timeOfDay(minutes)}:00`;
	return new Date(wallTimeIn(wall, timeZone) ?? `${wall}Z`);
}

// The zone's offset at that instant, in minutes, daylight saving time included, whatever the
// server's own zone: the distance from the instant to the zone's wall clock then
export function offsetMinutesAt(instant: Date, timeZone: string): number {
	const field = wallClock(instant, timeZone);
	const wall = Date.UTC(
		Number(field('year')),
		Number(field('month')) - 1,
		Number(field('day')),
		Number(field('hour')),
		Number(field('minute')),
		Number(field('second'))
	);
	return Math.round((wall - Math.floor(instant.getTime() / 1000) * 1000) / 60_000);
}

// A wall time without offset, such as 2026-10-13T18:00:00, its fraction of a second left out
const WALL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/;

function isCalendarDate(year: string, month: string, day: string): boolean {
	const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
	return (
		date.getUTCFullYear() === Number(year) &&
		date.getUTCMonth() === Number(month) - 1 &&
		date.getUTCDate() === Number(day)
	);
}

// A wall time in a zone the runtime knows, such as Europe/Paris, as RFC 3339 with the zone's offset
// at that time: the offset at the instant first guessed, then again at the instant that offset
// gives, which settles a time near a change of offset, daylight saving time included; null for a
// time or a zone it cannot read
export function wallTimeIn(wall: string, timeZone: string): string | null {
	const zone = findTimeZone(timeZone);
	const match = WALL.exec(wall);
	if (zone === null || match === null) return null;
	const [, year = '', month = '', day = '', hour = '', minute = '', second = '00'] = match;
	if (!isCalendarDate(year, month, day)) return null;
	const at = Date.UTC(
		Number(year),
		Number(month) - 1,
		Number(day),
		Number(hour),
		Number(minute),
		Number(second)
	);
	const guessed = offsetMinutesAt(new Date(at), zone);
	const settled = offsetMinutesAt(new Date(at - guessed * 60_000), zone);
	return `${year}-${month}-${day}T${hour}:${minute}:${second}${formatOffset(settled)}`;
}

export function describeMoment(instant: Date, timeZone: string, locale: Locale): Moment {
	const date = new Intl.DateTimeFormat(locale, {
		timeZone,
		weekday: 'long',
		day: 'numeric',
		month: 'long',
		year: 'numeric'
	}).format(instant);
	const time = new Intl.DateTimeFormat(locale, {
		timeZone,
		hour: '2-digit',
		minute: '2-digit',
		hourCycle: 'h23'
	}).format(instant);
	return { words: `${date}, ${time}`, date, time, iso: isoIn(instant, timeZone), timeZone };
}

// An instant in ISO 8601 with the zone's offset at that instant, never Z:
// "2026-10-06T13:26:00+02:00"
export function isoIn(instant: Date, timeZone: string): string {
	const field = wallClock(instant, timeZone);
	return `${dateIn(instant, timeZone)}T${field('hour')}:${field('minute')}:${field('second')}${formatOffset(offsetMinutesAt(instant, timeZone))}`;
}

// The day, the hour and the minute of a zone's wall clock at an instant: 2026-10-08, 9 and 30 at
// half past nine in the morning there
export interface WallDay {
	readonly date: string;
	readonly hour: number;
	readonly minute: number;
}

export function wallDayAt(instant: Date, timeZone: string): WallDay {
	const field = wallClock(instant, timeZone);
	return {
		date: dateIn(instant, timeZone),
		hour: Number(field('hour')),
		minute: Number(field('minute'))
	};
}

// How many days of the calendar go from one day to another, both as dateIn gives them
export function daysFrom(from: string, to: string): number {
	return Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
}

// The days of the week, Monday first
export const WEEKDAYS = [
	'monday',
	'tuesday',
	'wednesday',
	'thursday',
	'friday',
	'saturday',
	'sunday'
] as const;
export type Weekday = (typeof WEEKDAYS)[number];

// The day of the week of a day as dateIn gives it
export function weekdayOf(date: string): Weekday {
	const day = new Date(`${date}T00:00:00Z`).getUTCDay();
	return WEEKDAYS[(day + 6) % 7] ?? 'monday';
}

// A day written as dateIn writes it
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

// Whether a text is a day of the calendar as dateIn writes it: 2026-10-20, never 2026-02-30
export function isCalendarDay(text: string): boolean {
	const match = DAY.exec(text);
	if (match === null) return false;
	const [, year = '', month = '', day = ''] = match;
	return isCalendarDate(year, month, day);
}

// A time of day in minutes after midnight, as a wall clock shows it: 07:30 for 450
export function timeOfDay(minutes: number): string {
	return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

// A time of day as the model or a deployment writes it, 07:30, in minutes after midnight, when it
// falls on the quarter hour; null otherwise
export function quarterHourOf(time: string): number | null {
	const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
	if (match === null) return null;
	const hours = Number(match[1]);
	const minutes = Number(match[2]);
	return hours > 23 || minutes > 59 || minutes % 15 !== 0 ? null : hours * 60 + minutes;
}
