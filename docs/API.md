# REST API

Base: `http://localhost:8787`. Implementation: `apps/api/src/app.ts`. Input schemas are in `packages/shared-types/src/inputs.ts`. Every route calls the same domain service as the matching MCP tool.

## Authentication

| Method | How |
|---|---|
| Browser | `POST /api/auth/login` sets the `lt_session` cookie (HttpOnly, SameSite=Lax, Secure on https, 7 days) |
| API token | `Authorization: Bearer lt_pat_...` (create with `POST /api/auth/tokens`). Any other `Authorization` header (e.g. an MCP OAuth token) is rejected with 401 rather than treated as anonymous |
| Anonymous | Allowed when `ALLOW_ANONYMOUS=true`, with scopes `sessions:read telemetry:read analytics:read predictions:read`. Only sources allowed for public display are visible |

**CSRF:** cookie-authenticated requests other than GET/HEAD must send `X-Requested-With: lemon-tea`, and the `Origin` (if present) must be in the allowed origins (`PUBLIC_URL` + `ALLOWED_ORIGINS`). Otherwise the response is 403.

**CORS:** only the allowed origins receive `Access-Control-Allow-Origin` (with credentials).

**Rate limit:** `RATE_LIMIT_PER_MINUTE` (default 240) per user or client IP, fixed window, `RateLimit-*` headers, 429 with `Retry-After`.

**Body limit:** 1 MB (60 MB for `/api/imports`).

## Errors

```json
{ "error": { "code": "not_found", "message": "Session openf1:1 not found", "details": {} } }
```

| code | HTTP |
|---|---|
| invalid_input | 400 |
| unauthorized | 401 |
| forbidden | 403 |
| not_found | 404 |
| conflict | 409 |
| data_unavailable, insufficient_data | 422 |
| rate_limited, quota_exceeded | 429 |
| internal | 500 |
| provider_error | 502 |

`provider_error` also covers a rejected or expired Formula 1 account token ("… Sign in again."). That concerns the provider account, not the caller's app session.

Validation failures list zod issues in `details.issues`. Sessions that exist but are not visible to the caller return `not_found`.

## Routes

`:id` is a session id such as `openf1:9908`. Scopes are listed where a route requires more than `sessions:read`.

### Meta and auth
| Method | Path | Notes |
|---|---|---|
| GET | `/api/health` | |
| POST | `/api/auth/login` | `{email, password}` |
| POST | `/api/auth/logout` | |
| GET | `/api/auth/me` | user and scopes |
| POST | `/api/auth/tokens` | browser session only; `{name, scopes[], expiresInDays=90}` → token shown once (`admin` is never granted) |

### Sessions and timing
| Method | Path | Query / notes |
|---|---|---|
| GET | `/api/sources` | governance registry |
| GET | `/api/seasons` | |
| GET | `/api/meetings` | `year` |
| GET | `/api/sessions` | `year, meetingId, type, ingestedOnly, limit≤200` |
| GET | `/api/sessions/:id` | info, drivers, counts, regulation notes, attribution |
| GET | `/api/sessions/:id/availability` | channels and observed quality |
| GET | `/api/sessions/:id/drivers` | |
| GET | `/api/sessions/:id/circuit` | derived geometry |
| GET | `/api/sessions/:id/bundle` | full `TimingBundle` (used by the web replay) |
| GET | `/api/sessions/:id/timing` | `t` (session ms) → tower, track status, weather |
| GET | `/api/sessions/:id/timeline` | events |
| GET | `/api/sessions/:id/laps/:driver` | laps with compound and tyre age |
| GET | `/api/sessions/:id/race-control` | untrusted text |
| GET | `/api/sessions/:id/pits` | |
| GET | `/api/sessions/:id/weather` | `t` optional |
| GET | `/api/sessions/:id/radio` | `driver`; links only |
| GET | `/api/sessions/:id/position` | `t, driver` · `telemetry:read` |
| GET | `/api/sessions/:id/replay` | `from, to` (≤ 10 min), `hz≤10` · `telemetry:read` |
| GET | `/api/sessions/:id/telemetry` | `TelemetryInput`: `driver, lap` or `from/to` (≤ 30 min), `maxPoints` · `telemetry:read` |
| GET | `/api/sessions/:id/export/laps` | `format=csv\|json`; rights-checked (see [DATA_LICENSING](DATA_LICENSING.md#exports)) |
| GET | `/api/sessions/:id/export/telemetry` | `driver, lap, format` · `telemetry:read`; rights-checked |
| GET | `/api/sessions/:id/theoretical-best` | `driver` · `analytics:read` |

### Analysis (`analytics:read`)
| Method | Path | Body |
|---|---|---|
| POST | `/api/analysis/compare` | `CompareLapsInput` `{a:{sessionId,driverNumber,lapNumber?}, b, stepMetres=5, includeTraces=false, traceResolutionMetres=25}` |
| POST | `/api/analysis/delta` | `CompareLapsInput` |
| POST | `/api/analysis/corner` | `CornerInput` (+ `corner?`) |
| POST | `/api/analysis/braking` | `CompareLapsInput` |
| POST | `/api/analysis/acceleration` | `CompareLapsInput` |
| POST | `/api/analysis/dominance` | `TrackDominanceInput` `{sessionId, driverNumbers[2..10], segments=25}` |
| POST | `/api/analysis/driver-style` | `{sessionId, driverNumber}` |
| POST | `/api/analysis/teams` | `CompareTeamsInput` |

### Predictions and strategy
| Method | Path | Body / scope |
|---|---|---|
| POST | `/api/practice/long-runs` | `PracticeInput` `{sessionIds[1..6]}` · `predictions:read` (long-run detection and pace via `PracticeAnalysisService.longRuns`) |
| POST | `/api/tyres/degradation` | `DegradationInput` |
| POST | `/api/tyres/compare` | `PracticeInput` |
| POST | `/api/predictions/qualifying` | `PredictQualifyingInput` (`persist=true`) |
| POST | `/api/predictions/race-pace` | `PracticeInput` |
| POST | `/api/predictions/race-result` | `PredictRaceResultInput` · `simulations:execute`; iterations capped at 2000 |
| POST | `/api/strategy/simulate` | `SimulateStrategyInput` · `simulations:execute`; capped at 2000 |
| GET | `/api/predictions/history` | `meetingId`, `qualifyingSessionId` |
| GET | `/api/models/metrics` | `family` |

### Jobs (signed-in only)
| Method | Path | Notes |
|---|---|---|
| POST | `/api/jobs` | `CreateJobInput` `{kind, input, idempotencyKey?}` → 202. Kinds: `simulate_strategy`, `predict_race_result`, `predict_qualifying`, `ingest_session`. Backtests run offline in `services/analytics`. A repeated `idempotencyKey` returns the existing job; new jobs are limited to 5 queued or running per tenant |
| GET | `/api/jobs/:jobId` | status, progress, error, `resultRef` |
| GET | `/api/jobs/:jobId/result` | 409 unless succeeded |
| DELETE | `/api/jobs/:jobId` | request cancellation |

### Provider accounts (signed-in web or REST callers; not MCP)
Connect the caller's own provider account. Today only `f1lt` (Formula 1 account → F1 live timing) exists. Responses contain **status only**: `{provider, name, status: "connected"|"expired"|"not_connected", expiresAt, method: "password"|"token"|null, connectedAt, details}`, where `details` may hold `SubscriptionStatus` / `SubscribedProduct`. Tokens and passwords are never returned. Requires `APP_ENCRYPTION_KEY`.

| Method | Path | Notes |
|---|---|---|
| GET | `/api/connections` | status for every account provider |
| GET | `/api/connections/:provider` | status |
| POST | `/api/connections/:provider/sign-in` | `{username, password}`, forwarded once to Formula 1's sign-in service and never stored. 400 with the provider's message on failure. 5/min per user |
| POST | `/api/connections/:provider/token` | `{token}`, a pasted F1 TV subscription JWT (e.g. from FastF1). Expired or malformed → 400. 5/min per user |
| DELETE | `/api/connections/:provider` | `{disconnected}` |

### Ingestion and imports (`ingest:write`)
| Method | Path | Notes |
|---|---|---|
| GET | `/api/ingest/discover` | `source=openf1\|jolpica\|f1lt, year`; `f1lt` uses the caller's connected Formula 1 account |
| POST | `/api/ingest` | `IngestInput` `{sessionId, channels, visibility}` → queued `ingest_session` job; `public` requires `admin` and is refused for `f1lt` (e.g. `f1lt:2025-9908`, always private) |
| POST | `/api/imports` | `{manifest, car?, location?}`; each table is `{format:"json",rows}`, `{format:"csv",text}` or `{format:"parquet",base64}`; always private; returns the ingest result and a rejection report |

## Examples

```bash
curl -s -c jar -X POST localhost:8787/api/auth/login -H 'content-type: application/json' \
  -H 'x-requested-with: lemon-tea' -d '{"email":"admin@example.org","password":"..."}'

curl -s -b jar -X POST localhost:8787/api/analysis/compare -H 'content-type: application/json' \
  -H 'x-requested-with: lemon-tea' \
  -d '{"a":{"sessionId":"openf1:9908","driverNumber":1},"b":{"sessionId":"openf1:9908","driverNumber":4}}'

curl -s -H "authorization: Bearer $LT_TOKEN" "localhost:8787/api/sessions/openf1:9908/timing?t=1800000"
```

## WebSocket: `/ws/live/:id`

Requires `telemetry:read` on the session. Messages (`LiveMessage`, `apps/api/src/live.ts`):

```json
{ "type": "delta" | "status", "sessionId": "openf1:...", "seq": 12,
  "sourceTimestamp": "2026-...Z", "receivedAt": "2026-...Z",
  "payload": { "bundle": {}, "car": { "<driver>": {} }, "position": { "<driver>": {} } } }
```

- `sourceTimestamp` against `receivedAt` exposes source latency.
- `status` messages report `unavailable` (no authorised live provider), `degraded` (with `retryInMs`) or `error`.
- Late joiners receive the last 120 messages.
- For account-scoped sources (`f1lt`) the poller uses the viewer's tenant token, one upstream connection per (session, tenant).
- Not verified against a real live feed.
