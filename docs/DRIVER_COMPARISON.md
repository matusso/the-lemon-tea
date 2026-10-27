# Driver comparison

Code: `telemetry-core/src/{comparison,delta,corners,explain}.ts`, exposed via `LapComparisonService`, `POST /api/analysis/*` and the MCP tools `compare_laps`, `analyze_corner`, `analyze_braking`, `analyze_acceleration` and `get_lap_delta`.

## Inputs

Each side is `{sessionId, driverNumber, lapNumber?}`. The default lap is the driver's fastest valid lap. Laps may come from different drivers, sessions or seasons:

| Case | Warning added | Effect |
|---|---|---|
| Different sessions | `cross_session` | none |
| Different seasons | `different_seasons` | none |
| Different circuits | `different_circuits` | data quality set to `insufficient` |

## Delta

Convention **A_minus_B**: `delta(d) = tA(d) − tB(d)`.

- Negative means A reached distance `d` earlier: A is ahead.
- A section change `delta(d2) − delta(d1)` uses the same sign, so negative means A gained in that section.
- Because of distance scaling, `delta(L)` equals `lapTime(A) − lapTime(B)`.

Outputs:
- cumulative delta,
- largest lead and largest deficit for A,
- sector deltas (measured sector times; boundaries located on lap B),
- 25 equal mini-sectors,
- per-corner and per-straight deltas.

Corner windows and straights partition the lap, so their deltas sum to the lap delta.

## Corner detection (`corner-analysis-v1`)

Corners are detected on the element-wise **minimum** of both laps' speed. This keeps the analysis consistent when one driver lifts and the other does not.

| Parameter | Value |
|---|---|
| Smoothing | moving average, `max(3, round(25 m / step) | 1)` points |
| `minProminence` | 12 km/h rise to the higher of the left/right peaks (searched ±1500 m) |
| `mergeDistance` | 120 m (chicanes collapse to their slowest point) |
| `tractionZone` | 120 m after full throttle (min throttle ≥ 95 %) |
| Window | from the speed peak before the corner to `min(next peak, full throttle + 120 m)`; overlaps trimmed |
| Speed band | min speed < 130 km/h `low`, < 210 `medium`, else `high` |

Numbering is sequential (`C1`, `C2`, …), not official turn numbers.

## Corner metrics (per driver)

| Metric | Definition |
|---|---|
| `brakeStart` / `brakeEnd` | first brake-on sample in the window (searched up to 5 grid points past the minimum) and the following release. The brake channel is binary |
| `brakingDistance`, `brakingDuration` | from brakeStart to brakeEnd |
| `approachSpeed` | speed at window start |
| `entrySpeed` | speed at brake start, or at lift (throttle < 95 %) if there is no braking |
| `minSpeed`, `minSpeedDistance` | speed minimum: the "speed apex", **not** a measured racing-line apex |
| `throttleOn` | first point after the minimum with throttle > 20 % and non-decreasing |
| `fullThrottle` | first point with throttle ≥ 95 % |
| `exitSpeed` | speed at window end |
| `exitAcceleration` | (exit speed − min speed) / time, in m/s² |

**Phases:**
- entry: window start → mean of both drivers' brake release (or the speed minimum if neither brakes),
- mid: → mean throttle-on point,
- exit: → window end.

Boundaries are clamped to be monotonic. The dominant phase is the one contributing most in the direction of the corner's total delta.

**Apex policy:** `apexAssessment.status` is always `not_determinable`. An apex hit/miss judgement needs track boundaries and sub-metre positions; the data has about 4 Hz positions with metre-level noise.

## Explanations (`explain-v1`)

Deterministic templates filled with computed numbers. Only corners and straights with |delta| ≥ 0.04 s (the noise floor) produce findings.

| Dominant phase | Factor chosen |
|---|---|
| entry | `braking_point` if the gainer braked > 4 m later, else `entry_speed` |
| mid | `minimum_speed` |
| exit | `throttle_application` if throttle came on > 4 m earlier, else `exit_acceleration` |
| straight (> 50 m between windows) | `straight_line_speed`, with the caveat that power, drag, slipstream and DRS/active aero are not separable |

Each finding includes an `evidence` object: brake-point difference, min-speed difference, throttle-on difference, exit speed and acceleration differences, dominant phase and its share. The share is relative to the gross (absolute) phase movement in the corner, so it never exceeds 100 %; when phases partly cancel (gross movement > 2 × |net| + 0.02 s) the finding says so and `phases_offsetting` is "yes". The summary lists the up to three largest findings that agree in sign with the lap delta. No brake pressure, steering, tyre slip or setup quantities are used, because none are available.

## Confidence

`confidence` is an **algorithmic quality score** (`confidence_type: "algorithmic_quality_score"`), not a probability:

`score = clamp(min(1, samplesPerSecond/3.5) − 0.05·gaps − 5·lengthMismatch, 0, 1)`

where `samplesPerSecond` uses the sparser of the two laps. Data quality is `high` (> 0.8), `medium` (> 0.6), `low` (> 0.3) or `insufficient`.

## Test evidence

`comparison.test.ts` (synthetic fixture with exact ground truth, not real data) checks:
- integrated length within 0.5 % of the true 4,200 m,
- final delta equals the lap-time difference,
- identical laps stay within the noise floor,
- all 4 corners detected within 30 m of the true apex,
- 25 m later braking attributed to `braking_point` in the entry phase, with the measured difference within 10 m of truth,
- stronger acceleration attributed to exit,
- corner and straight deltas sum to the lap delta.

On real data (2025 Monza qualifying, VER vs NOR) the delta was −0.077 s, matching the official gap.
