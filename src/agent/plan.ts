import { z } from 'zod';

import type { LlmMessage } from '../llm/client.js';
import { toolCallStatus, type ToolOutcome } from './tools.js';

export const PLAN_TOOL = 'plan';

// The most steps one plan may hold, which bounds how long a turn goes on
export const MAX_PLAN_STEPS = 8;

// One step of the plan of a turn: the model wrote what it is and named its tool; the harness alone
// marks it done, from the result of a call to that tool
export interface PlanStep {
	readonly what: string;
	readonly tool: string;
	readonly done: boolean;
	// For a write: false when the decision model was not sure the message asks for it, which then
	// waits for the owner's yes, in this turn and in the one their yes resumes
	readonly sure?: boolean;
	// A call to its tool ran and did not succeed: the owner is told, unless a later one does
	readonly failed?: boolean;
	// For a step done: what its call carried, as its owner reads it below the answer
	readonly detail?: string;
}

// What a turn knows of its tools, beside running them
export interface ToolCatalog {
	// What a tool does, in its own words, or null when the turn offers no such tool
	describe(tool: string): string | null;
	// Whether a tool acts for the owner in an application, rather than read
	isAction(tool: string): boolean;
	// What a call carried, as its owner reads it
	detail(args: unknown): string;
}

const planArgs = z.strictObject({
	steps: z
		.array(
			z.strictObject({
				what: z.string().min(1),
				tool: z.string().min(1),
				sure: z.boolean().optional()
			})
		)
		.min(1)
		.max(MAX_PLAN_STEPS)
});

export type PlanResult =
	| { readonly ok: true; readonly steps: readonly PlanStep[] }
	| { readonly ok: false; readonly error: string };

// The plan the model wrote, when every step names a tool the turn offers
export function readPlan(args: unknown, isTool: (name: string) => boolean): PlanResult {
	const parsed = planArgs.safeParse(args);
	if (!parsed.success) {
		return { ok: false, error: `a plan is 1 to ${MAX_PLAN_STEPS} steps, each with what and tool` };
	}
	const unknown = parsed.data.steps.filter((step) => step.tool === PLAN_TOOL || !isTool(step.tool));
	if (unknown.length > 0) {
		return { ok: false, error: `unknown tool: ${unknown.map((step) => step.tool).join(', ')}` };
	}
	return {
		ok: true,
		steps: parsed.data.steps.map(({ what, tool, sure }) => ({
			what,
			tool,
			done: false,
			...(sure === undefined ? {} : { sure })
		}))
	};
}

// Whether a call did what it was made for: it reached its tool, which answered without an error,
// and with a success when it answers with an HTTP status
function succeeded(outcome: ToolOutcome): boolean {
	if (toolCallStatus(outcome) !== 'ok') return false;
	const { result } = outcome;
	if (typeof result !== 'object' || result === null) return true;
	if ('error' in result) return false;
	if (!('status' in result)) return true;
	// A call that waits for its owner did nothing yet
	if (result.status === 'awaiting_owner') return false;
	if (typeof result.status !== 'number') return true;
	return result.status >= 200 && result.status < 300;
}

// The plan once a call ran: a call that succeeded does the first step left that names its tool
export function markDone(
	plan: readonly PlanStep[],
	tool: string,
	outcome: ToolOutcome,
	detail = ''
): readonly PlanStep[] {
	// A call that waits for its owner neither did its step nor failed at it
	if (toolCallStatus(outcome) === 'final' || isWaiting(outcome)) return plan;
	const index = plan.findIndex((step) => !step.done && step.tool === tool);
	if (!succeeded(outcome)) {
		return plan.map((step, i) => (i === index ? { ...step, failed: true } : step));
	}
	return plan.map((step, i) =>
		i === index ? { ...step, done: true, ...(detail.length === 0 ? {} : { detail }) } : step
	);
}

function isWaiting(outcome: ToolOutcome): boolean {
	const { result } = outcome;
	return (
		typeof result === 'object' &&
		result !== null &&
		'status' in result &&
		result.status === 'awaiting_owner'
	);
}

// The most characters of a call the owner reads below an answer
const DETAIL_CHARS = 400;
const VALUE_CHARS = 120;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

// What a call carried, for the owner who reads what was done: each of its arguments by its name,
// those of its body among them, and an instant as their language and their time zone write it
export function describeCall(args: unknown, locale: string, timeZone: string): string {
	const when = new Intl.DateTimeFormat(locale, { dateStyle: 'full', timeStyle: 'short', timeZone });
	const shown = (value: unknown): string | null => {
		if (typeof value === 'string') {
			const instant = INSTANT.test(value) ? new Date(value) : null;
			return instant !== null && !Number.isNaN(instant.getTime())
				? when.format(instant)
				: value.slice(0, VALUE_CHARS);
		}
		if (typeof value === 'number' || typeof value === 'boolean') return String(value);
		if (Array.isArray(value)) {
			const items = value.map(shown).filter((item) => item !== null);
			return items.length === 0 ? null : items.join(', ');
		}
		return null;
	};
	const parts = (fields: unknown, deep: boolean): string[] =>
		typeof fields !== 'object' || fields === null || Array.isArray(fields)
			? []
			: Object.entries(fields).flatMap(([name, value]) => {
					const text = shown(value);
					if (text !== null) return [`${name}: ${text}`];
					return deep ? parts(value, false) : [];
				});
	return parts(args, true).join(', ').slice(0, DETAIL_CHARS);
}

function parseJson(text: string | null | undefined): unknown {
	try {
		return JSON.parse(text ?? '') as unknown;
	} catch {
		return null;
	}
}

// The plan with a step for a call that acts for the owner, when no step left names its tool:
// nothing is done for the owner outside the plan, so a write the model did not plan becomes a step
// of it, in the words of its tool
export function withAction(
	plan: readonly PlanStep[] | null,
	tool: string,
	catalog: ToolCatalog
): readonly PlanStep[] | null {
	const what = catalog.describe(tool);
	if (what === null || !catalog.isAction(tool)) return plan;
	if (undoneSteps(plan).some((step) => step.tool === tool)) return plan;
	return [...(plan ?? []), { what, tool, done: false }];
}

// The plan of a turn its owner's answer resumes, as the conversation holds it: the last plan the
// model wrote since the owner's last message, the calls that act for the owner, and what the calls
// made since did, the one their owner allowed among them. The walk the answer resumes is a new
// one, and is held to the same plan.
export function planFromHistory(
	history: readonly LlmMessage[],
	catalog: ToolCatalog
): readonly PlanStep[] | null {
	const since = history.map((message) => message.role).lastIndexOf('user') + 1;
	const written = new Map<string, string>();
	const carried = new Map<string, string>();
	let plan: readonly PlanStep[] | null = null;
	for (const message of history.slice(since)) {
		for (const call of message.tool_calls ?? []) {
			if (call.function.name === PLAN_TOOL) written.set(call.id, call.function.arguments);
			else carried.set(call.id, call.function.arguments);
		}
		if (message.role !== 'tool' || message.name === undefined) continue;
		const result = parseJson(message.content);
		if (message.name !== PLAN_TOOL) {
			plan = withAction(plan, message.name, catalog);
			if (plan !== null) {
				const args = parseJson(carried.get(message.tool_call_id ?? ''));
				plan = markDone(plan, message.name, { result }, catalog.detail(args));
			}
			continue;
		}
		const read = readPlan(
			parseJson(written.get(message.tool_call_id ?? '')),
			(name) => catalog.describe(name) !== null
		);
		if (read.ok && typeof result === 'object' && result !== null && 'planned' in result) {
			plan = read.steps;
		}
	}
	return plan;
}

// The step of the plan that comes before the one a call would do, and was not attempted yet: a
// call that acts for the owner waits for it, so that what is to be checked first is checked first.
// A step whose call failed holds nothing back: the plan is a ledger, not an order
export function stepBefore(plan: readonly PlanStep[] | null, tool: string): PlanStep | null {
	const steps = plan ?? [];
	const index = steps.findIndex((step) => !step.done && step.tool === tool);
	return (
		steps.slice(0, Math.max(index, 0)).find((step) => !step.done && step.failed !== true) ?? null
	);
}

export function undoneSteps(plan: readonly PlanStep[] | null): readonly PlanStep[] {
	return (plan ?? []).filter((step) => !step.done);
}

// The steps whose call ran and failed, with none that succeeded since: what the owner is told was
// not done. A step the model left untried is not among them: the plan is a ledger of what was
// attempted, not an order, and a write a check rules out is rightly left.
export function failedSteps(plan: readonly PlanStep[] | null): readonly PlanStep[] {
	return (plan ?? []).filter((step) => !step.done && step.failed === true);
}

// What the model is told of its plan before each of its answers, in the system prompt: some chat
// templates refuse a system message after a tool's answer
export function planInstruction(plan: readonly PlanStep[]): string {
	const lines = plan.map(
		(step, i) =>
			`${i + 1}. [${step.done ? 'done' : step.failed === true ? 'failed' : 'to do'}] ${step.what} (${step.tool})`
	);
	const next =
		undoneSteps(plan).length === 0
			? 'Every step is done: answer the user now.'
			: 'Do the steps that apply, in this order. A step that turns out not to apply, such as an action that what you read rules out, is left as it is: tell the user why.';
	return `## Plan\nThe steps of this request. Each is marked done from the result of its tool call, never from what you write.\n${lines.join('\n')}\n${next}`;
}
