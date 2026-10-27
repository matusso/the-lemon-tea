# Telemetry engine and synchronisation

Code: `packages/telemetry-core` (algorithms) and `packages/synchronization` (timeline, tower, interpolation, clock).

## Coordinate systems

Four coordinate systems are kept separate:

| System | Representation | Used for |
|---|---|---|
| UTC | ISO-8601 strings in bundles, epoch ms in sample arrays | authoritative source timestamps |
| Session time | `tMs` = ms since `session.dateStart` | replay, live, timing tower, events, MCP `tMs` parameters |
| Lap time | seconds since a lap's `dateStart` | `DistanceTrace.time` |
| Lap distance | metres from the start/finish line on the normalised lap | comparisons, corners, track clicks |

Helpers: `toSessionMs` and `toUtcIso` in `synchronization/src/timing.ts`.

## Interpolation (`interpolate.ts`)

| Channel type | Method |
|---|---|
| Continuous (speed, throttle, RPM, x/y, time-on-distance) | linear |
| Discrete (gear, brake, DRS code) | step (the previous sample holds) |
| Outside the sampled range | `NaN` (the `interpLinearClamped` variant clamps; used only at lap edges) |
| Gaps > `MAX_SAMPLE_GAP_MS` = 1500 ms | not bridged for positions (`NaN`) |

Original samples are never modified. Interpolated grid values carry `measuredMask[i] = true` only where a raw sample lies within half a grid step (in time) of the grid point.

## Lap distance (`distance.ts`, `lap-distance-v1`)

1. Take car samples in `[lapStart − 2 s, lapEnd + 2 s]`, where `lapEnd = lapStart + lapTime`.
2. Integrate speed by the trapezoid rule: `d_i = d_{i−1} + (v_i + v_{i−1})/2/3.6 · Δt`. Gaps above 1.5 s are integrated with the mean of the bounding speeds and counted as gaps.
3. Shift so that `d(lapStart) = 0`. Scale so that `d(lapEnd) = referenceLength`. A comparison uses the mean of the two laps' integrated lengths; a single lap uses its own. The scaling forces the start and finish lines to coincide, so the final delta equals the timed lap-time difference.
4. Build a distance grid (default 5 m) that always includes the finish line. On it, interpolate time (linear), continuous channels (linear) and gear/brake (step).
5. Longitudinal acceleration (m/s²) is the central difference of speed over time on the grid, smoothed with a 5-point moving average (≈25 m at 5 m steps), because speed is quantised to 1 km/h at about 4 Hz.

A warning is emitted if the integrated lengths differ by more than 2 % (e.g. a pit-lane pass or a layout change).

## Delta noise floor

`DELTA_NOISE_FLOOR_SECONDS = 0.04`. Two identical synthetic laps sampled with different sample phase (≈3.7 Hz, jittered, 1 km/h quantisation) differ locally by up to about 35 ms (`comparison.test.ts`, "identical laps produce ~zero delta"). Section deltas below 0.04 s are therefore not explained, and every comparison reports `noise_floor_seconds`.

## Decimation

`decimateIndices` uses min/max bucketing. Each bucket keeps its minimum and maximum samples, so braking points and top speeds survive. `get_telemetry` defaults to 1,000 points (maximum 5,000). Time windows are limited to 30 minutes; replay windows to 10 minutes.

## Synchronisation package

| Function | Purpose |
|---|---|
| `timingTower(bundle, tMs)` | Tower using only data timestamped at or before `tMs`: position (race: position feed; practice/qualifying: ordered by best lap), gaps (race: interval feed, `gapKind: "measured"`; otherwise calculated from best laps), last/best lap, in-progress sectors, personal-best sectors, compound and tyre age from stints, pit count, status (running / in_pit / retired / finished / not_started), positions gained, pace trend (Theil–Sen slope of the last ≤5 laps within 107 % of best) |
| `trackStatusAt` | green / yellow / sc / vsc / red / chequered / unknown, derived from race-control flags and messages |
| `weatherAt` | latest observation at or before `tMs` |
| `buildTimeline` | merged, sorted event list: flags, SC/VSC, red flag, investigations, penalties, pit stops, team radio, race start, retirements (approximate time) |
| `positionAt(samples, t)` | linear position between samples at most 2 s apart. Labelled `measured` if a real sample is within 60 ms, otherwise `interpolated`, together with `sampleAgeMs`. Returns `null` (unknown) across larger gaps instead of drawing a guessed path |
| `PlaybackClock` | shared clock. Rates `0.25, 0.5, 1, 2, 4, 8, 16`; play, pause, seek, ±step, step to next/previous event. High-frequency consumers read `now()` in their own animation loop |

The server (`TimingService`, MCP `get_timing`) and the browser call the same functions on the same `TimingBundle` (`GET /api/sessions/:id/bundle`).

## Session end

`TimingBundle.endMs = max(scheduled date_end, last lap end) − dateStart`, because sessions overrun. Using only the scheduled end originally dropped the pole lap of 2025 Monza qualifying from the tower.
