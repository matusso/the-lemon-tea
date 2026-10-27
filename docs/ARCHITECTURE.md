# Architecture

## Principle: one analytical engine

Every interactive calculation lives in TypeScript packages, mainly `packages/telemetry-core`. That covers distance alignment, deltas, corners, explanations, lap classification, degradation, qualifying and race-pace models, and Monte Carlo strategy. These packages are pure, deterministic (seeded RNG) and dependency-free, so the same code runs in:

- the Node API server and job runner,
- the Cloudflare Worker (`workerd`),
- the browser (the web app imports `@lemon-tea/synchronization` and `@lemon-tea/circuit-engine` for the timing tower, interpolation and track mapping),
- both MCP transports (remote `/mcp` and local stdio).

`packages/domain` wraps the algorithms in services with authorisation and data loading. REST routes, MCP tools, WebSocket handlers and jobs only call those services. MCP is a thin adapter (`packages/mcp-tools`), not a second implementation. An integration test checks that `compare_laps` over MCP equals `POST /api/analysis/compare`.

Python (`services/analytics`) does **offline** work only: rolling-origin backtests, calibration, and optional FastF1 cross-validation. It writes `model_versions` and `backtest_runs` rows. The TypeScript engine reads the active `pace` model through `paceParams()` (`packages/domain/src/services/predictions.ts`) and otherwise falls back to the documented priors (`DEFAULT_PACE_PARAMS`).

## Repository map

```text
apps/
  api/            Hono app (REST, OAuth, /mcp), Node server, Cloudflare Worker, ingest CLI, live coordinator
  mcp/            stdio MCP server
  web/            React/Vite/R3F/ECharts front end
packages/
  shared-types/   zod input schemas, domain types, AuthContext, error codes
  telemetry-core/ analytics algorithms (pure)
  synchronization/ timing tower, event timeline, position interpolation, playback clock
  circuit-engine/ centreline derivation from positions, map <-> distance helpers
  provider-sdk/   ProviderAdapter contract, rate-limited/SSRF-safe HTTP client
  providers/      openf1, jolpica, file-import
  domain/         services, access policy, Store interfaces, ingestion, jobs, MemoryStore
  db/             PostgreSQL Store + IdentityStore, migration runner
  auth/           WebCrypto primitives, OAuth 2.1 server logic, AuthContext builders
  mcp-tools/      MCP tool/resource/prompt registrations
services/
  jobs/           job runner (SKIP LOCKED) + processJob
  analytics/      Python: backtests, calibration, FastF1 validation
database/migrations/  0001_core.sql, 0002_reference_data.sql
infrastructure/   docker/ (Dockerfile.node, Dockerfile.analytics), cloudflare/wrangler.toml
tests/            fixtures (synthetic), integration, bench
```

## Data flow

```text
 Provider (OpenF1 / Jolpica / file import)
      │  ProviderAdapter (rate limit, retry, SSRF allow-list, unit normalisation)
      ▼
 IngestionService ──► PostgreSQL + TimescaleDB
      │                 timing tables · car_samples / position_samples hypertables
      │                 RLS on sessions / predictions / jobs / provider_connections
      ▼
 Store (PgStore)  ◄── AccessPolicy → AuthorizedSession
      ▼
 Domain services (Session, Timing, Telemetry, Circuit, LapComparison, Practice, Tyre,
                  Qualifying, RacePace, Strategy, ModelEvaluation, Jobs)
      │
      ├── REST  /api/*            (Hono)
      ├── MCP   /mcp  (HTTP)  +  stdio
      ├── WebSocket /ws/live/:id  (LiveSessionCoordinator; Durable Object on Cloudflare)
      └── Job runner / Queue consumer
                    ▲
 services/analytics (Python) ── writes model_versions / backtest_runs (offline)
```

Live data follows the same path. One `LiveSessionCoordinator` per session polls the provider and fans deltas out to every viewer, so each viewer does not open its own provider connection. Live polling exists in code but has not been verified against an authenticated OpenF1 account.

## Security contexts

The three contexts are deliberately kept apart (`packages/shared-types/src/auth.ts`):

1. **Application identity:** users and tenants. Browser session cookie or personal API token (`lt_pat_...`).
2. **MCP delegation:** OAuth 2.1 access tokens bound to the `/mcp` resource. The scopes are the intersection of the grant and the user's own rights.
3. **Provider authorisation:** provider credentials (e.g. `OPENF1_USERNAME/PASSWORD`) exist only in server configuration. They never appear in an `AuthContext`, a response or an MCP tool.

See [AUTHENTICATION.md](AUTHENTICATION.md) and [SECURITY.md](SECURITY.md).

## Deployment modes

| | Self-hosted (Node) | Cloudflare |
|---|---|---|
| HTTP | `@hono/node-server` (`apps/api/src/server.ts`) | Worker (`apps/api/src/worker.ts`) |
| Database | PostgreSQL/TimescaleDB | Same, via Hyperdrive |
| Jobs | `services/jobs/src/runner.ts` polling with SKIP LOCKED | Queue consumer + cron sweep calling the same `processJob` |
| Live fan-out | in-process coordinator + `@hono/node-ws` | Durable Object `LiveSession` |
| Static web | served from `apps/web/dist` | `[assets]` binding |

Both modes build the app with the same `createApp()` and `createServices()`. See [DEPLOYMENT.md](DEPLOYMENT.md).

## Decisions

- **TypeScript for interactive analytics:** keeps one implementation across the Worker, browser and MCP. Python is limited to offline research and parameter fitting.
- **Column-oriented samples** (`CarSamples`, `PositionSamples`): arrays sharing an index, cheap to slice and send over the wire.
- **Public session ids** (`<source>:<key>`) are resolved to internal `uid`s per caller. A tenant's private copy shadows the public row. Unknown and forbidden sessions both return `not_found`.
- **TypeScript 5.9** rather than 7.x, chosen for compatibility with the Vite, Vitest and Wrangler toolchains.
- **No ClickHouse:** not evaluated; the benchmarks in the README show TimescaleDB is adequate for current query shapes.
