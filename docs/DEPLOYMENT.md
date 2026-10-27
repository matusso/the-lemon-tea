# Deployment

## Self-hosted with Docker Compose

```bash
cp .env.example .env
# generate secrets, e.g.: openssl rand -base64 48
docker compose up --build
```

| Service | Image / command | Purpose |
|---|---|---|
| `db` | `timescale/timescaledb:2.24.0-pg17` | PostgreSQL + TimescaleDB, bound to 127.0.0.1:`DB_PORT` |
| `migrate` | `Dockerfile.node`, `packages/db/src/migrate.ts` | applies migrations as `lemontea_owner` and sets the `lemontea_app` password |
| `api` | `Dockerfile.node` (`BUILD_WEB=true`), `apps/api/src/server.ts` | web app, REST, OAuth, `/mcp`, `/ws/live`, bound to 127.0.0.1:`PORT` |
| `jobs` | `services/jobs/src/runner.ts` | analysis and ingestion jobs (`JOB_CONCURRENCY`, default 2) |
| `analytics` | `Dockerfile.analytics` (profile `analytics`) | Python backtests and calibration: `docker compose --profile analytics run analytics backtest --years 2025` |

### Environment (`.env.example`)

| Variable | Required | Meaning |
|---|---|---|
| `DB_OWNER_PASSWORD`, `APP_DB_PASSWORD` | yes | database owner and app-role passwords |
| `APP_JWT_SECRET` | yes, ≥ 32 characters | signs MCP access tokens |
| `PUBLIC_URL` | | external base URL; MCP resource = `${PUBLIC_URL}/mcp`; https enables Secure cookies and HSTS |
| `PORT` | | default 8787 |
| `ALLOWED_ORIGINS` | | extra CORS / MCP origins (e.g. the Vite dev server) |
| `ALLOW_ANONYMOUS` | | default `true` |
| `PUBLIC_SOURCES` | | extra source ids anonymous users may read |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | first start | bootstrap administrator |
| `OPENF1_USERNAME`, `OPENF1_PASSWORD` | optional | OpenF1 authenticated tier (live) |
| `APP_ENCRYPTION_KEY` | to connect provider accounts | 32-byte base64url key that encrypts users' Formula 1 account tokens. Compose passes it to `api` and `jobs`. Rotating it disconnects every stored account |
| `RATE_LIMIT_PER_MINUTE`, `COOKIE_SECURE`, `WEB_DIST`, `MIGRATE_ON_START` + `MIGRATION_DATABASE_URL` | optional | tuning |

**Production notes:**
- Put a TLS-terminating reverse proxy in front of the API and set `PUBLIC_URL` to the https URL.
- Keep the database private.
- Back up the `db-data` volume.
- Never expose the owner role to the application.

Ingest data with the CLI:

```bash
docker compose exec api npx tsx apps/api/src/cli/ingest.ts --discover --year 2025
docker compose exec api npx tsx apps/api/src/cli/ingest.ts --session openf1:9908 --public       # admin decision
docker compose exec api npx tsx apps/api/src/cli/ingest.ts --session openf1:9908 --tenant <uuid> # private
```

F1 live timing sessions (`f1lt`) use a tenant's connected Formula 1 account and are always private. Users can load them from the web app (account menu → **F1 account**), or with the CLI:

```bash
docker compose exec api npx tsx apps/api/src/cli/ingest.ts --discover --source f1lt --tenant <uuid> --year 2025
docker compose exec api npx tsx apps/api/src/cli/ingest.ts --session f1lt:2025-9908 --tenant <uuid>
```

`--channels timing` skips car and location samples. That is much faster and is enough for prediction backtests.

## Cloudflare Workers

Config: `infrastructure/cloudflare/wrangler.toml`; entry: `apps/api/src/worker.ts`. It is the same Hono app and services as Node; only the platform bindings differ.

| Binding | Purpose |
|---|---|
| `HYPERDRIVE` | pooled connection to your PostgreSQL/TimescaleDB, as role `lemontea_app` |
| `JOBS` queue (`lemontea-jobs`, DLQ `lemontea-jobs-dlq`, `max_retries` 3) | pushed when a job is created (`onJobCreated`); the consumer runs `processJob` |
| cron `* * * * *` | sweeps up to 3 queued jobs per minute (fallback) |
| `LIVE` Durable Object `LiveSession` (migration `v1`) | one live poller per session with WebSocket fan-out |
| `ASSETS` | `apps/web/dist`, SPA fallback; `/api/*`, `/mcp`, `/oauth/*`, `/.well-known/*`, `/ws/*` run the Worker first |

Steps:

```bash
# 1. database reachable from Cloudflare, migrated from a machine with DB access:
MIGRATION_DATABASE_URL=... APP_DB_PASSWORD=... npx tsx packages/db/src/migrate.ts
# 2. Hyperdrive + queues
npx wrangler hyperdrive create lemontea --connection-string="postgres://lemontea_app:...@host:5432/lemontea"
npx wrangler queues create lemontea-jobs && npx wrangler queues create lemontea-jobs-dlq
#    put the Hyperdrive id into wrangler.toml and set PUBLIC_URL there
# 3. secrets
npx wrangler secret put APP_JWT_SECRET --config infrastructure/cloudflare/wrangler.toml
npx wrangler secret put APP_ENCRYPTION_KEY --config infrastructure/cloudflare/wrangler.toml   # Formula 1 account connections
# optional: OPENF1_USERNAME, OPENF1_PASSWORD
# 4. build and deploy
npm run build -w @lemon-tea/web
npx wrangler deploy --config infrastructure/cloudflare/wrangler.toml
```

Create the first admin before or after deploying by running the Node bootstrap once against the same database (e.g. start `apps/api/src/server.ts` locally with `ADMIN_EMAIL` and `ADMIN_PASSWORD` set). The Worker does not bootstrap users.

**What has been verified:**
- `wrangler deploy --dry-run` bundles the Worker (2.0 MB, 396 KiB gzip) with all bindings resolved.
- `wrangler dev` against local PostgreSQL through a Hyperdrive `localConnectionString`: `/api/health`, MCP `initialize`, login, and an authenticated `compare` on 2025 Monza qualifying, which returned −0.077 s, identical to the Node server.

**Not verified:**
- A real deployment to a Cloudflare account.
- Queue consumption and cron sweeps on the platform.
- Durable Object WebSocket fan-out with a live provider.

Workers CPU and duration limits make large ingestions better suited to the Node job runner.
