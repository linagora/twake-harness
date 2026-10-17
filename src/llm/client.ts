import { z } from 'zod';

export type LlmRole = 'system' | 'user' | 'assistant' | 'tool';

export interface LlmToolCall {
	readonly id: string;
	readonly type: 'function';
	readonly function: { readonly name: string; readonly arguments: string };
}

export interface LlmMessage {
	readonly role: LlmRole;
	readonly content: string | null;
	readonly tool_calls?: readonly LlmToolCall[];
	readonly tool_call_id?: string;
	readonly name?: string;
}

export interface LlmToolDefinition {
	readonly type: 'function';
	readonly function: {
		readonly name: string;
		readonly description: string;
		readonly parameters: Record<string, unknown>;
	};
}

export interface LlmUsage {
	readonly promptTokens: number;
	readonly completionTokens: number;
}

export interface LlmCompletion {
	readonly content: string | null;
	readonly reasoning: string | null;
	readonly toolCalls: readonly LlmToolCall[];
	readonly finishReason: string | null;
	readonly usage: LlmUsage | null;
}

// What one call may change from the client's defaults
export interface LlmCallOptions {
	readonly maxTokens?: number;
	// Another model of the gateway than the client's own, such as a faster one for a short check
	readonly model?: string;
}

export interface LlmClient {
	readonly model: string;
	// The token budget of a call that does not set its own
	readonly maxTokens: number;
	complete(
		messages: readonly LlmMessage[],
		tools: readonly LlmToolDefinition[],
		options?: LlmCallOptions
	): Promise<LlmCompletion>;
}

export interface LlmClientOptions {
	readonly baseUrl: URL;
	readonly consumerKey: string;
	readonly model: string;
	readonly maxTokens: number;
	readonly timeoutMs: number;
	readonly fetchImpl?: typeof fetch;
}

export class LlmError extends Error {
	override readonly name = 'LlmError';
}

const toolCallSchema = z.object({
	id: z.string(),
	type: z.literal('function'),
	function: z.object({ name: z.string(), arguments: z.string() })
});

const completionSchema = z.object({
	choices: z
		.array(
			z.object({
				message: z.object({
					content: z.string().nullable().optional(),
					reasoning_content: z.string().nullable().optional(),
					tool_calls: z.array(toolCallSchema).optional()
				}),
				finish_reason: z.string().nullable().optional()
			})
		)
		.min(1),
	usage: z.object({ prompt_tokens: z.number(), completion_tokens: z.number() }).partial().optional()
});

const THINK_BLOCK = /<think>([\s\S]*?)<\/think>\s*/g;

// Reasoning models return their deliberation either as a separate field or inline in think
// tags. Both are kept for the logs and neither reaches the caller.
export function splitReasoning(
	content: string | null,
	reasoningField: string | null
): { content: string | null; reasoning: string | null } {
	const parts: string[] = [];
	if (reasoningField !== null && reasoningField.length > 0) parts.push(reasoningField);
	let visible = content;
	if (visible !== null) {
		for (const match of visible.matchAll(THINK_BLOCK)) {
			const inner = match[1];
			if (inner !== undefined && inner.trim().length > 0) parts.push(inner.trim());
		}
		visible = visible.replace(THINK_BLOCK, '').trim();
	}
	return { content: visible, reasoning: parts.length === 0 ? null : parts.join('\n\n') };
}

export function makeLlmClient(options: LlmClientOptions): LlmClient {
	const fetchImpl = options.fetchImpl ?? fetch;
	const endpoint = new URL('llm/v1/chat/completions', ensureTrailingSlash(options.baseUrl));
	return {
		model: options.model,
		maxTokens: options.maxTokens,
		async complete(messages, tools, callOptions) {
			const body: Record<string, unknown> = {
				model: callOptions?.model ?? options.model,
				messages,
				max_tokens: callOptions?.maxTokens ?? options.maxTokens
			};
			if (tools.length > 0) body['tools'] = tools;
			let response: Response;
			try {
				response = await fetchImpl(endpoint, {
					method: 'POST',
					headers: { 'content-type': 'application/json', apikey: options.consumerKey },
					body: JSON.stringify(body),
					signal: AbortSignal.timeout(options.timeoutMs)
				});
			} catch (err: unknown) {
				throw new LlmError(
					`model call failed: ${err instanceof Error ? err.message : String(err)}`,
					{
						cause: err
					}
				);
			}
			if (!response.ok) {
				throw new LlmError(`model answered HTTP ${response.status}`);
			}
			const parsed = completionSchema.safeParse(await response.json());
			if (!parsed.success) {
				throw new LlmError('model answer has an unexpected shape');
			}
			const choice = parsed.data.choices[0];
			if (choice === undefined) throw new LlmError('model answered without a choice');
			const { content, reasoning } = splitReasoning(
				choice.message.content ?? null,
				choice.message.reasoning_content ?? null
			);
			const usage = parsed.data.usage;
			return {
				content,
				reasoning,
				toolCalls: choice.message.tool_calls ?? [],
				finishReason: choice.finish_reason ?? null,
				usage:
					usage?.prompt_tokens === undefined || usage.completion_tokens === undefined
						? null
						: { promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens }
			};
		}
	};
}

function ensureTrailingSlash(url: URL): URL {
	return url.pathname.endsWith('/') ? url : new URL(`${url.href}/`);
}
