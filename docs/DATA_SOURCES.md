# Data sources

The governance registry is the `data_sources` table, seeded by `database/migrations/0002_reference_data.sql` (and `0004_f1_livetiming.sql` for `f1lt`). Licensing fields record what the project knows. **They grant no rights.** Operators must check current provider terms.

| id | Name | Redistribution | Public display (default) | Enabled | Coverage |
|---|---|---|---|---|---|
| `openf1` | OpenF1 (v1) | `non_commercial` | **false** | true | 2023 onwards |
| `jolpica` | Jolpica-F1 (Ergast-compatible) | `unknown` | false | true | 1950 onwards (results) |
| `f1lt` | F1 Live Timing (the user's own Formula 1 account) | `forbidden` | **false** (private-only) | true | 2018 onwards; live while sessions run |
| `fastf1` | FastF1 (Python library, 3.x) | `unknown` | false | true | 2018 onwards |
| `file_import` | User file import | `unknown` (importer's responsibility) | false | true | any |
| `synthetic` | Synthetic development fixtures | `permitted` | true | true | n/a, **not real data** |
| `f1tv` | F1 TV placeholder | `forbidden` | false | **false** | none |

## OpenF1

- **Recorded terms:** unofficial community API. Historical data is free for non-commercial use; real-time access needs an authorised paid account. The attribution text is stored in the registry and returned by `get_session_info`.
- **Endpoints used:** `sessions`, `meetings`, `drivers`, `laps`, `stints`, `pit`, `race_control`, `weather`, `team_radio`, `position`, `intervals` (race/sprint only), `session_result`, `car_data`, `location`. Live polling uses the same endpoints with `date>cursor`.
- **Rate limit:** the API responded "Max 3 requests/second" during development. The adapter defaults to 2.5 req/s with a burst of 3.
- **Ingestion cost:** one qualifying session took about 7 minutes to ingest (349,040 car samples and 296,543 positions for 20 drivers), bounded by the rate limit.

### Channels and units

| Channel | Kind | Unit / note |
|---|---|---|
| speed | measured | km/h, quantised to 1 km/h, ~3.7 Hz |
| throttle | measured | %, clipped to 0–100 |
| brake | measured | source reports 0/100; stored as binary 0/1. **Not brake pressure** |
| rpm, n_gear | measured | |
| drs | measured | raw source code; `null` for 2026 sessions, and dropped when every sample is null |
| x, y, z | measured | **decimetres** in the source frame, converted to metres (see below). `(0,0,0)` is treated as "no fix" and dropped |
| lap distance, acceleration | calculated | from speed |
| brake pressure, steering, tyre temperature/pressure, fuel, ERS state | unavailable | |
| active aero state, overtake mode state | unavailable | 2026 concepts the source does not expose |

**Position units verified:** the summed x/y path length of VER lap 20 of the 2025 Monza race was 57,464 source units, against 5,730 m from integrating measured speed. A ratio of 10.0 means decimetres. The scale is `POSITION_SCALE = 0.1` in `packages/providers/openf1/src/index.ts`.

**Known gaps:**
- Session `date_end` can be earlier than the last lap (overruns, red flags). The timing bundle uses `max(date_end, last lap end)`.
- Some laps have no `date_start` or `lap_duration`. Those laps are excluded from telemetry analysis, never filled.
- Intervals exist only for races and sprints.

## F1 Live Timing (`f1lt`, your Formula 1 account)

The first-party feed behind FastF1 (`packages/providers/f1-livetiming`): the archive at `livetiming.formula1.com/static/<year>/...` and the live SignalR Core hub at `wss://livetiming.formula1.com/signalrcore`.

- **Access:** since 2025 the archive answers **401** without an F1 TV subscription token (verified). Each user connects their own Formula 1 account (see [AUTHENTICATION.md](AUTHENTICATION.md#provider-accounts)); every request carries that user's token. Without a connected account the provider refuses to fetch.
- **Private only:** ingestion refuses `public` visibility for `f1lt`, and the registry row has `public_display_allowed = false`, `redistribution = forbidden`. Loaded sessions are visible only to the connecting tenant.
- **Session ids:** `f1lt:<year>-<F1 session key>`, e.g. `f1lt:2025-9908`. The key is the same as OpenF1's `session_key`, but the two are separate sessions in the platform.
- **Streams read:** `Index.json`, `Heartbeat`, `DriverList`, `TimingData`, `TimingAppData`, `RaceControlMessages`, `WeatherData`, `SessionStatus`, `TeamRadio`, `CarData.z`, `Position.z`. `.jsonStream` records are `HH:MM:SS.mmm` offsets plus JSON; `.z` payloads are base64 raw-deflate. Decode failures are counted in the quality report, never guessed.
- **Rate limit:** conservative 2 req/s per tenant instance. Each car/position stream is downloaded once per ingest and sliced per window.

### Parsing (port of FastF1 `_api`, MIT)

- **Time origin:** `max(Utc − stream offset)` over `Heartbeat` records (fallback: `CarData`), as FastF1 does.
- **Laps:** FastF1's reconstruction rules from `TimingData`: two passes, a 5 s window for late values, lap times > 150 s accepted only when the sectors add up (Q1/Q2/Q3 gaps), back-fill of repeated sector/lap values, and lap end times synchronised to the least-delayed sector timestamp. Integrity errors are recorded per driver in the quality report.
- **Stints** from `TimingAppData` (list and index-keyed forms); a stint starts on the lap in progress when its tyre set first appears. **Pit events** from `InPit`/pit-out; lane times > 120 s are treated as garage visits (`laneDuration = null`). **Positions and intervals** from `TimingData` (intervals for race/sprint only). **Results:** final position, laps, best lap (non-race) and `dnf` from `Retired` (race). Drivers declared more than 60 min after the stream start are ignored, as in FastF1.
- **Team radio:** timestamps only. Recording URLs are dropped because they require the subscriber's token.
- **Differences from FastF1:** an out-lap starts at the pit exit when that is later than the previous lap's end (FastF1 uses the previous lap end); mini-sector status codes and personal-best flags are not parsed.

### Channels

The same channels as OpenF1, because OpenF1 republishes this feed: speed (km/h, 1 km/h steps), throttle, **binary** brake, rpm, gear and the raw DRS code (absent from 2026) at ~3.7 Hz; position X/Y/Z in 1/10 m converted to metres at ~4 Hz. **A Formula 1 account does not unlock richer telemetry:** brake pressure, steering, tyre temperatures/pressures, fuel and ERS state are not in the feed. What it adds is the first-party source, availability shortly after each session, and live access.

### Live

SignalR Core JSON protocol: negotiate (Bearer token + `AWSALBCORS` load-balancer cookie), WebSocket handshake, `Subscribe` to the timing topics, then `feed(topic, patch, utc)` messages merged into state; pings every 15 s. Frames are applied strictly in arrival order. Live laps are approximated from `NumberOfLaps`/`LastLapTime` patches.

### Verification status

Verified: the archive's 401 without a token; parsing of the real sign-in configuration and the `/as/authorize` step; rejection of an invalid token by the real archive (connection marked expired). **Not yet verified:** the credential submit and token exchange, parsing of a real archive session, and the live feed during a running session. All three need a real F1 TV subscription.

## Jolpica-F1

Ergast-compatible results, qualifying, sprint and race lap times (`packages/providers/jolpica`). Session keys look like `2024-5-R`, `2024-5-Q`, `2024-5-S`. It has no telemetry and no positions; capabilities mark those channels unavailable. Laps have no start timestamps. Team colours are not provided (`888888`). The adapter is implemented but has not been exercised end to end against the live API.

## File import

User-supplied data (`packages/providers/file-import`), always stored privately for the importing tenant. It is validated with zod; rejected rows are reported (first 100) and never repaired. Formats: JSON arrays, CSV (RFC 4180) and Parquet (via `hyparquet`). See [API.md](API.md) (section "Ingestion and imports") for the payload.

| Table | Required columns |
|---|---|
| car | `date` (ISO-8601 with offset), `driver_number`, `speed` (0–450 km/h), `throttle` (0–104, clipped to 100), `brake` (0–100, >0 means on); optional `rpm`, `n_gear` |
| location | `date`, `driver_number`, `x`, `y` (metres); optional `z` |

## FastF1

Used only by `services/analytics/src/lemontea_analytics/fastf1_validation.py` to compare stored lap times with FastF1's for one session. Its data stays in a local cache and is never stored or redistributed. Install it with `uv sync --extra fastf1`. FastF1 ≥ 3.9 needs a Formula 1 account because the archive requires a token: run `uv run python -m fastf1 auth f1tv` once (or set `F1_USERNAME`/`F1_PASSWORD`). **This path has not been executed yet.**

## 2026 regulations

Sessions from 2026 onwards have `regulation_era = active_aero_2026`. DRS does not exist under those rules: `get_data_availability` reports the `drs` channel as unavailable for these sessions, and OpenF1 returns `drs: null`. Active aero and overtake-mode states are separate concepts. They are listed as unavailable because no connected source exposes them.
