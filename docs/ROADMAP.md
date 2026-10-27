# Roadmap and status

Legend: **done** · **partial** · **not started**

## Phase 1 — Foundation
| Item | Status |
|---|---|
| Monorepo, TypeScript packages, Python service | done |
| PostgreSQL/TimescaleDB schema, migrations, RLS | done |
| OpenF1, Jolpica, file-import adapters | done (Jolpica not exercised live) |
| F1 live timing via the user's own Formula 1 account (`f1lt`): sign-in, encrypted per-tenant token, archive parser, SignalR live client, web panel | partial: implemented and tested on synthetic feed data; **credential submit, real archive parsing and live feed not yet verified with a real account** |
| Real historical import | done (2025 Monza qualifying; practice and race ingestion started) |
| Automated tests and CI | done |

## Phase 2 — Live and replay visualisation
| Item | Status |
|---|---|
| Dashboard layout, timing tower, playback, event timeline | partial (web app in progress, see `apps/web`) |
| 3D circuit (R3F) with cars | partial |
| Common timeline and synchronisation engine | done (`packages/synchronization`) |
| Live streaming infrastructure (coordinator, Durable Object, WebSocket) | partial: implemented, **not verified with a licensed live feed** |
| Detachable panels, WebGPU | not started |

## Phase 3 — Telemetry laboratory
| Item | Status |
|---|---|
| Distance sync, delta, corners, braking, acceleration, explanations | done |
| Comparison UI with synchronised charts | partial |
| Track overlays (speed, delta), track dominance | engine done; UI partial |
| Driver and team fingerprints | done (descriptive, single session) |

## Phase 4 — Performance intelligence
| Item | Status |
|---|---|
| Lap classification, long runs, degradation, qualifying and race-pace forecasts | done (uncalibrated priors) |
| Prediction snapshots and history scoring | done |
| Prediction dashboards in the web app | not started / in progress |
| Inferred tyre thermal metrics | not started |

## Phase 5 — Race strategy
| Item | Status |
|---|---|
| Monte Carlo simulator with SC/VSC, traffic, overtaking, sensitivity, head-to-head | done |
| Live strategy updates during races | not started |
| Weather transitions, red flags in simulation | not started |

## Phase 6 — Research and hardening
| Item | Status |
|---|---|
| Rolling backtests and calibration (Python) | partial: implemented and tested on synthetic data; **needs ≥ 5 ingested weekends** |
| Benchmarks | done (`npm run bench`) |
| Security hardening (CSP, CSRF, RLS, OAuth, SSRF, audit) | done; gaps listed in [SECURITY.md](SECURITY.md) |
| Cloudflare deployment | partial: dry-run bundle and `wrangler dev` verified; **no real deployment yet** |
| Monitoring and alerting | not started (Workers observability flag only) |
| Exports | CSV/JSON done; Parquet export not started; chart PNG/SVG export not started |

## Next steps, in priority order

1. Ingest more 2024–2025 weekends (`--channels timing` is enough), run `lemontea-analytics backtest` and `calibrate`, and activate parameters only if coverage passes.
2. Finish the web modes (Performance Intelligence, Strategy, Research) and add Playwright end-to-end tests.
3. Verify the F1 account integration with a real subscription: sign-in, ingest a 2025 session via `f1lt` and compare its laps with `openf1` for the same session key, then live mode during a session (also an authorised OpenF1 account), including latency display and Durable Object fan-out on Cloudflare.
4. Add a licensed official corner and circuit-metadata source (turn names, DRS/active-aero zones, pit lane).
5. Calibrate SC/VSC, overtaking and DNF rates per circuit from historical races.
6. Archive raw provider payloads to R2/S3 (the `raw_payloads` table exists but is unused).
7. Traffic detection from position data (`gapAhead` for the lap classifier).
8. User management, MFA, JWT key rotation, platform rate limiting on Cloudflare.
9. Run FastF1 cross-validation (`validate-fastf1`) and document the results.
10. Evaluate ClickHouse only if benchmarks show TimescaleDB bottlenecks; WebGPU rendering; Parquet export.
