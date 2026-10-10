import { randomBytes } from 'node:crypto';

import type { LlmMessage } from './client.js';

function fence(label: string, nonce: string, line: string): string {
	return [`<<<${label} ${nonce}`, line, `${label} ${nonce}>>>`].join('\n');
}

// Data as the model is handed it: one line of JSON, so that nothing a third party wrote can start
// a line of its own, between fences of a random nonce it cannot close
export function fenced(label: string, data: unknown): string {
	return fence(label, randomBytes(6).toString('hex'), JSON.stringify(data));
}

// A block fenced() wrote, in a text: its label, its nonce and its line of JSON, which may hold the
// separators of lines and paragraphs JSON leaves unescaped
const FENCED = /^<<<(\S+) ([0-9a-f]{12})\n([^\n]*)\n\1 \2>>>$/gm;

// JSON with its data changed; a text that is no JSON stays as written
function withJsonChanged(json: string, change: (data: unknown) => unknown): string {
	let data: unknown;
	try {
		data = JSON.parse(json);
	} catch {
		return json;
	}
	return JSON.stringify(change(data));
}

// The messages of a prompt with the data they hand the model changed: the answer of each tool, and
// each block fenced() wrote in a message of the user, between the same fences
export function withDataChanged(
	messages: readonly LlmMessage[],
	change: (data: unknown) => unknown
): LlmMessage[] {
	return messages.map((message) => {
		const { role, content } = message;
		if (content === null) return message;
		if (role === 'tool') return { ...message, content: withJsonChanged(content, change) };
		if (role !== 'user') return message;
		return {
			...message,
			content: content.replace(
				FENCED,
				(_block: string, label: string, nonce: string, line: string) =>
					fence(label, nonce, withJsonChanged(line, change))
			)
		};
	});
}

// Text people wrote, cut to its first characters rather than refused, as the contracts cap theirs:
// it is shown as data anyway
export function cut(text: string, max: number): string {
	const characters = Array.from(text);
	return characters.length <= max ? text : characters.slice(0, max).join('');
}
