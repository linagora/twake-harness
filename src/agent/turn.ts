import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import type { FastifyBaseLogger } from 'fastify';

import type { Locale } from '../i18n/messages.js';
import {
	LlmError,
	type LlmClient,
	type LlmCompletion,
	type LlmMessage,
	type LlmToolCall,
	type LlmToolDefinition
} from '../llm/client.js';
import { conversationText, type OwnerRequest } from '../consents/request.js';
import { MAX_LENGTH, mayArrangeMeeting } from '../suggestions/prefilter.js';
import {
	askedMessage,
	DECISION_MAX_TOKENS,
	MEETING_THRESHOLD,
	meetingRequest,
	readMeeting
} from '../suggestions/sort.js';
import { withoutCallMarkup } from './call-markup.js';
import type { TimeZone } from './clock.js';
import { computeMessageSize, computeVisibleHistory } from './history.js';
import {
	describeCall,
	markDone,
	PLAN_TOOL,
	planFromHistory,
	planInstruction,
	stepBefore,
	failedSteps,
	withAction,
	type PlanStep,
	type ToolCatalog
} from './plan.js';
import {
	LIKELIEST_THRESHOLD,
	laneOf,
	readProbabilities,
	REFUSE_THRESHOLD,
	routeRequest,
	WRITE_THRESHOLD,
	type Capability,
	type Lane
} from './route.js';
import {
	checkPrompt,
	isConcerned,
	readClaims,
	readSort,
	sentencesOf,
	sortRequest
} from './verify.js';
import {
	comesFromOthers,
	runTool,
	toolCallStatus,
	type ToolCallStatus,
	type ToolContext,
	type ToolRegistry,
	type TurnBrief
} from './tools.js';
import { withDatesInWords, withTrueWeekdays } from './weekdays.js';

// The id the plan the harness made from the decision model is written under in the conversation
const ROUTE_PLAN = 'route_';

// The conversation as the model reads it: without the plans the harness wrote for it, which the
// system prompt already lays out. Kept in the history for the turn an owner's answer resumes, a
// plan the model did not call reads to a small model as a step it took, after which it answers
// without calling the tools the plan names.
function withoutRoutePlans(messages: readonly LlmMessage[]): LlmMessage[] {
	return messages.filter(
		(message) =>
			!(message.role === 'tool' && message.tool_call_id?.startsWith(ROUTE_PLAN) === true) &&
			!(
				message.role === 'assistant' &&
				(message.tool_calls ?? []).length > 0 &&
				(message.tool_calls ?? []).every((call) => call.id.startsWith(ROUTE_PLAN))
			)
	);
}

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
	// What holds the turn to a plan and checks its answer; without it, the model has every tool and
	// its words go to its owner as they are
	readonly guard?: TurnGuard;
}

// What a guarded turn needs beside its tools: what they do for the owner, the models that sort
// and check, and the harness's own words to the owner, in their language
export interface TurnGuard {
	// The model that checks an answer, sentence by sentence
	readonly checkModel: string;
	// The decision model that tells what a message asks for and sorts the answers worth a check,
	// or empty when the gateway serves none
	readonly decisionModel: string;
	// What a tool does for the owner in an application, as they read it, or null when it only reads
	action(tool: string): string | null;
	// What the assistant can do in its owner's applications, reads before writes
	capabilities(): readonly Capability[];
	// Below an answer: the steps left undone, what was done, and that nothing was
	stepsNotice(steps: readonly string[]): string;
	doneNotice(steps: readonly string[]): string;
	nothingDoneNotice(): string;
	// What the platform holds of the owner's events, read by the harness itself to check an answer
	// against, or null when it may not read them without asking
	ownerEvents(): Promise<LlmMessage | null>;
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

// The model's words to its owner; in a guarded turn, without the calls it wrote in its text
// rather than made: a model that wrote nothing else answered nothing
function wordsOf(completion: LlmCompletion, guarded: boolean): string {
	const words = guarded ? withoutCallMarkup(answerOf(completion)) : answerOf(completion);
	if (words.length === 0) throw new TurnError('the model answered nothing');
	return words;
}

// The model's answer to its owner, which ends the turn
function answerOf(completion: LlmCompletion): string {
	const answer = completion.content ?? '';
	if (answer.length === 0) throw new TurnError('the model answered nothing');
	return answer;
}

// What a turn carries from one step of its graph to the next
const TurnState = Annotation.Root({
	// What this turn adds to the conversation, which the model always reads whole
	messages: Annotation<LlmMessage[]>({
		reducer: (kept, added) => [...kept, ...added],
		default: () => []
	}),
	toolCalls: Annotation<number>(),
	// The calls that reached their tool, and those of the turn before the model spoke
	actions: Annotation<number>(),
	iteration: Annotation<number>(),
	// The calls the model made past the limit of the message, which never run
	notRun: Annotation<number>(),
	// The model ran out while thinking past the tokens of the turn: its last call ends it
	cut: Annotation<boolean>(),
	// The steps of the turn, each marked done by the harness from the result of its call
	steps: Annotation<readonly PlanStep[] | null>(),
	// How likely the owner's message asks for each thing the assistant can do, as a decision model
	// read it, or null when none read it
	asked: Annotation<Readonly<Record<string, number>> | null>(),
	// Where the decision model sent the turn, or null when none sorted its message: the model then
	// has every tool
	lane: Annotation<Lane | null>(),
	// Whether the model asked its way out of its lane: it then has every tool, and each write waits
	// for the owner's yes
	escaped: Annotation<boolean>(),
	// The capabilities the turn may use in its lane, by their names
	named: Annotation<readonly string[]>(),
	// Whether the answer said something was done for the owner, in a turn that did nothing
	unfounded: Annotation<boolean>(),
	// What the model answered without a call, before the harness checked it against the plan
	draft: Annotation<string | null>(),
	// What the owner reads, once a step ended the turn
	answer: Annotation<string | null>(),
	// The model ended the turn on no words, as it may
	silent: Annotation<boolean>(),
	// The turn reached one of its limits before it answered
	atLimit: Annotation<boolean>(),
	pendingCallId: Annotation<string | undefined>(),
	request: Annotation<OwnerRequest | undefined>(),
	brief: Annotation<TurnBrief | undefined>()
});

type TurnStep = typeof TurnState.State;
type TurnUpdate = typeof TurnState.Update;

// The way out of a lane, for a model that needs a tool of the applications it was not given: the
// decision model can be wrong, and a turn it sorted must not be a dead end
const NEED_TOOL = 'need_tool';
const needToolDefinition: LlmToolDefinition = {
	type: 'function',
	function: {
		name: NEED_TOOL,
		description:
			"Call this when doing what the user asks takes a tool of their applications that you were not given. Say why. You then get every tool, and what you do with them waits for the user's yes.",
		parameters: {
			type: 'object',
			properties: { why: { type: 'string', description: 'What you need it for, in a few words' } },
			required: ['why'],
			additionalProperties: false
		}
	}
};

// What the model reads for a call its lane does not give it, or for a write the owner's message
// does not ask for
const NOT_ASKED = {
	error: 'not_asked',
	hint: "This call did not run: the user's message does not ask for it. Tell them what you could do, and let them ask for it."
} as const;

// One turn, as a graph the harness walks: the model answers, possibly through tool calls, within a
// bounded number of calls and of tokens. Which step comes next is decided here, from what the last
// one did, never by the model: its calls go to their tools, a call that waits for its owner ends
// the turn on the harness's question, and a model that goes past its calls, or a turn that spent
// its tokens, is asked once more, without tools, to tell its owner where things stand; should it
// write no words for them, the harness tells them itself what was done, so that the turn ends on
// an answer whatever the model writes.
//
// A turn is guarded once a decision model tells what its owner's message asks for, before the
// model reads it: the decision model routes, the assistant's model thinks, in a lane of the graph
// that gives it the tools the message asks for and no other of the applications. The harness alone
// marks a step done, from the result of its call; a write is always a step of the plan and waits
// for the steps before it not yet attempted; and the owner reads below the answer what was done
// and what failed. The plan is a ledger of what was attempted, not an order: the model is not sent
// back to a step it left. The answer of a turn that could act and did nothing is checked sentence
// by sentence: when one says something was done, the owner reads below the answer that nothing was.
//
// The graph keeps no checkpoint: a call that waits for its owner is frozen in the database, and
// the turn their answer resumes is a new walk, which reads its plan back from the conversation.
// Every model call and every tool call is logged at info with its metadata only. The conversation
// itself (prompt, answer, reasoning, tool arguments and results) goes to debug: messages reach the
// harness end-to-end encrypted and are decrypted only here, so their text must stay out of the
// production logs.
export async function runTurn(deps: TurnDeps, input: TurnInput): Promise<TurnOutput> {
	const { guard } = input;
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
	const spent: Spent = { tokens: 0, unreported: false };
	const decisionModel = guard?.decisionModel ?? '';
	const capabilities = guard?.capabilities() ?? [];
	const capabilityNames = new Set(capabilities.map((capability) => capability.name));
	const actionOf = (tool: string): string | null => guard?.action(tool) ?? null;
	const catalog: ToolCatalog = {
		describe: (name) =>
			deps.tools.find(name) === null
				? null
				: (actionOf(name) ?? deps.tools.find(name)?.definition.function.description ?? null),
		isAction: (name) => actionOf(name) !== null,
		detail: (args) => describeCall(args, input.locale, input.timeZone)
	};

	const systemFor = (state: TurnStep, more?: string): LlmMessage => ({
		role: 'system',
		content: [
			input.systemPrompt,
			...(state.steps === null ? [] : [planInstruction(state.steps)]),
			...(more === undefined ? [] : [more])
		].join('\n\n')
	});

	// What the owner's message asks for, told by a decision model before the assistant's model
	// reads it: the lane of the turn, and the capabilities it names. A sorting that fails leaves
	// the turn to the model.
	async function route(state: TurnStep): Promise<TurnUpdate> {
		// The measure never fails the turn, and is over before the turn goes on
		const [sent] = await Promise.allSettled([sort(state), scoreAsked()]);
		if (sent.status === 'rejected') throw sent.reason;
		return sent.value;
	}

	// The message a user asked their assistant about from Twake Chat (« Ask my assistant »), put to
	// the decision model as a channel's message is: whether a suggestion could have come of it.
	// Measured, never acted on, and spent on no one's tokens: it reads the message alone, without
	// the one before it that a channel gives, and from a conversation the listener may never read,
	// so a miss counted here is one of the decision model on a lone message. The log lines hold no
	// word of it.
	const fromChat: { readonly request: string | null; readonly caught: boolean | null }[] = [];
	async function scoreAsked(): Promise<void> {
		const message = input.message === null ? null : askedMessage(input.message);
		if (message === null) return;
		const words = mayArrangeMeeting(message.quoted.text);
		// A channel never sorts a message this long: it was missed whatever the model says
		if (message.quoted.text.length > MAX_LENGTH) {
			fromChat.push({ request: message.request, caught: false });
			deps.log.info(
				{ request: message.request, probability: null, caught: false, words, reason: 'too_long' },
				'asked message sorted'
			);
			return;
		}
		let probability: number | null = null;
		try {
			const sorted = await deps.llm.complete(meetingRequest([message.quoted]), [], {
				model: decisionModel,
				maxTokens: DECISION_MAX_TOKENS
			});
			probability = readMeeting(sorted.content);
		} catch (err: unknown) {
			deps.log.warn({ err }, 'asked message not sorted');
		}
		const caught = probability === null ? null : probability >= MEETING_THRESHOLD;
		fromChat.push({ request: message.request, caught });
		deps.log.info({ request: message.request, probability, caught, words }, 'asked message sorted');
	}

	async function sort(state: TurnStep): Promise<TurnUpdate> {
		if (capabilities.length === 0 || input.message === null) return {};
		try {
			const started = performance.now();
			const sorted = await deps.llm.complete(routeRequest(capabilities, past, input.message), [], {
				model: decisionModel
			});
			spend(deps.log, state.iteration, sorted, spent);
			const given = readProbabilities(sorted.content);
			const durationMs = Math.round(performance.now() - started);
			if (given === null) {
				deps.log.info({ lane: null, durationMs }, 'message routed');
				return {};
			}
			const { lane, named } = laneOf(given, capabilities);
			const sent = {
				lane,
				named: named.map((capability) => capability.name),
				asked: Object.fromEntries(given)
			};
			deps.log.info({ lane, tools: sent.named, durationMs }, 'message routed');
			return sent;
		} catch (err: unknown) {
			if (!(err instanceof LlmError)) throw err;
			deps.log.warn({ err }, 'message not routed');
			return {};
		}
	}

	// The plan of the turn, made by the harness from what the decision model named, before the
	// model reads the message: one step for each capability, reads before writes. It is written in
	// the conversation as a plan the assistant made, so that the turn an owner's answer resumes
	// reads it back. A message that names nothing has no plan.
	function plan(state: TurnStep): TurnUpdate {
		if (state.named.length === 0) return {};
		const steps = state.named.map((name) => ({
			what: catalog.describe(name) ?? name,
			tool: name,
			...(catalog.isAction(name) && (state.asked?.[name] ?? 0) < WRITE_THRESHOLD
				? { sure: false }
				: {})
		}));
		const id = `${ROUTE_PLAN}${input.history.length}`;
		deps.log.info({ steps: steps.length }, 'turn planned');
		return {
			steps: steps.map((step) => ({ ...step, done: false })),
			messages: [
				{
					role: 'assistant',
					content: null,
					tool_calls: [
						{
							id,
							type: 'function',
							function: { name: PLAN_TOOL, arguments: JSON.stringify({ steps }) }
						}
					]
				},
				{
					role: 'tool',
					tool_call_id: id,
					name: PLAN_TOOL,
					content: JSON.stringify({ planned: steps.length })
				}
			]
		};
	}

	// One answer of the model, to a prompt and with the tools the step gives it
	async function answer(
		state: TurnStep,
		system: LlmMessage,
		offered: readonly LlmToolDefinition[]
	): Promise<TurnUpdate> {
		const asked = await askModel(
			deps,
			state.iteration,
			[system, ...withoutRoutePlans([...past, ...state.messages])],
			offered,
			spent,
			input
		);
		const iteration = state.iteration + 1;
		// The model ran out while thinking past the tokens of the turn: its last call, without tools,
		// ends it
		if (asked.cut) return { iteration, cut: true };
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
				return { iteration, silent: true };
			}
			// The answer stands as soon as the model gives it: the plan is a ledger of what was
			// attempted, and the model is not sent back to a step it left
			const words = wordsOf(completion, guard !== undefined);
			return { iteration, draft: words, answer: words };
		}
		return {
			iteration,
			draft: null,
			messages: [
				{ role: 'assistant', content: completion.content, tool_calls: completion.toolCalls }
			]
		};
	}

	// A turn no decision model sorted: the model has every tool
	const model = (state: TurnStep): Promise<TurnUpdate> =>
		answer(state, systemFor(state), deps.tools.definitions);

	// The tools of a lane: the assistant's own always, and of what it can do in the applications,
	// what the lane needs. A model cannot call what it is not given.
	const toolsOf = (state: TurnStep): readonly LlmToolDefinition[] =>
		state.lane === 'unsure'
			? deps.tools.definitions
			: [
					...deps.tools.definitions.filter(
						(tool) =>
							!capabilityNames.has(tool.function.name) || state.named.includes(tool.function.name)
					),
					// Whatever the lane, the model may say that it needs more
					needToolDefinition
				];
	const inLane =
		(note?: string) =>
		(state: TurnStep): Promise<TurnUpdate> =>
			answer(state, systemFor(state, note), toolsOf(state));
	// The message asks for nothing in the applications: the model talks, with none of their tools
	const discuss = inLane();
	// It asks for something to be read: the model has those reads, and no write
	const consult = inLane();
	// It asks for something to be done: the model has what the plan names, and is held to it
	const act = inLane();
	// It may ask for something to be done: the model has every tool, and a write waits for a yes
	const unsure = inLane(
		'The user may be asking you to do something in their applications, or not. If you judge that they are, do it: they will be asked to confirm. If not, answer them.'
	);

	// Runs the calls of the model's last answer, in their order, up to the limit of the message
	async function tools(state: TurnStep): Promise<TurnUpdate> {
		const made = state.messages.at(-1);
		const calls = made?.tool_calls ?? [];
		const messages: LlmMessage[] = [];
		let { toolCalls, actions, lane, escaped } = state;
		let plan = state.steps;
		const kept = (): TurnUpdate => ({ messages, toolCalls, actions, steps: plan, lane, escaped });
		// What the model wrote alongside its calls goes with each of them: a call that waits for its
		// owner shows it as the assistant's words
		const said = made?.content ?? '';
		const context: ToolContext =
			said.trim().length === 0 ? input.context : { ...input.context, accompanyingText: said };
		for (const [index, call] of calls.entries()) {
			const args = parseArguments(call.function.arguments);
			const atLimit = toolCalls >= deps.maxToolCalls;
			if (atLimit) {
				// This call and those after it never run
				const late = calls.slice(index);
				messages.push(...skippedAnswers(late, limitReached(deps.maxToolCalls)));
				return { ...kept(), notRun: late.length };
			}
			toolCalls += 1;
			if (call.function.name === NEED_TOOL && lane !== null) {
				// The model asked its way out of its lane: from here on it has every tool
				deps.log.info({ tool: NEED_TOOL, status: 'ok', lane }, 'tool called');
				lane = 'unsure';
				escaped = true;
				messages.push(
					...skippedAnswers([call], {
						ok: true,
						hint: "You now have every tool. What you do in the user's applications waits for their yes."
					})
				);
				continue;
			}
			const tool = deps.tools.find(call.function.name);
			// A write is held to what the owner's message asks for, as the decision model read it:
			// one the message clearly does not ask for does not run, and one it may ask for waits for
			// the owner's yes whatever they allowed before
			const read =
				state.asked !== null && catalog.isAction(call.function.name)
					? (state.asked[call.function.name] ?? 0)
					: 1;
			// Out of its lane at the model's own asking, a write is never refused for what the
			// decision model read, and always waits for the owner
			const likely = escaped && read < REFUSE_THRESHOLD ? REFUSE_THRESHOLD : read;
			// Nor does a call to what the lane does not give the model, should it make one all the same
			const outOfLane =
				lane !== null &&
				lane !== 'unsure' &&
				capabilityNames.has(call.function.name) &&
				!state.named.includes(call.function.name);
			if (outOfLane || likely < REFUSE_THRESHOLD) {
				deps.log.info({ tool: call.function.name, status: 'not_asked' }, 'tool called');
				messages.push(...skippedAnswers([call], NOT_ASKED));
				continue;
			}
			const callContext: ToolContext =
				likely < WRITE_THRESHOLD ? { ...context, askOwner: true } : context;
			if (guard !== undefined) plan = withAction(plan, call.function.name, catalog);
			const first = catalog.isAction(call.function.name)
				? stepBefore(plan, call.function.name)
				: null;
			if (first !== null) {
				// The plan is kept in its order for what acts for the owner, whatever the model calls
				deps.log.info({ tool: call.function.name, status: 'step_order' }, 'tool called');
				messages.push(
					...skippedAnswers([call], {
						error: 'step_order',
						hint: `This call did not run: the step "${first.what}" (${first.tool}) of your plan comes before it and is not done. Do that step, then make this call again.`
					})
				);
				continue;
			}
			if (tool !== null && args !== null) actions += 1;
			const started = performance.now();
			const outcome =
				tool === null
					? { result: { error: `unknown tool ${call.function.name}` } }
					: args === null
						? { result: { error: 'arguments are not valid JSON' } }
						: await runTool(tool, args, callContext);
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
			if (plan !== null) {
				plan = markDone(plan, call.function.name, outcome, catalog.detail(args));
			}
			if (outcome.final !== undefined) {
				// The calls the model made after this one never run
				messages.push(...skippedAnswers(calls.slice(index + 1), NOT_RUN));
				// The conversation keeps a request as the model may read it: without what an application
				// said of the call, which only its owner reads
				messages.push({
					role: 'assistant',
					content: outcome.request === undefined ? outcome.final : conversationText(outcome.request)
				});
				return {
					...kept(),
					answer: outcome.final,
					pendingCallId: outcome.pendingCallId,
					request: outcome.request,
					brief: outcome.brief
				};
			}
			if (tool !== null && args !== null) input.actionsDone?.(actions);
		}
		return kept();
	}

	// The harness's check of the words of an answer, in a turn that could act for its owner and did
	// not. A decision model first tells, in a fraction of a second, whether the exchange has to do
	// with what the assistant can do: one that has not is sent as it is. For the others, a model
	// reads the answer sentence by sentence, with what came before it, and names those that say the
	// assistant did something in an application. The words stay as they are; the owner then reads
	// below them that nothing was done. A check that fails changes nothing.
	async function verify(state: TurnStep): Promise<TurnUpdate> {
		// A turn others started says what the harness chose for it, and is not checked
		if (guard === undefined || comesFromOthers(input.context.origin)) return {};
		const steps = state.steps ?? [];
		// A turn that did something for its owner may say so: only one that did nothing is checked
		const acted = steps.some((step) => step.done && actionOf(step.tool) !== null);
		const canAct = deps.tools.definitions.some((tool) => actionOf(tool.function.name) !== null);
		if (!canAct || acted) return {};
		const words = state.answer ?? '';
		try {
			const actions = deps.tools.definitions
				.filter((tool) => actionOf(tool.function.name) !== null)
				.map((tool) => ({ name: tool.function.name, description: tool.function.description }));
			const last = [...past, ...state.messages].filter((said) => said.role === 'user').at(-1);
			const started = performance.now();
			const sorted = await deps.llm.complete(sortRequest(actions, last?.content ?? '', words), [], {
				model: decisionModel
			});
			spend(deps.log, state.iteration, sorted, spent);
			const probability = readSort(sorted.content);
			deps.log.info(
				{ probability, durationMs: Math.round(performance.now() - started) },
				'answer sorted'
			);
			if (!isConcerned(probability)) return {};
			const sentences = sentencesOf(words, input.locale);
			// What the owner's events say, when the turn did not read them: a sentence that reports one
			// is then told from a sentence that claims an action
			const events = state.messages.some((said) => said.role === 'tool')
				? null
				: await guard.ownerEvents();
			const checked = await deps.llm.complete(
				checkPrompt([...past, ...state.messages, ...(events === null ? [] : [events])], sentences),
				[],
				{ model: guard.checkModel }
			);
			spend(deps.log, state.iteration, checked, spent);
			const claims = readClaims(checked.content, sentences.length);
			deps.log.info({ sentences: sentences.length, claims: claims.length }, 'answer checked');
			if (claims.length === 0) return {};
			// The words stay as the model wrote them: a check can be wrong, and the harness's own
			// word below them is what counts
			return { unfounded: true };
		} catch (err: unknown) {
			if (!(err instanceof LlmError)) throw err;
			deps.log.warn({ err }, 'answer not checked');
			return {};
		}
	}

	// The message ran all the calls it may, or the turn spent all its tokens: rather than fail, the
	// turn ends on the model's own account of what it did and what remains, which only the call that
	// asks for it is told to give. Each limit reached is logged; the model is told of the tool calls
	// when one answer reached both, as the calls it made past them did not run.
	async function wrapUp(state: TurnStep): Promise<TurnUpdate> {
		const reached: TurnLimit = state.notRun > 0 ? 'tool_calls' : 'tokens';
		if (state.notRun > 0) {
			deps.log.info(
				{ limit: deps.maxToolCalls, toolCalls: state.toolCalls, notRun: state.notRun },
				'tool call limit reached'
			);
		}
		if (spent.tokens >= deps.maxTurnTokens) {
			deps.log.info({ limit: deps.maxTurnTokens, tokens: spent.tokens }, 'token limit reached');
		}
		// In the system prompt rather than a message of its own: some chat templates refuse a system
		// message after a tool's answer
		const asked = await askModel(
			deps,
			state.iteration,
			[systemFor(state, wrapUpInstruction(deps, reached)), ...past, ...state.messages],
			[],
			spent,
			input
		);
		// A model with no tools may still call one, through the API or in its text: those calls are
		// not for the owner, its words beside them are
		const written = asked.completion.content ?? '';
		let words = withoutCallMarkup(written);
		if (words.length === 0) {
			const reason =
				written.trim().length > 0
					? 'markup'
					: asked.completion.toolCalls.length > 0
						? 'tool_calls'
						: 'empty';
			deps.log.info({ actions: state.actions, reason }, LIMITS[reached].notice);
			words = input.limitNotice(state.actions);
		}
		return { answer: words, atLimit: true };
	}

	// The answer as the owner reads it and as the conversation keeps it: the model's words, and
	// below them the harness's own account, from the results of the calls and never from those
	// words: what was done for the owner, and the steps that stay undone
	function report(state: TurnStep): TurnUpdate {
		const undone = failedSteps(state.steps);
		const done = (state.steps ?? []).filter((step) => step.done && actionOf(step.tool) !== null);
		if (undone.length > 0) deps.log.info({ undone: undone.length }, 'plan left undone');
		const words = [
			state.answer ?? '',
			...(guard === undefined || done.length === 0
				? []
				: [
						guard.doneNotice(
							done.map((step) =>
								step.detail === undefined ? step.what : `${step.what} (${step.detail})`
							)
						)
					]),
			...(guard === undefined || undone.length === 0
				? []
				: [guard.stepsNotice(undone.map((step) => step.what))]),
			// The steps left undone already say that nothing was done
			...(guard !== undefined && state.unfounded && undone.length === 0
				? [guard.nothingDoneNotice()]
				: [])
		]
			.filter((part) => part.length > 0)
			.join('\n\n');
		return { answer: words, messages: [{ role: 'assistant', content: words }] };
	}

	// The step where the model thinks, in this turn; a turn that spent its tokens has no call left
	// with tools, and ends on its account
	const THINKERS = ['model', 'discuss', 'consult', 'act', 'unsure'] as const;
	type Thinker = (typeof THINKERS)[number];
	const thinker = (state: TurnStep): Thinker | 'wrapUp' =>
		spent.tokens >= deps.maxTurnTokens ? 'wrapUp' : (state.lane ?? 'model');
	const afterAnswer = (state: TurnStep): 'tools' | 'verify' | 'wrapUp' | typeof END =>
		state.silent ? END : state.cut ? 'wrapUp' : state.draft === null ? 'tools' : 'verify';
	const AFTER_ANSWER = ['tools', 'verify', 'wrapUp', END] as const;

	const graph = new StateGraph(TurnState)
		.addNode('route', route)
		.addNode('plan', plan)
		.addNode('model', model)
		.addNode('discuss', discuss)
		.addNode('consult', consult)
		.addNode('act', act)
		.addNode('unsure', unsure)
		.addNode('tools', tools)
		.addNode('verify', verify)
		.addNode('wrapUp', wrapUp)
		.addNode('report', report)
		// A new message of an owner is sorted first, when the gateway serves a model for that: an
		// event's text is the harness's own
		.addConditionalEdges(
			START,
			(state) =>
				decisionModel.length > 0 && input.message !== null && !comesFromOthers(input.context.origin)
					? 'route'
					: thinker(state),
			['route', ...THINKERS, 'wrapUp']
		)
		// What it named is planned, then the turn goes into its lane; one it did not sort goes to
		// the model
		.addEdge('route', 'plan')
		.addConditionalEdges('plan', thinker, [...THINKERS, 'wrapUp'])
		.addConditionalEdges('model', afterAnswer, [...AFTER_ANSWER])
		.addConditionalEdges('discuss', afterAnswer, [...AFTER_ANSWER])
		.addConditionalEdges('consult', afterAnswer, [...AFTER_ANSWER])
		.addConditionalEdges('act', afterAnswer, [...AFTER_ANSWER])
		.addConditionalEdges('unsure', afterAnswer, [...AFTER_ANSWER])
		// What a call answered returns to the turn's own lane
		.addConditionalEdges(
			'tools',
			(state) => (state.answer !== null ? END : state.notRun > 0 ? 'wrapUp' : thinker(state)),
			[...THINKERS, 'wrapUp', END]
		)
		.addEdge('verify', 'report')
		.addEdge('wrapUp', 'report')
		.addEdge('report', END)
		.compile();

	// A turn its owner's yes resumes goes on with the plan it had, if any. What the message asked
	// for is not kept: the resumed turn has every tool, the writes its plan was sure of go as the
	// owner allowed, and any other write waits for their yes
	const resuming =
		guard !== undefined && input.message === null && !comesFromOthers(input.context.origin);
	const resumed = resuming ? planFromHistory(input.history, catalog) : null;
	// What came of a message asked about from Chat, to put beside whether the sorting caught it: the
	// writes done, and the one that waits for the owner, whose yes or no the consent's own line tells
	const answered = (fields: Record<string, unknown>): void => {
		for (const scored of fromChat)
			deps.log.info({ ...scored, ...fields }, 'asked message answered');
	};
	const walked = graph.invoke(
		{
			messages: input.message === null ? [] : [{ role: 'user', content: input.message }],
			toolCalls: 0,
			actions: input.actionsBefore,
			iteration: 0,
			notRun: 0,
			cut: false,
			steps: resumed,
			lane: resuming ? 'act' : null,
			named: resuming ? [...capabilityNames] : [],
			escaped: resuming,
			asked: resuming
				? Object.fromEntries(
						(resumed ?? []).map((step) => [
							step.tool,
							step.sure === false ? LIKELIEST_THRESHOLD : 1
						])
					)
				: null,
			unfounded: false,
			draft: null,
			answer: null,
			silent: false,
			atLimit: false,
			pendingCallId: undefined,
			request: undefined,
			brief: undefined
		},
		// Every model answer that calls tools runs at least one of them, so the limit of tool calls
		// bounds the walk: two steps for each, and those of the sorting, the plan, the answer past
		// the limit, its check and the report
		{ recursionLimit: 2 * deps.maxToolCalls + 16 }
	);
	const end = await walked.catch((err: unknown) => {
		answered({ failed: true });
		throw err;
	});
	answered({
		done: (end.steps ?? [])
			.filter((step) => step.done && actionOf(step.tool) !== null)
			.map((step) => step.tool),
		pendingCallId: end.pendingCallId ?? null
	});
	if (end.silent)
		return { answer: '', messages: input.history, tokens: spent.tokens, silent: true };
	if (end.answer === null) throw new TurnError('the turn ended without an answer');
	return {
		answer: end.answer,
		messages: [...input.history, ...end.messages],
		tokens: spent.tokens,
		...(end.pendingCallId === undefined ? {} : { pendingCallId: end.pendingCallId }),
		...(end.request === undefined ? {} : { request: end.request }),
		...(end.brief === undefined ? {} : { brief: end.brief }),
		...(end.atLimit ? { atLimit: true as const } : {})
	};
}
