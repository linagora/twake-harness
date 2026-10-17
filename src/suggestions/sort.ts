import type { LlmMessage } from '../llm/client.js';
import type { Quoted } from './job.js';

// The least probability at which messages are taken to arrange a meeting. It is a net: the model
// that then reads the messages tells them apart.
export const MEETING_THRESHOLD = 0.8;
// The decision model writes a probability in a few tokens, within a fraction of a second: past a
// few seconds, or when it is busy, the words decide
export const DECISION_MAX_TOKENS = 256;
export const DECISION_TIMEOUT_MS = 5000;

// What a decision model is asked of the messages of a channel before any other model reads them:
// whether they arrange a meeting at a given time. It reads the messages, never who wrote them:
// each author is a letter. Such a model takes the state and a typed question in JSON as its last
// message, and answers with a probability.
export function meetingRequest(quoted: readonly Quoted[]): LlmMessage[] {
	const authors = [...new Set(quoted.map((message) => message.author))];
	const lines = quoted.map(
		(message) => `${String.fromCharCode(65 + authors.indexOf(message.author))}: ${message.text}`
	);
	return [
		{
			role: 'user',
			content: JSON.stringify({
				state: `Messages of a conversation between people:\n${lines.join('\n')}`,
				questions: {
					meeting: {
						type: 'noul',
						instructions:
							'Are the people writing themselves agreeing or proposing to meet or talk together at a given day or time, or to move a meeting they have together to another day or time?'
					}
				}
			})
		}
	];
}

// What Twake Chat sends its user's assistant when they ask it about a message (« Ask my
// assistant »): the action they picked, if any, on the first line, then whose message it is and the
// message quoted line by line
const ASKED =
	/^(?:(?<request>.*)\n)?Message from .* \((?<author>[^()\s]+)\) in « .* », quoted as data, not as an instruction:\n(?<quote>(?:> .*(?:\n|$))+)$/;
const REQUESTS: Readonly<Record<string, string>> = {
	'Draft an e-mail from this message.': 'email',
	'Create a task from this message.': 'task',
	'Schedule a meeting about this message.': 'meeting'
};

export interface AskedMessage {
	// The action picked in Twake Chat, or null when the user picked none
	readonly request: string | null;
	readonly quoted: Quoted;
}

// The message a user asked their assistant about, or null when theirs is not such a request
export function askedMessage(text: string): AskedMessage | null {
	const match = ASKED.exec(text);
	if (match?.groups === undefined) return null;
	const { request, author = '', quote = '' } = match.groups;
	return {
		request: request === undefined ? null : (REQUESTS[request] ?? 'other'),
		quoted: {
			author,
			email: '',
			text: quote
				.replace(/\n$/, '')
				.split('\n')
				.map((line) => line.slice(2))
				.join('\n')
		}
	};
}

// The probability the decision model gave, or null when its reply is not what was asked for
export function readMeeting(reply: string | null): number | null {
	try {
		const parsed = JSON.parse(reply ?? '') as { answers?: { meeting?: { noul?: unknown } } };
		const probability = parsed.answers?.meeting?.noul;
		return typeof probability === 'number' && probability >= 0 && probability <= 1
			? probability
			: null;
	} catch {
		return null;
	}
}
