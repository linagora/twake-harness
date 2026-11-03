import { describe, expect, it } from 'vitest';

import { withoutAnyCallMarkup, withoutCallMarkup } from '../src/agent/call-markup.js';

const CALL = '{"name": "consents_list", "arguments": {}}';
const BLOCK = `<tool_call>\n${CALL}\n</tool_call>`;

describe('the words of a text that ends on a call written in it', () => {
	it('are what comes before the call, in its tags, open or closed, or in JSON', () => {
		expect(withoutCallMarkup(`Here is what I found.\n${BLOCK}`)).toBe('Here is what I found.');
		expect(withoutCallMarkup(`Here is what I found.\n<tool_call>\n{"name": "consents_li`)).toBe(
			'Here is what I found.'
		);
		expect(withoutCallMarkup(`Here is what I found.\n${CALL}`)).toBe('Here is what I found.');
		expect(withoutCallMarkup(`Here is the call:\n\`\`\`json\n${CALL}\n\`\`\``)).toBe(
			'Here is the call:'
		);
		expect(
			withoutCallMarkup(
				'Here is what I found.\n{\n  "name": "consents_list",\n  "arguments": {}\n}'
			)
		).toBe('Here is what I found.');
		expect(withoutCallMarkup(`Two calls.\n${BLOCK}\n<function_call>${CALL}</function_call>`)).toBe(
			'Two calls.'
		);
	});

	it('are what comes before a call cut short in its tags, or whose opening tag was lost', () => {
		expect(
			withoutCallMarkup(
				'Here is what I found.\n<tool_call>\n<function=calendar_list>\n<parameter=day>\n2026-11-04'
			)
		).toBe('Here is what I found.');
		expect(
			withoutCallMarkup(`Here is what I found.\n<tool_calls>\n${BLOCK}\n<tool_call>\n{"name": "con`)
		).toBe('Here is what I found.');
		expect(withoutCallMarkup(`Here is what I found.\n${CALL}\n</tool_call>`)).toBe(
			'Here is what I found.'
		);
	});

	it('are nothing when the text holds nothing else', () => {
		expect(withoutCallMarkup(BLOCK)).toBe('');
		expect(withoutCallMarkup(CALL)).toBe('');
		expect(withoutCallMarkup(`[${CALL}]`)).toBe('');
		expect(
			withoutCallMarkup(
				'```json\n[{"type": "function", "function": {"name": "consents_list", "arguments": "{}"}}]\n```'
			)
		).toBe('');
	});

	it('keep a tag or a call the model speaks of among its words', () => {
		const explained = 'Use the <tool_call> tag to ask for a tool, then wait for its result.';
		expect(withoutCallMarkup(explained)).toBe(explained);
		const shown = `A call looks like this:\n\`\`\`json\n${CALL}\n\`\`\`\nThe harness runs it.`;
		expect(withoutCallMarkup(shown)).toBe(shown);
		expect(withoutCallMarkup(`I use <tool_call> tags. Done.\n${BLOCK}`)).toBe(
			'I use <tool_call> tags. Done.'
		);
		expect(
			withoutCallMarkup('I use <tool_call> tags. Done.\n<tool_call>\n{"name": "consents_li')
		).toBe('I use <tool_call> tags. Done.');
		const data = 'Your contacts:\n{"name":"Alice","parameters":{"age":3}}\nand that is all.';
		expect(withoutCallMarkup(data)).toBe(data);
		const named = 'The <tool_call> and </tool_call> tags wrap a call.';
		expect(withoutCallMarkup(named)).toBe(named);
		const namedLast = 'Qwen writes a call between <tool_call> and </tool_call>';
		expect(withoutCallMarkup(namedLast)).toBe(namedLast);
	});

	it('leave out a block of tags that holds a call wherever it stands, and keep the words around it', () => {
		expect(withoutCallMarkup(`First.\n${BLOCK}\nThen more words.`)).toBe(
			'First.\n\nThen more words.'
		);
		const wrapped = `<tool_calls>\n${BLOCK}\n${BLOCK}\n</tool_calls>`;
		expect(withoutCallMarkup(`Here is what I found.\n${wrapped}`)).toBe('Here is what I found.');
		expect(withoutCallMarkup(`${wrapped}\nThen more words.`)).toBe('Then more words.');
		const tagged =
			'<tool_call>\n<function=calendar_list>\n<parameter=day>\n2026-11-04\n</parameter>\n</function>\n</tool_call>';
		expect(withoutCallMarkup(`I look.\n${tagged}\nThere.`)).toBe('I look.\n\nThere.');
		expect(withoutCallMarkup(`I use <tool_call> tags.\n${BLOCK}\nDone.`)).toBe(
			'I use <tool_call> tags.\n\nDone.'
		);
	});

	it('keep what ends the text but is no call', () => {
		for (const tail of ['[]', '{"arguments": {}}', '{"function": "x"}', '{not json}', '{}']) {
			expect(withoutCallMarkup(`Done.\n${tail}`)).toBe(`Done.\n${tail}`);
		}
	});

	it('are found in one pass from the end, whatever the number of calls', () => {
		// Read block after block from the start, 8000 of them took seconds
		const long = `Words first.\n${Array.from({ length: 8000 }, () => BLOCK).join('\n')}`;
		const started = performance.now();
		expect(withoutCallMarkup(long)).toBe('Words first.');
		expect(performance.now() - started).toBeLessThan(1000);
	});

	it('are found in one pass, whatever the number of tags left unclosed', () => {
		// Each tag read to the end of the text for its >, 20,000 of them took seconds
		const unclosed = `Words first. ${'<tool_call '.repeat(20_000)}`;
		const started = performance.now();
		expect(withoutCallMarkup(unclosed)).toBe(unclosed.trim());
		expect(withoutAnyCallMarkup(unclosed)).toBe(unclosed.trim());
		expect(performance.now() - started).toBeLessThan(1000);
	});

	it('are found in one pass from the end, whatever the number of calls in JSON', () => {
		// A model that loops on one call writes it over and over: 8000 of them took more than a second
		const long = `Words first.\n${Array.from({ length: 8000 }, () => CALL).join('\n')}`;
		const started = performance.now();
		expect(withoutCallMarkup(long)).toBe('Words first.');
		expect(performance.now() - started).toBeLessThan(1000);
	});

	it('are the whole text when it holds no call', () => {
		expect(withoutCallMarkup('  Plain words.\n')).toBe('Plain words.');
		expect(withoutCallMarkup('')).toBe('');
	});

	it('are read whatever the letters, one whose lower case is longer included', () => {
		// « İ » is two characters in lower case
		expect(withoutCallMarkup('Rendez-vous à İstanbul.')).toBe('Rendez-vous à İstanbul.');
		expect(withoutCallMarkup(`Rendez-vous à İstanbul.\n${BLOCK}`)).toBe('Rendez-vous à İstanbul.');
	});
});

describe('the words of a text that may hold no call at all, as a brief', () => {
	it('are what stands outside every block of tags, wherever it stands', () => {
		expect(withoutAnyCallMarkup(`First.\n${BLOCK}\nLast.\n${BLOCK}`)).toBe('First.\n\nLast.');
		const many = `First.\n${Array.from({ length: 5000 }, () => BLOCK).join('\n')}\nLast.`;
		expect(withoutAnyCallMarkup(many)).toBe('First.\n\nLast.');
		const wrapped = `<tool_calls>\n${BLOCK}\n${BLOCK}\n</tool_calls>`;
		expect(withoutAnyCallMarkup(`First.\n${wrapped}\nLast.`)).toBe('First.\n\nLast.');
	});
});
