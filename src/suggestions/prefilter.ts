// The cheap test that decides whether a channel message goes to the model at all: it names a date
// or a time AND shows the intent to meet, in French or English. Pure, so that it runs before any
// admission, request or model call. It is a net, not a judge: the model decides what to propose.

// Longer than a line of chat is not an arrangement to meet
export const MAX_LENGTH = 600;

const WEEKDAYS =
	'lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche|monday|tuesday|wednesday|thursday|friday|saturday|sunday';
const MONTHS =
	'janvier|février|fevrier|mars|avril|mai|juin|juillet|août|aout|septembre|octobre|novembre|décembre|decembre|january|february|march|april|june|july|august|september|october|november|december';

const DATE_PATTERNS: readonly RegExp[] = [
	new RegExp(`\\b(${WEEKDAYS})\\b`),
	/\b(demain|après-demain|apres-demain|ce soir|ce matin|cet après-midi|cet apres-midi|la semaine prochaine|semaine prochaine|tomorrow|tonight|this afternoon|this morning|next week|next month|le mois prochain)\b/,
	// 10h, 10h30, 9 h 30
	/\b\d{1,2}\s?h\s?(\d{2})?\b/,
	// 10am, 3:30 pm
	/\b\d{1,2}(:\d{2})?\s?(am|pm)\b/,
	// 14:30
	/\b\d{1,2}:\d{2}\b/,
	// 12/10, 12.10.2026, 12-10
	/\b\d{1,2}[/.-]\d{1,2}([/.-]\d{2,4})?\b/,
	new RegExp(`\\b\\d{1,2}(er)?\\s(${MONTHS})\\b`),
	new RegExp(`\\b(${MONTHS})\\s\\d{1,2}\\b`)
];

const INTENT_PATTERNS: readonly RegExp[] = [
	/\bon (en )?parle\b/,
	/\bon se (voit|vois|call|appelle|parle|retrouve|capte|joint)\b/,
	/\bon (s'appelle|s’appelle|se fait)\b/,
	// peut-on se voir, pour te voir, on pourrait se parler
	/\b(se|te|vous|nous) (voir|retrouver|parler|capter|caler|rejoindre)\b/,
	/\b(r[ée]union|rdv|rendez-vous|visio|appel|stand-?up|point (rapide|[ée]quipe)|caler|planifier|programmer)\b/,
	/\b(meeting|call|meet|catch[- ]?up|sync|schedule|book)\b/,
	/\b(let's|lets|we can|shall we|can we|could we|how about we) (talk|meet|chat|sync|catch up|call|discuss)\b/,
	/\bspeak (on|at|tomorrow|next)\b/
];

function normalize(text: string): string {
	return text.normalize('NFC').toLowerCase().replace(/’/g, "'");
}

export function mentionsDate(text: string): boolean {
	const normalized = normalize(text);
	return DATE_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function mentionsMeeting(text: string): boolean {
	const normalized = normalize(text);
	return INTENT_PATTERNS.some((pattern) => pattern.test(normalized));
}

// Whether a message may be about meeting at a given time
export function mayArrangeMeeting(text: string): boolean {
	return text.length <= MAX_LENGTH && mentionsDate(text) && mentionsMeeting(text);
}
