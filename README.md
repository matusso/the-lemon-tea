# The Lemon Tea

An open-source, self-hostable Formula 1 telemetry, race-intelligence and predictive-analytics platform with a native MCP server. The name is a play on "telemetry".

The Lemon Tea ingests timing and car telemetry from data providers you are authorised to use and stores it in PostgreSQL/TimescaleDB. It explains *why* one lap was faster than another, projects qualifying and race pace from practice, and simulates pit strategies with stated uncertainty. Humans use it through a web interface; AI agents use the same calculations through the Model Context Protocol.

Every number is labelled **measured**, **calculated**, **estimated** or **simulated**. Channels a source does not provide are shown as unavailable, never invented.

> Not affiliated with, endorsed by or connected to Formula 1, the FIA or any team. F1, FORMULA ONE and related marks are trademarks of Formula One Licensing B.V.

## Features

| Mode | What it does | Status |
|---|---|---|
| A — Command Center | Session replay: timing tower recomputed at the playback time, 3D circuit with interpolated car positions, race control, weather, event timeline, playback 0.25×–16× | Implemented for historical sessions. Live mode depends on an authorised live feed (not verified, see [ROADMAP](docs/ROADMAP.md)) |
| B — Telemetry Lab | Distance-aligned two-lap comparison: speed, throttle, brake, gear, RPM, acceleration, cumulative delta, corner phase analysis, deterministic explanations | Implemented |
| C — Performance Intelligence | Lap classification, practice→qualifying forecast with probabilities, long-run race pace, tyre degradation | Engine and API implemented; web UI in progress |
| D — Strategy Simulator | Lap-by-lap Monte Carlo with SC/VSC, traffic, overtaking, sensitivity, head-to-head | Engine and API implemented; web UI in progress |
| E — Research | Prediction history scored against results, model versions, rolling-origin backtests (Python) | API and Python service implemented; needs more ingested weekends |
| Export | Rights-aware CSV/JSON export of laps and lap telemetry (Parquet export not implemented) | Implemented |
| MCP | 38 tools, resources and 5 prompts over Streamable HTTP (`/mcp`, OAuth 2.1) and stdio | Implemented |

Details: [Telemetry engine](docs/TELEMETRY_ENGINE.md) · [Driver comparison](docs/DRIVER_COMPARISON.md) · [Prediction models](docs/PREDICTION_MODELS.md) · [Tyre degradation](docs/TYRE_DEGRADATION.md) · [Strategy simulation](docs/STRATEGY_SIMULATION.md) · [3D circuit](docs/3D_CIRCUIT_ENGINE.md) · [Architecture](docs/ARCHITECTURE.md)

## Data sources

| Source | Use | Status |
|---|---|---|
| OpenF1 | Sessions, laps, stints, pits, race control, weather, radio metadata, positions, intervals, results, car data, location | Historical ingestion verified on 2025 Monza. Live polling implemented but not verified with an authenticated account |
| F1 Live Timing (your Formula 1 account) | The first-party feed FastF1 reads: archive since 2018 and the live SignalR feed. Same channels as OpenF1. An F1 TV subscription is required (the archive returns 401 without one) | Implemented and tested on synthetic feed data; sign-in steps 1–2 checked against the real services. Real sign-in, archive parsing and live feed **not yet verified**. Data is always private to your account |
| Jolpica-F1 | Results and lap times (no telemetry) | Implemented, not exercised end to end |
| File import | Your own CSV / JSON / Parquet telemetry, always private | Implemented |
| FastF1 | Offline cross-validation in the Python service only (≥ 3.9 needs `python -m fastf1 auth f1tv`) | Code present, not executed |
| F1 TV video | Disabled placeholder; no scraping, proxying or re-hosting of video | Not implemented by design |

OpenF1 data is ingested with `public_display_allowed = false`, so anonymous visitors cannot see it. The operator decides whether provider terms allow public display. See [Data licensing](docs/DATA_LICENSING.md).

**Formula 1 account:** sign in, then open **F1 account** in the header to connect your account (or paste a token from FastF1) and load sessions. Your password is forwarded once to Formula 1's sign-in service (`id.formula1.com`) and never stored. Only the subscription token is kept, encrypted with `APP_ENCRYPTION_KEY`. A subscription does not add channels beyond OpenF1's: there is no brake pressure, steering or tyre temperature data. It gives the first-party source, availability soon after each session, and live access. See [Authentication](docs/AUTHENTICATION.md#provider-accounts).

## Quick start (Docker Compose)

```bash
cp .env.example .env          # fill DB_OWNER_PASSWORD, APP_DB_PASSWORD, APP_JWT_SECRET (>= 32 chars), ADMIN_EMAIL, ADMIN_PASSWORD (>= 12 chars), APP_ENCRYPTION_KEY (for F1 account connections)
docker compose up --build     # db + migrate + api (serves web + /mcp) + jobs
docker compose exec api npx tsx apps/api/src/cli/ingest.ts --session openf1:9908 --public
```

Open http://localhost:8787 and sign in with `ADMIN_EMAIL`. To list session ids: `docker compose exec api npx tsx apps/api/src/cli/ingest.ts --discover --year 2025`.

## Local development

```bash
npm install
docker compose up -d db
npx tsx --env-file=.env packages/db/src/migrate.ts   # uses MIGRATION_DATABASE_URL (owner role)
npm run dev:api        # http://localhost:8787 (reads .env)
npm run dev:web        # http://localhost:5173, proxies /api, /mcp, /oauth, /ws
```

`npm run db:migrate` does the same as the migration line above if `MIGRATION_DATABASE_URL` is exported. The API connects as the restricted `lemontea_app` role (`DATABASE_URL`) so that row-level security applies.

## MCP quick start

- **Remote:** point an MCP client at `http://localhost:8787/mcp`. Clients discover OAuth through `/.well-known/oauth-protected-resource/mcp`, register dynamically, and the user approves scopes in the browser.
- **Local stdio:** create a personal token while signed in (`POST /api/auth/tokens`), then run `npx tsx apps/mcp/src/stdio.ts` with `DATABASE_URL` and `LEMONTEA_API_TOKEN=lt_pat_...`.

See [MCP server](docs/MCP_SERVER.md) and the [tool reference](docs/MCP_TOOL_REFERENCE.md).

## Tests and benchmarks

```bash
npm test                                   # TypeScript unit + integration (vitest)
cd services/analytics && uv run pytest     # Python
npm run bench -- --session openf1:9908     # needs DATABASE_URL
```

Measured on a MacBook with local TimescaleDB, 2025 Monza qualifying (median):

| Operation | Time |
|---|---|
| `compareLaps`, synthetic, 5 m grid | 1.4 ms |
| Monte Carlo race, 20 cars × 57 laps × 2000 iterations | 239 ms |
| Lap comparison including DB reads | 7.1 ms |
| One-lap car sample query | 3.1 ms |
| 60 s replay window, all cars | 6.8 ms |
| `timingTower`, all drivers | 0.23 ms |
| Full-session car samples, one driver | 10.9 ms |

## Validation on real data

On 2025 Italian GP qualifying (OpenF1 session 9908):

- The timing tower reproduced the result: VER 1:18.792 pole, NOR +0.077, PIA +0.190.
- The VER–NOR distance-aligned lap delta was −0.077 s, the same as the timed gap.
- The derived centreline's lateral RMS agreement across laps was 1.41 m.
- The Node server and the Cloudflare Worker (run locally in `workerd`) returned identical comparison output.

Forecasts for the same weekend (single-event sanity checks with uncalibrated priors, not calibration evidence):

- Practice → qualifying (FP1–FP3): the predicted top-five set matched the actual top five; Spearman 0.75; 80 % intervals covered 18 of 22 drivers.
- Race result (practice long runs fused with qualifying pace): P(win) NOR 0.47 / VER 0.48 (actual VER 1st, NOR 2nd); the expected top six equalled the actual top-six set.
- Validating against reality changed two models: the qualifying estimator moved from "single best lap" to recency-weighted per-session bests, and the race forecast now widens the unknown practice fuel-load sd to 0.5 s and fuses qualifying pace. See [Prediction models](docs/PREDICTION_MODELS.md).

See [Validation](docs/VALIDATION.md).

## Licence

Apache-2.0 (see [LICENSE](LICENSE) and [NOTICE](NOTICE)). The licence covers the source code only. Data you ingest stays subject to its provider's terms.
