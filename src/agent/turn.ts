import type { FastifyBaseLogger } from 'fastify';

import type { Locale } from '../i18n/messages.js';
import type {
	LlmClient,
	LlmCompletion,
	LlmMessage,
	LlmToolCall,
	LlmToolDefinition
} from '../llm/client.js';
import { conversationText, type OwnerRequest } from '../consents/request.js';
import { withoutCallMarkup } from './call-markup.js';
import type { TimeZone } from './clock.js';
import { computeMessageSize, computeVisibleHistory } from './history.js';
import {
	runTool,
	toolCallStatus,
	type ToolCallStatus,
	type ToolContext,
	type ToolRegistry,
	type TurnBrief
} from './tools.js';
import { withDatesInWords, withTrueWeekdays } from './weekdays.js';

export interface TurnInput {
	readonly systemPrompt: string;
	readonly history: readonly LlmMessage[];
	// The owner's new message, or null when the turn goes on from its history, such as after a
	// call its owner allowed
	readonly message: string | null;
	readonly context: ToolContext;
	// The actions the turn did before the model spoke: the call its owner allowed, when it resumes
	// from one
	readonly actionsBefore: number;
	// What the owner reads, in their language, when the model answers one of the turn's limits with
	// no words for them: given the actions the turn did, what was done and how to have it go on
	limitNotice(actions: number): string;
	// Told, after each call that ran, the actions the turn has done so far: its owner sees them as
	// it goes
	readonly actionsDone?: (actions: number) => void;
	// Whether the model may end the turn on no words at all, as a turn an activity woke may
	readonly mayStaySilent?: boolean;
	// The owner's day, as ISO 8601 writes it, in which the model's words read a date without its year
	readonly today: string;
	// The owner's zone and language, in which each date the model reads is written in words
	readonly timeZone: TimeZone;
	readonly locale: Locale;
}

export interface TurnOutput {
	readonly answer: string;
	readonly messages: readonly LlmMessage[];
	readonly tokens: number;
	// The model ended the turn on no words, as it may: the answer is empty, and the conversation is
	// kept as it was before the turn
	readonly silent?: true;
	// The call the harness froze, when the turn ended on its question to the owner
	readonly pendingCallId?: string;
	// That question in its parts, when the harness laid it out as a request about the call
	readonly request?: OwnerRequest;
	// The brief the owner asked for, when the turn ended on it
	readonly brief?: TurnBrief;
	// The turn reached one of its limits before it answered: there is more to do
	readonly atLimit?: true;
}

export interface TurnDeps {
	readonly llm: LlmClient;
	readonly tools: ToolRegistry;
	readonly log: FastifyBaseLogger;
	readonly maxToolCalls: number;
	// The tokens the turn may spend, the prompts and answers of its model calls summed, checked
	// before each call: not the budget of one call, which is the client's
	readonly maxTurnTokens: number;
	// The most characters of the past conversation the model reads; its stored history keeps all
	readonly historyMaxChars: number;
}

export class TurnError extends Error {
	override readonly name = 'TurnError';
}

// The size of a prompt, which the info logs report instead of its text
function countCharacters(messages: readonly LlmMessage[]): number {
	let total = 0;
	for (const message of messages) total += computeMessageSize(message);
	return total;
}

// What the model reads for a call it made after one that ended the turn
const NOT_RUN = {
	error: 'not_run',
	hint: 'The turn stopped before this call ran. Make it again if it is still needed.'
} as const;

// What the model reads for a call it made once its turn had run all the calls one message may
function limitReached(limit: number): { readonly error: string; readonly hint: string } {
	return {
		error: 'tool_call_limit',
		hint: `This call did not run: the limit of ${limit} tool calls for one message is reached.`
	};
}

// A limit that ends the tool calls of a turn: once it is reached, the model answers once more,
// without tools
type TurnLimit = 'tool_calls' | 'tokens';

// What the model is told of each limit when it is asked for the answer that ends its turn, and the
// line logged when the harness then tells the owner itself, the model having no words for them
const LIMITS: Readonly<
	Record<TurnLimit, { readonly told: (deps: TurnDeps) => string; readonly notice: string }>
> = {
	tool_calls: {
		told: (deps) =>
			`the limit of ${deps.maxToolCalls} tool calls for one message, so the calls you made past it did not run`,
		notice: 'tool call limit notice'
	},
	tokens: {
		told: (deps) => `the limit of ${deps.maxTurnTokens} tokens for one message`,
		notice: 'token limit notice'
	}
};

// What the model is told when it is asked for the answer that ends a turn at one of its limits,
// with no tool left to call: the owner learns where things stand, and that they can have it go on
function wrapUpInstruction(deps: TurnDeps, reached: TurnLimit): string {
	return `You reached ${LIMITS[reached].told(deps)}, and no tool is available now. Answer the user now: tell them what you did, what remains to be done, and that they can ask you to continue.`;
}

// The most one model call may spend: a call that ran out is retried once at twice the budget,
// up to this
export const MAX_RETRY_TOKENS = 32_768;

// A reasoning model can spend its whole budget deliberating and stop before it writes a word: the
// reasoning is stripped, so nothing visible is left
function ranOutOfBudget(completion: LlmCompletion): boolean {
	return (
		completion.finishReason === 'length' &&
		(completion.content ?? '').length === 0 &&
		completion.toolCalls.length === 0
	);
}

// Logging only: the metadata at info, the conversation itself at debug
function logAnswer(log: FastifyBaseLogger, iteration: number, completion: LlmCompletion): void {
	log.info(
		{
			iteration,
			finishReason: completion.finishReason,
			usage: completion.usage,
			toolNames: completion.toolCalls.map((call) => call.function.name),
			answerLength: completion.content?.length ?? 0,
			hasReasoning: completion.reasoning !== null && completion.reasoning.length > 0
		},
		'model answered'
	);
	log.debug(
		{
			iteration,
			content: completion.content,
			reasoning: completion.reasoning,
			toolCalls: completion.toolCalls,
			finishReason: completion.finishReason,
			usage: completion.usage
		},
		'model answered'
	);
}

// The answers of calls the model made that never run, each telling it why: strict model APIs refuse
// a history with a call left unanswered
function skippedAnswers(calls: readonly LlmToolCall[], result: unknown): LlmMessage[] {
	return calls.map((call): LlmMessage => ({
		role: 'tool',
		tool_call_id: call.id,
		name: call.function.name,
		content: JSON.stringify(result)
	}));
}

function parseArguments(raw: string): unknown {
	try {
		return JSON.parse(raw) as unknown;
	} catch {
		return null;
	}
}

// The tokens the model calls of a turn spent, as the model reports them
interface Spent {
	tokens: number;
	// An answer of the turn reported no usage, which the log tells once
	unreported: boolean;
}

// Adds the tokens of an answer to those its turn spent. An answer that reports none counts for
// nothing, against the limit of its turn as against the owner's day: the log warns of it once a turn
function spend(
	log: FastifyBaseLogger,
	iteration: number,
	completion: LlmCompletion,
	spent: Spent
): void {
	if (completion.usage === null) {
		if (!spent.unreported) log.warn({ iteration }, 'model reported no usage');
		spent.unreported = true;
		return;
	}
	spent.tokens += completion.usage.promptTokens + completion.usage.completionTokens;
}

interface Asked {
	readonly completion: LlmCompletion;
	// The model ran out of budget while thinking, with tools, and its turn spent its tokens, on this
	// call or on its retry: no call with tools follows
	readonly cut: boolean;
}

// An answer to a call with tools that ran out of budget while thinking once its turn spent its
// tokens: past them, no call with tools is made, neither the same again nor the next, and the turn
// ends on its last call, without tools, rather than fail for want of an answer
function cutShort(
	deps: TurnDeps,
	tools: readonly LlmToolDefinition[],
	completion: LlmCompletion,
	spent: Spent
): boolean {
	return tools.length > 0 && ranOutOfBudget(completion) && spent.tokens >= deps.maxTurnTokens;
}

// One model call, with the tools it may call, whose tokens its turn adds to those it spent: a call
// that ran out of budget while thinking is made once more with twice the budget, up to the ceiling,
// unless it has tools and the turn spent all its tokens. The model reads each date it is handed
// written in words beside it, in its owner's zone and language.
async function askModel(
	deps: TurnDeps,
	iteration: number,
	messages: readonly LlmMessage[],
	tools: readonly LlmToolDefinition[],
	spent: Spent,
	owner: Pick<TurnInput, 'today' | 'timeZone' | 'locale'>
): Promise<Asked> {
	const prompt = withDatesInWords(messages, owner.timeZone, owner.locale);
	deps.log.info(
		{ iteration, messageCount: prompt.length, characters: countCharacters(prompt) },
		'model asked'
	);
	deps.log.debug({ iteration, messages: prompt }, 'model asked');
	let completion = await deps.llm.complete(prompt, tools);
	spend(deps.log, iteration, completion, spent);
	logAnswer(deps.log, iteration, completion);
	if (ranOutOfBudget(completion) && !cutShort(deps, tools, completion, spent)) {
		const budget = deps.llm.maxTokens;
		const retryBudget = Math.min(budget * 2, MAX_RETRY_TOKENS);
		// Already at the ceiling, a second call would end the same way
		if (retryBudget > budget) {
			deps.log.info(
				{ iteration, budget, retryBudget, usage: completion.usage },
				'model ran out of budget'
			);
			completion = await deps.llm.complete(prompt, tools, { maxTokens: retryBudget });
			spend(deps.log, iteration, completion, spent);
			logAnswer(deps.log, iteration, completion);
		}
	}
	// Whatever the turn does with the model's words, the owner reads, the conversation keeps and a
	// request quotes them with the day of each date named from the date; the debug line of
	// logAnswer keeps them as the model wrote them
	if (completion.content !== null) {
		completion = { ...completion, content: withTrueWeekdays(completion.content, owner.today) };
	}
	return { completion, cut: cutShort(deps, tools, completion, spent) };
}

// The model's answer to its owner, which ends the turn
function answerOf(completion: LlmCompletion): string {
	const answer = completion.content ?? '';
	if (answer.length === 0) throw new TurnError('the model answered nothing');
	return answer;
}

// One turn: the model answers, possibly through tool calls, within a bounded number of calls and of
// tokens. A model that goes past that number of calls, or a turn that spent those tokens, is asked
// once more, without tools, to tell its owner where things stand; should it write no words for
// them, the harness tells them itself what was done, so that the turn ends on an answer whatever
// the model writes. Every model call and every tool call is logged at info with its metadata only.
// The conversation itself (prompt, answer, reasoning, tool arguments and results) goes to debug:
// messages reach the harness end-to-end encrypted and are decrypted only here, so their text must
// stay out of the production logs.
export async function runTurn(deps: TurnDeps, input: TurnInput): Promise<TurnOutput> {
	// What this turn adds to the conversation, which the model always reads whole
	const messages: LlmMessage[] =
		input.message === null ? [] : [{ role: 'user', content: input.message }];
	// The past conversation as the model reads it, each date in words, cut to what it may read
	const past = computeVisibleHistory(
		withDatesInWords(input.history, input.timeZone, input.locale),
		deps.historyMaxChars
	);
	if (past.length < input.history.length) {
		deps.log.info(
			{ historyMessages: input.history.length, shownMessages: past.length },
			'history windowed'
		);
	}
	const system: LlmMessage = { role: 'system', content: input.systemPrompt };
	let toolCalls = 0;
	// The calls that reached their tool, and those of the turn before the model spoke
	let actions = input.actionsBefore;
	const spent: Spent = { tokens: 0, unreported: false };
	let iteration = 0;
	// The calls the model made past the limit of the message, which never run
	let notRun = 0;
	// Every model answer that calls tools runs at least one of them, until a limit stops the loop:
	// the tool calls of the message, or the tokens of the turn, checked before each model call
	while (notRun === 0 && spent.tokens < deps.maxTurnTokens) {
		const asked = await askModel(
			deps,
			iteration,
			[system, ...past, ...messages],
			deps.tools.definitions,
			spent,
			input
		);
		iteration += 1;
		// The model ran out while thinking past the tokens of the turn: its last call, without tools,
		// ends it
		if (asked.cut) break;
		const { completion } = asked;
		if (completion.toolCalls.length === 0) {
			// A model that chose to say nothing, rather than one cut off by its budget before a word,
			// leaves the conversation as it was: an empty answer would follow the activity in every
			// later prompt, which some providers refuse
			if (
				input.mayStaySilent === true &&
				completion.finishReason !== 'length' &&
				(completion.content ?? '').trim().length === 0
			) {
				return { answer: '', messages: input.history, tokens: spent.tokens, silent: true };
			}
			const answer = answerOf(completion);
			messages.push({ role: 'assistant', content: answer });
			return { answer, messages: [...input.history, ...messages], tokens: spent.tokens };
		}
		messages.push({
			role: 'assistant',
			content: completion.content,
			tool_calls: completion.toolCalls
		});
		// What the model wrote alongside its calls goes with each of them: a call that waits for its
		// owner shows it as the assistant's words
		const said = completion.content ?? '';
		const context: ToolContext =
			said.trim().length === 0 ? input.context : { ...input.context, accompanyingText: said };
		for (const [index, call] of completion.toolCalls.entries()) {
			if (toolCalls >= deps.maxToolCalls) {
				// This call and those after it never run
				const late = completion.toolCalls.slice(index);
				messages.push(...skippedAnswers(late, limitReached(deps.maxToolCalls)));
				notRun = late.length;
				break;
			}
			toolCalls += 1;
			const tool = deps.tools.find(call.function.name);
			const args = parseArguments(call.function.arguments);
			if (tool !== null && args !== null) actions += 1;
			const started = performance.now();
			const outcome =
				tool === null
					? { result: { error: `unknown tool ${call.function.name}` } }
					: args === null
						? { result: { error: 'arguments are not valid JSON' } }
						: await runTool(tool, args, context);
			const status: ToolCallStatus =
				tool === null
					? 'unknown_tool'
					: args === null
						? 'invalid_arguments'
						: toolCallStatus(outcome);
			deps.log.info(
				{
					tool: call.function.name,
					status,
					durationMs: Math.round(performance.now() - started)
				},
				'tool called'
			);
			deps.log.debug(
				{ tool: call.function.name, arguments: args, result: outcome.result },
				'tool called'
			);
			messages.push({
				role: 'tool',
				tool_call_id: call.id,
				name: call.function.name,
				content: JSON.stringify(outcome.result)
			});
			if (outcome.final !== undefined) {
				// The calls the model made after this one never run
				messages.push(...skippedAnswers(completion.toolCalls.slice(index + 1), NOT_RUN));
				// The conversation keeps a request as the model may read it: without what an application
				// said of the call, which only its owner reads
				messages.push({
					role: 'assistant',
					content: outcome.request === undefined ? outcome.final : conversationText(outcome.request)
				});
				return {
					answer: outcome.final,
					messages: [...input.history, ...messages],
					tokens: spent.tokens,
					...(outcome.pendingCallId === undefined ? {} : { pendingCallId: outcome.pendingCallId }),
					...(outcome.request === undefined ? {} : { request: outcome.request }),
					...(outcome.brief === undefined ? {} : { brief: outcome.brief })
				};
			}
			if (tool !== null && args !== null) input.actionsDone?.(actions);
		}
	}
	// The message ran all the calls it may, or the turn spent all its tokens: rather than fail, the
	// turn ends on the model's own account of what it did and what remains, which only the call that
	// asks for it is told to give
	// Each limit reached is logged; the model is told of the tool calls when one answer reached both,
	// as the calls it made past them did not run
	const reached: TurnLimit = notRun > 0 ? 'tool_calls' : 'tokens';
	if (notRun > 0) {
		deps.log.info({ limit: deps.maxToolCalls, toolCalls, notRun }, 'tool call limit reached');
	}
	if (spent.tokens >= deps.maxTurnTokens) {
		deps.log.info({ limit: deps.maxTurnTokens, tokens: spent.tokens }, 'token limit reached');
	}
	// In the system prompt rather than a message of its own: some chat templates refuse a system
	// message after a tool's answer
	const instructed: LlmMessage = {
		role: 'system',
		content: `${input.systemPrompt}\n\n${wrapUpInstruction(deps, reached)}`
	};
	const asked = await askModel(
		deps,
		iteration,
		[instructed, ...past, ...messages],
		[],
		spent,
		input
	);
	// A model with no tools may still call one, through the API or in its text: those calls are
	// not for the owner, its words beside them are
	const written = asked.completion.content ?? '';
	let answer = withoutCallMarkup(written);
	if (answer.length === 0) {
		const reason =
			written.trim().length > 0
				? 'markup'
				: asked.completion.toolCalls.length > 0
					? 'tool_calls'
					: 'empty';
		deps.log.info({ actions, reason }, LIMITS[reached].notice);
		answer = input.limitNotice(actions);
	}
	messages.push({ role: 'assistant', content: answer });
	return { answer, messages: [...input.history, ...messages], tokens: spent.tokens, atLimit: true };
}
