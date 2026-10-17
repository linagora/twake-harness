import { describe, expect, it } from 'vitest';

import { meetingRequest, readMeeting } from '../src/suggestions/sort.js';

describe('what a decision model is asked of the messages of a channel', () => {
	const quoted = [
		{ author: '@bob:test.local', email: 'bob@test.local', text: 'On voit ça lundi à 8h ?' },
		{ author: '@alice:test.local', email: 'alice@test.local', text: 'Ok, lundi 8h.' },
		{ author: '@bob:test.local', email: 'bob@test.local', text: 'Parfait.' }
	];

	it('is the messages in their order, each author a letter, and one typed question', () => {
		const [message] = meetingRequest(quoted);
		const asked = JSON.parse(message?.content ?? '{}') as {
			state: string;
			questions: { meeting: { type: string; instructions: string } };
		};
		expect(asked.state).toBe(
			'Messages of a conversation between people:\nA: On voit ça lundi à 8h ?\nB: Ok, lundi 8h.\nA: Parfait.'
		);
		expect(asked.questions.meeting.type).toBe('noul');
		expect(asked.questions.meeting.instructions).toMatch(/given day or time, or to move a meeting/);
	});

	it('names nobody: neither a Matrix identifier nor an address', () => {
		const sent = meetingRequest(quoted)[0]?.content ?? '';
		expect(sent).not.toMatch(/bob|alice|test\.local/);
	});

	it('reads the probability of the answer, and nothing from any other reply', () => {
		const reply = JSON.stringify({ answers: { meeting: { type: 'noul', noul: 0.91 } } });
		expect(readMeeting(reply)).toBe(0.91);
		expect(readMeeting('yes')).toBeNull();
		expect(readMeeting(null)).toBeNull();
		expect(readMeeting(JSON.stringify({ answers: {} }))).toBeNull();
		// A probability is between 0 and 1
		expect(readMeeting(JSON.stringify({ answers: { meeting: { noul: 3 } } }))).toBeNull();
		expect(readMeeting(JSON.stringify({ answers: { meeting: { noul: -1 } } }))).toBeNull();
	});
});
