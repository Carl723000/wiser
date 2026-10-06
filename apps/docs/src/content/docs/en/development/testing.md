---
title: Testing and definition of done
description: WISER Red-Green-Refactor loops, root verification scope, focused tests, integration smoke, fake-AI boundary, and completion criteria.
docType: workflow
scope: repository-testing
status: active
authoritative: true
owner: wiser
language: en
whenToUse:
  - when starting a behavior change, selecting verification commands, or preparing a commit
  - when changing databases, browser flows, observability, or Agent exercises
whenToUpdate:
  - when test scripts, CI gates, workspaces, or the definition of done change
checkPaths:
  - package.json
  - vitest.config.ts
  - apps/*/package.json
  - apps/*/vitest.config.ts
  - apps/*/playwright.config.ts
  - apps/*/playwright.*.config.ts
  - apps/*/e2e*/**
  - tests/toolchain/*browser*.spec.ts
  - tests/toolchain/candidate-backflow-fixture.spec.ts
  - tests/toolchain/a12-candidate-load-driver.spec.ts
  - tests/toolchain/a12-candidate-load-traversal.spec.ts
  - tests/toolchain/a12-candidate-load-runner.spec.ts
  - tests/toolchain/a12-candidate-original-http.spec.ts
  - tests/toolchain/a12-standard-intake-http.spec.ts
  - tests/toolchain/a12-candidate-inventory-collector.spec.ts
  - tests/toolchain/a12-standard-intake-collector.spec.ts
  - tests/toolchain/a12-standard-intake-http-combination.spec.ts
  - tests/toolchain/a12-normal-runtime-window.spec.ts
  - tests/toolchain/a12-native-runtime-observer.spec.ts
  - tests/toolchain/a12-platform-identity-http.spec.ts
  - scripts/data-foundation/**
  - infrastructure/observability/**
  - examples/agent-excon/**
  - .github/workflows/**
lastReviewedAt: 2026-10-06
lastReviewedCommit: f5fe0e3777dc211e9956fd3b63504e152c8c9ca0
---

## Red → Green → Refactor

A behavior change starts with a failing test that describes a user outcome, protocol guarantee, or domain invariant.

1. **Red:** write the smallest failing test, run it, and confirm it fails because the intended behavior is absent rather than because of a fixture, environment, or spelling error.
2. **Green:** implement the smallest change that passes the test, then run regressions at the same boundary.
3. **Refactor:** improve naming, duplication, and dependency direction while tests remain green and observable behavior stays unchanged.
4. **Integrate:** run the real database, browser, observability, or vertical smoke required by the change type.
5. **Document and commit:** update Chinese/English docs, run worktree Docpact before every commit and branch-wide lint against the merge base before handoff, and retain small recoverable Red/Green commits.

Tests should prefer public functions, HTTP, GraphQL, MCP, database policies, or visible UI. Do not substitute private-call counts for business outcomes. Reproduce a production defect with a regression test before fixing it.

Asynchronous map-replacement tests wait for the old instance to be removed and its replacement to exist before checking the camera and unchanged native input. Loading text disappearing is not a drawing-lifecycle barrier. Controlled responses and commit-phase observations can distinguish these conditions without changing production effects; focused checks and bounded repetition still require the combined verification gate before a Green milestone.

## Test layers

| Layer                     | Primary proof                                                                             | Default tool                                          |
| ------------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Pure domain and contracts | State transitions, scores, schemas, error codes, determinism                              | Vitest                                                |
| Application component     | Fastify routes, identity resolution, idempotency, adapter collaboration                   | Vitest + Fastify `inject()`                           |
| Database integration      | Migrations, constraints, RLS, runtime roles, locks, and transaction atomicity             | Local Supabase / Compose PostgreSQL                   |
| Browser                   | Chinese default, isomorphic English, themes, keyboard, responsiveness, and critical flows | Playwright Chromium                                   |
| Vertical smoke            | Real Auth, API, Worker, persistence, projections, MCP, and Web composition                | Repository operations scripts                         |
| Agent exercise            | Multiple RunAgents, Receipts, Barriers, revisions, and deterministic evaluation           | Scripted/rework cookbook                              |
| Online AI                 | Provider credentials and minimal call availability                                        | Explicit opt-in only; never a default test or CI gate |

## What `pnpm verify` actually covers

Run from the repository root:

```bash
pnpm verify
```

It performs, in order:

1. `prettier --check .` across the repository;
2. Fumadocs content generation followed by type-aware Oxlint;
3. TypeScript checks for every workspace that declares `typecheck`;
4. `pnpm test:coverage`, which executes the complete unit suite and enforces coverage in one Vitest projects run: app projects may run in parallel, while the root project named `repository` serializes `packages/**/*.spec.ts` and `tests/**/*.spec.ts`;
5. `pnpm test:ops`, which uses the Node test runner over `scripts/data-foundation/*.test.mjs` to verify operations orchestration, runtime roles, Supabase status parsing, and the vertical-smoke contract;
6. builds for every workspace that declares `build`;
7. `docker compose config --quiet` for the default Compose configuration.

`pnpm verify` does not start Docker services, reset or test Supabase, apply Data migrations, run `data:smoke`, or include Web/Docs Playwright, observability smoke, cookbooks, showcases, or any real AI call. Add the focused gates below whenever the change requires them.

## CI scheduling and completion

Documentation governance, workspace verification, reference browsers, Supabase, Data Foundation, and observability start independently on isolated runners. They consume no build artifact from the workspace job. Every existing check remains required by the delivery contract; `CI complete` waits for all six and fails on failure, cancellation, a skipped lane, or a missing result. Keep the existing required-check names when configuring branch protection; the aggregate is an additional check, not permission to omit a lane.

Use `pnpm verify` before pushing so local validation includes the same unit coverage ratchet as CI. Integration databases remain disposable and freshly migrated. Within each integration job, preserve setup, assertions, and unconditional cleanup order. Parallel scheduling changes when checks start, never what passing means.

### CI image and environment preparation

Data preparation preserves the sequential Chromium, fresh Supabase start/reset, and `pnpm data:up` flow. All migration, seed, service-health, parser, smoke, authenticated-browser, and PostgreSQL checks still run. Each job uses fresh databases and native Docker storage. Runtime credentials, database volumes, and smoke state are never cached.

## Focused Vitest and workspace commands

Use the narrowest command during development, then return to root verification before completion.

| Scope                            | Command                                                                               |
| -------------------------------- | ------------------------------------------------------------------------------------- |
| One root or package spec         | `pnpm exec vitest run <path-to-spec>`                                                 |
| Complete unit coverage           | `pnpm test:coverage`                                                                  |
| Data Foundation operations       | `pnpm test:ops`                                                                       |
| Agent EXCON contracts/core/infra | `pnpm exec vitest run packages/contracts/test packages/core/test packages/infra/test` |
| Platform contracts/auth          | `pnpm exec vitest run packages/platform-contracts/test packages/platform-auth/test`   |
| API composition                  | `pnpm --filter @wiser/api test`                                                       |
| Agent EXCON durable journal      | `pnpm test:postgres:excon-v2`                                                         |
| EXCON v1 compatibility Worker    | `pnpm --filter @agent-excon/worker test`                                              |
| Data Worker                      | `pnpm --filter @wiser/data-worker test`                                               |
| MCP composition                  | `pnpm --filter @wiser/mcp test`                                                       |
| Telemetry Ingress                | `pnpm --filter @wiser/telemetry-ingress test`                                         |
| Web unit/read model              | `pnpm --filter @wiser/web test`                                                       |
| Data contracts                   | `pnpm --filter @wiser/data-contracts test`                                            |
| Data core                        | `pnpm --filter @wiser/data-core test`                                                 |
| Data infrastructure              | `pnpm --filter @wiser/data-infra test`                                                |
| EXCON scenario assets            | `pnpm --filter @agent-excon/scenarios test`                                           |

`pnpm test` explicitly composes `test:unit` and `test:ops`. `@agent-excon/contracts`, `@agent-excon/core`, `@agent-excon/infra`, `@wiser/platform-contracts`, and `@wiser/platform-auth` have no standalone `test` script. Their specs are collected by the `repository` project, so use the path commands in the table. Do not mistake a no-script result from `pnpm --filter <package> test` for an executed test suite.

## Coverage

```bash
pnpm test:coverage
```

This command merges packages and every app with a unit suite in one Vitest projects run, explicitly includes TypeScript/TSX source files that no test imported, and emits text, `coverage/lcov.info`, and `coverage/coverage-summary.json`. Docs remains build/Playwright-gated and is outside unit coverage. Long-running process bootstrap files are explicitly excluded; CLIs, barrels, and Web pages remain visible in the report.

The verified coverage ratchet enforces global floors of 73% statements, 67% branches, 75% functions, and 76% lines. Higher scoped floors protect pure Core v2, its shared deterministic helpers, the OTLP Collector forwarder, and Graph/STAC/PostGIS input validation. Local and CI `pnpm verify` include this command exactly once; CI retains LCOV plus the JSON summary for seven days. Thresholds never auto-update: a future increase is an explicit reviewed change based on a fresh Green report.

These figures measure only the Vitest manifest. Playwright, pgTAP, real PostgreSQL integration, operations smoke, and browser-visible Next.js pages remain separate proof layers and are not merged into the unit percentage. Do not lower a threshold merely to accommodate untested code or interpret the global number as product-level coverage.

The suite declares `{ concurrent: false }` explicitly for Vitest 5; the removed `describe.sequential` API must not be used. Keep all seven database cases and their cleanup intact when changing the test runner. Collection-only checks are not database execution evidence.

## Supabase and Data Foundation

For Supabase schema, RLS, seed, or platform/EXCON database logic changes:

```bash
pnpm supabase:start
pnpm supabase:verify
pnpm supabase:stop
```

`supabase:verify` resets local Supabase before running pgTAP, lint, and advisors. Back up any local data that must be retained.

The Agent EXCON journal deep suite runs only against a verified local Supabase PostgreSQL server and requires an explicit loopback administrator URL:

```bash
EXCON_JOURNAL_TEST_ADMIN_URL='<loopback-admin-dsn>' pnpm test:postgres:excon-v2
```

The suite never resets the shared `postgres` database. Each of its seven serial cases creates one exact ephemeral database and login role, applies the canonical journal migration, exercises the production runtime, closes every service and pool, and drops only those tracked objects. It proves least-privilege restart/replay, pending-outcome recovery, one-writer locking, result drift, intent corruption, historical HMAC-key loss, and rejection of runtime roles with RLS-bypass, database/role-creation, or replication capability. CI runs it after `supabase:verify` and before the unconditional Supabase stop step.

For Data package, migration-runner, or Compose contract changes, first run:

```bash
pnpm data:verify
```

`data:verify` reuses the root `test:ops` entrypoint, then checks the four Data workspaces' test/typecheck/build and Compose configuration; it does not touch a running database. Changes to Data schemas, runtime roles, Workers, object storage, projections, REST, GraphQL, MCP, or authenticated Web also require the live vertical path:

```bash
pnpm supabase:start
pnpm supabase:reset
pnpm data:up
pnpm data:migrate
pnpm data:seed
pnpm data:smoke
pnpm data:down
pnpm supabase:stop
```

The two real PostgreSQL adapter gates may target only CI or an explicitly disposable isolated Data database. The API gate runs both command and PostGIS query specs and needs a migration-owner DSN so it can create temporary non-bypass roles; the Worker gate logs in as the real `wiser_data_worker` and commits randomized authority fixtures:

```bash
WISER_DATA_PG_INTEGRATION=1 DATA_TEST_DATABASE_URL='<owner-dsn>' pnpm test:postgres:data-api
DATA_WORKER_PG_SMOKE_URL='<worker-dsn>' pnpm test:postgres:data-worker
```

The API command spec uses a temporary non-bypass role to prove illegal Operation, Ingestion, Job, and Transform Plan transitions fail with stable PostgreSQL errors. It also proves authority identity/content, terminal and running same-state protection, capability-scoped upload completion, exact row versions, retirement of the legacy claim path, accurate wake-to-claim event history, and legal heartbeat/wait aggregation. Its positive fixture advances through the legal lifecycle rather than inserting an impossible intermediate state. The API PostGIS spec separately proves authoritative latest/exact immutable-version selection, sibling-extent collection, snapshot pagination, DataItem intersection, and fail-closed Tenant, security, and policy boundaries. The authenticated GeoJSON browser fixture must enable vector, disable raster, and issue no raster tile request; this checks version-level authority metadata without pretending that the fixture proves a valid COG. The Worker deep test then proves the guarded schema still accepts the complete ingestion commit path.

Data Foundation CI completes the vertical smoke and saves its machine-readable report first, runs the authenticated Data browser suite against that same stack, then runs the API and Worker deep tests, and finally removes that job's Data volumes unconditionally. The order is `smoke → authenticated browser → API/Worker deep tests → always cleanup`; cleanup must still run after any earlier failure. Never point these commands at a shared database or a local volume whose data must be retained.

On a clean environment, `pnpm stack:full:up` converges Supabase startup, the Data profile, migrations, seed, and `data:smoke`. A passing smoke proves the fixed sequence across upload, scanning, fingerprinting, fake Agent, deterministic transformation, quality/review, authority commit, Outbox, five completion targets, REST, GraphQL, MCP, and authenticated Web. It also verifies that Outbox replay does not duplicate target facts. The upload bundle contains both English and `zh-CN` Markdown; the REST phase selects `fulltext`, `semantic`, and `graph` independently, proving that OpenSearch multilingual lexical recall, Weaviate pure-vector recall, and Neo4j full-text graph seeds can each retrieve the same governed version.

## Playwright

Run both reference browser suites together:

```bash
pnpm test:e2e:reference
```

Or run only the affected application:

```bash
pnpm --filter @wiser/web test:e2e
pnpm --filter @wiser/docs test:e2e
```

The root command runs Web and Docs concurrently with workspace concurrency two and `--no-bail`: either suite failing still fails the command, while the other suite finishes and retains its own diagnostics. Their ports and output directories are separate. Both Playwright configurations start isolated development servers: Web uses `127.0.0.1:3200`, while Docs uses `127.0.0.1:4322`. Web explicitly configures reference/Auth-off mode in this isolated suite; production continues to forbid Auth-off mode. CI runs Web with one browser worker and a 60-second per-test limit to avoid concurrent cold-route compilation and allow the multi-viewport navigation cases to finish on the runner. Local Web runs use four workers. The CI browser job runs the same root command independently of `pnpm verify` and retains screenshots, traces, and the HTML report only on failure. These suites prove browser routing, language, theme, and interaction; they do not replace unified-Auth or database vertical smoke, and their compilation-inclusive timing is not a production latency budget.

### Authenticated Data live suite

After a disposable loopback stack has already completed Data migration, seed, and smoke, run the protected browser flow against that same stack:

```bash
WISER_WEB_LIVE_BASE_URL='http://127.0.0.1:3100' \
WISER_WEB_LIVE_SMOKE_REPORT='<absolute-path-to-successful-smoke-report.json>' \
WISER_WEB_LIVE_EMAIL='<seeded-local-email>' \
WISER_WEB_LIVE_PASSWORD='<seeded-local-password>' \
pnpm test:e2e:data-live
```

| Variable                      | Contract                                                                                                       |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `WISER_WEB_LIVE_BASE_URL`     | Loopback origin of the already-running Web application; shared, staging, and production origins are forbidden. |
| `WISER_WEB_LIVE_SMOKE_REPORT` | Absolute path to the successful machine-readable `data:smoke` report produced by this same stack.              |
| `WISER_WEB_LIVE_EMAIL`        | Seeded local fixture identity used through the sign-in UI.                                                     |
| `WISER_WEB_LIVE_PASSWORD`     | Password for that local fixture identity; never print or persist it in diagnostics.                            |

This command is a test consumer, not a stack orchestrator: it does not start or stop services, apply migrations or seed, run smoke, or reset any authority. It must reuse an already migrated, seeded, smoke-verified loopback stack whose data and volumes are disposable. Unlike the reference/Auth-off suite, it signs in through a real Supabase session and verifies protected Data Web/API behavior; a passing reference suite cannot satisfy this identity boundary.

The live Playwright configuration disables traces and video and captures screenshots only on failure. CI may upload the failed-run screenshots and live HTML report, with restricted access and short retention; it must not publish the four environment values, auth cookies or storage state, request headers, DSNs, the smoke report, service logs, or downloaded user content. Treat even the permitted failure diagnostics as sensitive before sharing them outside the CI run.

Every visible UI change covers Chinese-default and equivalent English states, and checks light/dark themes, keyboard focus, narrow screens, and failure/unavailable states. When repairing locators, prefer roles, labels, visible text, or stable test ids.

## Observability

When changing OTLP ingress, collectors, trace/metric/log pipelines, Grafana data sources, or redaction behavior, run:

```bash
pnpm observability:config
pnpm observability:up
pnpm observability:smoke
pnpm observability:down
```

The smoke checks real OTLP traces, metrics, logs, and sensitive-field redaction. It validates the best-effort diagnostics plane; complete telemetry still cannot replace Events, Receipts, evaluations, or database audit facts.

## Cookbooks, showcase, and other smoke

For Agent EXCON scenario, MCP participant flow, Barrier, evaluation, or exercise-runner changes, run both model-free paths:

```bash
pnpm cookbook:scripted
pnpm cookbook:rework
pnpm showcase:preflight
```

`cookbook:scripted` proves four scripted RunAgents complete the case through real MCP/API. `cookbook:rework` first injects a schema error, then proves the scoped grant, revision 2, and final evaluation. `showcase:preflight` validates prerequisites only; it does not prove that a showcase session ran successfully.

The real WorkBuddy path incurs model usage and requires network access, login, and explicit current-user authorization:

```bash
WORKBUDDY_LIVE=1 pnpm cookbook:workbuddy
```

It is not a default gate and must never run automatically for an ordinary code change. The complete Data smoke is `pnpm data:smoke`; the observability smoke is `pnpm observability:smoke`. Do not treat one `/health/ready` response as a passing vertical smoke.

## AI and deterministic boundaries

- Tests, CI, scripted cookbooks, and Data smoke use a fake provider or deterministic fake embedding, with no network access or model cost.
- Fake output still passes through the same schemas and business gates as production adapters.
- AI never generates deterministic scores, authorization decisions, quality conclusions, acceptance, or publication verdicts. Pure rules and tests fix those behaviors.
- The local Codex provider is enabled explicitly on a trusted host only; authentication files never enter containers.
- OpenAI-compatible or WorkBuddy online smoke is always explicit opt-in. Report failures faithfully; do not hide retries or silently downgrade them into a “success.”

## When to run each gate

| Change type                    | Minimum development loop           | Add before merge                                          |
| ------------------------------ | ---------------------------------- | --------------------------------------------------------- |
| Contracts / core               | One spec or package path           | `pnpm verify`                                             |
| API / Worker / MCP             | Corresponding workspace `test`     | `pnpm verify`; add the relevant smoke for real storage    |
| Web / Docs UI                  | Web unit test or Docs build        | Corresponding Playwright + `pnpm verify`                  |
| Supabase schema/RLS/seed       | pgTAP Red + `pnpm supabase:verify` | `pnpm verify`                                             |
| Data schema/runtime/projection | Focused spec + `pnpm data:verify`  | Complete Data sequence or `stack:full:up` + `pnpm verify` |
| Observability                  | Focused Vitest                     | config/up/smoke/down + `pnpm verify`                      |
| EXCON scenario/cookbook        | Focused root spec                  | scripted + rework + `pnpm verify`                         |
| Documentation governance       | Docs build + `pnpm docpact:check`  | Docs Playwright + `pnpm verify`                           |

## Definition of done

Before a change is ready to hand off:

- The new test failed for the expected reason and now passes; existing regressions remain green.
- Negative cases cover authorization, invalid input, concurrency, idempotency, and unavailable states in proportion to risk.
- Core remains pure and deterministic; cross-system calls use public contracts or HTTP only.
- Database migrations replay from an empty local database; RLS is exercised through non-superuser roles, and seeds stay synchronized with declarative schemas.
- Visible UI copy exists in both languages, with theme, keyboard, and responsive behavior verified.
- Default tests have no real model call, external cost, or secret dependency.
- After coding, `pnpm docpact:check` has run and matched authoritative docs are updated or have genuine review evidence.
- A multi-commit branch runs `docpact lint --root . --merge-base <base-ref> --mode enforce --fail-on-uncovered-change --fail-on-stale-docs` so committed Red/Green slices are included.
- Required focused gates, integration smoke, and final `pnpm verify` all pass.
- The Git diff contains only intended scope and passes `git diff --check`; Red is a recoverable checkpoint, while the final commit is Green and single-purpose.

The Data API PostgreSQL integration command runs its test files sequentially. Their temporary roles still grant privileges on shared schemas, so concurrent fixtures can collide in PostgreSQL system catalogs even when business rows use distinct tenants. All fixtures and rollback checks remain enabled.

### Explicit source-case browser suite

#### Candidate API load driver

Admission rejects malformed input without exposing its exception. Dispatched requests and fixed references are immutable to the transport, and failure classifications cannot be rewritten into unredacted result values.

`pnpm exec vitest run tests/toolchain/a12-candidate-load-driver.spec.ts tests/toolchain/a12-candidate-load-traversal.spec.ts` validates the deterministic load utility in `apps/web/e2e-live/support/a12-candidate-load-driver.ts` with synthetic responses. This unit gate proves the driver and assertions only; it does not prove current Auth, HTTP latency, complete real pagination, memory, sustained load or cold reconstruction.

Freeze complete standard-intake receipts, candidate references, per-asset counts, ordered columns and content digests before sampling. Unknown counts or incomplete inventory prevent the run; drift after measured work starts fails that run. Keep real and synthetic datasets separate. Each dataset has eighteen conditions: three existing candidate GET capabilities, first-page sizes 50/200 and client concurrency 1/4/8. Every condition retains five warmups and one hundred measured attempts, including errors and slow responses; a failed attempt is not a completed strict response and is never replaced by a retry. Sort all observed elapsed times, use the upper middle element for median and nearest rank for p95; targets remain median ≤300 ms and p95 ≤800 ms, with one hundred complete responses and no failed attempt required.

The public REST GET boundary and same-origin Web BFF POST boundary are distinct. Reject wrong fixed references, per-asset count drift, schema failures, non-JSON replies, the existing 3 MiB material budget, oversized/echoed cursors and empty continuing pages. Preserve original missing/null/empty values and source-index gaps; a GeometryCollection is one original geometry record, not the number of drawing parts. Reports contain only condition labels, ordinals, timings, byte/count checks and sanitized outcomes. Do not persist bodies, original values, coordinates, URLs, cursors, headers, credentials or raw errors. Formal execution still requires the independently registered runtime/resource/privacy gates, twenty complete traversals, actual current authorization, and the separate sustained/memory/cold tests.

The three version-bound business/record navigation regressions use admitted local source data, including a TCI band and independently checked observation counts. An unfiltered `pnpm --filter @wiser/web test:e2e:data-case --reporter=list` run requires `WISER_WEB_LIVE_BASE_URL`, the existing live credentials, `WISER_WEB_LIVE_RELATION_URL`, `WISER_WEB_LIVE_RECORD_URL`, `WISER_WEB_LIVE_OBSERVATION_COUNT`, and `WISER_WEB_LIVE_CANDIDATE_VIEW_URL`. The relation URL must identify the fixed catalog version and relation view; the record URL must carry its fixed record focus; the candidate URL must satisfy the real saved-view contract below. Use the file-filtered command below when running only the candidate return case. Missing or invalid case inputs fail explicitly. These `e2e-live/*.case.ts` tests retain all assertions and are collected by `playwright.case.config.ts`; they are not portable CI fixtures. `test:e2e:data-live` continues to collect all existing `*.spec.ts` suites against the CI smoke stack. The discovery regression invokes Playwright with synthetic inputs and `--list` only; it does not claim a real-case browser run. Docpact routes live browser cases, browser configuration and discovery fixtures to this bilingual testing contract.

The full-traversal utility uses a domain-separated SHA256 chain with ordered entries and column definitions, independent of page boundaries. Every one of twenty traversals must match the pre-frozen inventory, including full assets, row and geometry counts, identity uniqueness and order; matching only another traversal is insufficient. It rejects duplicate/cyclic cursors and bounds reads by the frozen counts, without retaining original content in results.

The test-side HTTP adapter uses the registered method, route and input schema for these three public GET capabilities. Admit the exact task-owned loopback origin and port before supplying a verified session closure. It never follows redirects, sends a GET body or retries a failed attempt. Successful JSON responses retain actual consumed entity bytes, enforce the existing 3 MiB streaming limit, reject incomplete transport and invalid UTF-8, and preserve the existing 30-second total deadline. Non-200 replies retain their status without consuming error content; zero bytes means nothing was consumed, not that the response was empty. Thrown failures retain unknown byte counts. Client abort and adapter close release owned requests, listeners and timers; these checks do not prove server SQL cancellation.

The in-memory Auth guard signs in once using the existing Supabase client, then rechecks verified claims, the same session token and the existing platform identity response before each condition. These checks are outside measured GET timing. It disables persisted sessions and refresh, rejects token replacement, and invalidates old condition closures after a new check or failure. The identity endpoint proves only identity and necessary scopes: it does not expose every candidate resource, delegation or validity condition. Complete current candidate authority remains the responsibility of the actual public GET. Fake Auth tests and synthetic loopback tests do not establish actual Auth, RLS, standard intake provenance or formal A12 results.

Run the adapter checks with `pnpm exec vitest run tests/toolchain/a12-candidate-load-http.spec.ts tests/toolchain/a12-candidate-load-auth.spec.ts`. Their synthetic HTTP fixtures bind only their own system-assigned loopback ports and close only their own listeners, so they do not reserve the live API port. Composition checks exercise the actual Auth guard, HTTP adapter and driver together: token expiry stops new attempts as denied, an obsolete condition stops them as stale, and a closed guard cancels them. Already started attempts remain in the results; no replacement requests are made. Configuration exceptions and error classifications remain bounded and sanitized.

The private matrix runner in `apps/web/e2e-live/support/a12-candidate-load-runner.ts` admits independently pinned receipt, inventory, prepared-asset and standard-stack capture files before signing in. It recomputes hashes from actual bytes, checks existing upload/ingestion/Operation associations and complete per-track totals, then snapshots the admitted input immutably. The linked Operation must identify `data.ingestion.create`; matching two unrelated capability identifiers is insufficient. Submitted upload hashes, generic Operation messages and a declared READY label cannot certify scanning or fingerprinting. A task-owned trusted capture verifier must confirm that evidence; absent or unknown evidence is `not_run`. Source registration is optional in the existing intake contract. A manifest-bearing PARTIAL batch remains partial; do not drop its manifest or relabel it READY to satisfy this test.

The runner invokes the existing driver for all thirty-six fixed conditions and traverses every member in frozen order within each of twenty rounds per track. A fixed representative member is selected per action before sampling; performance attempts are not pooled across members. Traversal page samples retain only ordinals, action, elapsed time, consumed bytes and bounded outcomes. Current authority is checked outside timing before each condition or member traversal, owned transports are closed afterward, and terminal failures stop later work without replacing started attempts. A cleanup exception preserves an earlier terminal cause and its samples; malformed returned guards or transports release their own data-property close method without evaluating accessors. Run `pnpm exec vitest run tests/toolchain/a12-candidate-load-runner.spec.ts` for synthetic orchestration checks. Its fake clocks, capture verifier and transports do not prove actual Auth/SQL, dataset scale or formal performance. Even a completed candidate matrix keeps overall `formalA12` as `not_run` until the separately registered sustained, memory, first-screen and cold-rebuild exits have actual evidence.

The private original-content adapter in `apps/web/e2e-live/support/a12-candidate-original-http.ts` consumes the existing fixed candidate GET route. It accepts only the registered task loopback origin and exact reference/asset, requires a complete uncompressed 200 response with the expected Content-Length, hashes the actual stream, and retains the existing 32 MiB input boundary and 30-second deadline. It rejects redirects, ranges, truncated transfers, changed bytes and accessor-based inputs, and closes its own requests. Synthetic checks of `tests/toolchain/a12-candidate-original-http.spec.ts` prove the consumer's integrity guards; an actual successful normal API GET would prove current API guards and bytes, not a fresh per-asset scanner transaction.

`apps/web/e2e-live/support/a12-standard-intake-http.ts` must consume only the seven existing upload-session, intake and Operation capabilities, including `data.ingestion.submit`. Creating an ingestion only registers a waiting Operation; processing requires the existing submit command with the current ingestion version and matching If-Match. Its nested Operation retains the original create capability and identity. Commands retain their registered paths, success statuses, deadlines and UUID idempotency keys. Event reads parse the actual finite SSE snapshot and its next cursor within a bounded 30-second read, preserving event identity and order. Presigned PUT copies and hashes admitted bytes before dispatch, permits only the task storage origin and existing required object headers, and sends no API credentials. JSON/SSE reads retain the existing 3 MiB stream budget; PUT response reads are bounded separately. The adapter checks both schema and requested scope/identity, then releases owned timers, requests and sockets on completion, cancellation and failure.

Live DTOs and signed upload targets remain in memory. `redactA12StandardIntakeReply` produces an explicit persistence projection: signed URLs become `https://redacted.invalid/`, upload headers are removed, error/message text is redacted, and actual wire and projection digests remain distinct. A redacted JSON file cannot establish scanner execution or mint trusted intake admission. Run `pnpm exec vitest run tests/toolchain/a12-candidate-original-http.spec.ts tests/toolchain/a12-standard-intake-http.spec.ts` for synthetic loopback checks; these consumers do not start services, change permissions or approve/publish intake. Real normal-stack provenance, Auth/SQL and formal A12 remain separate gates.

Candidate inventory collection must read the existing asset, record and geometry pages against a prepared asset/hash manifest, retaining source order, strict increasing record indices, ordered column keys and labels, and page-independent content digests. Geometry record identity, index and source ID must match the records marked as having geometry. Known zero remains zero, unknown counts produce `not_run`, and known `PARTIAL` status stays partial; formal load admission still requires the existing complete `READY` gate. Empty continuation pages remain invalid; after a response has been classified as denied, a later abort or cleanup failure cannot overwrite that first outcome. `tests/toolchain/a12-candidate-inventory-collector.spec.ts` checks this consumer contract with synthetic pages, including foreign assets, drifting metadata, columns and counts, cursor loops, cancellation and first-cause cleanup. Such checks do not establish normal-stack provenance, scanner execution, actual authority or formal A12.

The task-private fresh-intake collector must preserve one ordered preparation through upload targets, complete-upload, ingestion creation, the actual current ingestion read and submit. The submit version comes from the ingestion, not its Operation; all replies retain the original create Operation identity. It then bounds status and event-page reads, rejects successive observed version regression, collects the same candidate inventory and checks every full original against prepared bytes. Before freezing a result it must reread current ingestion and the same Operation after all originals, rejecting changed candidate identity, version regression, revoked access and terminal failure. The runner receipt remains six keys; submit, pre-submit and byte-read capture belong to the private owner. Synthetic DTOs, READY and copyable JSON cannot mint trusted normal-stack provenance; missing trusted evidence remains unknown and blocks formal load dispatch. Run `pnpm exec vitest run tests/toolchain/a12-standard-intake-collector.spec.ts` for the consumer contract, not actual Auth/SQL or scanner acceptance.

#### Fixed candidate same-tab Back case

Run `pnpm --filter @wiser/web test:e2e:data-case candidate-backflow.case.ts --reporter=list` only against the already prepared disposable local stack, with the existing live base URL and fixture credentials and `WISER_WEB_LIVE_CANDIDATE_VIEW_URL` obtained from a real saved-view HTTP receipt in that same stack. The URL must be canonical, use the configured HTTP `localhost` or `127.0.0.1` origin, and contain exactly one `candidateView` UUID on an ingestion detail route. Userinfo, fragments, extra parameters and cursors are rejected. The saved view and its selected material page must currently be readable and nonempty; missing input or resources fail explicitly and are recorded as `not_run`, never as a passing skip. A supplied URL alone does not prove resource provenance or permission.

The case signs in through the real login page, consumes the actual saved-view open, fixed material read and confirmation, clicks the ingestion detail's current Operation link, and uses the first-segment control to consume the real event HTTP request before `page.goBack()`. Observation is armed before Back and isolates departing requests. Saved requests are bound to the actual material action and fixed reference. The restored complete references, viewSpec, fixed page anchor and material content are compared only in memory; only newly issued signed cursors are excluded from equality. Each visible row, value or geometry entry is matched to HTTP, including the selected record's focus state, and rendered events are matched after the first-segment read finishes. No exact open-request count is required. The current ingestion Operation is checked from its actual link, without assuming that a historical saved batch owns that Operation. Asset, record and geometry responses retain their own schemas and fixed-reference binding.

Visible material counts as restored only after the restricted content is visible, non-inert and no longer busy, loading has ended and refresh is enabled, the selected panel is actually visible and bound to its tab, and the technical batch and review hash match the saved request. The test-only visibility helper preserves the live 30-second default; a disposable synthetic DOM probe may pass a shorter timeout explicitly. That probe exercises the actual helper against public synthetic assets without loading the live case module, credentials or platform resources; it proves assertion behavior, not real Auth or Back acceptance.

The observer fails the whole round if any current candidate response fails HTTP, JSON, schema or fixed identity checks, exceeds the existing 128 KiB saved-open or 3 MiB material-reader limit, or cannot supply its body. Later successful responses cannot recover that round; the 45-second snapshot wait ends as a sanitized failure. This conservative behavior does not prove denial recovery. An Operation with no readable events is a missing-resource `not_run`; other event contract or rendering failures remain failures. A real run must record its actual assets, records or geometry page kind, and acceptance applies only to that exercised kind.

The case requires the sole `list` reporter before any credential fill, rejecting HTML, JSON, blob, custom or mixed reporters as `not_run`; those formats may persist API step parameters even when a thrown error is sanitized. It overrides failure screenshots to `off`, keeps trace and video off, and enables the installed runner's worker-local `PLAYWRIGHT_NO_COPY_PROMPT` switch to omit the automatic failure DOM snapshot through artifact teardown. The runner can still write sanitized error context and metadata; the switch does not disable every error-context file. Diagnostics suppress supplied URLs, response content, signed cursors and credentials; do not attach cookies, storage state or candidate material. It tests ordinary authorized same-tab return, without revocation or synthesized events, and does not verify the actual map camera pose or continuation beyond 100 events. The separate continuation-403 path still requires a real long-event Operation and an explicitly authorized control action; neither discovery nor this return case satisfies that path. Discovery retains the original nine cases and adds this one case with clearly synthetic `--list` input. It does not start services or perform real login.

The Supabase CI lane also runs the live Agent connection, managed MCP consent, resource authority and resource batch integration suites serially after schema verification. Both `WISER_AGENT_TEST_DATABASE_URL` and `WISER_RESOURCE_TEST_DATABASE_URL` must target the disposable seeded control database. These suites validate real PostgreSQL authorization, bounded consent, revocation, independent purpose approval and transactional audit failure; setting neither variable skips them and is not acceptance. Never point them at a shared deployment. The personal browser/client and authorized external-provider checks remain separate target gates.

The owned synthetic HTTP composition in `tests/toolchain/a12-standard-intake-http-combination.spec.ts` uses the actual intake, candidate-page and binary-original adapters against task-only ephemeral loopback listeners. It verifies ordered bytes, cursor continuation, post-original authority changes and owned cleanup. Public DTO controls and compiler checks establish fixture validity; these tests do not establish actual Auth, RLS, normal scan provenance or formal A12.

Task-host observation lifecycle is tested separately in `tests/toolchain/a12-normal-runtime-window.spec.ts`. Each drift variant must first open its own window and pass an unchanged read. Missing observation remains unknown; a known generation, build, configuration, mount, migration or signature change rejects and remains terminal after recovery. Check bounded observation deadlines, out-of-band sampling, cross-owner handles, close during pending reads, and complete owned timer cancellation. This lifecycle helper cannot issue a scanner receipt or runner verified: actual native launch ownership and same-window intake membership require their own private composition and live evidence.

The task-host native reader must use a launcher-selected immutable canonical workspace/runtime, executable and Unix-socket read policy; no personal paths, environment discovery or Docker context changes belong in the utility. Root aliases cannot widen the allowed canonical target; selectors must preserve the host policy root. Selected paths, file identities, service generations, applied-migration and signature-source receipts are read inputs, not launch evidence. Keep bounded file/command consumption and cancellation across the complete observation; known drift rejects and missing native observations stay unknown. `tests/toolchain/a12-native-runtime-observer.spec.ts` exercises the complete reader with task-owned temporary files, an explicit synthetic Docker-shaped executable and a passive Unix IPC inode. It must not connect that inode, start Docker, authenticate, query SQL or prove normal scanning. Real source/build binding, normal startup and same-window intake issuance remain separate private-composition gates.

The private platform-identity HTTP consumer calls only the existing `GET /api/platform/v1/me` at the exact selected loopback API origin. Snapshot selector and credential/scope data descriptors before dispatch, reject values that Node cannot encode as request headers as invalid input before creating a request, preserve non-200 status without reading error content or following redirects, and bound successful JSON to 32 KiB and the existing 30-second total transport deadline. Cancellation and close release only owned sockets and timers. `tests/toolchain/a12-platform-identity-http.spec.ts` verifies this wire consumer with ephemeral synthetic listeners; the existing Auth guard must still verify claims, the same session and the identity body, and each candidate GET remains responsible for complete current resource authorization. This transport neither signs in nor issues trusted normal-runtime admission.
