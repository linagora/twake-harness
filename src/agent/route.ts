import type { LlmMessage } from '../llm/client.js';
import { MAX_PLAN_STEPS } from './plan.js';

// One thing the assistant can do in an application of its owner: read there, or act there
export interface Capability {
	readonly name: string;
	readonly description: string;
	// Whether it acts for the owner, rather than read
	readonly acts: boolean;
}

// The least probability at which a message is read as asking for a capability. Higher for one
// that acts: a write the owner did not ask for is worse than a read they did not. These bounds are
// provisional: they were set on the messages of tests/fixtures/routing-cases.ts, written for the
// purpose, where the decision model gave a write asked for alone 0.83 or more, one asked for in
// few words or beside a read 0.40 or more, and a write not asked for at most 0.35.
export const READ_THRESHOLD = 0.5;
export const WRITE_THRESHOLD = 0.6;
// With no write named, the likeliest one is, from this bound: a write asked for in few words, or
// beside a read, is often scored lower than one asked for alone
export const LIKELIEST_THRESHOLD = 0.38;
// Below it, a message is read as not asking for a write at all; between it and the bound of a
// write, it may, and the write waits for the owner's yes
export const REFUSE_THRESHOLD = 0.3;
// The most characters of a message the decision model reads
const MESSAGE_CHARS = 1_500;
// The messages before the owner's last one it reads: a short answer, such as a name the assistant
// asked for, is of the request that came before it
const CONTEXT_MESSAGES = 4;

// What a decision model is asked of a message before the assistant's model reads it: for each
// thing the assistant can do in its owner's applications, whether the message asks for it. What
// a message asks for is thus told by a model made to classify, in a fraction of a second, and
// not left to the model that then does it. Such a model takes the state and typed questions in
// JSON as its last message, and answers each with a probability.
export function routeRequest(
	capabilities: readonly Capability[],
	before: readonly LlmMessage[],
	message: string
): LlmMessage[] {
	const context = before
		.filter((said) => said.role === 'user' || (said.role === 'assistant' && said.content !== null))
		.slice(-CONTEXT_MESSAGES)
		.map((said) => `${said.role}: ${(said.content ?? '').slice(0, MESSAGE_CHARS)}`);
	return [
		{
			role: 'user',
			content: JSON.stringify({
				state: `${context.length === 0 ? '' : `Earlier in the conversation:\n${context.join('\n')}\n\n`}User's last message to their assistant: ${message.slice(0, MESSAGE_CHARS)}`,
				questions: Object.fromEntries(
					capabilities.map((capability) => [
						capability.name,
						{
							type: 'noul',
							instructions: `Does the user's last message ask the assistant to do this now: "${capability.description}"?`
						}
					])
				)
			})
		}
	];
}

// The probability the decision model gave each capability, by its name, or null when the reply
// is not what was asked for
export function readProbabilities(reply: string | null): ReadonlyMap<string, number> | null {
	let answers: unknown;
	try {
		answers = (JSON.parse(reply ?? '') as { answers?: unknown }).answers;
	} catch {
		return null;
	}
	if (typeof answers !== 'object' || answers === null) return null;
	const given = new Map<string, number>();
	for (const [name, answer] of Object.entries(answers)) {
		const probability = (answer as { noul?: unknown } | null)?.noul;
		if (typeof probability === 'number') given.set(name, probability);
	}
	return given;
}

// Where a turn goes once its message is sorted: each is a way of its own for the model to think,
// with the tools that way needs and no other
export type Lane = 'discuss' | 'consult' | 'act' | 'unsure';

export interface Routed {
	readonly lane: Lane;
	// The capabilities the message asks for, reads before writes
	readonly named: readonly Capability[];
}

// The lane of a message, from the probability the decision model gave each capability. A message
// that names nothing is talked over; one that names only reads is looked up; one that names a
// write is acted on. With no write named, one the message may ask for, neither named nor ruled
// out, makes the turn unsure: the model then has every tool, and each write waits for the owner's yes.
export function laneOf(
	given: ReadonlyMap<string, number>,
	capabilities: readonly Capability[]
): Routed {
	const of = (capability: Capability): number => given.get(capability.name) ?? 0;
	const likeliest = capabilities
		.filter((capability) => capability.acts)
		.reduce<Capability | null>(
			(best, capability) => (best === null || of(capability) > of(best) ? capability : best),
			null
		);
	const sure = capabilities.some(
		(capability) => capability.acts && of(capability) >= WRITE_THRESHOLD
	);
	const likely = capabilities.filter(
		(capability) =>
			of(capability) >= (capability.acts ? WRITE_THRESHOLD : READ_THRESHOLD) ||
			// With no write named for sure, the likeliest is named when it is likely enough
			(!sure && capability === likeliest && of(capability) >= LIKELIEST_THRESHOLD)
	);
	// Past the most steps a plan holds, the likeliest are kept, in their order
	const kept = new Set([...likely].sort((a, b) => of(b) - of(a)).slice(0, MAX_PLAN_STEPS));
	const named = likely.filter((capability) => kept.has(capability));
	// A write the message names settles it: the writes beside it that it only may ask for, such
	// as accepting an invitation beside creating a meeting, are then left out
	const lane: Lane = named.some((capability) => capability.acts)
		? 'act'
		: likeliest !== null && of(likeliest) >= REFUSE_THRESHOLD
			? 'unsure'
			: named.length > 0
				? 'consult'
				: 'discuss';
	return { lane, named };
}
