import MarkdownIt from 'markdown-it';

import type { DomainLabel } from '../contracts/domains.js';
import type { Messages } from '../i18n/messages.js';
import { escapeHtml, renderQuotedMarkdown } from '../matrix/format.js';
import type { ConsentLevel, WaitReason } from './consent.js';

// A call the harness froze, as its request to the owner tells of it
export interface RequestedCall {
	// The tool the call is to, as the harness names it
	readonly tool: string;
	// The application as its owner reads it, from labelOf: its name, and what the call's level
	// covers there when the catalog says
	readonly application: DomainLabel;
	readonly level: ConsentLevel;
	// Every reason the call waits for, all answered by one yes
	readonly reasons: readonly WaitReason[];
	// The call as it was frozen, which may hold what a third party wrote
	readonly arguments: unknown;
	// What its contract said the call would do, from its preview, which its owner reads in place of
	// the call, and nothing else ever shows; null for a contract that offers none. It is that
	// application's data, which may hold what a third party wrote.
	readonly summary: string | null;
	// What the model wrote alongside the call, or null when it wrote nothing
	readonly said: string | null;
}

// What stands for a call under the harness's question: the call as it was frozen, whole, as
// indented JSON; or, for a call the model wrote without arguments, which says nothing so, the tool
// it calls, as the harness names it
export interface ShownCall {
	readonly kind: 'arguments' | 'tool';
	readonly text: string;
}

// The harness's request to an owner about a call it froze, in the parts their client shows apart,
// in this order. Only the question, the labels and how to answer are the harness's own words, and
// the parts stay apart wherever the request goes, so that the API can show the question without
// the call.
export interface OwnerRequest {
	// What the model wrote alongside the call, under the harness's label for it, or null when it
	// wrote nothing
	readonly said: { readonly label: string; readonly text: string } | null;
	// The harness's question, in Markdown: the application named as the catalog does
	readonly question: string;
	// The call under the question: what its owner reads of it when its contract offers no preview,
	// and what the conversation keeps of it either way; null when the request shows none: for a
	// first read, and for a first write the model wrote without arguments that no preview describes,
	// whose questions ask about their application alone
	readonly call: ShownCall | null;
	// What its contract said the call would do, under the harness's label for it, in Markdown,
	// which names the application: what its owner reads in the call's place; null for a contract
	// that offers no preview
	readonly summary: { readonly label: string; readonly text: string } | null;
	readonly howToAnswer: string;
}

// The most a request quotes of what the model wrote: its words, never what runs
const SAID_LENGTH = 2_000;

// The most those words may take of the event as HTML once rendered: what their escaped lines
// could take, six bytes a character at most, as a line break becomes <br /> and a control
// character \u0001 in the event's JSON
const SAID_HTML_BYTES = SAID_LENGTH * 6;

// The most what a request shows of a call, the call or the summary in its place, may take of the
// event that carries the request, as plain text and as HTML together, escaped as the event's JSON
// holds them. With the model's words, 12,000 bytes at most in each, and the rest of the request,
// the encrypted event stays under 60 KiB, well within the 64 KiB a Matrix event may take.
export const CALL_BYTES = 16_384;

// The bytes a text takes in the event that carries the request, escaped as its JSON holds it: a
// quotation mark, a backslash or a line break takes two, a control character six
function eventBytes(text: string): number {
	return Buffer.byteLength(JSON.stringify(text), 'utf8') - 2;
}

function linesOf(text: string): string[] {
	return text.split(/\r\n|[\n\r\u0085\u2028\u2029]/);
}

// A call the model wrote without arguments, which as JSON would show its owner an empty object
function hasNoArguments(args: unknown): boolean {
	return typeof args === 'object' && args !== null && Object.keys(args).length === 0;
}

// The harness's question for the reasons a call waits for, with the call it shows: a first use
// asks about the application; a high-risk write, or a write that a turn an event started
// prepared, about that very call; and the first of either in its application about both. A first
// read shows no call. Unless a summary stands in its place, a write without arguments shows its
// tool instead, where the question asks about that very call, and nothing under a first write's,
// whose words say it all.
// A recurring invitation asks about that very call whether to answer for the whole series: its yes
// runs the call the usual way of writes.
function questionFor(
	call: RequestedCall,
	consent: Messages['consent']
): Pick<OwnerRequest, 'question' | 'call'> {
	const { name, covers } = call.application;
	const firstUse = call.reasons.includes('consent');
	const bare = call.summary === null && hasNoArguments(call.arguments);
	const frozen: ShownCall = {
		kind: 'arguments',
		text: JSON.stringify(call.arguments, null, 2) ?? 'null'
	};
	// What a question about that very call shows of it
	const itself: ShownCall = bare ? { kind: 'tool', text: call.tool } : frozen;
	if (call.reasons.includes('series')) return { question: consent.series(name), call: itself };
	// A high-risk write asks every time, whoever started the turn: its question also holds for one
	// that a turn an event started prepared
	if (call.reasons.includes('high_risk')) {
		return {
			question: firstUse ? consent.firstHighRisk(name, covers) : consent.highRisk(name),
			call: itself
		};
	}
	// A write the owner's message may not ask for, in an application they already allowed
	if (call.reasons.includes('unsure') && !firstUse) {
		return { question: consent.unsure(name), call: itself };
	}
	if (call.reasons.includes('event_turn')) {
		return {
			question: firstUse ? consent.firstEventWrite(name, covers) : consent.eventWrite(name),
			call: itself
		};
	}
	// A first read asks about its application alone, whatever the call: its yes lets the assistant
	// read there
	if (call.level === 'read') return { question: consent.firstRead(name, covers), call: null };
	return { question: consent.firstWrite(name, covers, !bare), call: bare ? null : frozen };
}

// The request about a frozen call, or null when what it shows of the call, the call or its
// summary, is too large to show whole in one message: an owner is never asked about a call they
// cannot see whole
export function makeOwnerRequest(call: RequestedCall, messages: Messages): OwnerRequest | null {
	const { consent } = messages;
	const said = Array.from(call.said?.trim() ?? '');
	const request: OwnerRequest = {
		said:
			said.length === 0
				? null
				: {
						label: consent.said,
						text:
							said.length > SAID_LENGTH ? `${said.slice(0, SAID_LENGTH).join('')}…` : said.join('')
					},
		...questionFor(call, consent),
		summary:
			call.summary === null
				? null
				: { label: consent.described(call.application.name), text: call.summary },
		howToAnswer: consent.howToAnswer
	};
	const shown = [...shownText(request), ...shownHtml(request)];
	return shown.reduce((total, part) => total + eventBytes(part), 0) > CALL_BYTES ? null : request;
}

// A text that is not the harness's, quoted line by line under the harness's label for it, so that
// none of its lines passes for the harness's own
function quoted(label: string, text: string): string {
	return [label, ...linesOf(text).map((line) => `> ${line}`.trimEnd())].join('\n');
}

// The request as plain text: the body of its message, and what the API answers. The model's
// words, and what an application said of the call, are quoted under the harness's labels.
export function requestText(request: OwnerRequest): string {
	const { said } = request;
	return [
		...(said === null ? [] : [quoted(said.label, said.text)]),
		request.question,
		...shownText(request),
		request.howToAnswer
	].join('\n\n');
}

// What the request shows in the call's place, as plain text: what its application said of it,
// quoted under the harness's label, or else the call, when it shows one
function shownText(request: Pick<OwnerRequest, 'call' | 'summary'>): string[] {
	const { call, summary } = request;
	if (summary !== null) return [quoted(summary.label, summary.text)];
	return call === null ? [] : [call.text];
}

// The request as the conversation keeps it, which later turns of the model read: as its owner
// read it, with the call in the place of what its application said of it. That is the
// application's data, which may hold what a third party wrote, and only its owner reads it. A
// request that shows no call, a first read's or a first write's about a call without arguments,
// shows none there either: what would run comes just before it in the conversation, as the model's
// own call or, for the harness's own check of an invitation's slot, in what the model is told. A
// call without arguments whose summary stood in its place shows there, {}, as any call does.
export function conversationText(request: OwnerRequest): string {
	return requestText({ ...request, summary: null });
}

// The harness's own Markdown: no HTML of its own, and no link it did not write
const QUESTION_MARKDOWN = new MarkdownIt({ html: false, linkify: false, breaks: true });

// The call under the question as code: its arguments as JSON, or the tool it calls
function callHtml(call: ShownCall): string {
	const language = call.kind === 'arguments' ? ' class="language-json"' : '';
	return `<pre><code${language}>${escapeHtml(call.text)}</code></pre>`;
}

// The same as HTML: the summary under its label, rendered from the harness's own Markdown, or the
// call, as code
function shownHtml(request: Pick<OwnerRequest, 'call' | 'summary'>): string[] {
	const { call, summary } = request;
	if (summary !== null) {
		return [
			QUESTION_MARKDOWN.render(summary.label).trim(),
			`<pre><code>${escapeHtml(summary.text)}</code></pre>`
		];
	}
	return call === null ? [] : [callHtml(call)];
}

// What the model wrote, as HTML in the quote under the harness's label: its Markdown rendered with
// nothing that acts, every tag of it closed within it, so that nothing of it follows the quote and
// passes for the harness's own words; or its lines as text, should the rendering take more of the
// event than its escaped lines could
function saidHtml(text: string): string {
	const rendered = renderQuotedMarkdown(text);
	return eventBytes(rendered) <= SAID_HTML_BYTES
		? rendered
		: linesOf(text).map(escapeHtml).join('<br />');
}

// The request as HTML, laid out by the harness. The model's words render their Markdown, with no
// link, image or heading, held whole in a quote under the harness's label. The call, or its
// contract's summary under the harness's label, is code, and only the question and that label are
// rendered from the harness's own Markdown.
export function requestHtml(request: OwnerRequest): string {
	const { said } = request;
	const quoted =
		said === null
			? []
			: [`<p>${escapeHtml(said.label)}</p>`, `<blockquote>${saidHtml(said.text)}</blockquote>`];
	return [
		...quoted,
		QUESTION_MARKDOWN.render(request.question).trim(),
		...shownHtml(request),
		`<p>${escapeHtml(request.howToAnswer)}</p>`
	].join('\n');
}
