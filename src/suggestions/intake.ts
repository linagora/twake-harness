import type { FastifyBaseLogger } from 'fastify';

import { findAssistant } from '../assistants/repository.js';
import type { Config } from '../config.js';
import { withPrincipal, type Db } from '../db/client.js';
import { enqueueJob } from '../jobs/queue.js';
import { principalOfMatrixUser } from '../principals/identity.js';
import { suggestGroup, type Quoted, type SuggestPayload } from './job.js';
import { mayArrangeMeeting } from './prefilter.js';
import { readSettings } from './repository.js';

// A message stays context for the next one for this long; it lives in this process's memory only,
// and goes once that time is over, whether a next one came or not
const CONTEXT_TTL_MS = 15 * 60 * 1000;
const MAX_ROOMS_IN_MEMORY = 2000;
// How often the messages held past their time are looked for
const SWEEP_INTERVAL_MS = 60 * 1000;

interface Remembered extends Quoted {
	readonly eventId: string;
	readonly at: number;
}

export interface ChannelMessage {
	readonly sender: string;
	readonly eventId: string;
	readonly text: string;
}

export interface SuggestionIntake {
	// The listener left a room, or an assistant stopped reading it for its owner: the last message
	// held of it is dropped, for that owner or, without one, for all
	forget(roomId: string, owner?: string): void;
	// A clear message of a channel the listener is in; with `onlyFor`, a message of an encrypted
	// room whose owner invited their assistant, which proposes to that owner alone
	onMessage(roomId: string, message: ChannelMessage, onlyFor?: string): Promise<void>;
	// The role stops: what is held goes, and nothing is looked for any more
	stop(): void;
}

export interface IntakeDeps {
	readonly config: Config;
	readonly db: Db;
	readonly log: FastifyBaseLogger;
	readonly now?: () => number;
}

// The messages of the channels the listener was invited to come to the matrix role, and of no
// other room but the assistants' and the creator's. A message is looked at for the time it takes
// to decide, the last one of each room is held in memory as
// context for the next, and a job per member who may be offered something carries the quotes.
export function makeSuggestionIntake(deps: IntakeDeps): SuggestionIntake {
	const { config, db, log } = deps;
	const now = deps.now ?? Date.now;
	// Oldest first, as a message held again goes last
	// Under the room, or the room and its owner where an assistant reads for them: each owner of a
	// room has the same context
	const recent = new Map<string, Remembered>();
	const keyOf = (roomId: string, owner?: string): string =>
		owner === undefined ? roomId : `${roomId}\n${owner}`;
	function remember(key: string, message: Remembered): void {
		recent.delete(key);
		recent.set(key, message);
		if (recent.size > MAX_ROOMS_IN_MEMORY) {
			const oldest = recent.keys().next();
			if (oldest.done !== true) recent.delete(oldest.value);
		}
	}
	function sweep(): void {
		const end = now() - CONTEXT_TTL_MS;
		for (const [key, message] of recent) {
			if (message.at > end) return;
			recent.delete(key);
		}
	}
	const sweeping = setInterval(sweep, SWEEP_INTERVAL_MS);
	sweeping.unref();

	async function enabled(owner: string): Promise<boolean> {
		return (await withPrincipal(db, { id: owner }, (tx) => readSettings(tx, owner))).enabled;
	}

	async function hasAssistant(owner: string): Promise<boolean> {
		const assistant = await withPrincipal(db, { id: owner }, (tx) => findAssistant(tx, owner));
		return assistant !== null && assistant.deletedAt === null;
	}

	return {
		forget(roomId, owner) {
			if (owner !== undefined) recent.delete(keyOf(roomId, owner));
			else {
				for (const key of recent.keys()) {
					if (key === roomId || key.startsWith(`${roomId}\n`)) recent.delete(key);
				}
			}
		},
		stop() {
			clearInterval(sweeping);
			recent.clear();
		},
		async onMessage(roomId, message, onlyFor) {
			if (!config.suggestions.enabled) return;
			sweep();
			const sender = principalOfMatrixUser(config, message.sender);
			if (sender === null) return;
			const current: Remembered = {
				author: message.sender,
				email: sender,
				text: message.text.slice(0, 600),
				eventId: message.eventId,
				at: now()
			};
			const key = keyOf(roomId, onlyFor);
			const previous = recent.get(key);
			remember(key, current);
			if (!mayArrangeMeeting(message.text)) return;
			// Whoever turned suggestions off is not read: not as the message that starts one, nor as its context
			if (!(await enabled(sender))) {
				log.info({ roomId, eventId: message.eventId, reason: 'opted_out' }, 'channel ignored');
				return;
			}
			let context: Remembered | null =
				previous !== undefined &&
				previous.eventId !== message.eventId &&
				now() - previous.at <= CONTEXT_TTL_MS
					? previous
					: null;
			if (context !== null && context.email !== sender && !(await enabled(context.email))) {
				context = null;
			}
			const quoted: Quoted[] = [context, current]
				.filter((item): item is Remembered => item !== null)
				.map(({ author, email, text }) => ({ author, email, text }));
			// The conversation pair: whoever wrote the message and whoever wrote the one before; the
			// owner alone where they invited their assistant, the other member having asked nothing
			const owners = onlyFor === undefined ? [...new Set(quoted.map((q) => q.email))] : [onlyFor];
			let queued = 0;
			for (const owner of owners) {
				if (!(await hasAssistant(owner))) continue;
				const payload: SuggestPayload = {
					owner,
					roomId,
					eventId: message.eventId,
					at: now(),
					quoted
				};
				const added = await enqueueJob(db, {
					kind: 'suggest',
					payload,
					dedupKey: `suggest:${message.eventId}:${owner}`,
					groupKey: suggestGroup(owner)
				});
				if (added) queued += 1;
			}
			log.info(
				{ roomId, eventId: message.eventId, candidates: owners.length, queued },
				'suggestions queued'
			);
		}
	};
}
