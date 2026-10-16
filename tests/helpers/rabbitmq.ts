import { RabbitMQContainer, type StartedRabbitMQContainer } from '@testcontainers/rabbitmq';
import { connect, type ChannelModel, type ConfirmChannel } from 'amqplib';
import { startPulling } from './containers.js';

// The broker of the platform, RabbitMQ 3.13 as on dev, from Google's public mirror of Docker Hub:
// anonymous pulls from Docker Hub hit its rate limit on the organization's runners
const IMAGE = process.env['RABBITMQ_IMAGE'] ?? 'mirror.gcr.io/library/rabbitmq:3.13';

// Twice the tick of a quorum queue, on which the broker counts the queue's messages
const COUNTED_WITHIN_MS = 10_000;

// What a user may do on a vhost, each a regular expression over the names of exchanges and queues
export interface Permissions {
	readonly configure: string;
	readonly write: string;
	readonly read: string;
}

// An exchange routing to a queue, and the key it routes on
export interface Binding {
	readonly source: string;
	readonly routingKey: string;
}

export interface QueueState {
	readonly type: string;
	readonly arguments: Readonly<Record<string, unknown>>;
	// Ready and unacknowledged
	readonly messages: number;
}

// The broker, as the platform runs it: the default vhost, where the activity exchange is, and the
// vhosts it creates for an application such as Calendar. What reads a vhost reads the default one
// unless told otherwise.
export interface TestBroker {
	// The platform's own channel on the default vhost, with every right: what sets the broker up and
	// publishes on it
	readonly channel: ConfirmChannel;
	// The address of the broker for one of its users
	urlFor(user: string, password: string, vhost?: string): string;
	// Where the broker takes AMQP connections now: a restart may move it
	address(): { readonly host: string; readonly port: number };
	// Creates a user, who may do this much on the default vhost
	addUser(user: string, password: string, permissions: Permissions): Promise<void>;
	// Creates a vhost, which the platform's own user may do everything on, and resolves to the
	// platform's channel there
	addVhost(name: string): Promise<ConfirmChannel>;
	// Lets a user do this much on another vhost
	allow(user: string, vhost: string, permissions: Permissions): Promise<void>;
	// What routes to a queue, but the default exchange, which routes to every queue by its name
	bindingsOf(queue: string, vhost?: string): Promise<Binding[]>;
	queue(name: string, vhost?: string): Promise<QueueState | null>;
	// Resolves once the broker counts that many messages in a queue. It counts those of a quorum
	// queue on the queue's tick, every five seconds, so a message settled a moment ago may still be
	// counted; and a dead letter until its dead letter queue takes it, so once a quorum queue is
	// counted empty, its dead letter queue holds every message dead-lettered from it.
	waitForMessages(name: string, count: number, vhost?: string): Promise<void>;
	// How many messages each consumer of a queue may hold unacknowledged
	prefetchOf(queue: string, vhost?: string): Promise<number[]>;
	// The user of each connection open, one entry per connection: on every vhost unless one is named
	connectedUsers(vhost?: string): Promise<string[]>;
	// Closes every connection of a user, as the broker does when a node goes down
	closeConnectionsOf(user: string): Promise<void>;
	// Publishes as an application does, persistent and under its id, once the broker took it
	publish(exchange: string, routingKey: string, body: unknown, messageId?: string): Promise<void>;
	// Moves every message of a queue to another, as an operator replays a dead letter queue once
	// its cause is fixed, with a shovel or the management UI: through the default exchange, under
	// the name of the queue it goes to. Resolves to how many it moved.
	replay(from: string, to: string): Promise<number>;
	// Restarts the broker as a rolling upgrade does, letting it stop on its own, which drops every
	// connection and may move its address, then opens the platform's own channel again; the other
	// vhosts' channels stay closed. Killed instead, a broker can lose a quorum queue declared a
	// moment before, which then never elects a leader again.
	restart(): Promise<void>;
	stop(): Promise<void>;
}

// The platform's own connection: a broker that goes down closes it with an error, which nobody
// handles but the test that took the broker down
async function connectAsPlatform(url: string): Promise<ChannelModel> {
	const connection = await connect(url);
	connection.on('error', () => undefined);
	return connection;
}

export interface TestBrokerOptions {
	// The consumer timeout of the broker, past which it takes a message back from a consumer that
	// holds it unacknowledged, its default half an hour unless set; set, the broker checks it
	// every second rather than every minute
	readonly consumerTimeoutMs?: number;
}

export async function startTestBroker(options: TestBrokerOptions = {}): Promise<TestBroker> {
	const image = new RabbitMQContainer(IMAGE);
	if (options.consumerTimeoutMs !== undefined) {
		image
			.withCopyContentToContainer([
				{
					content: `consumer_timeout = ${options.consumerTimeoutMs}\n`,
					target: '/etc/rabbitmq/conf.d/90-consumer-timeout.conf'
				}
			])
			// Not a setting of rabbitmq.conf: the check of the consumer timeout runs on this tick
			.withEnvironment({
				RABBITMQ_SERVER_ADDITIONAL_ERL_ARGS: '-rabbit channel_tick_interval 1000'
			});
	}
	const container: StartedRabbitMQContainer = await startPulling(image);
	let admin: ChannelModel = await connectAsPlatform(container.getAmqpUrl());
	let channel = await admin.createConfirmChannel();
	// The platform's own connections to the other vhosts, closed with the broker
	const vhosts: ChannelModel[] = [];

	async function rabbitmqctl(...args: string[]): Promise<string> {
		const result = await container.exec(['rabbitmqctl', '-q', ...args]);
		if (result.exitCode !== 0) {
			throw new Error(`rabbitmqctl ${args.join(' ')} failed: ${result.output}`);
		}
		return result.stdout;
	}

	async function listed<T>(...args: string[]): Promise<T[]> {
		return JSON.parse(await rabbitmqctl(...args, '--formatter', 'json')) as T[];
	}

	// The address of the broker for one of its users, on the default vhost or on another one
	function urlOn(vhost: string, user: string, password: string): string {
		const path = vhost === '/' ? '' : `/${encodeURIComponent(vhost)}`;
		return `amqp://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${container.getHost()}:${container.getMappedPort(5672)}${path}`;
	}

	async function allowOn(vhost: string, user: string, permissions: Permissions): Promise<void> {
		await rabbitmqctl(
			'set_permissions',
			'-p',
			vhost,
			user,
			permissions.configure,
			permissions.write,
			permissions.read
		);
	}

	async function bindingsOn(vhost: string, queue: string): Promise<Binding[]> {
		const rows = await listed<{
			source_name: string;
			destination_name: string;
			routing_key: string;
		}>('list_bindings', '-p', vhost, 'source_name', 'destination_name', 'routing_key');
		return rows
			.filter((row) => row.destination_name === queue && row.source_name !== '')
			.map((row) => ({ source: row.source_name, routingKey: row.routing_key }));
	}

	async function queueOn(vhost: string, name: string): Promise<QueueState | null> {
		const rows = await listed<{
			name: string;
			type: string;
			arguments: [string, string, unknown][];
			messages: number;
		}>('list_queues', '-p', vhost, 'name', 'type', 'arguments', 'messages');
		const row = rows.find((candidate) => candidate.name === name);
		if (row === undefined) return null;
		return {
			type: row.type,
			arguments: Object.fromEntries(row.arguments.map(([key, , value]) => [key, value])),
			messages: row.messages
		};
	}

	// Resolves once the broker counts that many messages in a queue of a vhost
	async function messagesOn(vhost: string, name: string, count: number): Promise<void> {
		const deadline = Date.now() + COUNTED_WITHIN_MS;
		let counted = (await queueOn(vhost, name))?.messages;
		while (counted !== count && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 250));
			counted = (await queueOn(vhost, name))?.messages;
		}
		if (counted === undefined) throw new Error(`the broker has no queue ${name}`);
		if (counted !== count) {
			throw new Error(
				`the broker still counts ${counted} messages in ${name} after ${COUNTED_WITHIN_MS / 1000} s, not ${count}`
			);
		}
	}

	async function prefetchOn(vhost: string, queue: string): Promise<number[]> {
		return (
			await listed<{ queue_name: string; prefetch_count: number }>(
				'list_consumers',
				'-p',
				vhost,
				'queue_name',
				'prefetch_count'
			)
		)
			.filter((row) => row.queue_name === queue)
			.map((row) => row.prefetch_count);
	}

	// Every connection open on the broker, by its user and its vhost
	async function openConnections(): Promise<{ user: string; vhost: string }[]> {
		return listed<{ user: string; vhost: string }>('list_connections', 'user', 'vhost');
	}

	return {
		get channel() {
			return channel;
		},
		urlFor: (user, password, vhost = '/') => urlOn(vhost, user, password),
		address: () => ({ host: container.getHost(), port: container.getMappedPort(5672) }),
		addUser: async (user, password, permissions) => {
			await rabbitmqctl('add_user', user, password);
			await allowOn('/', user, permissions);
		},
		allow: (user, vhost, permissions) => allowOn(vhost, user, permissions),
		bindingsOf: (queue, vhost = '/') => bindingsOn(vhost, queue),
		queue: (name, vhost = '/') => queueOn(vhost, name),
		waitForMessages: (name, count, vhost = '/') => messagesOn(vhost, name, count),
		prefetchOf: (queue, vhost = '/') => prefetchOn(vhost, queue),
		connectedUsers: async (vhost) =>
			(await openConnections())
				.filter((row) => vhost === undefined || row.vhost === vhost)
				.map((row) => row.user),
		closeConnectionsOf: async (user) => {
			await rabbitmqctl('close_all_user_connections', user, 'closed by the test');
		},
		publish: async (exchange, routingKey, body, messageId) => {
			channel.publish(exchange, routingKey, Buffer.from(JSON.stringify(body)), {
				persistent: true,
				contentType: 'application/cloudevents+json',
				...(messageId === undefined ? {} : { messageId })
			});
			await channel.waitForConfirms();
		},
		addVhost: async (name) => {
			await rabbitmqctl('add_vhost', name);
			// The default user the platform's channel connects as, which a new vhost grants nothing
			await allowOn(name, 'guest', { configure: '.*', write: '.*', read: '.*' });
			const connection = await connectAsPlatform(urlOn(name, 'guest', 'guest'));
			vhosts.push(connection);
			return connection.createConfirmChannel();
		},
		replay: async (from, to) => {
			for (let moved = 0; ; moved += 1) {
				const message = await channel.get(from, { noAck: false });
				if (message === false) return moved;
				const { messageId, contentType, headers } = message.properties;
				channel.sendToQueue(to, message.content, {
					persistent: true,
					messageId,
					contentType,
					headers
				});
				await channel.waitForConfirms();
				channel.ack(message);
			}
		},
		restart: async () => {
			await container.restart({ timeout: 30_000 });
			admin = await connectAsPlatform(container.getAmqpUrl());
			channel = await admin.createConfirmChannel();
		},
		stop: async () => {
			// A restart closed those it found open
			for (const connection of vhosts) await connection.close().catch(() => undefined);
			await channel.close();
			await admin.close();
			await container.stop();
		}
	};
}
