import { z } from 'zod';

import { quarterHourOf, timeOfDay, WEEKDAYS, type TimeZone } from '../agent/clock.js';
import { ACCESS_DENIED, WRITE_OWN_SETTINGS, type Tool } from '../agent/tools.js';
import { fetchOwnerMessages } from '../assistants/locale.js';
import { withPrincipal } from '../db/client.js';
import type { Locale, Messages } from '../i18n/messages.js';
import { ORGANIZATION_PRINCIPAL } from '../principals/principal.js';
import { findOwnerSettings, saveQuietChoices, type QuietChoices } from '../settings/repository.js';
import { hasQuietHours, quietHoursOf, type QuietHours } from './hours.js';

// The tool by which the owner sets their quiet hours, which only their own turns are given: a turn
// an activity woke must not silence nor wake them on what a third party wrote
export const QUIET_HOURS_TOOL: string = 'quiet_hours';

export interface QuietHoursDeps {
	// The deployment's zone, until a read of the owner's calendar names theirs
	readonly timeZone: TimeZone;
	// The deployment's language, for an owner who chose none
	readonly locale: Locale;
	// The deployment's quiet hours, QUIET_HOURS_DEFAULT, in place of what the owner did not choose
	readonly defaults: QuietHours;
}

const ACTIONS = ['show', 'hours', 'days', 'none'] as const;

const quietArgs = z.object({
	action: z.enum(ACTIONS),
	start: z.string().optional(),
	end: z.string().optional(),
	days: z.array(z.enum(WEEKDAYS)).optional()
});

type QuietArgs = z.infer<typeof quietArgs>;

// What the owner's request makes of what they chose, their quiet hours as they stand in place of a
// bound of their range they did not name, or why it is refused
function changeOf(
	args: QuietArgs,
	choices: QuietChoices,
	hours: QuietHours
): { readonly choices: QuietChoices } | { readonly error: string } {
	switch (args.action) {
		case 'show':
			return { choices };
		case 'hours': {
			const start =
				args.start === undefined ? (hours.range?.start ?? null) : quarterHourOf(args.start);
			const end = args.end === undefined ? (hours.range?.end ?? null) : quarterHourOf(args.end);
			if (start === null || end === null) {
				return {
					error:
						'start and end must be HH:MM on the quarter hour, such as 20:00 or 07:45; give both when they have no daily range'
				};
			}
			return start === end
				? { error: 'start and end must differ' }
				: { choices: { ...choices, start, end } };
		}
		case 'days':
			return args.days === undefined
				? { error: 'days needs every whole quiet day, none when empty' }
				: { choices: { ...choices, days: WEEKDAYS.filter((day) => args.days?.includes(day)) } };
		case 'none':
			return { choices: { start: 0, end: 0, days: [] } };
	}
}

// The quiet hours as the model reads them
function viewOf(hours: QuietHours, timeZone: TimeZone): Record<string, unknown> {
	return {
		hours:
			hours.range === null
				? null
				: { start: timeOfDay(hours.range.start), end: timeOfDay(hours.range.end) },
		days: hours.days,
		time_zone: timeZone
	};
}

// What the harness tells the owner of their quiet hours as they set them
function confirmationOf(hours: QuietHours, messages: Messages): string {
	if (!hasQuietHours(hours)) return messages.quietHours.none;
	const { range, days } = hours;
	return messages.quietHours.set(
		range === null ? null : { start: timeOfDay(range.start), end: timeOfDay(range.end) },
		days
	);
}

// The owner sets their quiet hours in conversation, during which their assistant posts nothing on
// its own: a daily range, whole days, or none. Every change ends their turn on the harness's own
// words, in their language.
export function makeQuietHoursTool(deps: QuietHoursDeps): Tool {
	return {
		definition: {
			type: 'function',
			function: {
				name: QUIET_HOURS_TOOL,
				description:
					"Read or set the user's quiet hours, in their zone, during which you tell them nothing on your own: what reaches them then waits for their brief or the end of those hours, unless it is a meeting that starts before. Unless they chose others, they run from 20:00 to 08:00 every day and all of Saturday and Sunday. Change them only when they ask. show reads them. hours sets the daily range, such as start 19:00 for nothing after 19:00, keeping the bound they do not name. days sets every whole quiet day, not only those they name, none when empty. none removes both, for no quiet hours at all.",
				parameters: {
					type: 'object',
					properties: {
						action: { type: 'string', enum: ACTIONS },
						start: {
							type: 'string',
							description: 'For hours: HH:MM in their zone, on the quarter hour, when they start'
						},
						end: {
							type: 'string',
							description: 'For hours: HH:MM in their zone, on the quarter hour, when they end'
						},
						days: {
							type: 'array',
							items: { type: 'string', enum: WEEKDAYS },
							description: 'For days: every whole quiet day of the week'
						}
					},
					required: ['action'],
					additionalProperties: false
				}
			}
		},
		argumentKeys: ['action', 'start', 'end', 'days'],
		requiredAction: WRITE_OWN_SETTINGS,
		run: async (args, context) => {
			const owner = context.principalId;
			// The organization agent posts nothing on its own
			if (owner === ORGANIZATION_PRINCIPAL) return { result: ACCESS_DENIED, denied: true };
			const parsed = quietArgs.safeParse(args);
			if (!parsed.success) return { result: { success: false, error: 'invalid arguments' } };
			const { result, set } = await withPrincipal(context.db, { id: owner }, async (tx) => {
				const { timeZone, quiet } = await findOwnerSettings(tx, owner);
				const zone = timeZone ?? deps.timeZone;
				const hours = quietHoursOf(quiet, deps.defaults);
				const change = changeOf(parsed.data, quiet, hours);
				if ('error' in change) {
					return {
						result: { success: false, error: change.error, quiet_hours: viewOf(hours, zone) },
						set: null
					};
				}
				if (change.choices !== quiet) await saveQuietChoices(tx, owner, change.choices);
				const chosen = quietHoursOf(change.choices, deps.defaults);
				return {
					result: { success: true, quiet_hours: viewOf(chosen, zone) },
					set: parsed.data.action === 'show' ? null : chosen
				};
			});
			if (set === null) return { result };
			context.log.info({ quietHours: set }, 'quiet hours set');
			const messages = await fetchOwnerMessages(context.db, owner, deps.locale);
			return { result, final: confirmationOf(set, messages) };
		}
	};
}
