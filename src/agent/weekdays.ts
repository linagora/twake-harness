import type { Locale } from '../i18n/messages.js';
import type { LlmMessage } from '../llm/client.js';
import { withDataChanged } from '../llm/data.js';
import { describeMoment, type TimeZone } from './clock.js';

// The names of the days of the week, from Sunday, and of the months, as a language writes a date
interface Names {
	readonly weekdays: readonly string[];
	readonly months: readonly string[];
}

const FRENCH: Names = {
	weekdays: ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'],
	months: [
		'janvier',
		'février',
		'mars',
		'avril',
		'mai',
		'juin',
		'juillet',
		'août',
		'septembre',
		'octobre',
		'novembre',
		'décembre'
	]
};

const ENGLISH: Names = {
	weekdays: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
	months: [
		'January',
		'February',
		'March',
		'April',
		'May',
		'June',
		'July',
		'August',
		'September',
		'October',
		'November',
		'December'
	]
};

// One way of a language to write a date its day is named before, which the pattern finds with its
// weekday, day, month and year, when written
interface Writing {
	readonly names: Names;
	readonly pattern: RegExp;
}

function writing(names: Names, datePattern: string): Writing {
	return {
		names,
		pattern: new RegExp(
			`(?<![\\p{L}\\p{N}])(?<weekday>${names.weekdays.join('|')})${datePattern}(?![\\p{L}\\p{N}])`,
			'giu'
		)
	};
}

const WRITINGS: readonly Writing[] = [
	// « mardi 13 octobre 2026 », « mardi 13 octobre », « jeudi 1er octobre », « mardi, 13 octobre »,
	// « mardi le 13 octobre »
	writing(
		FRENCH,
		`,?\\s+(?:le\\s+)?(?<day>\\d{1,2})(?:er)?\\s+(?<month>${FRENCH.months.join('|')})(?:\\s+(?<year>\\d{4}))?`
	),
	// "Tuesday, October 13, 2026", "Tuesday October 13th"
	writing(
		ENGLISH,
		`,?\\s+(?<month>${ENGLISH.months.join('|')})\\s+(?<day>\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(?<year>\\d{4}))?`
	),
	// "Tuesday 13 October 2026", "Tuesday, the 13th of October"
	writing(
		ENGLISH,
		`,?\\s+(?:the\\s+)?(?<day>\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(?<month>${ENGLISH.months.join('|')})(?:,?\\s+(?<year>\\d{4}))?`
	)
];

interface WrittenDate {
	readonly weekday?: string;
	readonly day?: string;
	readonly month?: string;
	readonly year?: string;
}

const DAY_MS = 86_400_000;

// How far from the owner's day a date written without its year may be, in days, in the year it is
// read in: half a year, before or after
const NEAREST_DAYS = 183;

// A date of the calendar, as the time since 1970 at its midnight in UTC; null for one there is not
function dayOf(year: number, month: number, day: number): number | null {
	const date = new Date(Date.UTC(year, month - 1, day));
	return date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? date.getTime() : null;
}

function weekdayAt(day: number): number {
	return new Date(day).getUTCDay();
}

// The day of the week a date names, from 0 for Sunday, given the one the model wrote: from its year
// when written, and otherwise from the year nearest to the owner's day, unless the model's day is
// that of the date in another year near it, as the 13th of a month half a year away may be; null
// for a date there is not
function trueWeekday(
	written: number,
	date: { readonly day: number; readonly month: number; readonly year: number | null },
	today: string
): number | null {
	if (date.year !== null) {
		const day = dayOf(date.year, date.month, date.day);
		return day === null ? null : weekdayAt(day);
	}
	const from = Date.parse(`${today}T00:00:00Z`);
	const year = new Date(from).getUTCFullYear();
	const near = [year - 1, year, year + 1]
		.map((candidate) => dayOf(candidate, date.month, date.day))
		.filter((day): day is number => day !== null && Math.abs(day - from) <= NEAREST_DAYS * DAY_MS)
		.sort((a, b) => Math.abs(a - from) - Math.abs(b - from));
	if (near.length === 0) return null;
	if (near.some((day) => weekdayAt(day) === written)) return written;
	return weekdayAt(near[0] ?? from);
}

// The place of a name in a list of them, whatever its case; -1 for none
function indexOf(names: readonly string[], name: string): number {
	return names.findIndex((candidate) => candidate.toLowerCase() === name.toLowerCase());
}

// A name in the case of the one it replaces: in capitals, with a capital first, or in lower case
function casedAs(name: string, written: string): string {
	if (written.length > 1 && written === written.toUpperCase()) return name.toUpperCase();
	const lower = name.toLowerCase();
	const first = written.charAt(0);
	return first === first.toUpperCase()
		? `${lower.charAt(0).toUpperCase()}${lower.slice(1)}`
		: lower;
}

// The model's words with the day of each date they write named from the date itself, a date
// without its year read in the year nearest to the owner's day, as ISO 8601 writes it: a model
// works that name out from the date, and gets it wrong
export function withTrueWeekdays(text: string, today: string): string {
	return WRITINGS.reduce(
		(words, { names, pattern }) =>
			words.replace(pattern, (written: string, ...rest: unknown[]) => {
				const { weekday: named = '', day = '', month = '', year } = rest.at(-1) as WrittenDate;
				const weekday = trueWeekday(
					indexOf(names.weekdays, named),
					{
						day: Number(day),
						month: indexOf(names.months, month) + 1,
						year: year === undefined ? null : Number(year)
					},
					today
				);
				const name = weekday === null ? undefined : names.weekdays[weekday];
				return name === undefined
					? written
					: `${casedAs(name, named)}${written.slice(named.length)}`;
			}),
		text
	);
}

// A date as ISO 8601 writes it, then the time of that day RFC 3339 may write after it, with its
// offset or Z, or without one for a time that floats, as iCalendar writes one
const DATE_TIME =
	/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/i;

// The key of an event's end: that of a whole day's event is the day after its last, as iCalendar
// writes it (RFC 5545), which its words would name as if the event lasted that day too
const END = 'end';

// A date in words, its day of the week included, in the owner's language: "mardi 13 octobre 2026";
// a time, in their zone, or as written for one that floats: "mardi 13 octobre 2026, 18:00"; null
// for any other text, and for the day an event ends after
function inWords(key: string, text: string, timeZone: TimeZone, locale: Locale): string | null {
	const [, year, month, day, hour, minute, offset] = DATE_TIME.exec(text) ?? [];
	const date = dayOf(Number(year), Number(month), Number(day));
	if (date === null) return null;
	if (hour === undefined) {
		return key === END ? null : describeMoment(new Date(date), 'UTC', locale).date;
	}
	if (offset === undefined) {
		const [hours, minutes] = [Number(hour), Number(minute)];
		if (hours > 23 || minutes > 59) return null;
		const wall = new Date(date + (hours * 60 + minutes) * 60_000);
		return describeMoment(wall, 'UTC', locale).words;
	}
	const instant = new Date(text);
	return Number.isNaN(instant.getTime()) ? null : describeMoment(instant, timeZone, locale).words;
}

// Data with each date it gives written in words beside it, under its key ending in _in_words; what
// people wrote, under untrusted, stays as they wrote it
function withWords(value: unknown, words: (key: string, text: string) => string | null): unknown {
	if (Array.isArray(value)) return value.map((item) => withWords(item, words));
	if (typeof value !== 'object' || value === null) return value;
	const record = value as Record<string, unknown>;
	const entries: [string, unknown][] = [];
	for (const [key, item] of Object.entries(record)) {
		if (key === 'untrusted') {
			entries.push([key, item]);
			continue;
		}
		entries.push([key, withWords(item, words)]);
		const said = typeof item === 'string' ? words(key, item) : null;
		const beside = `${key}_in_words`;
		if (said !== null && !Object.hasOwn(record, beside)) entries.push([beside, said]);
	}
	return Object.fromEntries(entries);
}

// What the model reads, with each date the harness hands it as data, in a tool's answer or between
// the fences of a message, written in words beside it, in the owner's language and zone: a model
// works the day of the week out from an ISO 8601 date, and gets it wrong, when it could copy it
export function withDatesInWords(
	messages: readonly LlmMessage[],
	timeZone: TimeZone,
	locale: Locale
): LlmMessage[] {
	return withDataChanged(messages, (data) =>
		withWords(data, (key, text) => inWords(key, text, timeZone, locale))
	);
}
