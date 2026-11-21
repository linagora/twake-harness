import type { LlmMessage } from '../llm/client.js';

// A task key, as the owner's tasks write it: the board's letters, a dash and a number
const TASK_KEY = /[A-Z][A-Z0-9]*-\d+/g;

// The task keys a text names, each once
export function keysOf(text: string): readonly string[] {
	return [...new Set(text.match(TASK_KEY) ?? [])];
}

const prefixOf = (key: string): string => key.slice(0, key.lastIndexOf('-'));

// The keys of an answer that the data the turn was given never names, among those of a board the
// data does name: J-1, UTC-5 or ISO-9001 look like keys and name no task, unless the data holds a
// key with the same letters
export function unfoundedKeys(answer: string, given: string): readonly string[] {
	const known = keysOf(given);
	const prefixes = new Set(known.map(prefixOf));
	return keysOf(answer).filter((key) => !known.includes(key) && prefixes.has(prefixOf(key)));
}

// The most characters of the earlier turns a check reads, in all: it sees what the owner and the
// results held before this turn, newest first, without paying for a whole conversation; the
// results of this turn stay whole. A message is cut only when it alone exceeds what remains, so
// an item far down one long earlier result still reaches the check while the budget lasts.
const EARLIER_CHARS = 30_000;

// What the data of the turns before this one says to a check: the owner's messages and the results
// of their reads, the assistant's own words left out, as they are no data
export function earlierData(past: readonly LlmMessage[]): readonly string[] {
	let remaining = EARLIER_CHARS;
	const lines: string[] = [];
	for (const said of past.filter((m) => m.role === 'user' || m.role === 'tool').reverse()) {
		if (remaining <= 0) break;
		const who = said.role === 'user' ? 'user' : `result of ${said.name ?? 'a tool'}`;
		const text = (said.content ?? '').slice(0, remaining);
		remaining -= text.length;
		lines.unshift(`[earlier, ${who}] ${text}`);
	}
	return lines;
}

export interface GroundQuestion {
	// The owner's last message
	readonly asked: string;
	// The results of this turn's reads, whole
	readonly results: readonly string[];
	// The data of earlier turns, as earlierData lays it out
	readonly earlier: readonly string[];
	readonly sentences: readonly string[];
	// The present, with its zone's offset, and the owner's zone by its IANA name
	readonly now: string;
	readonly timeZone: string;
}

// What a model is asked about an answer of a turn that read the owner's data: sentence by
// sentence, which ones state a fact about that data the results do not support
export function groundPrompt(question: GroundQuestion): LlmMessage[] {
	const { asked, results, earlier, sentences, now, timeZone } = question;
	return [
		{
			role: 'system',
			content: `You check the answer of an assistant against the data it read for its user, sentence by sentence.
It is now ${now}. The user's time zone is ${timeZone}. Times in the results may be in UTC or carry an offset, and the answer may show them in the user's zone: the same instant written in another zone is the same fact.
A sentence is unsupported when it states a fact about the user's data that the results below do not support: a date, a person, a number or a duration that is not the one the results hold, an item they do not hold, or facts of two different items mixed into one. The data of earlier turns, labelled as such, supports it too.
A sentence is NOT unsupported when it repeats what the user wrote, gives an opinion, a proposal or a question, says what the assistant could do, or states what the results hold, in any language or wording.
Reply with JSON only: {"claims":[numbers of the unsupported sentences]}. No such sentence: {"claims":[]}.`
		},
		{
			role: 'user',
			content: `Message of the user:\n${asked}\n\nData of earlier turns:\n${earlier.join('\n')}\n\nResults the assistant read in this turn:\n${results.join('\n')}\n\nSentences of the answer:\n${sentences
				.map((sentence, i) => `${i + 1}. ${sentence}`)
				.join('\n')}`
		}
	];
}

// "2", "2 and 4", "1, 2 and 3"
const listed = (numbers: readonly number[]): string =>
	numbers.length < 2
		? numbers.join('')
		: `${numbers.slice(0, -1).join(', ')} and ${numbers[numbers.length - 1]}`;

// What the model is told when it writes its answer again, from the data alone: the sentences are
// named by their numbers in its last answer, which it reads as data in a message of the user, and
// never copied here, as the system prompt is no place for words a stranger may have written
export function rewriteInstruction(
	keys: readonly string[],
	unsupported: readonly number[]
): string {
	const parts = [
		"Your last answer cited details that the data of this conversation does not hold, and it was not sent. Answer the user's last message again, with no tool: say only what the data above holds, and leave out or correct what it does not. Your last answer is given as data in the last message, its sentences numbered."
	];
	if (keys.length > 0)
		parts.push(`Task keys it names that the data never names: ${keys.join(', ')}.`);
	if (unsupported.length > 0) {
		parts.push(
			`The data does not support ${unsupported.length === 1 ? 'sentence' : 'sentences'} ${listed(unsupported)} of your last answer.`
		);
	}
	return parts.join('\n');
}
