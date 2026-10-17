import { describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.js';

describe('the settings of the suggestions', () => {
	const base = {
		HARNESS_ROLE: 'api',
		DATABASE_URL: 'postgres://x@localhost/x',
		AUTH_JWKS_URL: 'https://example.test/jwks',
		AUTH_ISSUER: 'https://example.test/',
		AUTH_AUDIENCE: 'twake-harness',
		APISIX_BASE_URL: 'http://apisix.test',
		APISIX_CONSUMER_KEY: 'k'
	};

	it('are off unless the deployment turns them on', () => {
		expect(loadConfig(base).suggestions.enabled).toBe(false);
		expect(loadConfig({ ...base, SUGGESTIONS_ENABLED: 'true' }).suggestions.enabled).toBe(true);
	});

	it('refuse, at startup, a listener the namespace would take for the creator or an assistant', () => {
		for (const localpart of ['twake-space-assistant', 'twake-space-assistant-listener']) {
			expect(() =>
				loadConfig({
					...base,
					SUGGESTIONS_ENABLED: 'true',
					SUGGESTIONS_USER_LOCALPART: localpart
				})
			).toThrow(
				'invalid configuration: SUGGESTIONS_USER_LOCALPART must not be MATRIX_SENDER_LOCALPART nor start with twake-space-assistant-'
			);
		}
		// Off, the listener is never registered: its name stops no start
		expect(
			loadConfig({ ...base, SUGGESTIONS_USER_LOCALPART: 'twake-space-assistant' }).suggestions
				.enabled
		).toBe(false);
	});

	it('refuse a Space address that is no URL, or that has no token', () => {
		expect(() => loadConfig({ ...base, SPACE_API_URL: 'not a url', SPACE_API_TOKEN: 't' })).toThrow(
			'invalid configuration: SPACE_API_URL is not a URL'
		);
		expect(() => loadConfig({ ...base, SPACE_API_URL: 'https://space.test/api' })).toThrow(
			'invalid configuration: SPACE_API_URL needs SPACE_API_TOKEN'
		);
		expect(loadConfig(base).suggestions.space).toBeNull();
	});

	it('read the audiences that may answer a call as a list, and none unless given', () => {
		expect(
			loadConfig({ ...base, AUTH_ANSWER_AUDIENCES: ' twakespace, ,other-buttons ' }).auth
				.answerAudiences
		).toEqual(['twakespace', 'other-buttons']);
		expect(loadConfig(base).auth.answerAudiences).toEqual([]);
		expect(loadConfig(base).auth.audience).toBe('twake-harness');
	});
});

describe('the tracing of a turn', () => {
	it('refuses, at startup, to send the turns to LangSmith', () => {
		const base = {
			HARNESS_ROLE: 'api',
			DATABASE_URL: 'postgres://x@localhost/x',
			AUTH_JWKS_URL: 'https://example.test/jwks',
			AUTH_ISSUER: 'https://example.test/',
			AUTH_AUDIENCE: 'twake-harness',
			APISIX_BASE_URL: 'http://apisix.test',
			APISIX_CONSUMER_KEY: 'k'
		};
		expect(() => loadConfig({ ...base, LANGSMITH_TRACING: 'true' })).toThrow(/LANGSMITH_TRACING/);
		expect(() => loadConfig({ ...base, LANGCHAIN_TRACING_V2: 'true' })).toThrow(
			/LANGCHAIN_TRACING_V2/
		);
		expect(() => loadConfig({ ...base, LANGSMITH_TRACING: 'false' })).not.toThrow();
	});
});
