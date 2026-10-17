# Development

## Stack and conventions

Aligned with `twake-workplace-common-settings` wherever it has an opinion: TypeScript in strict mode as ES modules, npm, Vitest, Drizzle with postgres.js, zod, ESLint flat config and Prettier with tabs. A turn is a LangGraph graph, with `@langchain/langgraph` and no LangChain model package: the model is still called through the harness's own client, behind APISIX. The HTTP layer is Fastify: common-settings is a SvelteKit application and carries no backend framework, Fastify is the server already used in Twake backends, and its pino logger writes the JSON lines with a request id that the spec requires. Node 24.

Code follows the Twake JavaScript and TypeScript conventions: named exports only, explicit types on exported symbols, `unknown` for external data, no enums, `#` for private members, comments only for business reasons.

## Develop

```sh
docker compose up -d postgres
npm ci
npm test
npm run lint
npm run typecheck
```

Tests drive the service through its HTTP boundary against the real PostgreSQL of the compose file, as a non-superuser role so that row-level security applies, and mint identities with a local signer.

`npm run test:real` plays the messages of `tests/fixtures/routing-cases.ts` against a real decision model and checks that it still routes them as the bounds of `src/agent/route.ts` expect: set `LLM_UPSTREAM_URL` to an OpenAI-compatible chat completions endpoint, `LLM_DECISION_MODEL` to the decision model and `LLM_DECISION_UPSTREAM_KEY` to its key. The bounds were set on these messages, so it catches a regression, not how well they hold on other messages. Without `LLM_UPSTREAM_URL` the test is skipped, as in `npm test` and in CI.

## Replaying against dev

`npm run test:dev` replays the prototype's black-box checks (identity, default rights, memory and session isolation, identity override, two users at once) against a deployed harness through its gateway, with no database or container: set `HARNESS_BASE_URL` to the api route (for instance `https://apisix.dev.twake.lin-saas.com/agents`) and `HARNESS_TOKEN_A` and `HARNESS_TOKEN_B` to the access tokens of two users carrying the `twake-harness` audience. The results land in `dev-results/vitest.json`, to keep with the pilot. Without those variables the suite is skipped.
