import { createHmac } from 'node:crypto';
import { access, copyFile, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dump, load } from 'js-yaml';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { inject } from 'vitest';
import { startPulling } from './containers.js';

// The Synapse of the platform; CI also runs the suites against the latest release
const IMAGE = process.env['SYNAPSE_IMAGE'] ?? 'ghcr.io/element-hq/synapse:v1.160.0';
export const SYNAPSE_SERVER_NAME = 'test.local';
const SHARED_SECRET = 'test-registration-secret';

export interface AppserviceRegistration {
	// The registration file Synapse loads, as the harness builds it
	readonly file: Record<string, unknown>;
}

export interface MatrixUser {
	readonly userId: string;
	readonly accessToken: string;
	// What the user signs in with, and confirms a change of their cross-signing identity with
	readonly password?: string;
}

export interface MatrixReply {
	readonly status: number;
	readonly body: Record<string, unknown>;
}

export interface TestSynapse {
	readonly url: string;
	// A new account, its display name the one given or else its localpart, as Synapse gives it
	registerUser(localpart: string, displayName?: string): Promise<MatrixUser>;
	// A new session of a registered user, as a client opened anew: a new device with its own token
	login(localpart: string): Promise<MatrixUser>;
	request(
		user: MatrixUser | null,
		method: string,
		path: string,
		body?: unknown
	): Promise<MatrixReply>;
	createDirectRoom(user: MatrixUser, invite: string): Promise<string>;
	sendText(user: MatrixUser, roomId: string, text: string): Promise<string>;
	messagesFrom(user: MatrixUser, roomId: string, sender: string): Promise<string[]>;
	waitForMessage(
		user: MatrixUser,
		roomId: string,
		sender: string,
		predicate: (text: string) => boolean
	): Promise<string>;
	pendingInvites(user: MatrixUser): Promise<{ roomId: string; inviter: string }[]>;
	joinRoom(user: MatrixUser, roomId: string): Promise<void>;
	joinedMembers(user: MatrixUser, roomId: string): Promise<string[]>;
	// Resolves once `userId` joined the room, as `viewer` sees its members
	waitForMember(viewer: MatrixUser, roomId: string, userId: string): Promise<void>;
	displayName(userId: string): Promise<string | null>;
	// Gives a user a new display name as the homeserver's admin, which a homeserver refusing
	// display-name changes still lets through, as when a login brings the user's name: a new member
	// event of theirs in each of their rooms tells it
	renameUserAsAdmin(userId: string, displayName: string): Promise<void>;
	whoami(accessToken: string): Promise<number>;
	logs(): Promise<string>;
	stop(): Promise<void>;
}

export interface ReservedPort {
	readonly port: number;
	// Lets the port go, right before whoever reserved it listens on it
	release(): Promise<void>;
}

// A port held until it is needed: Docker maps the containers' ports on the host in the same
// range, so a port merely found free could be taken while a container starts.
export async function reservePort(): Promise<ReservedPort> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.listen(0, '0.0.0.0', () => {
			const address = server.address();
			if (address === null || typeof address === 'string') {
				reject(new Error('no port'));
				return;
			}
			resolve({
				port: address.port,
				release: () => new Promise((done) => server.close(() => done()))
			});
		});
	});
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// The host Synapse and the broker use to call the app service back. `host.docker.internal` by
// default, which the containers resolve to `host-gateway`, the Docker host's own address, as the
// suites have always done, and as CI and a plain `docker run` expect. Where the app service is
// itself a container on the same Docker host, that address names the host, not the service: set
// this to an address the test containers reach it on, such as the service's address on the
// default Docker bridge.
export function callbackHost(): string {
	return process.env['HARNESS_CALLBACK_HOST'] ?? 'host.docker.internal';
}

// The extra host entries the test containers need: `host.docker.internal` resolves on the host to
// the address the callback host names, `host-gateway` unless overridden.
function callbackExtraHosts(): { host: string; ipAddress: string }[] {
	const override = process.env['HARNESS_CALLBACK_HOST_ADDRESS'];
	return [
		{
			host: 'host.docker.internal',
			ipAddress: override === undefined || override === '' ? 'host-gateway' : override
		}
	];
}

const GENEROUS = { per_second: 1000, burst_count: 1000 };

// A real Synapse, configured with the harness registration, that pushes to this host.
// The containers run as the host user, so the files they write in the shared directory stay
// readable on Linux hosts, where a bind mount keeps the container's ownership.
function hostIdentity(): { UID: string; GID: string } {
	return {
		UID: String(process.getuid?.() ?? 1000),
		GID: String(process.getgid?.() ?? 1000)
	};
}

// What Synapse's `generate` writes: its configuration, the logging configuration it names, and the
// server's signing key, written last
const SIGNING_KEY = `${SYNAPSE_SERVER_NAME}.signing.key`;
const GENERATED_FILES = ['homeserver.yaml', `${SYNAPSE_SERVER_NAME}.log.config`, SIGNING_KEY];

let generating: Promise<string> | null = null;

// The run's Synapse configuration, generated by its first Synapse in the folder the global setup
// made for it, and copied by every later one instead of a `generate` container of its own
function generatedConfig(): Promise<string> {
	generating ??= generateConfig(inject('synapseConfigDir'));
	return generating;
}

async function generateConfig(dir: string): Promise<string> {
	const generated = await access(join(dir, SIGNING_KEY)).then(
		() => true,
		() => false
	);
	if (!generated) {
		const generator: StartedTestContainer = await startPulling(
			new GenericContainer(IMAGE)
				.withEnvironment({ SYNAPSE_SERVER_NAME, SYNAPSE_REPORT_STATS: 'no', ...hostIdentity() })
				.withBindMounts([{ source: dir, target: '/data' }])
				.withCommand(['generate'])
				.withWaitStrategy(Wait.forOneShotStartup())
		);
		// The container exits once it has written them, and stopping it is what removes it
		await generator.stop();
	}
	return dir;
}

// The settings given go over the suites' own, as for a homeserver that refuses display-name changes
export async function startTestSynapse(
	registration: AppserviceRegistration,
	settings: Readonly<Record<string, unknown>> = {}
): Promise<TestSynapse> {
	const generated = await generatedConfig();
	const dir = await mkdtemp(join(tmpdir(), 'synapse-'));
	for (const file of GENERATED_FILES) await copyFile(join(generated, file), join(dir, file));
	const configPath = join(dir, 'homeserver.yaml');
	const config = load(await readFile(configPath, 'utf8')) as Record<string, unknown>;
	Object.assign(config, {
		enable_registration: true,
		enable_registration_without_verification: true,
		registration_shared_secret: SHARED_SECRET,
		app_service_config_files: ['/data/harness.yaml'],
		experimental_features: {
			msc2409_to_device_messages_enabled: true,
			msc3202_device_masquerading: true,
			msc3202_transaction_extensions: true
		},
		rc_message: GENEROUS,
		rc_registration: GENEROUS,
		rc_login: { address: GENEROUS, account: GENEROUS, failed_attempts: GENEROUS },
		rc_joins: { local: GENEROUS, remote: GENEROUS },
		rc_invites: { per_room: GENEROUS, per_user: GENEROUS, per_issuer: GENEROUS },
		...settings
	});
	await writeFile(configPath, dump(config));
	await writeFile(join(dir, 'harness.yaml'), dump(registration.file));
	const builder = new GenericContainer(IMAGE)
		.withEnvironment(hostIdentity())
		.withBindMounts([{ source: dir, target: '/data' }])
		.withExposedPorts(8008)
		.withExtraHosts(callbackExtraHosts());
	const started: StartedTestContainer = await startPulling(
		builder.withWaitStrategy(Wait.forHttp('/_matrix/client/versions', 8008))
	);
	const url = `http://${started.getHost()}:${started.getMappedPort(8008)}`;

	async function request(
		user: MatrixUser | null,
		method: string,
		path: string,
		body?: unknown
	): Promise<MatrixReply> {
		const headers: Record<string, string> = { 'content-type': 'application/json' };
		if (user !== null) headers['authorization'] = `Bearer ${user.accessToken}`;
		const res = await fetch(`${url}${path}`, {
			method,
			headers,
			...(body === undefined ? {} : { body: JSON.stringify(body) })
		});
		return { status: res.status, body: (await res.json()) as Record<string, unknown> };
	}

	async function login(localpart: string): Promise<MatrixUser> {
		const res = await request(null, 'POST', '/_matrix/client/v3/login', {
			type: 'm.login.password',
			identifier: { type: 'm.id.user', user: localpart },
			password: `${localpart}-password`
		});
		if (res.status !== 200) {
			throw new Error(`login of ${localpart} failed: ${JSON.stringify(res.body)}`);
		}
		return {
			userId: res.body['user_id'] as string,
			accessToken: res.body['access_token'] as string,
			password: `${localpart}-password`
		};
	}

	// A new account, registered with the shared secret, an admin of the homeserver or not
	async function register(
		localpart: string,
		admin: boolean,
		displayName?: string
	): Promise<MatrixUser> {
		const nonce = (await request(null, 'GET', '/_synapse/admin/v1/register')).body[
			'nonce'
		] as string;
		const password = `${localpart}-password`;
		const mac = createHmac('sha1', SHARED_SECRET)
			.update(`${nonce}\0${localpart}\0${password}\0${admin ? 'admin' : 'notadmin'}`)
			.digest('hex');
		// Given at the registration, which a homeserver refusing display-name changes still takes
		const res = await request(null, 'POST', '/_synapse/admin/v1/register', {
			nonce,
			username: localpart,
			password,
			admin,
			mac,
			...(displayName === undefined ? {} : { displayname: displayName })
		});
		if (res.status !== 200) {
			throw new Error(`registration of ${localpart} failed: ${JSON.stringify(res.body)}`);
		}
		return {
			userId: res.body['user_id'] as string,
			accessToken: res.body['access_token'] as string,
			password
		};
	}

	async function registerUser(localpart: string, displayName?: string): Promise<MatrixUser> {
		return register(localpart, false, displayName);
	}

	// The homeserver's admin, registered the first time a test needs it
	let admin: Promise<MatrixUser> | null = null;

	async function renameUserAsAdmin(userId: string, displayName: string): Promise<void> {
		admin ??= register('homeserver-admin', true);
		const res = await request(
			await admin,
			'PUT',
			`/_synapse/admin/v2/users/${encodeURIComponent(userId)}`,
			{ displayname: displayName }
		);
		if (res.status !== 200) {
			throw new Error(`rename of ${userId} failed: ${JSON.stringify(res.body)}`);
		}
	}

	async function createDirectRoom(user: MatrixUser, invite: string): Promise<string> {
		const res = await request(user, 'POST', '/_matrix/client/v3/createRoom', {
			is_direct: true,
			preset: 'trusted_private_chat',
			invite: [invite]
		});
		if (res.status !== 200) throw new Error(`createRoom failed: ${JSON.stringify(res.body)}`);
		return res.body['room_id'] as string;
	}

	async function sendText(user: MatrixUser, roomId: string, text: string): Promise<string> {
		const txn = `${Date.now()}-${Math.random()}`;
		const res = await request(
			user,
			'PUT',
			`/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txn}`,
			{ msgtype: 'm.text', body: text }
		);
		if (res.status !== 200) throw new Error(`send failed: ${JSON.stringify(res.body)}`);
		return res.body['event_id'] as string;
	}

	interface TimelineEvent {
		type: string;
		sender: string;
		content: { body?: string };
	}

	async function messagesFrom(user: MatrixUser, roomId: string, sender: string): Promise<string[]> {
		const res = await request(
			user,
			'GET',
			`/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages?dir=b&limit=50`
		);
		const chunk = (res.body['chunk'] ?? []) as TimelineEvent[];
		return chunk
			.filter(
				(e) =>
					e.type === 'm.room.message' && e.sender === sender && typeof e.content.body === 'string'
			)
			.map((e) => e.content.body ?? '')
			.reverse();
	}

	async function waitForMessage(
		user: MatrixUser,
		roomId: string,
		sender: string,
		predicate: (text: string) => boolean
	): Promise<string> {
		for (let i = 0; i < 60; i += 1) {
			const found = (await messagesFrom(user, roomId, sender)).find(predicate);
			if (found !== undefined) return found;
			await sleep(250);
		}
		throw new Error(`no message from ${sender} in ${roomId} matched within 15 s`);
	}

	async function pendingInvites(user: MatrixUser): Promise<{ roomId: string; inviter: string }[]> {
		const res = await request(user, 'GET', '/_matrix/client/v3/sync?timeout=0');
		const invites = ((res.body['rooms'] as Record<string, unknown> | undefined)?.['invite'] ??
			{}) as Record<
			string,
			{ invite_state?: { events?: { type: string; sender: string; state_key?: string }[] } }
		>;
		return Object.entries(invites).map(([roomId, room]) => {
			const member = (room.invite_state?.events ?? []).find(
				(e) => e.type === 'm.room.member' && e.state_key === user.userId
			);
			return { roomId, inviter: member?.sender ?? '' };
		});
	}

	async function joinRoom(user: MatrixUser, roomId: string): Promise<void> {
		const res = await request(
			user,
			'POST',
			`/_matrix/client/v3/join/${encodeURIComponent(roomId)}`,
			{}
		);
		if (res.status !== 200) throw new Error(`join failed: ${JSON.stringify(res.body)}`);
	}

	async function joinedMembers(user: MatrixUser, roomId: string): Promise<string[]> {
		const res = await request(
			user,
			'GET',
			`/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/joined_members`
		);
		return Object.keys((res.body['joined'] as Record<string, unknown> | undefined) ?? {});
	}

	async function waitForMember(viewer: MatrixUser, roomId: string, userId: string): Promise<void> {
		for (let i = 0; i < 80; i += 1) {
			if ((await joinedMembers(viewer, roomId)).includes(userId)) return;
			await sleep(250);
		}
		throw new Error(`${userId} never joined ${roomId}`);
	}

	async function displayName(userId: string): Promise<string | null> {
		const res = await request(
			null,
			'GET',
			`/_matrix/client/v3/profile/${encodeURIComponent(userId)}/displayname`
		);
		const name = res.body['displayname'];
		return typeof name === 'string' ? name : null;
	}

	async function whoami(accessToken: string): Promise<number> {
		return (await request({ userId: '', accessToken }, 'GET', '/_matrix/client/v3/account/whoami'))
			.status;
	}

	return {
		url,
		registerUser,
		login,
		request,
		createDirectRoom,
		sendText,
		messagesFrom,
		waitForMessage,
		pendingInvites,
		joinRoom,
		joinedMembers,
		waitForMember,
		displayName,
		renameUserAsAdmin,
		whoami,
		logs: async () => {
			// The log stream follows the container and never ends: read what is there, then let go
			const stream = await started.logs();
			const chunks: string[] = [];
			await new Promise<void>((resolve) => {
				const done = (): void => {
					clearTimeout(timer);
					stream.destroy();
					resolve();
				};
				const timer = setTimeout(done, 1500);
				stream.on('data', (chunk: Buffer | string) => {
					chunks.push(String(chunk));
				});
				stream.on('end', done);
				stream.on('error', done);
			});
			return chunks.join('');
		},
		stop: async () => {
			await started.stop();
		}
	};
}
