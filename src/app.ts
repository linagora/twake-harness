import { randomUUID } from 'node:crypto';
import type { Writable } from 'node:stream';
import Fastify, {
	type FastifyBaseLogger,
	type FastifyInstance,
	type FastifyReply,
	type FastifyRequest
} from 'fastify';

import { z } from 'zod';

import type { Clock } from './agent/clock.js';
import { readMeeting } from './agent/suggestion.js';
import { makeAgentService, type AgentService, type OwnerTurnResult } from './agent/service.js';
import { runTool, toolCallStatus, WITHDRAW_OWN_CONSENTS } from './agent/tools.js';
import { fetchOwnerMessages, localeOf } from './assistants/locale.js';
import { requestNaming } from './assistants/naming.js';
import { readIdentity, requestPreparation, requestRecovery } from './assistants/provisioning.js';
import { findAssistant, setAssistantRoomId } from './assistants/repository.js';
import { findBriefQuestion, refuseBriefQuestion } from './briefs/questions.js';
import { makeAssistantService, type AssistantService } from './assistants/service.js';
import { makeJwtAuthenticator, type Authenticator } from './auth/jwt.js';
import type { Config } from './config.js';
import type { Answer } from './consents/answers.js';
import { lookUpAnswerable, refusalNoticeJob, resumeJob } from './consents/answering.js';
import { isConsentLevel, type ResumeRequest } from './consents/consent.js';
import { makeConsentMetrics, type AnswerOutcome, type ConsentMetrics } from './consents/metrics.js';
import {
	answerPendingCall,
	findPendingCall,
	grantConsent,
	listConsents,
	listPendingCalls,
	toConsentView,
	toPendingCallView,
	withdrawConsents,
	type PendingCallRecord,
	type PendingCallView,
	type RequestState
} from './consents/repository.js';
import { readJsonColumn, withPrincipal, type Db, type Tx } from './db/client.js';
import { getMessages } from './i18n/messages.js';
import { enqueueJob, type EnqueueInput } from './jobs/queue.js';
import type { LlmClient } from './llm/client.js';
import { FAILURE_SERIALIZERS } from './logging/failures.js';
import { makeMatrixAdmin } from './matrix/admin.js';
import { announceCommands } from './matrix/commands.js';
import {
	acceptSeenIdentity,
	findOwnerCrossSigning,
	type OwnerCrossSigning
} from './matrix/owner-cross-signing-repository.js';
import { listMemory } from './memory/repository.js';
import { principalOfMatrixUser } from './principals/identity.js';
import type { Principal } from './principals/principal.js';
import { ensurePrincipal, type PrincipalRecord } from './principals/repository.js';
import { findSession, listSessionIds } from './sessions/repository.js';
import { suggestGroup, type SuggestPayload } from './suggestions/job.js';
import {
	findSuggestion,
	muteRoomFor,
	readCallArguments,
	readSettings,
	writeEnabled,
	writeSettings
} from './suggestions/repository.js';
import {
	findSkill,
	insertSkill,
	isValidSkillId,
	listSkills,
	setSkillStatus,
	toSkillMarkdown
} from './skills/repository.js';

declare module 'fastify' {
	interface FastifyRequest {
		principal: Principal | null;
	}
	interface FastifyInstance {
		// The agent behind the routes, shared with the turn worker of the same process
		agent: AgentService;
	}
}

export interface AppOptions {
	readonly config: Config;
	readonly db: Db;
	readonly logStream?: Writable;
	readonly authenticator?: Authenticator;
	readonly llm?: LlmClient;
	readonly assistants?: AssistantService;
	readonly agent?: AgentService;
	// The present as the agent reads it; the system clock unless a test sets its own
	readonly clock?: Clock;
	// The consent counters its metrics serve, which the role brings when it counts some of its
	// own, such as the worker role's expiries; new ones otherwise
	readonly consentMetrics?: ConsentMetrics;
	// What the role adds to its health check, such as whether it listens to the broker: never a
	// reason for the check to fail, which would restart the role
	readonly health?: () => Readonly<Record<string, unknown>>;
}

const assistantBodySchema = z.object({ name: z.string().min(1).max(64) }).strict();

// What a provisioner may say of the owner along with its call
const provisionBodySchema = z.object({ timezone: z.string().min(1).max(64).optional() });

// The direct room the owner's client opened with the assistant
const homeBodySchema = z.object({ roomId: z.string().min(1).max(255) });

const suggestionSwitchSchema = z.object({ enabled: z.boolean() }).strict();

// How long the room a client names may wait for the assistant to join it, and how often it looks
const HOME_JOIN_WAIT_MS = 5_000;
const HOME_JOIN_POLL_MS = 250;

const chatBodySchema = z
	.object({
		message: z.string().min(1).max(32_768),
		session_id: z
			.string()
			.regex(/^[0-9a-f]{32}$/)
			.optional()
	})
	.strict();

// Why the owner refuses a suggestion: another time is tried once, not useful mutes the room a week
const refuseBodySchema = z
	.object({ reason: z.enum(['another_time', 'not_useful']).optional() })
	.strict();

const NOT_USEFUL_MUTE_MS = 7 * 24 * 60 * 60 * 1000;

// The routes where a token of one of AUTH_ANSWER_AUDIENCES is accepted: the owner's yes or no to a
// call that waits for them, from buttons another application shows them, and nothing else
const ANSWER_ROUTES: ReadonlySet<string> = new Set([
	'/v1/pending-calls/:id/approve',
	'/v1/pending-calls/:id/refuse'
]);

const suggestionSettingsSchema = z
	.object({
		enabled: z.boolean(),
		mutedRooms: z.array(z.string().min(1).max(255)).max(500)
	})
	.strict();

const toolBodySchema = z
	.object({ tool: z.string().min(1), arguments: z.unknown().optional() })
	.strict();

const skillBodySchema = z
	.object({
		name: z.string().min(1).max(80),
		description: z.string().min(1).max(500),
		content: z.string().min(1).max(20_000)
	})
	.strict();

// The identity an owner accepts, given by the master key the harness showed them
const ownerIdentityBodySchema = z.object({ master_key: z.string().min(1).max(128) }).strict();

// The cross-signing identity an owner's assistant holds for them, and the one that signed the
// session their words last came from when it was another, as the owner reads them
interface OwnerIdentityView {
	readonly pinned: {
		readonly master_key: string;
		readonly pinned_by: string;
		readonly pinned_at: string;
	} | null;
	readonly published: { readonly master_key: string; readonly seen_at: string } | null;
}

function toOwnerIdentityView(held: OwnerCrossSigning | null): OwnerIdentityView {
	return {
		pinned:
			held === null
				? null
				: {
						master_key: held.masterPublicKey,
						pinned_by: held.pinnedBy,
						pinned_at: held.pinnedAt.toISOString()
					},
		published:
			held === null || held.seen === null
				? null
				: { master_key: held.seen.masterPublicKey, seen_at: held.seen.at.toISOString() }
	};
}

const RESOURCE_UNAVAILABLE = { error: 'resource unavailable' } as const;
const FORBIDDEN = { error: 'forbidden' } as const;
const NOT_A_PROVISIONER = { error: 'not a provisioner' } as const;
const NO_ASSISTANT = { error: 'no assistant' } as const;
// The room a client names is not one the assistant and its owner are both in
const NOT_A_MEMBER = { error: 'not a member' } as const;
// Others are in that room: what the assistant writes its owner there would reach them too
const NOT_A_DIRECT_ROOM = { error: 'not a direct room' } as const;
// The assistant's escrowed identity waits for its owner's recovery: POST /v1/assistants/me/recover
// by the owner, or POST /v1/provisioning/assistants/:owner/recover by their provisioner
const RECOVERY_NEEDED = { error: 'recovery_needed' } as const;
// The owner has no account on the homeserver the assistants live on, so no room can be opened
const OWNER_NOT_ON_HOMESERVER = { error: 'owner not on the homeserver' } as const;

// An answer to a call no longer waiting: answered already, expired, or replaced by a newer
// question in its room
function pendingCallClosed(state: RequestState): { error: string; state: RequestState } {
	return { error: 'pending call closed', state };
}

const PENDING_CALL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const SESSION_ID = /^[0-9a-f]{32}$/;

const REQUEST_ID_HEADER = 'x-request-id';

function requestIdOf(request: { headers: Record<string, string | string[] | undefined> }): string {
	const given = request.headers[REQUEST_ID_HEADER];
	return typeof given === 'string' && given.length > 0 && given.length <= 128
		? given
		: randomUUID();
}

function principalOf(request: FastifyRequest): Principal {
	if (request.principal === null) {
		throw new Error('authenticated route reached without a principal');
	}
	return request.principal;
}

export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
	const { config, db } = options;
	const authenticate = options.authenticator ?? makeJwtAuthenticator(config.auth);
	const authenticateAnswer =
		options.authenticator ??
		(config.auth.answerAudiences.length === 0
			? authenticate
			: makeJwtAuthenticator({
					...config.auth,
					audience: [config.auth.audience, ...config.auth.answerAudiences]
				}));

	async function loadPrincipal(principal: Principal): Promise<PrincipalRecord> {
		return withPrincipal(db, principal, (tx) => ensurePrincipal(tx, principal));
	}

	// Reads the owner's pending calls once their requests left unanswered past their lifetime
	// expired, as an answer in the chat finds them
	function withOverdueExpired<T>(
		principal: Principal,
		log: FastifyBaseLogger,
		read: (tx: Tx) => Promise<T>
	): Promise<T> {
		const lookup = {
			db,
			log,
			metrics: consentMetrics,
			lifetimeMs: config.consent.requestLifetimeMs
		};
		return lookUpAnswerable(lookup, principal.id, read);
	}

	// An answer through the API, logged and counted as answers in the chat are: one that decided
	// the call, or one that came once its request had expired or been replaced and ran nothing. A
	// second answer to a call already decided is neither.
	function answeredThroughApi(
		log: FastifyBaseLogger,
		owner: string,
		call: PendingCallRecord,
		says: Answer,
		outcome: AnswerOutcome
	): void {
		log.info(
			{ owner, pendingCallId: call.id, answer: says, via: 'api', outcome },
			'owner answered'
		);
		consentMetrics.answered(call, says, 'api', outcome);
	}

	// What the owner's assistant says in their room, in their language, once they refused a call
	// asked there: how to resume their brief, when it was the question of their first brief; nothing
	// when the room is no longer the assistant's
	async function refusalNotice(
		principal: Principal,
		roomId: string,
		pendingCallId: string
	): Promise<EnqueueInput | null> {
		const { assistant, question } = await withPrincipal(db, principal, async (tx) => ({
			assistant: await findAssistant(tx, principal.id),
			question: await findBriefQuestion(tx, principal.id)
		}));
		if (assistant === null || assistant.deletedAt !== null || assistant.roomId !== roomId) {
			return null;
		}
		const messages = getMessages(localeOf(assistant, config.locale));
		const text =
			question?.pendingCallId === pendingCallId ? messages.brief.refused : messages.consent.refused;
		return refusalNoticeJob(assistant.userId, roomId, pendingCallId, text);
	}

	// One of the owner's pending calls as their clients read it
	async function pendingCallView(
		principal: Principal,
		id: string
	): Promise<PendingCallView | null> {
		const call = await withPrincipal(db, principal, (tx) => findPendingCall(tx, principal.id, id));
		return call === null ? null : toPendingCallView(call, config.consent.requestLifetimeMs);
	}

	// What a turn through the API answers; a turn that stopped on the harness's question returns
	// the call it froze, which waits for the owner's answer
	async function turnAnswer(
		principal: Principal,
		result: Extract<OwnerTurnResult, { kind: 'ok' }>
	): Promise<Record<string, unknown>> {
		const answer = { session_id: result.sessionId, answer: result.answer, model: result.model };
		const pending =
			result.pendingCallId === undefined
				? null
				: await pendingCallView(principal, result.pendingCallId);
		return pending === null ? answer : { ...answer, pending_call: pending };
	}
	const app = Fastify({
		logger: {
			level: config.logLevel,
			serializers: FAILURE_SERIALIZERS,
			...(options.logStream === undefined ? {} : { stream: options.logStream })
		},
		genReqId: requestIdOf,
		requestIdHeader: false
	});

	const consentMetrics = options.consentMetrics ?? makeConsentMetrics();
	const agent =
		options.agent ??
		makeAgentService({
			config,
			db,
			log: app.log,
			consentMetrics,
			...(options.llm === undefined ? {} : { llm: options.llm }),
			...(options.clock === undefined ? {} : { clock: options.clock })
		});
	app.decorate('agent', agent);
	const tools = agent.tools;

	const matrixAdmin = makeMatrixAdmin({
		apisixBaseUrl: config.apisix.baseUrl,
		consumerKey: config.apisix.consumerKey,
		asToken: config.matrix.asToken
	});
	const assistants =
		options.assistants ?? makeAssistantService({ config, db, log: app.log, admin: matrixAdmin });

	// The members joined to a room the owner's client names, once the assistant is among them: it
	// joins as soon as the matrix role takes its owner's invitation, which may come a moment after
	// the client opened the room. Null when the assistant is not in the room by then.
	async function membersOnceJoined(
		assistantUserId: string,
		roomId: string
	): Promise<string[] | null> {
		const deadline = Date.now() + HOME_JOIN_WAIT_MS;
		for (;;) {
			const members = await matrixAdmin.joinedMembers(assistantUserId, roomId);
			if (members?.includes(assistantUserId) === true) return members;
			if (Date.now() >= deadline) return null;
			await new Promise((resolve) => setTimeout(resolve, HOME_JOIN_POLL_MS));
		}
	}

	app.decorateRequest('principal', null);
	app.addHook('onSend', async (request, reply) => {
		reply.header(REQUEST_ID_HEADER, request.id);
	});

	// Behind the gateway only: when a shared secret is set, every request of the API carries it,
	// which the gateway injects and nobody else knows; the health check and the metrics stay open
	if (config.gateway.sharedSecret !== null) {
		const secret = config.gateway.sharedSecret;
		app.addHook('onRequest', async (request, reply) => {
			if (!request.url.startsWith('/v1/')) return;
			if (request.headers['x-twake-gateway'] !== secret) {
				request.log.info({ reason: 'gateway' }, 'request refused');
				return reply.code(403).send(FORBIDDEN);
			}
		});
	}

	app.get('/health', async () => ({ status: 'ok', ...options.health?.() }));

	// A provisioner, such as the identity server the Twake Chat clients ask for their assistant,
	// acts for the owner it names after authenticating them itself. Only the service clients named
	// in the settings may, never a user. The owner is named by their Matrix identifier on the
	// assistants' homeserver, as the provisioner authenticated them: their principal is the
	// platform's email for that account. Resolves to the client admitted and the owner it acts for,
	// or null once refused.
	async function admitProvisioner(
		request: FastifyRequest,
		reply: FastifyReply
	): Promise<{ client: string; owner: string; ownerUserId: string } | null> {
		const auth = await authenticate(request.headers.authorization);
		if (!auth.ok) {
			request.log.info({ reason: auth.reason }, 'provisioning refused');
			await reply.code(401).send({ error: 'invalid token' });
			return null;
		}
		const client = auth.principal.id;
		if (!config.provisioning.clientIds.includes(client)) {
			request.log.info({ client, reason: 'not_a_provisioner' }, 'provisioning refused');
			await reply.code(403).send(NOT_A_PROVISIONER);
			return null;
		}
		const { owner: ownerUserId } = request.params as { owner: string };
		const owner = principalOfMatrixUser(config, ownerUserId);
		if (owner === null) {
			await reply.code(422).send(OWNER_NOT_ON_HOMESERVER);
			return null;
		}
		return { client, owner, ownerUserId };
	}

	// The provisioner's answer once the owner's assistant exists, whether the provisioner read it or
	// provisioned it, as `via` logs: its identity once ready; that it awaits its owner's recovery; or
	// that it is not ready yet, its preparation asked for meanwhile
	async function answerAssistant(
		request: FastifyRequest,
		reply: FastifyReply,
		asked: { readonly client: string; readonly owner: string; readonly userId: string },
		via: 'read' | 'provision'
	): Promise<FastifyReply> {
		const { client, owner, userId } = asked;
		const known = await readIdentity(db, owner, userId);
		if (known.state === 'ready') {
			request.log.info({ client, owner, userId: known.identity.userId, via }, 'assistant ready');
			return reply.code(200).send(known.identity);
		}
		// Only the owner's recovery brings an escrowed identity back: preparing it changes nothing
		if (known.state === 'awaiting_recovery') {
			request.log.info({ client, owner, userId, via }, 'assistant awaits its recovery');
			return reply.code(409).send(RECOVERY_NEEDED);
		}
		const queued = await requestPreparation(db, owner);
		request.log.info({ client, owner, userId, queued, via }, 'assistant not ready');
		return reply.code(503).header('retry-after', '5').send({ error: 'not_ready' });
	}

	// The owner's assistant as its provisioner reads it, never made nor brought back by reading:
	// what the provisioning answers for one that exists, none for an owner without one
	app.get('/v1/provisioning/assistants/:owner', async (request, reply) => {
		const admitted = await admitProvisioner(request, reply);
		if (admitted === null) return reply;
		const { client, owner } = admitted;
		const assistant = await assistants.find(owner);
		if (assistant === null) return reply.code(404).send(NO_ASSISTANT);
		return answerAssistant(request, reply, { client, owner, userId: assistant.userId }, 'read');
	});

	app.put('/v1/provisioning/assistants/:owner', async (request, reply) => {
		const admitted = await admitProvisioner(request, reply);
		if (admitted === null) return reply;
		const { client, owner } = admitted;
		// The zone the owner's client reports is accepted and ignored: the harness keeps for each
		// owner the zone of their calendar, as a read of it names it
		const parsed = provisionBodySchema.safeParse(request.body ?? {});
		if (!parsed.success) return reply.code(400).send({ error: 'invalid request' });
		const provisioned = await assistants.provision(owner);
		if (!provisioned.ok) {
			return provisioned.reason === 'not_on_homeserver'
				? reply.code(422).send(OWNER_NOT_ON_HOMESERVER)
				: reply.code(502).send({ error: 'assistant creation failed' });
		}
		return answerAssistant(
			request,
			reply,
			{ client, owner, userId: provisioned.userId },
			'provision'
		);
	});

	// The direct room the owner's client opened with the assistant becomes the room the assistant
	// writes to its owner in, as an event's turn does, and one of the rooms it answers them in. Only
	// a room where the assistant and its owner are, and nobody else, may be that room.
	app.put('/v1/provisioning/assistants/:owner/home', async (request, reply) => {
		const admitted = await admitProvisioner(request, reply);
		if (admitted === null) return reply;
		const { client, owner, ownerUserId } = admitted;
		const parsed = homeBodySchema.safeParse(request.body);
		if (!parsed.success) return reply.code(400).send({ error: 'invalid request' });
		const { roomId } = parsed.data;
		const assistant = await withPrincipal(db, { id: owner }, (tx) => findAssistant(tx, owner));
		if (assistant === null || assistant.deletedAt !== null) {
			return reply.code(404).send(NO_ASSISTANT);
		}
		const members = await membersOnceJoined(assistant.userId, roomId);
		if (members === null || !members.includes(ownerUserId)) {
			request.log.info({ client, owner, roomId, reason: 'not_a_member' }, 'room refused');
			return reply.code(409).send(NOT_A_MEMBER);
		}
		if (members.some((member) => member !== ownerUserId && member !== assistant.userId)) {
			request.log.info({ client, owner, roomId, reason: 'not_a_direct_room' }, 'room refused');
			return reply.code(409).send(NOT_A_DIRECT_ROOM);
		}
		await withPrincipal(db, { id: owner }, async (tx) => {
			await setAssistantRoomId(tx, owner, roomId);
			await tx.sql`
				insert into assistant_rooms (room_id, owner, user_id) values (${roomId}, ${owner}, ${assistant.userId})
				on conflict (room_id) do update set owner = excluded.owner, user_id = excluded.user_id`;
			// Its name shows there by a job, as at the join, in case the room refused it for good then
			await requestNaming(tx, owner);
		});
		request.log.info(
			{ client, owner, userId: assistant.userId, roomId },
			'assistant home room set'
		);
		// Announced at the join already, unless the room refused it then
		await announceCommands(
			{ admin: matrixAdmin, log: request.log },
			{ roomId, assistantUserId: assistant.userId },
			await fetchOwnerMessages(db, owner, config.locale)
		);
		return reply.code(204).send();
	});

	// The owner's switch of the suggestions, as GET and PUT /v1/suggestions/settings show and turn it,
	// for a provisioner whose clients hold no token of the harness: whether the assistant reads the
	// owner's messages in channels and offers them actions. It needs no assistant, as the listener
	// reads every member; the rooms the owner muted stay as they are.
	app.get('/v1/provisioning/assistants/:owner/suggestions', async (request, reply) => {
		const admitted = await admitProvisioner(request, reply);
		if (admitted === null) return reply;
		const { owner } = admitted;
		const { enabled } = await withPrincipal(db, { id: owner }, (tx) => readSettings(tx, owner));
		return { enabled };
	});

	app.put('/v1/provisioning/assistants/:owner/suggestions', async (request, reply) => {
		const admitted = await admitProvisioner(request, reply);
		if (admitted === null) return reply;
		const { client, owner } = admitted;
		const parsed = suggestionSwitchSchema.safeParse(request.body);
		if (!parsed.success) return reply.code(400).send({ error: 'invalid request' });
		const { enabled } = parsed.data;
		await withPrincipal(db, { id: owner }, (tx) => writeEnabled(tx, owner, enabled));
		request.log.info({ client, owner, enabled }, 'suggestions switched');
		return { enabled };
	});

	// The owner's recovery, asked by their provisioner as it asks for the assistant: the provisioner
	// authenticated them, and the job is the one of /v1/assistants/me/recover, which puts back the
	// identity the owner's clients already trust
	app.post('/v1/provisioning/assistants/:owner/recover', async (request, reply) => {
		const admitted = await admitProvisioner(request, reply);
		if (admitted === null) return reply;
		const { client, owner } = admitted;
		const assistant = await assistants.find(owner);
		if (assistant === null) return reply.code(404).send(NO_ASSISTANT);
		const queued = await requestRecovery(db, owner, assistant.roomId);
		request.log.info({ client, owner, queued }, 'recovery requested for a client');
		return reply.code(202).send({ queued });
	});

	// Prometheus exposition: what the autoscaler and the dashboards read
	app.get('/metrics', async (_request, reply) => {
		const snapshot = agent.admission.snapshot();
		const assistants = await db.sql<
			{ n: number }[]
		>`select count(*)::int as n from assistant_rooms`;
		const lines = [
			'# TYPE harness_turns_inflight gauge',
			`harness_turns_inflight ${snapshot.inflight}`,
			'# TYPE harness_turns_queued gauge',
			`harness_turns_queued ${snapshot.queued}`,
			'# TYPE harness_turns_refused_total counter',
			...Object.entries(snapshot.refused).map(
				([reason, n]) => `harness_turns_refused_total{reason="${reason}"} ${n}`
			),
			'# TYPE harness_assistants_held gauge',
			`harness_assistants_held ${assistants[0]?.n ?? 0}`,
			...consentMetrics.exposition()
		];
		return reply.type('text/plain; version=0.0.4').send(`${lines.join('\n')}\n`);
	});

	await app.register(
		async (scope) => {
			// Identity is settled before any other work: a refused token never reaches the database.
			scope.addHook('preHandler', async (request: FastifyRequest, reply) => {
				const answering = ANSWER_ROUTES.has(request.routeOptions.url ?? '');
				const result = await (answering ? authenticateAnswer : authenticate)(
					request.headers.authorization
				);
				if (!result.ok) {
					request.log.info({ reason: result.reason }, 'request refused');
					return reply.code(401).send({ error: 'invalid token' });
				}
				request.principal = result.principal;
			});

			scope.get('/me', async (request) => {
				const principal = principalOf(request);
				const record = await withPrincipal(db, principal, (tx) => ensurePrincipal(tx, principal));
				return { user: record.id, actions: record.actions };
			});

			// The same operations as the creator conversation, for the Twake Chat front
			scope.post('/assistants', async (request, reply) => {
				const principal = principalOf(request);
				const parsed = assistantBodySchema.safeParse(request.body);
				if (!parsed.success) return reply.code(400).send({ error: 'invalid request' });
				const created = await assistants.create(principal.id, parsed.data.name);
				if (!created.ok) {
					switch (created.reason) {
						case 'exists':
							return reply.code(409).send({ error: 'assistant already exists' });
						case 'not_on_homeserver':
							return reply.code(422).send(OWNER_NOT_ON_HOMESERVER);
						case 'failed':
							return reply.code(502).send({ error: 'assistant creation failed' });
						default:
							return reply.code(400).send({ error: 'invalid request' });
					}
				}
				return reply.code(201).send(created.assistant);
			});

			scope.get('/assistants/me', async (request, reply) => {
				const assistant = await assistants.find(principalOf(request).id);
				return assistant === null ? reply.code(404).send(RESOURCE_UNAVAILABLE) : assistant;
			});

			scope.put('/assistants/me', async (request, reply) => {
				const parsed = assistantBodySchema.safeParse(request.body);
				if (!parsed.success) return reply.code(400).send({ error: 'invalid request' });
				const renamed = await assistants.rename(principalOf(request).id, parsed.data.name);
				return renamed === null ? reply.code(404).send(RESOURCE_UNAVAILABLE) : renamed;
			});

			// After a lost encryption store, the owner asks for the assistant's escrowed identity back
			scope.post('/assistants/me/recover', async (request, reply) => {
				const principal = principalOf(request);
				const assistant = await assistants.find(principal.id);
				if (assistant === null) return reply.code(404).send(RESOURCE_UNAVAILABLE);
				const queued = await requestRecovery(db, principal.id, assistant.roomId);
				request.log.info({ principal: principal.id, queued }, 'recovery requested');
				return reply.code(202).send({ queued });
			});

			// The cross-signing identity the owner's assistant and the creator take their words with,
			// and the one that signed the session their words last came from when it was another, such
			// as after they reset theirs. The owner makes the harness hold that one instead, here with
			// their own token, or by a yes to their assistant's question while the deployment only
			// reports: the identity then shows as pinned by the chat, and counts for nothing once the
			// deployment enforces, until the owner confirms it here. The creator holds it before any
			// assistant exists, and so does this route.
			scope.get('/assistants/me/owner-identity', async (request, reply) => {
				const principal = principalOf(request);
				const record = await loadPrincipal(principal);
				if (!record.actions.includes('chat')) return reply.code(403).send(FORBIDDEN);
				const held = await withPrincipal(db, principal, (tx) =>
					findOwnerCrossSigning(tx, principal.id)
				);
				return toOwnerIdentityView(held);
			});

			scope.put('/assistants/me/owner-identity', async (request, reply) => {
				const principal = principalOf(request);
				const record = await loadPrincipal(principal);
				if (!record.actions.includes('chat')) return reply.code(403).send(FORBIDDEN);
				const parsed = ownerIdentityBodySchema.safeParse(request.body);
				if (!parsed.success) return reply.code(400).send({ error: 'invalid request' });
				const masterKey = parsed.data.master_key;
				// Only the identity that signed the session the owner's words last came from, as the
				// harness showed it to them, and only while it is still the latest one seen
				const accepted = await withPrincipal(db, principal, (tx) =>
					acceptSeenIdentity(tx, principal.id, masterKey, 'api')
				);
				if (accepted.pinned === null) {
					return reply
						.code(409)
						.send({ error: 'not the identity seen', ...toOwnerIdentityView(accepted.held) });
				}
				request.log.info(
					{ principal: principal.id, replaced: accepted.held?.pinnedBy ?? null },
					'owner identity accepted'
				);
				return toOwnerIdentityView(accepted.pinned);
			});

			scope.delete('/assistants/me', async (request, reply) => {
				const removed = await assistants.remove(principalOf(request).id);
				return removed ? reply.code(204).send() : reply.code(404).send(RESOURCE_UNAVAILABLE);
			});

			scope.get('/sessions', async (request, reply) => {
				const principal = principalOf(request);
				const record = await loadPrincipal(principal);
				if (!record.actions.includes('sessions.read_own')) return reply.code(403).send(FORBIDDEN);
				const sessions = await withPrincipal(db, principal, (tx) => listSessionIds(tx));
				return { sessions };
			});

			scope.get<{ Params: { id: string } }>('/sessions/:id', async (request, reply) => {
				const principal = principalOf(request);
				const record = await loadPrincipal(principal);
				if (!record.actions.includes('sessions.read_own')) return reply.code(403).send(FORBIDDEN);
				if (!SESSION_ID.test(request.params.id)) return reply.code(404).send(RESOURCE_UNAVAILABLE);
				const session = await withPrincipal(db, principal, (tx) =>
					findSession(tx, request.params.id)
				);
				if (session === null) return reply.code(404).send(RESOURCE_UNAVAILABLE);
				return { messages: session.messages };
			});

			// Skills: one library per user, one for the organization, proposals approved by their
			// owner or promoted by an administrator, by copy
			scope.get('/skills', async (request, reply) => {
				const principal = principalOf(request);
				const record = await loadPrincipal(principal);
				if (!record.actions.includes('skills.read_own')) return reply.code(403).send(FORBIDDEN);
				const skills = await withPrincipal(db, principal, (tx) => listSkills(tx));
				return { skills: skills.map((s) => s.id), details: skills };
			});

			scope.get('/skills/proposals', async (request, reply) => {
				const principal = principalOf(request);
				const record = await loadPrincipal(principal);
				if (!record.actions.includes('skills.read_own')) return reply.code(403).send(FORBIDDEN);
				const admin = record.actions.includes('skills.admin');
				const proposals = await withPrincipal(db, principal, (tx) => listSkills(tx, 'proposed'), {
					admin
				});
				return { proposals };
			});

			scope.get<{ Params: { id: string } }>('/skills/:id', async (request, reply) => {
				const principal = principalOf(request);
				const record = await loadPrincipal(principal);
				if (!record.actions.includes('skills.read_own')) return reply.code(403).send(FORBIDDEN);
				if (!isValidSkillId(request.params.id)) return reply.code(404).send(RESOURCE_UNAVAILABLE);
				const skill = await withPrincipal(db, principal, (tx) => findSkill(tx, request.params.id));
				if (skill === null) return reply.code(404).send(RESOURCE_UNAVAILABLE);
				return {
					id: skill.id,
					scope: skill.scope,
					status: skill.status,
					content: toSkillMarkdown(skill)
				};
			});

			scope.post('/skills', async (request, reply) => {
				const principal = principalOf(request);
				const record = await loadPrincipal(principal);
				if (!record.actions.includes('skills.read_own')) return reply.code(403).send(FORBIDDEN);
				const parsed = skillBodySchema.safeParse(request.body);
				if (!parsed.success) return reply.code(400).send({ error: 'invalid request' });
				const skill = await withPrincipal(db, principal, (tx) =>
					insertSkill(tx, { scope: 'user', owner: principal.id, status: 'active', ...parsed.data })
				);
				return reply.code(201).send({ id: skill.id, scope: skill.scope, status: skill.status });
			});

			scope.post<{ Params: { id: string } }>(
				'/skills/proposals/:id/approve',
				async (request, reply) => {
					const principal = principalOf(request);
					const record = await loadPrincipal(principal);
					if (!record.actions.includes('skills.read_own')) return reply.code(403).send(FORBIDDEN);
					if (!isValidSkillId(request.params.id)) return reply.code(404).send(RESOURCE_UNAVAILABLE);
					const approved = await withPrincipal(db, principal, async (tx) => {
						const skill = await findSkill(tx, request.params.id);
						if (
							skill === null ||
							skill.scope !== 'user' ||
							skill.owner !== principal.id ||
							skill.status !== 'proposed'
						) {
							return false;
						}
						return setSkillStatus(tx, skill.id, 'active');
					});
					return approved
						? { id: request.params.id, status: 'active' }
						: reply.code(404).send(RESOURCE_UNAVAILABLE);
				}
			);

			scope.post('/org/skills', async (request, reply) => {
				const principal = principalOf(request);
				const record = await loadPrincipal(principal);
				if (!record.actions.includes('skills.admin')) return reply.code(403).send(FORBIDDEN);
				const parsed = skillBodySchema.safeParse(request.body);
				if (!parsed.success) return reply.code(400).send({ error: 'invalid request' });
				const skill = await withPrincipal(
					db,
					principal,
					(tx) => insertSkill(tx, { scope: 'org', owner: 'org', status: 'active', ...parsed.data }),
					{ admin: true }
				);
				return reply.code(201).send({ id: skill.id, scope: skill.scope, status: skill.status });
			});

			// Promotion copies a user's proposal into the organization library and leaves it theirs
			scope.post<{ Params: { id: string } }>('/org/skills/promote/:id', async (request, reply) => {
				const principal = principalOf(request);
				const record = await loadPrincipal(principal);
				if (!record.actions.includes('skills.admin')) return reply.code(403).send(FORBIDDEN);
				if (!isValidSkillId(request.params.id)) return reply.code(404).send(RESOURCE_UNAVAILABLE);
				const promoted = await withPrincipal(
					db,
					principal,
					async (tx) => {
						const proposal = await findSkill(tx, request.params.id);
						if (proposal === null || proposal.scope !== 'user') return null;
						return insertSkill(tx, {
							scope: 'org',
							owner: 'org',
							status: 'active',
							name: proposal.name,
							description: proposal.description,
							content: proposal.content
						});
					},
					{ admin: true }
				);
				return promoted === null
					? reply.code(404).send(RESOURCE_UNAVAILABLE)
					: reply
							.code(201)
							.send({ id: promoted.id, scope: promoted.scope, status: promoted.status });
			});

			scope.get('/memory', async (request, reply) => {
				const principal = principalOf(request);
				const record = await loadPrincipal(principal);
				if (!record.actions.includes('memory.read_own')) return reply.code(403).send(FORBIDDEN);
				return withPrincipal(db, principal, (tx) => listMemory(tx, principal.id));
			});

			// The owner's consents, which a settings page lists, grants and withdraws with the owner's
			// own token
			scope.get('/consents', async (request, reply) => {
				const principal = principalOf(request);
				const record = await loadPrincipal(principal);
				if (!record.actions.includes('chat')) return reply.code(403).send(FORBIDDEN);
				const consents = await withPrincipal(db, principal, (tx) => listConsents(tx, principal.id));
				return { consents: consents.map(toConsentView) };
			});

			// Grants a level of an application the catalog offers, ahead of its first use
			scope.put<{ Params: { domain: string; level: string } }>(
				'/consents/:domain/:level',
				async (request, reply) => {
					const principal = principalOf(request);
					// Granting is the owner's own yes, given ahead of the question: it takes the same
					// right as answering one
					const record = await loadPrincipal(principal);
					if (!record.actions.includes('chat')) return reply.code(403).send(FORBIDDEN);
					const { domain, level } = request.params;
					const offered =
						isConsentLevel(level) &&
						agent.contracts.contracts.some((c) => c.domain === domain && c.level === level);
					if (!offered) return reply.code(404).send(RESOURCE_UNAVAILABLE);
					const { created, consent } = await withPrincipal(db, principal, async (tx) => {
						const created = await grantConsent(tx, principal.id, domain, level, 'api');
						const consents = await listConsents(tx, principal.id);
						return {
							created,
							consent: consents.find((c) => c.domain === domain && c.level === level)
						};
					});
					if (consent === undefined) throw new Error('a granted consent is not listed');
					if (created) {
						// pino writes the line's own level under `level`
						request.log.info(
							{ principal: principal.id, domain, consentLevel: level },
							'consent granted'
						);
					}
					return reply.code(created ? 201 : 200).send(toConsentView(consent));
				}
			);

			scope.delete<{ Params: { domain: string; level: string } }>(
				'/consents/:domain/:level',
				async (request, reply) => {
					const principal = principalOf(request);
					const record = await loadPrincipal(principal);
					if (!record.actions.includes(WITHDRAW_OWN_CONSENTS)) {
						return reply.code(403).send(FORBIDDEN);
					}
					const { domain, level } = request.params;
					if (!isConsentLevel(level)) return reply.code(404).send(RESOURCE_UNAVAILABLE);
					// A level the owner never allowed is no consent to withdraw, and changes nothing
					const withdrawal = await withPrincipal(db, principal, async (tx) => {
						const allowed = await listConsents(tx, principal.id);
						return allowed.some((c) => c.domain === domain && c.level === level)
							? withdrawConsents(tx, principal.id, domain, [level])
							: null;
					});
					if (withdrawal === null) return reply.code(404).send(RESOURCE_UNAVAILABLE);
					request.log.info(
						{ principal: principal.id, domain, levels: withdrawal.levels },
						'consent withdrawn'
					);
					for (const closed of withdrawal.superseded) {
						request.log.info(
							{ owner: principal.id, pendingCallId: closed.pendingCallId },
							'request superseded'
						);
						consentMetrics.superseded(closed);
					}
					return reply.code(204).send();
				}
			);

			// Whether the assistant may read the owner's messages in channels and offer them actions
			// (see Suggestions in the README), and the channels it leaves alone
			scope.get('/suggestions/settings', async (request) => {
				const principal = principalOf(request);
				await loadPrincipal(principal);
				return withPrincipal(db, principal, (tx) => readSettings(tx, principal.id));
			});

			scope.put('/suggestions/settings', async (request, reply) => {
				const principal = principalOf(request);
				const parsed = suggestionSettingsSchema.safeParse(request.body);
				if (!parsed.success) return reply.code(400).send({ error: 'invalid request' });
				await loadPrincipal(principal);
				return withPrincipal(db, principal, async (tx) => {
					await writeSettings(tx, principal.id, parsed.data);
					return readSettings(tx, principal.id);
				});
			});

			// What waits for the owner's answer, asked in their room or through the API, which they
			// answer here as they would in the chat
			scope.get('/pending-calls', async (request, reply) => {
				const principal = principalOf(request);
				const record = await loadPrincipal(principal);
				if (!record.actions.includes('chat')) return reply.code(403).send(FORBIDDEN);
				const calls = await withOverdueExpired(principal, request.log, (tx) =>
					listPendingCalls(tx, principal.id)
				);
				return {
					pending_calls: calls.map((call) =>
						toPendingCallView(call, config.consent.requestLifetimeMs)
					)
				};
			});

			// The owner's no through the API drops the call, as their no in the chat does
			scope.post<{ Params: { id: string } }>(
				'/pending-calls/:id/refuse',
				async (request, reply) => {
					const principal = principalOf(request);
					const record = await loadPrincipal(principal);
					if (!record.actions.includes('chat')) return reply.code(403).send(FORBIDDEN);
					const { id } = request.params;
					if (!PENDING_CALL_ID.test(id)) return reply.code(404).send(RESOURCE_UNAVAILABLE);
					const parsedBody = refuseBodySchema.safeParse(request.body ?? {});
					if (!parsedBody.success) return reply.code(400).send({ error: 'invalid request' });
					const { reason } = parsedBody.data;
					const call = await withOverdueExpired(principal, request.log, (tx) =>
						findPendingCall(tx, principal.id, id)
					);
					if (call === null) return reply.code(404).send(RESOURCE_UNAVAILABLE);
					if (call.state !== 'open') {
						if (call.state !== 'decided') {
							answeredThroughApi(request.log, principal.id, call, 'no', call.state);
						}
						// Not useful is said of the channel, which the owner hears no more of, whether the
						// suggestion still waits for them or not
						if (reason === 'not_useful') {
							await withPrincipal(db, principal, async (tx) => {
								const suggestion = await findSuggestion(tx, principal.id, id);
								if (suggestion !== null) {
									await muteRoomFor(tx, principal.id, suggestion.roomId, NOT_USEFUL_MUTE_MS);
								}
							});
						}
						return reply.code(409).send(pendingCallClosed(call.state));
					}
					// The harness says so in the owner's room when the call was asked there, as after their
					// ❌: the notice goes out with the refusal, or not at all
					const notice =
						call.channel.kind === 'room'
							? await refusalNotice(principal, call.channel.roomId, id)
							: null;
					const answerId = `api:${request.id}`;
					const refused = await withPrincipal(db, principal, async (tx) => {
						// What a suggestion needs of its call is read before the refusal erases it
						const suggestion =
							reason === undefined ? null : await findSuggestion(tx, principal.id, id);
						const meeting =
							suggestion === null
								? null
								: readMeeting(readJsonColumn(await readCallArguments(tx, principal.id, id)));
						// Before the refusal, which an answer that came first wins
						if (suggestion !== null && reason === 'not_useful') {
							await muteRoomFor(tx, principal.id, suggestion.roomId, NOT_USEFUL_MUTE_MS);
						}
						if (!(await answerPendingCall(tx, principal.id, id, 'refused', answerId))) return false;
						// A no to the question of the owner's first brief stops their brief, as in the chat
						await refuseBriefQuestion(tx, principal.id, id);
						if (notice !== null) await enqueueJob(tx, notice);
						// Another time is tried once: the second suggestion is not offered a third
						if (
							suggestion !== null &&
							reason === 'another_time' &&
							suggestion.attempt === 0 &&
							meeting !== null
						) {
							const payload: SuggestPayload = {
								owner: principal.id,
								roomId: suggestion.roomId,
								eventId: `retry:${id}`,
								at: Date.now(),
								quoted: [],
								retry: {
									title: meeting.title,
									attendees: [...meeting.attendees],
									start: meeting.start,
									end: meeting.end,
									timeZone: meeting.time_zone ?? null
								}
							};
							await enqueueJob(tx, {
								kind: 'suggest',
								payload,
								dedupKey: `suggest:retry:${id}`,
								groupKey: suggestGroup(principal.id)
							});
						}
						return true;
					});
					if (!refused) return reply.code(409).send(pendingCallClosed('decided'));
					answeredThroughApi(request.log, principal.id, call, 'no', 'decided');
					return { id, status: 'refused' };
				}
			);

			// The owner's yes through the API resumes the call where it was frozen, as their yes in the
			// chat does; the first answer wins, and a later one gets a conflict
			scope.post<{ Params: { id: string } }>(
				'/pending-calls/:id/approve',
				async (request, reply) => {
					const principal = principalOf(request);
					const record = await loadPrincipal(principal);
					if (!record.actions.includes('chat')) return reply.code(403).send(FORBIDDEN);
					const { id } = request.params;
					if (!PENDING_CALL_ID.test(id)) return reply.code(404).send(RESOURCE_UNAVAILABLE);
					const call = await withOverdueExpired(principal, request.log, (tx) =>
						findPendingCall(tx, principal.id, id)
					);
					if (call === null) return reply.code(404).send(RESOURCE_UNAVAILABLE);
					if (call.state === 'expired' || call.state === 'superseded') {
						answeredThroughApi(request.log, principal.id, call, 'yes', call.state);
						return reply.code(409).send(pendingCallClosed(call.state));
					}
					const { channel } = call;
					// A call asked in the room runs through the job its first answer queued: a later yes
					// changes nothing
					if (call.state === 'decided' && channel.kind === 'room') {
						return reply.code(409).send(pendingCallClosed('decided'));
					}
					// The yes goes in under an id of its own, so that the first answer wins, in the room
					// or through the API
					const answerId = `api:${request.id}`;
					const answered = (): void => {
						// A yes that takes back a call a lost replica left unrun was counted when it first came
						if (call.state === 'open') {
							answeredThroughApi(request.log, principal.id, call, 'yes', 'decided');
						} else {
							request.log.info(
								{ owner: principal.id, pendingCallId: id, answer: 'yes', via: 'api' },
								'owner answered again'
							);
						}
					};
					if (channel.kind === 'room') {
						// A call asked in the owner's room resumes there, with their turns, as after their
						// ✅: its job goes out with the approval, or not at all
						const resume: ResumeRequest = {
							owner: principal.id,
							roomId: channel.roomId,
							pendingCallId: id,
							through: 'api'
						};
						const approved = await withPrincipal(db, principal, async (tx) => {
							if (!(await answerPendingCall(tx, principal.id, id, 'approved', answerId))) {
								return false;
							}
							await enqueueJob(tx, resumeJob(resume));
							return true;
						});
						if (!approved) return reply.code(409).send(pendingCallClosed('decided'));
						answered();
						return reply.code(202).send({ id, status: 'approved' });
					}
					if (channel.kind === 'api_chat') {
						// A turn through the API goes on in its session, admitted like any turn: a turn
						// refused for now leaves the call waiting
						const result = await agent.runOwnerTurn({
							principal,
							target: { kind: 'id', id: channel.sessionId },
							message: null,
							log: request.log,
							resume: { pendingCallId: id, through: 'api', answerId }
						});
						if (result.kind === 'decided') {
							return reply.code(409).send(pendingCallClosed('decided'));
						}
						if (result.kind === 'busy') {
							return reply.code(429).send({ error: 'busy', reason: result.reason });
						}
						if (result.kind === 'forbidden') return reply.code(403).send(FORBIDDEN);
						if (result.kind === 'missing') return reply.code(404).send(RESOURCE_UNAVAILABLE);
						answered();
						if (result.kind === 'failed') {
							return reply.code(502).send({ error: 'execution failed' });
						}
						return turnAnswer(principal, result);
					}
					// A direct tool call runs once allowed, under the same rules as when it was made, and
					// answers as it would have: the rights to call and act through contracts stay a
					// switch above the owner's consents
					const tool = tools.find(call.tool);
					if (
						tool !== null &&
						tool.requiredAction !== null &&
						!record.actions.includes(tool.requiredAction)
					) {
						return reply.code(403).send(FORBIDDEN);
					}
					const ran = await agent.runAllowedCall({
						principal,
						pendingCallId: id,
						answerId,
						log: request.log
					});
					if (ran.kind === 'decided') return reply.code(409).send(pendingCallClosed('decided'));
					answered();
					if (ran.outcome.denied === true) return reply.code(404).send(RESOURCE_UNAVAILABLE);
					// A call that waits for its owner again answers as the tool route does: with its new
					// pending call
					const waiting =
						ran.outcome.pendingCallId === undefined
							? null
							: await pendingCallView(principal, ran.outcome.pendingCallId);
					if (waiting !== null) return reply.code(202).send({ pending_call: waiting });
					return ran.outcome.result;
				}
			);

			// Direct tool calls, under the same rules as the model's: identity from the token only,
			// unknown tools and unknown arguments refused, ownership enforced by the database.
			scope.post('/tool', async (request, reply) => {
				const principal = principalOf(request);
				const parsed = toolBodySchema.safeParse(request.body);
				if (!parsed.success) return reply.code(400).send({ error: 'invalid request' });
				const tool = tools.find(parsed.data.tool);
				if (tool === null) return reply.code(404).send(RESOURCE_UNAVAILABLE);
				const record = await loadPrincipal(principal);
				if (tool.requiredAction !== null && !record.actions.includes(tool.requiredAction)) {
					return reply.code(403).send(FORBIDDEN);
				}
				const started = performance.now();
				const outcome = await runTool(tool, parsed.data.arguments ?? {}, {
					principalId: principal.id,
					actions: record.actions,
					db,
					correlationId: request.id,
					log: request.log
				});
				request.log.info(
					{
						tool: parsed.data.tool,
						status: toolCallStatus(outcome),
						durationMs: Math.round(performance.now() - started)
					},
					'tool called'
				);
				request.log.debug(
					{ tool: parsed.data.tool, arguments: parsed.data.arguments, result: outcome.result },
					'tool called'
				);
				if (outcome.denied === true) return reply.code(404).send(RESOURCE_UNAVAILABLE);
				// A call that waits for the owner's answer did not run: the client gets the pending call
				const pending =
					outcome.pendingCallId === undefined
						? null
						: await pendingCallView(principal, outcome.pendingCallId);
				if (pending !== null) return reply.code(202).send({ pending_call: pending });
				return outcome.result;
			});

			scope.post('/chat', async (request, reply) => {
				const principal = principalOf(request);
				const parsed = chatBodySchema.safeParse(request.body);
				if (!parsed.success) {
					return reply.code(400).send({ error: 'invalid request' });
				}
				const body = parsed.data;
				const result = await agent.runOwnerTurn({
					principal,
					target:
						body.session_id === undefined ? { kind: 'new' } : { kind: 'id', id: body.session_id },
					message: body.message,
					log: request.log,
					correlationId: request.id
				});
				if (result.kind === 'forbidden') return reply.code(403).send(FORBIDDEN);
				// A turn of a new message resumes no call, so none was decided before it
				if (result.kind === 'missing' || result.kind === 'decided') {
					return reply.code(404).send(RESOURCE_UNAVAILABLE);
				}
				if (result.kind === 'busy')
					return reply.code(429).send({ error: 'busy', reason: result.reason });
				if (result.kind === 'failed') return reply.code(502).send({ error: 'execution failed' });
				return turnAnswer(principal, result);
			});
		},
		{ prefix: '/v1' }
	);

	return app;
}
