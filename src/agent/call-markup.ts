// What a model writes when it calls a tool in its text rather than through the API, as a model
// given no tools may still do: the tags its chat template wraps a call in, such as Qwen's
// <tool_call>, or the call itself in JSON. None of it is meant for the owner. A block of those
// tags that holds a call goes wherever it stands, as a model writes one only to call; a call in
// JSON, bare or fenced, goes when it ends the text, what the model wrote before it being its
// words. A tag named in a sentence stays, and so does a call in JSON among the words, as data
// the model gives or an example it shows.

const TAG = '(?:tool_calls?|function_calls?)';
// The attributes of a tag, which hold no other tag: a tag left unclosed is read to the next one,
// not to the end of the text
const ATTRIBUTES = '[^<>]*';
// What a tag that opens a block starts with, in lower case, and one that closes it
const OPENINGS = ['<tool_call', '<function_call'];
const CLOSINGS = ['</tool_call', '</function_call'];
// A tag that closes a block, the whole text it is looked for in
const CLOSING = new RegExp(`^<\\/${TAG}\\s*>$`, 'i');
// A closed block of tags, wherever it stands, with its name and what it holds: no block holds
// another of its name, so that a tag named in a sentence before a block does not run into it
const CLOSED_BLOCK = new RegExp(
	`<(tool_calls?|function_calls?)\\b${ATTRIBUTES}>((?:(?!<\\1\\b)[\\s\\S])*?)<\\/\\1\\s*>`,
	'gi'
);
// What a block that holds a call holds first: nothing, the call in JSON, or tags, such as the
// blocks of a block of calls or Qwen's <function=…>; words are a sentence that names the tags
const CALL_BODY = /^\s*(?:[[{<]|$)/;
// A block the model left open at the end, which holds nothing, or what a call starts with, and no
// end of tag
const OPEN_BLOCK = new RegExp(
	`^<${TAG}\\b${ATTRIBUTES}>\\s*(?:[[{<](?:(?!<\\/${TAG}\\b)[\\s\\S])*)?$`,
	'i'
);
// A fenced block, the whole text it is looked for in
const FENCED = /^```[^\n`]*\n?([\s\S]*?)```$/;
// Any block of tags, wherever it stands, the blocks it holds with it, which runs to the end of the
// text when left open
const ANY_BLOCK = new RegExp(
	`<(tool_calls?|function_calls?)\\b${ATTRIBUTES}>(?:(?!<\\1\\b)[\\s\\S])*?(?:<\\/\\1\\s*>|$)`,
	'gi'
);
// ponytail: a call in JSON that ends the text is looked for over its last lines only; one
// written over more lines is left as it is
const JSON_TAIL_LINES = 40;

// A call to a function, or a list of them, as chat templates write one (its name with its
// arguments or parameters) or as the OpenAI API carries it (under function, or tool_calls)
function isFunctionCall(value: unknown): boolean {
	if (Array.isArray(value)) return value.length > 0 && value.every(isFunctionCall);
	if (typeof value !== 'object' || value === null) return false;
	const fields = value as Record<string, unknown>;
	if (typeof fields['name'] === 'string' && ('arguments' in fields || 'parameters' in fields)) {
		return true;
	}
	return isFunctionCall(fields['function']) || isFunctionCall(fields['tool_calls']);
}

// The array or the object a text holds in JSON, or undefined when it holds none
function jsonOf(text: string): unknown {
	const trimmed = text.trim();
	if (!/^[[{][\s\S]*[\]}]$/.test(trimmed)) return undefined;
	try {
		return JSON.parse(trimmed) as unknown;
	} catch {
		return undefined;
	}
}

function isJsonCall(text: string): boolean {
	return isFunctionCall(jsonOf(text));
}

// Where the last of some tags starts before an end, in a text given in lower case, or -1 when
// none does: asked for ends that only go back, it looks for each tag again only once the one it
// found is past the end, so that a tag the text never holds is looked for once
function lastTagOf(lower: string, tags: readonly string[]): (end: number) => number {
	const found = tags.map(() => Number.POSITIVE_INFINITY);
	return (end) => {
		tags.forEach((tag, i) => {
			if ((found[i] ?? -1) >= end) found[i] = lower.lastIndexOf(tag, end - 1);
		});
		return Math.max(...found);
	};
}

// Where the last tag that opens a block, and the last that closes one, start before an end
interface LastTags {
	readonly opening: (end: number) => number;
	readonly closing: (end: number) => number;
}

// Where the call in JSON that ends the text at `end` starts, over its last lines, or -1. The
// first value found from the end is the only one: lines before a whole value cannot make
// another with it, as its brackets close none of theirs.
function trailingJsonCallAt(text: string, end: number): number {
	// A call in JSON ends on a bracket: a text that ends otherwise holds none
	if (!/[\]}]/.test(text.charAt(end - 1))) return -1;
	let lineEnd = end;
	for (let line = 0; line < JSON_TAIL_LINES && lineEnd > 0; line += 1) {
		const start = text.lastIndexOf('\n', lineEnd - 1) + 1;
		const value = jsonOf(text.slice(start, end));
		if (value !== undefined) return isFunctionCall(value) ? start : -1;
		lineEnd = start - 1;
	}
	return -1;
}

// Where the call that ends the text at `end` starts, or -1 when none does
function trailingCallAt(text: string, last: LastTags, end: number): number {
	// A closed block that holds a call is gone already; one that is still there holds words
	const opening = last.opening(end);
	if (opening !== -1 && OPEN_BLOCK.test(text.slice(opening, end))) return opening;
	// A tag that closes a block no tag opens, which a call whose opening tag was lost ends on
	const closing = last.closing(end);
	if (closing > opening && CLOSING.test(text.slice(closing, end))) {
		const opened = last.opening(closing);
		if (opened === -1 || last.closing(closing) > opened) return closing;
	}
	const fenced = trailingFencedCallAt(text, end);
	if (fenced !== -1) return fenced;
	return trailingJsonCallAt(text, end);
}

// Where the fenced block that ends the text at `end` starts, its fence opening a line, when it
// holds a call in JSON, or -1: among words, a fenced call is a block of code the model shows
function trailingFencedCallAt(text: string, end: number): number {
	if (!text.endsWith('```', end)) return -1;
	const fence = text.lastIndexOf('```', end - 4);
	if (fence === -1 || (fence > 0 && text.charAt(fence - 1) !== '\n')) return -1;
	const fenced = FENCED.exec(text.slice(fence, end));
	return fenced !== null && isJsonCall(fenced[1] ?? '') ? fence : -1;
}

// The text without the closed blocks of tags that hold a call, wherever they stand, and without
// the empty lines they leave
function withoutCallBlocks(text: string): string {
	const kept = text.replace(CLOSED_BLOCK, (block: string, _name: string, body: string) =>
		CALL_BODY.test(body) ? '' : block
	);
	return kept === text ? text : kept.replace(/\n{3,}/g, '\n\n');
}

// The end of the text at `end` without its trailing whitespace
function trimmedEnd(text: string, end: number): number {
	let at = end;
	while (at > 0 && /\s/.test(text.charAt(at - 1))) at -= 1;
	return at;
}

// The words of a model's text, without the blocks of tags that hold a call, then without the
// calls that end it, one after the other. The text is read from its end, by indexes into it: a
// text of thousands of calls is read once.
export function withoutCallMarkup(text: string): string {
	const words = withoutCallBlocks(text).trimStart();
	// The tags are in ASCII: its letters alone are lowered, so that the two keep the same indexes
	// where a letter's lower case is longer, as « İ »'s is
	const lower = words.replace(/[A-Z]+/g, (letters) => letters.toLowerCase());
	const last: LastTags = {
		opening: lastTagOf(lower, OPENINGS),
		closing: lastTagOf(lower, CLOSINGS)
	};
	let end = trimmedEnd(words, words.length);
	for (;;) {
		const call = trailingCallAt(words, last, end);
		if (call === -1) return words.slice(0, end);
		end = trimmedEnd(words, call);
	}
}

// The words of a text that may hold no call at all, as the brief of a model given no tool: every
// block of tags goes, wherever it stands, then what ends the text
export function withoutAnyCallMarkup(text: string): string {
	return withoutCallMarkup(text.replace(ANY_BLOCK, '').replace(/\n{3,}/g, '\n\n'));
}
