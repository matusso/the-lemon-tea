# Database

PostgreSQL 17 with TimescaleDB (the Docker image is `timescale/timescaledb:2.24.0-pg17`). Schema: `database/migrations/0001_core.sql`; reference data: `0002_reference_data.sql`. If the TimescaleDB extension is unavailable, the migration continues with plain tables.

## Conventions

- High-frequency data lives in narrow, typed tables, never in JSON blobs. JSONB is used only for small documents (circuit geometry of about 1k points, prediction outputs, job payloads, reports).
- Source rows carry `source` and `processing_version` (`laps`) or inherit them from `sessions`.
- Every session-scoped table keys on `session_uid` (an internal UUID). Public ids such as `openf1:9912` live in `sessions.id`.

## Tables

| Group | Table | Key / notes |
|---|---|---|
| Identity | `tenants` | `id` |
| | `users` | `id`; `email` unique; `role` `admin`/`user`; `password_hash` (PBKDF2) |
| | `app_sessions` | `token_hash` (sha256 of the cookie token) |
| | `api_tokens` | `token_hash`, `scopes[]`, `expires_at` |
| OAuth (MCP) | `oauth_clients` | `client_id`, `redirect_uris[]` |
| | `oauth_codes` | `code_hash`, PKCE `code_challenge`, `resource`, `expires_at`, `used_at` |
| | `oauth_refresh_tokens` | `token_hash`, `revoked_at` (rotation) |
| Governance | `data_sources` | `id`; licence, redistribution (checked enum), `public_display_allowed`, `enabled` |
| | `provider_connections` | per tenant + provider; `secret_ciphertext` (AES-GCM). **No code reads or writes this table yet** |
| | `regulation_eras` | `pre_2014`, `hybrid_2014_2021`, `ground_effect_2022_2025`, `active_aero_2026` |
| Calendar | `circuits`, `meetings` | `id` = `<source>:<key>` |
| | `sessions` | `uid` PK; `owner_tenant_id` NULL = public; partial unique indexes on `(id) WHERE owner IS NULL` and `(id, owner) WHERE owner IS NOT NULL`; `ingest_status`, `ingested_channels[]` |
| | `session_drivers` | `(session_uid, driver_number)` |
| Timing | `laps` | `(session_uid, driver_number, lap_number)`; `mini_sectors smallint[]` |
| | `stints`, `pit_events`, `session_results` | composite PKs on session + driver (+ number) |
| | `race_control` | `(session_uid, seq)`; index on `(session_uid, date)`; `message` is untrusted text |
| | `weather`, `team_radio`, `position_history`, `intervals` | PKs include `date` |
| Telemetry | `car_samples` | `(session_uid, driver_number, t)` unique; speed, throttle, brake smallint; rpm int; gear, drs smallint |
| | `position_samples` | `(session_uid, driver_number, t)` unique; x, y, z real (metres) |
| Raw archive | `raw_payloads` | index for archived provider payloads. **Not written yet** |
| Circuits | `circuit_layouts` | unique `(circuit_id, year)`; geometry JSONB, `length_m`, `accuracy_m`, `confidence`, provenance |
| Quality | `data_quality_reports` | `(session_uid, created_at)` |
| | `lap_features` | classifier output cache. **Not written yet** (classification is computed on demand) |
| Models | `model_versions` | `id`, `family`, `params`, `metrics`, `status` (candidate/active/retired) |
| | `predictions` | `owner_tenant_id`, `input_session_ids[]`, `model_version`, `params_version`, `input_hash`, `as_of`, `output`; index `(meeting_id, kind, created_at)` |
| | `backtest_runs` | written by `services/analytics` |
| Jobs | `jobs` | `status`, `progress`, `result`, `error`, `idempotency_key` (unique per tenant), `cancel_requested`; partial index on queued jobs |
| Audit | `audit_log` | `bigserial`; `user_id`, `tenant_id`, `via`, `client_id`, `action`, `resource`, `outcome`, `details`; index on `at` |

## Hypertables

`car_samples` and `position_samples` are hypertables on `t` with 7-day chunks. Compression is segmented by `session_uid, driver_number`, ordered by `t`, with a compression policy after 30 days. One qualifying session holds about 350k car samples and about 300k position samples.

## Row-level security

The application connects as **`lemontea_app`** (LOGIN, not owner, not superuser). The migration grants it DML on all tables. RLS is `ENABLE`d and `FORCE`d on:

| Table | Visible / writable when |
|---|---|
| `sessions` | `owner_tenant_id IS NULL` **or** `= current_setting('app.tenant_id')` **or** `app.role = 'system'` |
| `predictions` | owner NULL or own tenant |
| `jobs` | own tenant, or `app.role = 'system'` (job runners) |
| `provider_connections` | own tenant |

`PgStore` runs tenant-scoped reads in a transaction that sets `app.tenant_id` (`set_config(..., true)`). Ingestion status updates and job claiming set `app.role = 'system'`. Sample and timing tables have no RLS. They are reachable only through an `AuthorizedSession`, a branded type returned by `AccessPolicy.session()` after the RLS-filtered session lookup. `tests/db/rls.test.ts` checks the policies against a real database.

**Session resolution:** `findSessions(scope, id)` returns the visible rows for a public id. A tenant's private copy wins over the public row. Anything not visible yields `not_found`.

## Migrations

```bash
MIGRATION_DATABASE_URL=postgres://lemontea_owner:...@host:5432/lemontea APP_DB_PASSWORD=... npx tsx packages/db/src/migrate.ts
```

`packages/db/src/migrate.ts` applies `database/migrations/*.sql` in lexical order, one transaction each, and records them in `schema_migrations`. If `APP_DB_PASSWORD` is set, it then sets the `lemontea_app` login password. To add a migration, create the next `000N_name.sql`. Applied files must never be edited. Docker Compose runs the `migrate` service before `api` and `jobs`. In Cloudflare deployments, run migrations from any machine with database access.

## Retention

No automatic deletion is configured. Telemetry is compressed after 30 days. Deleting a session cascades to its timing tables and, since migration `0003_sample_fk.sql`, to its `car_samples` and `position_samples` rows.
