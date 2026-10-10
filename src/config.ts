import { z } from 'zod';

import { findTimeZone, type TimeZone } from './agent/clock.js';
import { LOCALES, type Locale } from './i18n/messages.js';
import { parseQuietHours, type QuietHours } from './quiet/hours.js';
import { TASK_ASSIGNED_EVENT_TYPE } from './wakeups/event-types.js';
import { HOUR_MS } from './wakeups/retention.js';

const ROLES = ['api', 'matrix', 'worker'] as const;
export type Role = (typeof ROLES)[number];

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

// How the matrix role holds an owner's words to the devices their cross-signing identity signed:
// enforce takes them only from such a device; report takes them all the same, and logs and tells
// the owner what enforce would not take
const OWNER_DEVICE_TRUST_MODES = ['report', 'enforce'] as const;
export type OwnerDeviceTrust = (typeof OWNER_DEVICE_TRUST_MODES)[number];

export interface ActivitySource {
	// The broker, its vhost included
	readonly amqpUrl: string;
	// The CloudEvent types that wake an assistant: the only routing keys its queue is bound to
	readonly types: readonly string[];
}

export interface CalendarSource {
	// The broker, Calendar's vhost included
	readonly amqpUrl: string;
}

export interface Config {
	readonly role: Role;
	readonly host: string;
	readonly port: number;
	readonly databaseUrl: string;
	readonly auth: {
		readonly jwksUrl: URL;
		readonly issuer: string;
		readonly audience: string;
		// The other audiences a token may carry to answer a call that waits for its owner, such as
		// those of Twake Space's buttons: accepted on /v1/pending-calls/:id/approve and /refuse, and
		// on no other route
		readonly answerAudiences: readonly string[];
	};
	readonly apisix: {
		readonly baseUrl: URL;
		readonly consumerKey: string;
	};
	readonly llm: {
		readonly model: string;
		readonly maxTokens: number;
		readonly timeoutMs: number;
	};
	readonly turn: {
		readonly maxToolCalls: number;
		// The tokens one turn may spend, the prompts and answers of all its model calls summed: once
		// they are spent, the turn ends on a last call, without tools
		readonly maxTokens: number;
		readonly memoryNudgeInterval: number;
		// The most characters of past conversation a turn shows the model
		readonly historyMaxChars: number;
		// How long a turn of an owner's message may go without an answer before its assistant posts
		// a status message, which closes once the turn answered
		readonly statusDelayMs: number;
		// How long a turn an event woke, or one its owner's yes resumed, may wait to start once
		// admission first refused it: it is tried again until then, and given up past it
		readonly eventMaxDelayMs: number;
	};
	readonly curation: {
		readonly intervalMs: number;
	};
	readonly admission: {
		// Turns running at once in this replica, and the queue behind them
		readonly maxInflight: number;
		// Per user: one running turn, then this many waiting; beyond, the user is told to come back
		readonly userQueue: number;
		readonly userPerMinute: number;
		readonly userDailyTokens: number;
		// The AI Gateway's own rate, respected before it refuses us
		readonly globalPerMinute: number;
		// The share of each user's daily tokens kept for their own words, from 0 to 1: the turns
		// activities wake and the briefs may spend the rest
		readonly chatReserve: number;
	};
	readonly contracts: {
		// Under the APISIX address: where the curated OpenAPI is served, and an optional prefix for
		// the calls. Empty, the calls go to the paths the document gives (its server path, then the
		// operation path); set, it prefixes them, for a gateway mounting the contracts elsewhere.
		readonly openapiPath: string;
		readonly basePath: string;
		readonly refreshMs: number;
		readonly timeoutMs: number;
	};
	readonly consent: {
		// How long the owner may answer a request; an answer after that runs nothing
		readonly requestLifetimeMs: number;
		// The token broker's consent link, the same for every owner: the only link a request shows
		// when the broker lacks an owner's permission for their assistant to act for them, or null
		// when the deployment gives none
		readonly brokerConsentUrl: string | null;
		// The hour, from 0 to 23 on the wall clock of ASSISTANT_TIMEZONE, the deployment's zone, of the
		// worker role's daily pass that reminds the owners whose permission expires within five days
		readonly delegationReminderHour: number;
	};
	readonly matrix: {
		readonly serverName: string;
		// The mail domain of the homeserver's users: a user @alice:<server> is the principal
		// alice@<mail domain>, the subject of her platform token
		readonly mailDomain: string;
		readonly appserviceId: string;
		readonly senderLocalpart: string;
		readonly assistantPrefix: string;
		// The token APISIX injects on the matrix route; set it only when the harness sends it itself
		readonly asToken: string;
		readonly hsToken: string;
		// Where the matrix role keeps the assistants' encryption state, on its volume
		readonly cryptoStorePath: string;
		// Whether an owner's words count only from a device their cross-signing identity signed
		readonly ownerDeviceTrust: OwnerDeviceTrust;
	};
	readonly org: {
		// The organization agent: one bot of the harness answering the organization's members
		readonly enabled: boolean;
		readonly localpart: string;
		readonly name: string;
		readonly persona: string;
		// The Matrix identifiers of the members it answers
		readonly members: readonly string[];
	};
	readonly provisioning: {
		// The service clients, by their token subject, allowed to provision an owner's assistant
		readonly clientIds: readonly string[];
	};
	readonly rabbitmq: {
		// What the names of the queues and exchanges this instance declares on the broker start
		// with: its own, so that no two instances share a queue
		readonly prefix: string;
	};
	// The activity exchange, where the applications publish what happens to people as CloudEvents,
	// which the worker role listens to when it is set
	readonly activity: ActivitySource | null;
	readonly wakeups: {
		// How many times events from the broker may wake one owner's assistant in a rolling hour,
		// whatever their source, counted in the database: past it, an event wakes that owner no more
		readonly perHour: number;
		// How long the worker role keeps a wake-up, by which an event delivered again wakes nobody
		// twice: an event replayed after it is a new one
		readonly retentionMs: number;
	};
	// The brief of each owner's working day, which the worker role asks their assistant for in their
	// room, on the days and from the time they chose in their zone, from eight on weekdays by default
	readonly brief: {
		readonly enabled: boolean;
	};
	// The quiet hours of an owner who chose none, on the wall clock of their zone, during which their
	// assistant posts nothing on its own: what reaches them then waits for their brief or their end
	readonly quietHours: QuietHours;
	// Calendar's fanout of the notifications it sends each invitee, which the worker role listens
	// to when it is set, for the new invitations
	readonly calendar: CalendarSource | null;
	readonly gateway: {
		// The secret the gateway sets on every request it forwards, when the API is only behind it
		readonly sharedSecret: string | null;
	};
	readonly escrow: {
		// The assistants' secrets (cross-signing keys, backup key) escrowed in the platform OpenBao
		readonly enabled: boolean;
		// The OpenBao route of APISIX, and the KV mount and path prefix of the escrow
		readonly path: string;
		readonly kvMount: string;
		readonly prefix: string;
		// Kubernetes authentication: the auth path, the role and where the pod's token is
		readonly authPath: string;
		readonly k8sRole: string;
		readonly k8sTokenPath: string;
	};
	readonly suggestions: {
		// Whether the assistants propose actions from the messages of channels that are not
		// encrypted, off unless a deployment turns it on: the matrix role then registers the listener,
		// which the registration's users namespace must hold
		readonly enabled: boolean;
		// The localpart of the one visible user that reads the channels it is invited to
		readonly userLocalpart: string;
		// Twake Space's notifications, which receive a suggestion for its user; null for none
		readonly space: { readonly apiUrl: URL; readonly apiToken: string } | null;
	};
	// The language of the fixed texts of the assistants and the creator
	readonly locale: Locale;
	// The IANA time zone the assistants read the present in, such as Europe/Paris, until a read of
	// their owner's calendar names its zone, and at whose midnight a user's day of tokens starts
	readonly timeZone: TimeZone;
	readonly logLevel: LogLevel;
}

const envSchema = z.object({
	HARNESS_ROLE: z.enum(ROLES).default('api'),
	HOST: z.string().default('0.0.0.0'),
	PORT: z.coerce.number().int().min(1).max(65535).default(8080),
	DATABASE_URL: z.string().min(1),
	AUTH_JWKS_URL: z.url(),
	AUTH_ISSUER: z.string().min(1),
	AUTH_AUDIENCE: z.string().min(1),
	AUTH_ANSWER_AUDIENCES: z.string().default(''),
	APISIX_BASE_URL: z.url(),
	APISIX_CONSUMER_KEY: z.string().min(1),
	LLM_MODEL: z.string().min(1).default('qwen3.8'),
	// Reasoning models spend part of it deliberating before they write the answer
	LLM_MAX_TOKENS: z.coerce.number().int().min(1).default(8192),
	LLM_TIMEOUT_MS: z.coerce.number().int().min(1000).default(120_000),
	TURN_MAX_TOOL_CALLS: z.coerce.number().int().min(0).default(6),
	// About a dozen model calls, which can each read some 20,000 tokens
	TURN_MAX_TOKENS: z.coerce.number().int().min(1).default(250_000),
	MEMORY_NUDGE_INTERVAL: z.coerce.number().int().min(0).default(10),
	// 24,000 characters is about 6,000 to 8,000 tokens at 3 to 4 characters a token: in a 32K-token
	// context it leaves room for the system prompt and its memory, the tool definitions, the turn's own
	// messages and tool results, and an answer of up to LLM_MAX_TOKENS
	TURN_HISTORY_MAX_CHARS: z.coerce.number().int().min(1).default(24_000),
	TURN_STATUS_DELAY_MS: z.coerce.number().int().min(1000).default(3000),
	TURN_EVENT_MAX_DELAY_MS: z.coerce.number().int().min(1000).default(3_600_000),
	CURATION_INTERVAL_MS: z.coerce.number().int().min(0).default(86_400_000),
	ADMISSION_MAX_INFLIGHT: z.coerce.number().int().min(1).default(32),
	ADMISSION_USER_QUEUE: z.coerce.number().int().min(0).default(2),
	ADMISSION_USER_PER_MINUTE: z.coerce.number().int().min(1).default(10),
	ADMISSION_USER_DAILY_TOKENS: z.coerce.number().int().min(1).default(200_000),
	ADMISSION_GLOBAL_PER_MINUTE: z.coerce.number().int().min(1).default(400),
	// The share of each owner's day kept for their own words: the turns activities wake and the
	// briefs may spend the rest
	CHAT_RESERVE: z.coerce.number().min(0).max(1).default(0.5),
	CONTRACTS_OPENAPI_PATH: z.string().min(1).default('contracts/openapi.json'),
	CONTRACTS_BASE_PATH: z.string().default(''),
	CONTRACTS_REFRESH_MS: z.coerce.number().int().min(0).default(300_000),
	CONTRACTS_TIMEOUT_MS: z.coerce.number().int().min(1000).default(30_000),
	CONSENT_REQUEST_LIFETIME_MS: z.coerce.number().int().min(1000).default(86_400_000),
	BROKER_CONSENT_URL: z.string().default(''),
	DELEGATION_REMINDER_HOUR: z.coerce.number().int().min(0).max(23).default(9),
	MATRIX_SERVER_NAME: z.string().default(''),
	MATRIX_MAIL_DOMAIN: z.string().default(''),
	MATRIX_APPSERVICE_ID: z.string().min(1).default('twake-harness'),
	MATRIX_SENDER_LOCALPART: z.string().min(1).default('twake-space-assistant'),
	MATRIX_ASSISTANT_PREFIX: z.string().min(1).default('twake-space-assistant-'),
	MATRIX_AS_TOKEN: z.string().default('injected-by-apisix'),
	MATRIX_HS_TOKEN: z.string().default(''),
	MATRIX_CRYPTO_STORE_PATH: z.string().min(1).default('/data/crypto'),
	// Reporting unless a deployment chooses to enforce, so that a deployment that sets nothing never
	// starts refusing its owners
	OWNER_DEVICE_TRUST: z.enum(OWNER_DEVICE_TRUST_MODES).default('report'),
	ORG_AGENT_ENABLED: z.enum(['true', 'false']).default('false'),
	ORG_AGENT_LOCALPART: z.string().min(1).default('twake-space-assistant-org'),
	ORG_AGENT_NAME: z.string().min(1).default('Twake Space'),
	ORG_AGENT_PERSONA: z
		.string()
		.default(
			'You are the organization agent of Twake Space. You answer the members of the organization about the organization, its usage and its practices.'
		),
	ORG_AGENT_MEMBERS: z.string().default(''),
	PROVISIONER_CLIENT_IDS: z.string().default(''),
	RABBITMQ_PREFIX: z
		.string()
		.regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/, 'a plain name, such as twake-harness-b2b')
		.default('twake-harness'),
	ACTIVITY_ENABLED: z.enum(['true', 'false']).default('false'),
	ACTIVITY_AMQP_URL: z.string().default(''),
	ACTIVITY_TYPES: z.string().default(TASK_ASSIGNED_EVENT_TYPE),
	// As many as the dispatcher allowed before the activity exchange replaced it
	WAKEUPS_PER_HOUR: z.coerce.number().int().min(1).default(20),
	CALENDAR_ENABLED: z.enum(['true', 'false']).default('false'),
	CALENDAR_AMQP_URL: z.string().default(''),
	// 30 days unless set, and an hour at least: an event that comes back after a restart of the
	// worker or of the broker, or an outage of the database, still wakes nobody twice
	WAKEUPS_RETENTION_MS: z.coerce
		.number()
		.int()
		.min(HOUR_MS)
		.default(30 * 24 * HOUR_MS),
	BRIEF_ENABLED: z.enum(['true', 'false']).default('false'),
	// From eight in the evening to eight in the morning, and all weekend
	QUIET_HOURS_DEFAULT: z.string().default('20:00-08:00 saturday sunday'),
	GATEWAY_SHARED_SECRET: z.string().default(''),
	ESCROW_ENABLED: z.enum(['true', 'false']).default('false'),
	OPENBAO_PATH: z.string().min(1).default('openbao'),
	OPENBAO_KV_MOUNT: z.string().min(1).default('secret'),
	OPENBAO_ESCROW_PREFIX: z.string().min(1).default('twake-harness/assistants'),
	OPENBAO_AUTH_PATH: z.string().min(1).default('auth/kubernetes/login'),
	OPENBAO_K8S_ROLE: z.string().min(1).default('twake-harness'),
	OPENBAO_K8S_TOKEN_PATH: z
		.string()
		.min(1)
		.default('/var/run/secrets/kubernetes.io/serviceaccount/token'),
	SUGGESTIONS_USER_LOCALPART: z.string().min(1).default('twake-assistant'),
	SUGGESTIONS_ENABLED: z.enum(['true', 'false']).default('false'),
	SPACE_API_URL: z.string().default(''),
	SPACE_API_TOKEN: z.string().default(''),
	ASSISTANT_LOCALE: z.enum(LOCALES).default('en'),
	ASSISTANT_TIMEZONE: z.string().min(1).default('UTC'),
	LOG_LEVEL: z.enum(LOG_LEVELS).default('info')
});

export type Env = Record<string, string | undefined>;

// The least a wake-up is kept when the briefs are on: a brief is one wake-up of its owner's date,
// which must outlast that date wherever it runs, an owner who moves west living its morning again
// up to a day later
const BRIEF_MIN_RETENTION_MS = 2 * 24 * HOUR_MS;

function isHttpsUrl(value: string): boolean {
	return URL.canParse(value) && new URL(value).protocol === 'https:';
}

// The items of a comma separated setting, without the spaces around them nor the empty ones
function listOf(value: string): string[] {
	return value
		.split(',')
		.map((item) => item.trim())
		.filter((item) => item.length > 0);
}

function isAmqpUrl(value: string): boolean {
	return URL.canParse(value) && ['amqp:', 'amqps:'].includes(new URL(value).protocol);
}

// The address a source the worker listens to is read at, as its settings give it: an amqp or
// amqps URL, which holds the password of the instance's user, so that a refusal never says it. The
// owners a source wakes are the recipients whose email is on the mail domain: without one, it
// would wake nobody, and say nothing.
function sourceAddress(
	source: 'ACTIVITY' | 'CALENDAR',
	address: string,
	values: { MATRIX_SERVER_NAME: string; MATRIX_MAIL_DOMAIN: string }
): string {
	if (!isAmqpUrl(address)) {
		throw new Error(
			`invalid configuration: ${source}_ENABLED needs ${source}_AMQP_URL, an amqp or amqps URL`
		);
	}
	if (values.MATRIX_SERVER_NAME === '' && values.MATRIX_MAIL_DOMAIN === '') {
		throw new Error(
			`invalid configuration: ${source}_ENABLED needs MATRIX_SERVER_NAME or MATRIX_MAIL_DOMAIN, the mail domain of the owners it wakes`
		);
	}
	return address;
}

// The activity exchange as the worker listens to it. The routing keys its queue is bound to are
// CloudEvent types, each exactly, since a word * or # of a topic binding would let in events of
// other types, or every event.
function activitySource(values: {
	ACTIVITY_AMQP_URL: string;
	ACTIVITY_TYPES: string;
	MATRIX_SERVER_NAME: string;
	MATRIX_MAIL_DOMAIN: string;
}): {
	amqpUrl: string;
	types: string[];
} {
	const amqpUrl = sourceAddress('ACTIVITY', values.ACTIVITY_AMQP_URL, values);
	const types = listOf(values.ACTIVITY_TYPES);
	if (types.length === 0) {
		throw new Error('invalid configuration: ACTIVITY_TYPES lists no CloudEvent type');
	}
	const pattern = types.find((type) => type.split('.').some((word) => /[*#]/.test(word)));
	if (pattern !== undefined) {
		throw new Error(
			`invalid configuration: ACTIVITY_TYPES lists the CloudEvent types that wake an assistant, never a pattern such as ${JSON.stringify(pattern)}`
		);
	}
	return { amqpUrl, types };
}

// Calendar's fanout, on the vhost its address names, whose notifications name their invitee by
// email
function calendarSource(values: {
	CALENDAR_AMQP_URL: string;
	MATRIX_SERVER_NAME: string;
	MATRIX_MAIL_DOMAIN: string;
}): CalendarSource {
	return { amqpUrl: sourceAddress('CALENDAR', values.CALENDAR_AMQP_URL, values) };
}

export function loadConfig(env: Env): Config {
	const parsed = envSchema.safeParse(env);
	if (!parsed.success) {
		const issues = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
		throw new Error(`invalid configuration: ${issues.join('; ')}`);
	}
	const values = parsed.data;
	if (
		values.HARNESS_ROLE === 'matrix' &&
		(values.MATRIX_SERVER_NAME === '' || values.MATRIX_HS_TOKEN === '')
	) {
		throw new Error(
			'invalid configuration: the matrix role needs MATRIX_SERVER_NAME and MATRIX_HS_TOKEN'
		);
	}
	// The organization agent lives in the namespace the application service owns
	if (
		values.ORG_AGENT_ENABLED === 'true' &&
		!values.ORG_AGENT_LOCALPART.startsWith(values.MATRIX_ASSISTANT_PREFIX)
	) {
		throw new Error(
			`invalid configuration: ORG_AGENT_LOCALPART must start with ${values.MATRIX_ASSISTANT_PREFIX}`
		);
	}
	// The link goes to owners in the harness's own words, so a mistake in it stops the start
	if (values.BROKER_CONSENT_URL !== '' && !isHttpsUrl(values.BROKER_CONSENT_URL)) {
		throw new Error(
			`invalid configuration: BROKER_CONSENT_URL ${JSON.stringify(values.BROKER_CONSENT_URL)} is not an https URL`
		);
	}
	// The namespace tells the listener from the creator and the assistants by its name alone
	if (
		values.SUGGESTIONS_ENABLED === 'true' &&
		(values.SUGGESTIONS_USER_LOCALPART === values.MATRIX_SENDER_LOCALPART ||
			values.SUGGESTIONS_USER_LOCALPART.startsWith(values.MATRIX_ASSISTANT_PREFIX))
	) {
		throw new Error(
			`invalid configuration: SUGGESTIONS_USER_LOCALPART must not be MATRIX_SENDER_LOCALPART nor start with ${values.MATRIX_ASSISTANT_PREFIX}`
		);
	}
	if (values.SPACE_API_URL !== '' && !URL.canParse(values.SPACE_API_URL)) {
		throw new Error('invalid configuration: SPACE_API_URL is not a URL');
	}
	if (values.SPACE_API_URL !== '' && values.SPACE_API_TOKEN === '') {
		throw new Error('invalid configuration: SPACE_API_URL needs SPACE_API_TOKEN');
	}
	const timeZone = findTimeZone(values.ASSISTANT_TIMEZONE);
	if (timeZone === null) {
		throw new Error(
			`invalid configuration: ASSISTANT_TIMEZONE ${JSON.stringify(values.ASSISTANT_TIMEZONE)} is not a time zone the runtime knows; give an IANA name such as Europe/Paris`
		);
	}
	if (values.BRIEF_ENABLED === 'true' && values.WAKEUPS_RETENTION_MS < BRIEF_MIN_RETENTION_MS) {
		throw new Error(
			`invalid configuration: BRIEF_ENABLED needs WAKEUPS_RETENTION_MS of two days at least, ${BRIEF_MIN_RETENTION_MS}, so that no brief goes twice for one date`
		);
	}
	const quietHours = parseQuietHours(values.QUIET_HOURS_DEFAULT);
	if (quietHours === null) {
		throw new Error(
			`invalid configuration: QUIET_HOURS_DEFAULT ${JSON.stringify(values.QUIET_HOURS_DEFAULT)} is not quiet hours; give a range on the quarter hour and whole days, such as 20:00-08:00 saturday sunday, either alone, or none`
		);
	}
	return {
		role: values.HARNESS_ROLE,
		host: values.HOST,
		port: values.PORT,
		databaseUrl: values.DATABASE_URL,
		auth: {
			jwksUrl: new URL(values.AUTH_JWKS_URL),
			issuer: values.AUTH_ISSUER,
			audience: values.AUTH_AUDIENCE,
			answerAudiences: listOf(values.AUTH_ANSWER_AUDIENCES)
		},
		apisix: {
			baseUrl: new URL(values.APISIX_BASE_URL),
			consumerKey: values.APISIX_CONSUMER_KEY
		},
		llm: {
			model: values.LLM_MODEL,
			maxTokens: values.LLM_MAX_TOKENS,
			timeoutMs: values.LLM_TIMEOUT_MS
		},
		turn: {
			maxToolCalls: values.TURN_MAX_TOOL_CALLS,
			maxTokens: values.TURN_MAX_TOKENS,
			memoryNudgeInterval: values.MEMORY_NUDGE_INTERVAL,
			historyMaxChars: values.TURN_HISTORY_MAX_CHARS,
			statusDelayMs: values.TURN_STATUS_DELAY_MS,
			eventMaxDelayMs: values.TURN_EVENT_MAX_DELAY_MS
		},
		curation: {
			intervalMs: values.CURATION_INTERVAL_MS
		},
		admission: {
			maxInflight: values.ADMISSION_MAX_INFLIGHT,
			userQueue: values.ADMISSION_USER_QUEUE,
			userPerMinute: values.ADMISSION_USER_PER_MINUTE,
			userDailyTokens: values.ADMISSION_USER_DAILY_TOKENS,
			globalPerMinute: values.ADMISSION_GLOBAL_PER_MINUTE,
			chatReserve: values.CHAT_RESERVE
		},
		contracts: {
			openapiPath: values.CONTRACTS_OPENAPI_PATH,
			basePath: values.CONTRACTS_BASE_PATH,
			refreshMs: values.CONTRACTS_REFRESH_MS,
			timeoutMs: values.CONTRACTS_TIMEOUT_MS
		},
		consent: {
			requestLifetimeMs: values.CONSENT_REQUEST_LIFETIME_MS,
			brokerConsentUrl: values.BROKER_CONSENT_URL === '' ? null : values.BROKER_CONSENT_URL,
			delegationReminderHour: values.DELEGATION_REMINDER_HOUR
		},
		matrix: {
			serverName: values.MATRIX_SERVER_NAME,
			mailDomain:
				values.MATRIX_MAIL_DOMAIN === '' ? values.MATRIX_SERVER_NAME : values.MATRIX_MAIL_DOMAIN,
			appserviceId: values.MATRIX_APPSERVICE_ID,
			senderLocalpart: values.MATRIX_SENDER_LOCALPART,
			assistantPrefix: values.MATRIX_ASSISTANT_PREFIX,
			asToken: values.MATRIX_AS_TOKEN,
			hsToken: values.MATRIX_HS_TOKEN,
			cryptoStorePath: values.MATRIX_CRYPTO_STORE_PATH,
			ownerDeviceTrust: values.OWNER_DEVICE_TRUST
		},
		org: {
			enabled: values.ORG_AGENT_ENABLED === 'true',
			localpart: values.ORG_AGENT_LOCALPART,
			name: values.ORG_AGENT_NAME,
			persona: values.ORG_AGENT_PERSONA,
			members: listOf(values.ORG_AGENT_MEMBERS)
		},
		provisioning: {
			clientIds: listOf(values.PROVISIONER_CLIENT_IDS)
		},
		rabbitmq: { prefix: values.RABBITMQ_PREFIX },
		activity: values.ACTIVITY_ENABLED === 'true' ? activitySource(values) : null,
		wakeups: { perHour: values.WAKEUPS_PER_HOUR, retentionMs: values.WAKEUPS_RETENTION_MS },
		brief: { enabled: values.BRIEF_ENABLED === 'true' },
		quietHours,
		calendar: values.CALENDAR_ENABLED === 'true' ? calendarSource(values) : null,
		gateway: {
			sharedSecret: values.GATEWAY_SHARED_SECRET.length > 0 ? values.GATEWAY_SHARED_SECRET : null
		},
		escrow: {
			enabled: values.ESCROW_ENABLED === 'true',
			path: values.OPENBAO_PATH,
			kvMount: values.OPENBAO_KV_MOUNT,
			prefix: values.OPENBAO_ESCROW_PREFIX,
			authPath: values.OPENBAO_AUTH_PATH,
			k8sRole: values.OPENBAO_K8S_ROLE,
			k8sTokenPath: values.OPENBAO_K8S_TOKEN_PATH
		},
		suggestions: {
			enabled: values.SUGGESTIONS_ENABLED === 'true',
			userLocalpart: values.SUGGESTIONS_USER_LOCALPART,
			space:
				values.SPACE_API_URL === ''
					? null
					: { apiUrl: new URL(values.SPACE_API_URL), apiToken: values.SPACE_API_TOKEN }
		},
		locale: values.ASSISTANT_LOCALE,
		timeZone,
		logLevel: values.LOG_LEVEL
	};
}
