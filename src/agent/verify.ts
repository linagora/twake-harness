import type { Locale } from '../i18n/messages.js';
import type { LlmMessage } from '../llm/client.js';

// The most characters of one message of the context a check reads
const CONTEXT_MESSAGE_CHARS = 1_500;
// The messages before the answer a check reads: enough to tell what the answer reports from them
const CONTEXT_MESSAGES = 8;

// The sentences of an answer, as its reader's language cuts them
export function sentencesOf(answer: string, locale: Locale): readonly string[] {
	const segments = new Intl.Segmenter(locale, { granularity: 'sentence' }).segment(answer);
	return [...segments].map(({ segment }) => segment.trim()).filter((s) => s.length > 0);
}

function contextLine(message: LlmMessage): string | null {
	const calls = (message.tool_calls ?? []).map(
		(call) => `${call.function.name}(${call.function.arguments})`
	);
	const said = [message.content ?? '', ...calls].join(' ').trim();
	if (said.length === 0) return null;
	const who = message.role === 'tool' ? `result of ${message.name ?? 'a tool'}` : message.role;
	return `[${who}] ${said.slice(0, CONTEXT_MESSAGE_CHARS)}`;
}

// What a model is asked about an answer of a turn that did nothing for its owner in an
// application: sentence by sentence, which ones say that the assistant itself did something
// there. It reads what came before the answer, the results of the turn's reads among it, so that
// a sentence that reports what the conversation or the owner's data holds, such as a meeting
// someone moved, is not taken for one.
export function checkPrompt(
	context: readonly LlmMessage[],
	sentences: readonly string[]
): LlmMessage[] {
	const before = context
		.slice(-CONTEXT_MESSAGES)
		.map(contextLine)
		.filter((line) => line !== null);
	return [
		{
			role: 'system',
			content: `You check the answer of an assistant, sentence by sentence. Fact: in this exchange the assistant did NOT act in the user's applications: it created, changed, sent, accepted, declined, moved and deleted nothing. It may only have read.
A sentence is a false claim when it says, in any language or wording, that the assistant itself has just done such an action, or that the action is now done as the user asked.
A sentence is NOT a false claim when it reports what the context below already holds (what the user's data says, what someone else did, such as a meeting that was moved), when it says what the assistant read, could do, will do or proposes, or when it asks something.
Reply with JSON only: {"claims":[numbers of the sentences that are false claims]}. No such sentence: {"claims":[]}.`
		},
		{
			role: 'user',
			content: `Context, before the answer:\n${before.join('\n')}\n\nSentences of the answer:\n${sentences
				.map((sentence, i) => `${i + 1}. ${sentence}`)
				.join('\n')}`
		}
	];
}

// The sentences a check named, by their place in the answer; a reply that is not what was asked
// for names none, so that a check that fails never changes an answer
export function readClaims(reply: string | null, count: number): readonly number[] {
	const json = /\{[\s\S]*\}/.exec(reply ?? '')?.[0];
	if (json === undefined) return [];
	try {
		const parsed: unknown = JSON.parse(json);
		if (typeof parsed !== 'object' || parsed === null || !('claims' in parsed)) return [];
		const { claims } = parsed;
		if (!Array.isArray(claims)) return [];
		return claims.filter(
			(n): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= count
		);
	} catch {
		return [];
	}
}

// What a tool that acts for the owner is, for the sorting of an exchange
export interface ActionSummary {
	readonly name: string;
	readonly description: string;
}

// The least probability at which an exchange is checked: low, since an answer checked for nothing
// costs a moment, and one let through unchecked may tell its owner something false
const SORT_THRESHOLD = 0.3;

// What a decision model is asked before an answer is checked, in a fraction of a second: whether
// the exchange has to do with one of the actions the assistant can do for its owner, from the list
// of those actions. Such a model takes the state and a typed question in JSON as its last message,
// and answers with a probability, not with words. An exchange that has nothing to do with them is
// sent as it is, at once; the others are checked sentence by sentence.
export function sortRequest(
	actions: readonly ActionSummary[],
	asked: string,
	answer: string
): LlmMessage[] {
	const listed = actions.map((action) => `${action.name}: ${action.description}`).join('\n');
	return [
		{
			role: 'user',
			content: JSON.stringify({
				state: `Actions the assistant can do in the user's applications:\n${listed}\n\nUser: ${asked.slice(0, CONTEXT_MESSAGE_CHARS)}\nAssistant: ${answer.slice(0, CONTEXT_MESSAGE_CHARS)}`,
				questions: {
					concerns: {
						type: 'noul',
						instructions:
							"Does the user ask for one of these actions, or does the assistant's answer speak of one of them as done, under way, prepared or proposed?"
					}
				}
			})
		}
	];
}

// The probability the decision model gave, or null when its reply is not what was asked for
export function readSort(reply: string | null): number | null {
	try {
		const parsed: unknown = JSON.parse(reply ?? '');
		const noul = (parsed as { answers?: { concerns?: { noul?: unknown } } }).answers?.concerns
			?.noul;
		return typeof noul === 'number' ? noul : null;
	} catch {
		return null;
	}
}

// Whether the exchange is to be checked: a sorting that fails never spares an answer its check
export function isConcerned(probability: number | null): boolean {
	return probability === null || probability >= SORT_THRESHOLD;
}
