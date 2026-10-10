import type { Locale } from '../i18n/messages.js';

const MAX_TITLE = 80;
const MAX_LISTED = 5;

// Words a person wrote, or the model wrote from theirs, shown as plain text on one line
function plain(text: string, max: number): string {
	const line = text
		.replace(/[\p{Cc}\p{Cf}]+/gu, ' ')
		.replace(/\s+/g, ' ')
		.trim();
	const characters = Array.from(line);
	return characters.length <= max ? line : `${characters.slice(0, max - 1).join('')}…`;
}

export interface Proposal {
	readonly title: string;
	readonly start: string;
	readonly end: string;
	readonly attendees: readonly string[];
	readonly timeZone: string;
}

function format(locale: Locale, timeZone: string, date: Date, options: Intl.DateTimeFormatOptions) {
	return new Intl.DateTimeFormat(locale, { timeZone, ...options }).format(date);
}

// The sentence a suggestion says, written by the harness from the call the model prepared, in the
// owner's language: the model's own words never reach the notification, only the slot, the title
// as plain text and the addresses that will be invited. A suggestion whose invitee's availability
// could not be seen adds the harness's own line saying so, without a reason.
export function proposalSentence(
	locale: Locale,
	proposal: Proposal,
	options: { readonly inviteeNotSeen?: string } = {}
): string {
	const { timeZone } = proposal;
	const start = new Date(proposal.start);
	const end = new Date(proposal.end);
	const day = format(locale, timeZone, start, { weekday: 'long', day: 'numeric', month: 'long' });
	const hours = { hour: 'numeric', minute: '2-digit' } as const;
	const from = format(locale, timeZone, start, hours);
	const to = format(locale, timeZone, end, hours);
	const listed = proposal.attendees.slice(0, MAX_LISTED).map((a) => plain(a, 80));
	const more = proposal.attendees.length - listed.length;
	const who = listed.join(', ') + (more > 0 ? ` +${more}` : '');
	const title = plain(proposal.title, MAX_TITLE);
	const sentence =
		locale === 'fr'
			? `Vous avez du temps libre le ${day}, de ${from} à ${to}. Planifier « ${title} » avec ${who} ?`
			: `You are free on ${day}, from ${from} to ${to}. Schedule “${title}” with ${who}?`;
	const { inviteeNotSeen } = options;
	return inviteeNotSeen === undefined ? sentence : `${sentence}\n${inviteeNotSeen}`;
}
