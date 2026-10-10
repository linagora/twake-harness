import type { BriefResult } from '../agent/brief.js';
import { ACCESS_DENIED, CONVERSATION_GONE, type Tool, type ToolContext } from '../agent/tools.js';
import { ORGANIZATION_PRINCIPAL } from '../principals/principal.js';

// The tool by which the owner has their brief when they ask for it, which only their own turns are
// given, and none while the briefs are off: a turn an activity woke must not post it on what a third
// party wrote
export const BRIEF_NOW_TOOL: string = 'brief_now';

export interface BriefNowDeps {
	// The brief the owner asks for in their turn
	brief(context: ToolContext): Promise<BriefResult>;
}

// The owner has their brief when they ask for it, as the answer of their turn, which ends there: the
// brief of the day, marked as their brief, or the question it gives way to. The conversation keeps
// what the brief's numbers, its tasks' keys and its emails name as the call's result.
export function makeBriefNowTool(deps: BriefNowDeps): Tool {
	return {
		definition: {
			type: 'function',
			function: {
				name: BRIEF_NOW_TOOL,
				description:
					"Post the user's brief of today in this room, now, as their morning brief: their meetings of the day not over yet, the invitations waiting for their answer, their unread mail since their last brief, and their late tasks and those due today. Call it when they ask for their brief, whether or not their morning brief is stopped or paused. It ends your turn: the brief, or the question it asks first, is your answer.",
				parameters: { type: 'object', properties: {}, additionalProperties: false }
			}
		},
		argumentKeys: [],
		requiredAction: null,
		run: async (_args, context) => {
			// The organization agent sends no brief
			if (context.principalId === ORGANIZATION_PRINCIPAL) {
				return { result: ACCESS_DENIED, denied: true };
			}
			const brief = await deps.brief(context);
			switch (brief.kind) {
				case 'ok':
					return {
						result:
							brief.references === null
								? { posted: true }
								: { posted: true, references: brief.references },
						final: brief.text,
						brief: { date: brief.date, html: brief.html }
					};
				case 'question':
					return {
						result: { asked: true },
						final: brief.text,
						pendingCallId: brief.pendingCallId
					};
				case 'missing':
					return { result: CONVERSATION_GONE };
				default:
					return { result: { success: false, error: 'the brief could not be written' } };
			}
		}
	};
}
