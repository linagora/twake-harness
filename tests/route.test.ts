import { describe, expect, it } from 'vitest';

import { MAX_PLAN_STEPS } from '../src/agent/plan.js';
import { laneOf, type Capability } from '../src/agent/route.js';

const read = (name: string): Capability => ({ name, description: name, acts: false });
const write = (name: string): Capability => ({ name, description: name, acts: true });

describe('the lane of a message, from what the decision model read', () => {
	it('talks over a message that names nothing, and looks up one that names only reads', () => {
		const capabilities = [read('list_events'), write('create_event')];
		expect(laneOf(new Map(), capabilities)).toEqual({ lane: 'discuss', named: [] });
		expect(laneOf(new Map([['list_events', 0.9]]), capabilities).lane).toBe('consult');
	});

	it('acts on a write it names, and is unsure of one it neither names nor rules out', () => {
		const capabilities = [read('list_events'), write('create_event'), write('send_email')];
		const named = laneOf(
			new Map([
				['list_events', 0.9],
				['create_event', 0.9],
				['send_email', 0.4]
			]),
			capabilities
		);
		expect(named.lane).toBe('act');
		expect(named.named.map((capability) => capability.name)).toEqual([
			'list_events',
			'create_event'
		]);
		expect(laneOf(new Map([['send_email', 0.33]]), capabilities).lane).toBe('unsure');
		expect(laneOf(new Map([['send_email', 0.1]]), capabilities).lane).toBe('discuss');
	});

	it('keeps the likeliest past the most steps of a plan, a write among them', () => {
		const reads = Array.from({ length: MAX_PLAN_STEPS + 2 }, (_, i) => read(`read_${i}`));
		const capabilities = [...reads, write('create_event')];
		const given = new Map<string, number>([
			...reads.map((capability, i): [string, number] => [capability.name, 0.6 + i / 100]),
			['create_event', 0.95]
		]);
		const { lane, named } = laneOf(given, capabilities);
		expect(lane).toBe('act');
		expect(named).toHaveLength(MAX_PLAN_STEPS);
		expect(named.map((capability) => capability.name)).toContain('create_event');
		// The least likely reads are those left out
		expect(named.map((capability) => capability.name)).not.toContain('read_0');
	});
});
