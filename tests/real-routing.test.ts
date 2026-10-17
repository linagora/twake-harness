import { describe, expect, it } from 'vitest';

import {
	laneOf,
	READ_THRESHOLD,
	REFUSE_THRESHOLD,
	readProbabilities,
	routeRequest,
	WRITE_THRESHOLD
} from '../src/agent/route.js';
import { ROUTING_CAPABILITIES, ROUTING_CASES } from './fixtures/routing-cases.js';

const upstream = process.env['LLM_UPSTREAM_URL'];
const key = process.env['LLM_DECISION_UPSTREAM_KEY'];
const model = process.env['LLM_DECISION_MODEL'];

// How many messages are sorted at once
const AT_ONCE = 6;

interface Sorted {
	readonly message: string;
	readonly asks: readonly string[];
	readonly given: ReadonlyMap<string, number>;
	readonly ms: number;
}

async function sort(message: string, asks: readonly string[]): Promise<Sorted> {
	const started = Date.now();
	const res = await fetch(upstream ?? '', {
		method: 'POST',
		headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
		body: JSON.stringify({ model, messages: routeRequest(ROUTING_CAPABILITIES, [], message) })
	});
	const body = (await res.json()) as { choices?: { message: { content: string | null } }[] };
	const given = readProbabilities(body.choices?.[0]?.message.content ?? null);
	if (given === null) throw new Error(`no decision for "${message}": HTTP ${res.status}`);
	return { message, asks, given, ms: Date.now() - started };
}

const share = (part: number, whole: number): number =>
	whole === 0 ? 1 : Math.round((part / whole) * 1000) / 1000;

// The decision model against a set of messages whose capabilities are known: what it names
// rightly, what it names for nothing and what it misses, apart for what reads and what acts,
// since a write named for nothing is the costly mistake
describe.skipIf(upstream === undefined || key === undefined || model === undefined)(
	'the decision model that tells what a message asks for',
	() => {
		it('names the capabilities of a set of known messages', { timeout: 600_000 }, async () => {
			const sorted: Sorted[] = [];
			for (let i = 0; i < ROUTING_CASES.length; i += AT_ONCE) {
				const batch = ROUTING_CASES.slice(i, i + AT_ONCE);
				sorted.push(...(await Promise.all(batch.map(([message, asks]) => sort(message, asks)))));
			}
			const count = { read: { hit: 0, miss: 0, extra: 0 }, write: { hit: 0, miss: 0, extra: 0 } };
			const mistakes: string[] = [];
			let lowestWriteAsked = 1;
			let highestWriteNotAsked = 0;
			let decisions = 0;
			let right = 0;
			for (const { message, asks, given } of sorted) {
				for (const capability of ROUTING_CAPABILITIES) {
					const probability = given.get(capability.name) ?? 0;
					const named = probability >= (capability.acts ? WRITE_THRESHOLD : READ_THRESHOLD);
					const asked = asks.includes(capability.name);
					const kind = count[capability.acts ? 'write' : 'read'];
					decisions += 1;
					if (named === asked) right += 1;
					if (named && asked) kind.hit += 1;
					if (!named && asked) kind.miss += 1;
					if (named && !asked) kind.extra += 1;
					if (capability.acts && asked) lowestWriteAsked = Math.min(lowestWriteAsked, probability);
					if (capability.acts && !asked) {
						highestWriteNotAsked = Math.max(highestWriteNotAsked, probability);
					}
					if (named !== asked) {
						mistakes.push(
							`${named ? 'extra' : 'missed'} ${capability.name} ${probability.toFixed(2)} | ${message}`
						);
					}
				}
			}
			// The lane each message is sent into, against the one its capabilities call for
			const lanes = { right: 0, unsure: [] as string[], wrong: [] as string[] };
			for (const { message, asks, given } of sorted) {
				const wanted = asks.some((name) => ROUTING_CAPABILITIES.find((c) => c.name === name)?.acts)
					? 'act'
					: asks.length > 0
						? 'consult'
						: 'discuss';
				const { lane } = laneOf(given, ROUTING_CAPABILITIES);
				if (lane === wanted) lanes.right += 1;
				else if (lane === 'unsure') {
					// With the writes that made it so, and how likely the message asks for each
					const doubts = ROUTING_CAPABILITIES.filter(
						(c) =>
							c.acts &&
							(given.get(c.name) ?? 0) >= REFUSE_THRESHOLD &&
							(given.get(c.name) ?? 0) < WRITE_THRESHOLD
					).map((c) => `${c.name} ${(given.get(c.name) ?? 0).toFixed(2)}`);
					lanes.unsure.push(`${wanted} | ${doubts.join(', ')} | ${message}`);
				} else lanes.wrong.push(`${wanted} sent to ${lane} | ${message}`);
			}
			const times = sorted.map((one) => one.ms).sort((a, b) => a - b);
			const report = {
				messages: sorted.length,
				decisions,
				accuracy: share(right, decisions),
				writes: {
					...count.write,
					precision: share(count.write.hit, count.write.hit + count.write.extra),
					recall: share(count.write.hit, count.write.hit + count.write.miss),
					lowestAsked: Number(lowestWriteAsked.toFixed(2)),
					highestNotAsked: Number(highestWriteNotAsked.toFixed(2))
				},
				reads: {
					...count.read,
					precision: share(count.read.hit, count.read.hit + count.read.extra),
					recall: share(count.read.hit, count.read.hit + count.read.miss)
				},
				lanes,
				msMedian: times[Math.floor(times.length / 2)],
				msMax: times.at(-1),
				mistakes
			};
			process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
			expect(report.accuracy).toBeGreaterThanOrEqual(0.9);
			// A message sent into a lane that cannot do what it asks is the mistake that costs
			expect(lanes.wrong.length / sorted.length).toBeLessThanOrEqual(0.05);
		});
	}
);
