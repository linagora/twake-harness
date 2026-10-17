import type { FastifyBaseLogger } from 'fastify';

import { findCalendarOperation, zoneOfAnswer } from '../agent/calendar.js';
import { fetchOwnerLocale } from '../assistants/locale.js';
import type { Config } from '../config.js';
import type { WaitReason } from '../consents/consent.js';
import {
	consentStepOf,
	readDelegationRefusal,
	type DelegationRefusal
} from '../consents/delegation.js';
import type { ConsentMetrics } from '../consents/metrics.js';
import { hasConsent, insertPendingCall, type PendingCallInput } from '../consents/repository.js';
import { makeOwnerRequest, requestText } from '../consents/request.js';
import { withPrincipal } from '../db/client.js';
import { getMessages, type Locale } from '../i18n/messages.js';
import { ORGANIZATION_PRINCIPAL } from '../principals/principal.js';
import { saveOwnerTimeZone } from '../settings/repository.js';
import type { LlmToolDefinition } from '../llm/client.js';
import {
	comesFromOthers,
	isConversationGone,
	keepInConversation,
	type CONVERSATION_GONE,
	type Tool,
	type ToolContext,
	type ToolOutcome
} from '../agent/tools.js';
import { makeOptionalOwnerConsentLink } from './consent-link.js';
import { labelOf, type DomainDescriptions } from './domains.js';
import { toolParametersOf, type ContractDefinition } from './openapi.js';
import {
	PREVIEW_DIGEST_HEADER,
	PREVIEW_HEADER,
	readPreview,
	type Preview,
	type PreviewAnswer
} from './preview.js';
import { refusedAsRecurring, wholeSeriesValues, withoutSeries } from './series.js';

export interface ContractToolDeps {
	readonly config: Config;
	readonly log: FastifyBaseLogger;
	readonly fetchImpl?: typeof fetch;
	// The path of the document's server, from readServer: empty when the paths are absolute
	readonly serverPath?: string;
	// Where the api role counts the calls that wait for their owner
	readonly consentMetrics: ConsentMetrics;
	// How the document names the applications to their owners, from readDomains
	readonly domains: DomainDescriptions;
}

// Joins path segments under the gateway's address, keeping the path that address may carry: no
// segment may climb back to the root, and an empty one adds nothing
export function joinPath(base: URL, ...segments: string[]): URL {
	const root = base.href.endsWith('/') ? base.href : `${base.href}/`;
	const kept = segments
		.map((segment, index) => {
			const trimmed = segment.replace(/^\/+/, '');
			return index === segments.length - 1 ? trimmed : trimmed.replace(/\/+$/, '');
		})
		.filter((segment) => segment.length > 0);
	return new URL(kept.join('/'), root);
}

// The body of an answer through the gateway: its JSON, the text itself when it is no JSON, or
// null when there is none
export function parseBody(text: string): unknown {
	if (text.length === 0) return null;
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return text;
	}
}

// Reading a contract and acting through one are separate rights, which stay a switch above what
// an owner allows: a principal without the second never writes, whoever asks
export const CALL_CONTRACTS = 'contracts.call';
export const ACT_THROUGH_CONTRACTS = 'contracts.act';

// What the model reads when a call that would wait for its owner is too large to show them whole:
// nothing waits, and it may make the call smaller
const TOO_LARGE_TO_CONFIRM = {
	error: 'too_large_to_confirm',
	hint: 'The owner must see a call whole before it runs, and this one is too large to show in one message. Nothing was done. Make the call smaller, for instance with a shorter text, then make it again.'
} as const;

// What the model reads when its call would wait for its owner, and the contract, asked what the
// call would do, answered with an error: its owner is not asked about a call they cannot see as
// its application tells it, so nothing waits, and the contract's answer follows, as data
const PREVIEW_REFUSED = {
	error: 'preview_refused',
	hint: 'The application answered with an error when asked what this call would do, so the owner was not asked about it. Its answer follows: fix the call if it says how, or tell the owner.'
} as const;

// The same when the contract did not answer in time, or at all: whether it did anything is unknown
const PREVIEW_UNANSWERED = {
	error: 'preview_unanswered',
	hint: 'The application did not answer when asked what this call would do, so the owner was not asked about it, and whether the application did anything is unknown. Tell the owner, and make the call again only if they ask.'
} as const;

// What the model reads when the contract, asked what a call would do, did it instead: the call was
// made without its owner's yes, and the harness told them so
const MADE_WITHOUT_OWNER = {
	status: 'made_without_owner',
	hint: "Asked what this call would do, the application did it instead: the call was made, without the owner's yes, and the harness told the owner so. Do not make it again."
} as const;

// Of the arguments named, those a call carries once and in their shape, as it sent them, and the
// names of the others it carries, in malformedArguments, never with what they hold
function loggedArguments(
	url: URL,
	shapes: Readonly<Record<string, RegExp>>
): Record<string, string | readonly string[]> {
	const logged: Record<string, string> = {};
	const malformed: string[] = [];
	for (const [name, shape] of Object.entries(shapes)) {
		const values = url.searchParams.getAll(name);
		if (values.length === 0) continue;
		const [value] = values;
		if (values.length === 1 && value !== undefined && shape.test(value)) logged[name] = value;
		else malformed.push(name);
	}
	return malformed.length === 0 ? logged : { ...logged, malformedArguments: malformed };
}

// A call as the model wrote it, ready to go on the gateway: the operation's address, with its
// parameters, and its body
interface ContractRequest {
	readonly url: URL;
	readonly body: string | undefined;
}

// What goes to a contract: the action itself, carrying the digest of the preview its owner was
// shown when there was one; or a preview, which asks what the action would do without doing it,
// in the owner's language for the words of its summary
type Sending =
	| { readonly kind: 'action'; readonly previewDigest: string | null }
	| { readonly kind: 'preview'; readonly locale: Locale };

// How the error of a call that never reached its contract begins, so that a caller tells it from
// a call the harness refused to make
export const CONTRACT_UNREACHED = 'the contract could not be called';

// What a contract answered: its status, 0 when it could not be called, the preview header it
// carries back, if any, and its body; what the model reads of it; and the refusal to act for the
// owner until they give what it lacks, the broker's or the contract's, when the gateway relayed one
interface Answered extends PreviewAnswer {
	readonly result: unknown;
	readonly delegation: DelegationRefusal | null;
}

// A contract becomes a tool that calls it through APISIX, naming the owner so that the gateway
// attaches the owner's token: the harness never holds one. What comes back is data for the model.
export function makeContractTool(contract: ContractDefinition, deps: ContractToolDeps): Tool {
	const { config, log } = deps;
	const fetchImpl = deps.fetchImpl ?? fetch;
	const definition: LlmToolDefinition = {
		type: 'function',
		function: {
			name: contract.toolName,
			description: contract.description,
			parameters: toolParametersOf(contract)
		}
	};
	const argumentKeys = [
		...contract.parameters.map((p) => p.name),
		...(contract.bodySchema === null ? [] : ['body'])
	];
	// Whether the contract is asked what a call would do before its owner is: as the catalog
	// declares, until a preview of it does what the call asks, a sign that it takes the preview
	// header for nothing. The catalog's next load makes the tool again, previews included.
	let previewing = contract.preview;
	// What the harness does with the calls beyond making them, when the contract is one of the
	// calendar's operations it knows
	const calendar = findCalendarOperation(contract.toolName);

	// Freezes the call as it would run until its owner answers, with the turn's session, the
	// harness's question as its owner reads it and the digest of the preview they are shown, if
	// any, counts it, and logs why it waits, never what it would send; resolves to the frozen call's
	// id, or to CONVERSATION_GONE when the turn's conversation was erased with its assistant: nothing
	// waits
	async function freeze(
		values: Record<string, unknown>,
		context: ToolContext,
		reasons: readonly WaitReason[],
		request: string,
		previewDigest: string | null
	): Promise<string | typeof CONVERSATION_GONE> {
		const owner = context.principalId;
		const call: PendingCallInput = {
			owner,
			tool: contract.toolName,
			contract: contract.id,
			domain: contract.domain,
			level: contract.level,
			reasons,
			arguments: values,
			previewDigest,
			correlationId: context.correlationId ?? null,
			origin: context.origin ?? 'owner',
			sessionId: context.sessionId ?? null,
			request
		};
		const pendingCallId = await keepInConversation(context, (tx) => insertPendingCall(tx, call));
		if (isConversationGone(pendingCallId)) return pendingCallId;
		deps.consentMetrics.requested(call);
		log.info(
			{
				pendingCallId,
				reasons,
				contract: contract.id,
				tool: contract.toolName,
				domain: contract.domain,
				// pino writes the line's own level under `level`
				consentLevel: contract.level,
				...(contract.risk === null ? {} : { risk: contract.risk }),
				...(previewDigest === null ? {} : { preview: true }),
				principal: owner
			},
			'contract call waits for its owner'
		);
		return pendingCallId;
	}

	// Why a call waits for its owner, every reason that applies: the first read of an application,
	// or the first write there even once it may read; a write that a turn an event started
	// prepared, each time, since what arrived was written by someone else; and a high-risk write,
	// each time, whatever its owner allowed. The organization agent acts for no user: none of its
	// calls waits for anyone.
	async function reasonsToWait(context: ToolContext): Promise<WaitReason[]> {
		const owner = context.principalId;
		if (owner === ORGANIZATION_PRINCIPAL) return [];
		const reasons: WaitReason[] = [];
		if (
			!(await withPrincipal(context.db, { id: owner }, (tx) =>
				hasConsent(tx, owner, contract.domain, contract.level)
			))
		) {
			reasons.push('consent');
		}
		if (contract.level === 'write' && comesFromOthers(context.origin)) reasons.push('event_turn');
		if (contract.risk === 'high') reasons.push('high_risk');
		// A write the harness is not sure its owner asked for
		if (contract.level === 'write' && context.askOwner === true) reasons.push('unsure');
		return reasons;
	}

	// The call as the model wrote it, at the path the document gives, under its server path and the
	// prefix the deployment may add, always on the gateway: the harness has no other way out
	function build(values: Record<string, unknown>): ContractRequest | { readonly error: string } {
		let path = contract.pathTemplate;
		const query = new URLSearchParams();
		for (const parameter of contract.parameters) {
			const value = values[parameter.name];
			if (value === undefined || value === null) {
				if (parameter.required) return { error: `${parameter.name} is required` };
				continue;
			}
			if (parameter.location === 'path') {
				path = path.replace(`{${parameter.name}}`, encodeURIComponent(String(value)));
			} else if (Array.isArray(value)) {
				// One key per item, the OpenAPI default for a query array (form, exploded): a
				// joined "a,b" would reach the contract as a single value
				for (const item of value as readonly unknown[]) query.append(parameter.name, String(item));
			} else {
				query.set(parameter.name, String(value));
			}
		}
		const url = joinPath(
			config.apisix.baseUrl,
			config.contracts.basePath,
			deps.serverPath ?? '',
			path
		);
		url.search = query.toString();
		const body = contract.bodySchema === null ? undefined : JSON.stringify(values['body'] ?? {});
		return { url, body };
	}

	// Calls the contract through APISIX, and logs the call, never what it sent or got back but the
	// arguments a calendar operation gives its line. Only a preview carries the header that asks for
	// one, and the action carries the digest of the preview its owner allowed, never that header.
	async function send(
		request: ContractRequest,
		context: ToolContext,
		sending: Sending
	): Promise<Answered> {
		// The organization agent calls with the harness key alone: it acts for no user
		const headers: Record<string, string> = {
			apikey: config.apisix.consumerKey,
			'x-twake-contract': contract.id
		};
		if (context.principalId !== ORGANIZATION_PRINCIPAL) {
			headers['x-twake-on-behalf-of'] = context.principalId;
		}
		// The gateway writes the audit record of the call; this id links it to the turn
		if (context.correlationId !== undefined && context.correlationId.length > 0) {
			headers['x-correlation-id'] = context.correlationId;
		}
		if (sending.kind === 'preview') {
			headers[PREVIEW_HEADER] = 'true';
			headers['accept-language'] = sending.locale;
		} else if (sending.previewDigest !== null) {
			headers[PREVIEW_DIGEST_HEADER] = sending.previewDigest;
		}
		if (request.body !== undefined) headers['content-type'] = 'application/json';
		let status = 0;
		let echoed: string | null = null;
		let body: unknown = null;
		let result: unknown;
		let delegation: DelegationRefusal | null = null;
		try {
			const response = await fetchImpl(request.url, {
				method: contract.method.toUpperCase(),
				headers,
				...(request.body === undefined ? {} : { body: request.body }),
				signal: AbortSignal.timeout(config.contracts.timeoutMs)
			});
			status = response.status;
			echoed = response.headers.get(PREVIEW_HEADER);
			body = parseBody(await response.text());
			result = { status, body };
			delegation = readDelegationRefusal(status, body);
		} catch (err: unknown) {
			result = {
				error: `${CONTRACT_UNREACHED}: ${err instanceof Error ? err.message : String(err)}`
			};
		}
		log.info(
			{
				contract: contract.id,
				method: contract.method,
				status,
				principal: context.principalId,
				...loggedArguments(request.url, calendar?.loggedArguments ?? {}),
				...(sending.kind === 'preview' ? { preview: true } : {}),
				...(delegation === null ? {} : { delegation: delegation.code })
			},
			'contract called'
		);
		return { status, echoed, body, result, delegation };
	}

	// The platform lacks what it needs from the owner to act for them: the broker, their permission
	// for their assistant to act for them, or, for Twake Space, an API token of theirs that Space
	// accepts for the call. The call waits for them, and the turn ends with the harness's own
	// request, which names the application as a first use does, tells them why and gives them the
	// deployment's consent link, at the step where they give what lacks, never one from the answer,
	// which a contract could have written. A call that carries the digest of the preview its owner
	// allowed keeps it for when it runs.
	async function waitForDelegation(
		values: Record<string, unknown>,
		context: ToolContext,
		refusal: DelegationRefusal,
		previewDigest: string | null,
		locale: Locale
	): Promise<ToolOutcome> {
		const application = labelOf(
			deps.domains,
			contract.domain,
			contract.level,
			locale,
			config.locale
		);
		const request = getMessages(locale).consent.delegation(
			application.name,
			contract.level,
			refusal,
			makeOptionalOwnerConsentLink(
				config.consent.brokerConsentUrl,
				context.principalId,
				consentStepOf(refusal.code)
			)
		);
		const pendingCallId = await freeze(values, context, ['delegation'], request, previewDigest);
		if (isConversationGone(pendingCallId)) return { result: pendingCallId };
		return {
			result: { status: 'awaiting_owner', reason: 'delegation', code: refusal.code },
			final: request,
			pendingCallId
		};
	}

	// Asked only what a call would do, the contract did it: the call was made without its owner's
	// yes. The turn ends on the harness's own notice that tells them so, the model reads that the
	// call was made, the operator reads an error, and the contract is previewed no more until the
	// catalog loads again, so that no other preview of it acts.
	function actedOnPreview(
		answered: Answered,
		context: ToolContext,
		problem: string,
		application: string,
		locale: Locale
	): ToolOutcome {
		previewing = false;
		log.error(
			{
				contract: contract.id,
				tool: contract.toolName,
				status: answered.status,
				problem,
				principal: context.principalId
			},
			'contract acted on a preview, previews stop until the catalog loads again'
		);
		// Of the contract's answer, the model reads its status alone: its body may be the preview the
		// contract meant to give, which only the owner reads
		return {
			result: { ...MADE_WITHOUT_OWNER, answer: { status: answered.status } },
			final: getMessages(locale).consent.actedOnPreview(application)
		};
	}

	// The call waits for its owner: it is frozen as it would run, and the turn ends with the
	// harness's own request. A contract that offers a preview is asked first what the call would
	// do, without doing it, and the request shows its owner that, rather than the call. The model
	// cannot answer for a whole series itself: only the question about one asks with series, and
	// only its owner's yes to that question runs the call so.
	async function ask(
		values: Record<string, unknown>,
		context: ToolContext,
		reasons: readonly WaitReason[]
	): Promise<ToolOutcome> {
		const owner = context.principalId;
		// The question names the application as the catalog does in its owner's language, and says
		// what the level covers there
		const locale = await fetchOwnerLocale(context.db, owner, config.locale);
		const application = labelOf(
			deps.domains,
			contract.domain,
			contract.level,
			locale,
			config.locale
		);
		let preview: Preview | null = null;
		if (previewing) {
			const built = build(values);
			if ('error' in built) return { result: { error: built.error } };
			const answered = await send(built, context, { kind: 'preview', locale });
			// The platform refuses a preview as it would the call: its owner gives what it lacks
			// first, that permission or their Twake Space API token, and sees the preview once it may
			// be asked for. The call for a whole series they
			// were about to be asked about waits for it without the series, which only their yes to
			// that question sets: once they gave it, the contract refuses the call for one occurrence
			// again, and the question comes then.
			if (answered.delegation !== null) {
				const waiting = reasons.includes('series') ? withoutSeries(contract, values) : values;
				return waitForDelegation(waiting, context, answered.delegation, null, locale);
			}
			// A recurring invitation its contract previews only for the whole series: its owner is
			// asked about that first, and their yes asks again what still waits
			if (refusedAsRecurring(contract, values, answered)) {
				return ask(wholeSeriesValues(values), context, ['series']);
			}
			const reading = readPreview(answered);
			if (reading.kind === 'acted') {
				return actedOnPreview(answered, context, reading.problem, application.name, locale);
			}
			if (reading.kind !== 'preview') {
				const refused = reading.kind === 'refused';
				log.warn(
					{
						contract: contract.id,
						tool: contract.toolName,
						problem: refused ? reading.problem : 'no answer',
						principal: owner
					},
					'contract preview failed'
				);
				return {
					result: {
						...(refused ? PREVIEW_REFUSED : PREVIEW_UNANSWERED),
						answer: answered.result
					}
				};
			}
			preview = reading.preview;
		}
		const request = makeOwnerRequest(
			{
				tool: contract.toolName,
				application,
				level: contract.level,
				reasons,
				arguments: values,
				summary: preview?.summary ?? null,
				said: context.accompanyingText ?? null
			},
			getMessages(locale)
		);
		// A call its owner could not see whole is never asked about: nothing waits, and the model may
		// make it smaller
		if (request === null) {
			log.info(
				{ reasons, contract: contract.id, tool: contract.toolName, principal: owner },
				'contract call too large to ask about'
			);
			return { result: TOO_LARGE_TO_CONFIRM };
		}
		// The call keeps the harness's question alone, never the call, the model's words nor what its
		// application said of it: it is what the API shows of the request
		const pendingCallId = await freeze(
			values,
			context,
			reasons,
			request.question,
			preview?.digest ?? null
		);
		if (isConversationGone(pendingCallId)) return { result: pendingCallId };
		return {
			result: {
				status: 'awaiting_owner',
				reasons,
				domain: contract.domain,
				level: contract.level
			},
			final: requestText(request),
			pendingCallId,
			request
		};
	}

	// What a turn nobody attends reads of a call that would wait for its owner: nothing was done,
	// nothing waits, and nobody was asked, for the reasons the call would have waited
	function notAsked(reasons: readonly WaitReason[]): ToolOutcome {
		return { result: { status: 'not_asked', reasons } };
	}

	return {
		definition,
		argumentKeys,
		requiredAction: contract.level === 'read' ? CALL_CONTRACTS : ACT_THROUGH_CONTRACTS,
		run: async (args, context): Promise<ToolOutcome> => {
			const written =
				typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {};
			const owner = context.principalId;
			const answeredReasons = context.answeredReasons ?? [];
			// The model cannot answer for a whole series itself: a new call loses any series its body
			// sets, whatever its value, and goes on without it, so that only its owner's yes to the
			// harness's question sets series. The call its owner allowed runs as it was frozen, series
			// included, and the organization agent, which has nobody to ask, calls as it wrote.
			const values =
				owner === ORGANIZATION_PRINCIPAL || answeredReasons.length > 0
					? written
					: withoutSeries(contract, written);
			// A call that waits is frozen, and the turn ends with the harness's own request. The call
			// its owner allowed runs as it was frozen, unless something their yes did not answer
			// applies now, such as writing they took back since: it then waits again, and the request
			// asks about everything that applies. A turn nobody attends makes no such call.
			const reasons = await reasonsToWait(context);
			if (reasons.some((reason) => !answeredReasons.includes(reason))) {
				return context.unattended === true ? notAsked(reasons) : ask(values, context, reasons);
			}
			const built = build(values);
			if ('error' in built) return { result: { error: built.error } };
			// The call its owner allowed once they saw its preview carries that preview's digest
			const previewDigest = context.previewDigest ?? null;
			const answered = await send(built, context, { kind: 'action', previewDigest });
			// The organization agent acts for no user: nobody could give it that permission. A turn nobody
			// attends asks nothing, but for one that gives way to that question, as the brief does.
			if (answered.delegation !== null && owner !== ORGANIZATION_PRINCIPAL) {
				if (context.unattended === true && context.asksDelegation !== true) {
					return notAsked(['delegation']);
				}
				const locale = await fetchOwnerLocale(context.db, owner, config.locale);
				return waitForDelegation(values, context, answered.delegation, previewDigest, locale);
			}
			// A recurring invitation its contract answers only for the whole series: the call for every
			// occurrence, the only one that sets series, waits for its owner, as any call does, the
			// organization agent having nobody to ask, and a turn nobody attends making no such call
			if (owner !== ORGANIZATION_PRINCIPAL && refusedAsRecurring(contract, values, answered)) {
				if (context.unattended === true) return notAsked(['series']);
				return ask(wholeSeriesValues(values), context, ['series']);
			}
			// A read of the owner's calendar that succeeded refreshes the zone their turns state the
			// present in: an error says nothing of their calendar, whatever zone it names
			const succeeded = answered.status >= 200 && answered.status < 300;
			const zone =
				succeeded && calendar?.namesOwnerZone === true ? zoneOfAnswer(answered.body) : null;
			if (zone !== null && owner !== ORGANIZATION_PRINCIPAL) {
				await withPrincipal(context.db, { id: owner }, (tx) => saveOwnerTimeZone(tx, owner, zone));
			}
			return { result: answered.result };
		}
	};
}
