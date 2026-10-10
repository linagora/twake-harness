import { z } from 'zod';

import {
	dateIn,
	isCalendarDay,
	quarterHourOf,
	timeOfDay,
	WEEKDAYS,
	type Clock,
	type TimeZone
} from '../agent/clock.js';
import { ACCESS_DENIED, WRITE_OWN_SETTINGS, type Tool } from '../agent/tools.js';
import { withPrincipal } from '../db/client.js';
import { ORGANIZATION_PRINCIPAL } from '../principals/principal.js';
import { findOwnerSettings, saveBriefChoices, type BriefChoices } from '../settings/repository.js';
import { briefSettingsOf, isPausedOn, type BriefSettings } from './settings.js';

// The tool by which the owner sets their morning brief, which only their own turns are given: a
// turn an activity woke must not move or stop it on what a third party wrote
export const BRIEF_SETTINGS_TOOL: string = 'brief_settings';

export interface BriefSettingsDeps {
	// The present, whose date in the owner's zone a pause must end after
	readonly clock: Clock;
	// The deployment's zone, until a read of the owner's calendar names theirs
	readonly timeZone: TimeZone;
}

const ACTIONS = ['show', 'time', 'days', 'pause', 'stop', 'resume'] as const;

const briefArgs = z.object({
	action: z.enum(ACTIONS),
	time: z.string().optional(),
	days: z.array(z.enum(WEEKDAYS)).optional(),
	until: z.string().optional()
});

type BriefArgs = z.infer<typeof briefArgs>;

// What the owner's request makes of what they chose, on the date they read on their wall clock,
// or why it is refused. To resume the brief ends its pause too.
function changeOf(
	args: BriefArgs,
	brief: BriefChoices,
	today: string
): { readonly choices: BriefChoices } | { readonly error: string } {
	switch (args.action) {
		case 'show':
			return { choices: brief };
		case 'time': {
			const time = quarterHourOf(args.time ?? '');
			return time === null
				? { error: 'time must be HH:MM on the quarter hour, such as 07:30 or 07:45' }
				: { choices: { ...brief, time } };
		}
		case 'days': {
			const days = WEEKDAYS.filter((day) => args.days?.includes(day));
			return days.length === 0
				? { error: 'days needs one day at least; to stop the brief, use stop' }
				: { choices: { ...brief, days } };
		}
		case 'pause': {
			const until = args.until ?? '';
			return isCalendarDay(until) && until > today
				? { choices: { ...brief, pausedUntil: until } }
				: { error: `until must be a date after today, ${today}, written YYYY-MM-DD` };
		}
		case 'stop':
			return { choices: { ...brief, stopped: true } };
		case 'resume':
			return { choices: { ...brief, stopped: false, pausedUntil: null } };
	}
}

// The brief as the model reads it, on the date the owner reads on their wall clock: a pause that
// ended is none
function viewOf(settings: BriefSettings, today: string): Record<string, unknown> {
	return {
		time: timeOfDay(settings.time),
		days: settings.days,
		paused_until: isPausedOn(settings, today) ? settings.pausedUntil : null,
		stopped: settings.stopped,
		time_zone: settings.timeZone
	};
}

// The owner sets their brief in conversation: the time it is due, its days, a pause, or a stop
// until they resume it
export function makeBriefSettingsTool(deps: BriefSettingsDeps): Tool {
	return {
		definition: {
			type: 'function',
			function: {
				name: BRIEF_SETTINGS_TOOL,
				description:
					"Read or set the user's morning brief, which you post in this room at 08:00 in their zone, Monday to Friday, unless they chose another time or other days. Change it only when they ask. show reads it. time sets the time it is due, on the quarter hour, such as 07:30. days sets every day of the week it goes out, not only those they name. pause holds it back until a date, on which it goes out again by itself. stop holds it back until they resume it. resume ends a stop and a pause. Every call answers the brief as it stands.",
				parameters: {
					type: 'object',
					properties: {
						action: { type: 'string', enum: ACTIONS },
						time: {
							type: 'string',
							description: 'For time: HH:MM in their zone, on the quarter hour, such as 07:30'
						},
						days: {
							type: 'array',
							items: { type: 'string', enum: WEEKDAYS },
							description: 'For days: every day of the week the brief goes out'
						},
						until: {
							type: 'string',
							description:
								'For pause: the date the brief goes out again, YYYY-MM-DD, after today in their zone'
						}
					},
					required: ['action'],
					additionalProperties: false
				}
			}
		},
		argumentKeys: ['action', 'time', 'days', 'until'],
		requiredAction: WRITE_OWN_SETTINGS,
		run: async (args, context) => {
			const owner = context.principalId;
			// The organization agent sends no brief
			if (owner === ORGANIZATION_PRINCIPAL) return { result: ACCESS_DENIED, denied: true };
			const parsed = briefArgs.safeParse(args);
			if (!parsed.success) return { result: { success: false, error: 'invalid arguments' } };
			const result = await withPrincipal(context.db, { id: owner }, async (tx) => {
				const { timeZone, brief } = await findOwnerSettings(tx, owner);
				const zone = timeZone ?? deps.timeZone;
				const today = dateIn(deps.clock.now(), zone);
				const change = changeOf(parsed.data, brief, today);
				if ('error' in change) {
					return {
						success: false,
						error: change.error,
						brief: viewOf(briefSettingsOf(brief, zone), today)
					};
				}
				if (change.choices !== brief) await saveBriefChoices(tx, owner, change.choices);
				return { success: true, brief: viewOf(briefSettingsOf(change.choices, zone), today) };
			});
			return { result };
		}
	};
}
