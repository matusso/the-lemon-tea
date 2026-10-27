# Prediction models

All predictions are labelled **estimated** or **simulated** and carry assumptions, a model version and a params version. Probabilities are reported as `uncalibrated_probability` unless the active parameter set has `calibrated: true`.

**Current status:** no trained `pace` model version has been activated. Every installation therefore uses the documented priors below, and probabilities are uncalibrated.

## Lap classification (`lap-classifier-v1`)

`classifyLaps` in `telemetry-core/src/classify.ts`. A lap can carry several classes. `primary` is picked by precedence:

no_time > out_lap > in_lap > interrupted > traffic_affected > qualifying_simulation > long_run > push > cooldown > unrepresentative

| Rule | `DEFAULT_CLASSIFIER_CONFIG` |
|---|---|
| push: lap ≤ session best × (1 + pushThreshold) | `pushThreshold = 0.03` |
| long run: ≥ `longRunMinLaps` consecutive laps in one stint (no out/in/interrupted/no-time laps), each within `longRunBand` of the run median | `longRunMinLaps = 5`, `longRunBand = 0.04` |
| unrepresentative (inside a run): robust z = (t − median)/max(MAD, 0.05) > `outlierZ` | `outlierZ = 3` |
| cooldown: lap > driver best × (1 + cooldownThreshold) | `cooldownThreshold = 0.1` |
| traffic: gap to car ahead < `trafficGap` s (only when `gapAhead` is supplied; the domain layer does not supply it yet) | `trafficGap = 1.0` |
| qualifying simulation: push lap with tyre age ≤ `qualiSimMaxTyreAge`, not an out-lap | `qualiSimMaxTyreAge = 2` |
| out_lap: `isPitOutLap` or first lap of a new stint; in_lap: lap with a pit event or followed by a pit-out lap | |
| interrupted: lap overlaps a neutralised period derived from race control (yellow, double yellow, SC, VSC, red; closed by GREEN/CLEAR, "VSC ENDING" or "SAFETY CAR IN THIS LAP") | |

## Model priors (`DEFAULT_PACE_PARAMS`, version `priors-2026.1`)

| Parameter | Value |
|---|---|
| `fuelEffectPerLap` | 0.06 s/lap (sd 0.015) |
| `compoundOffsetPrior` vs SOFT | MEDIUM 0.45 s, HARD 0.85 s, INTERMEDIATE 0, WET 0 |
| `degradationPrior` (slope / sd, s/lap) | SOFT 0.09/0.06, MEDIUM 0.06/0.04, HARD 0.04/0.03, INTERMEDIATE 0.08/0.08, WET 0.08/0.08 |
| `qualifyingImprovement` | mean 0.6 s, sd 0.35 s |
| `trackTempSensitivity` | 0.015 s/°C |
| `calibrated` | false |

`paceParams()` merges the active `model_versions` row of family `pace` over these priors.

## Qualifying forecast (`quali-practice-v2`)

`predictQualifying` (`telemetry-core/src/qualifying.ts`), run by `QualifyingPredictionService` with 5,000 iterations and seed 7:

1. **Candidate laps:** push or qualifying-simulation laps that are not interrupted, traffic-affected, out-laps or in-laps.
2. **Session evolution:** every session is shifted onto the scale of the latest session that has push laps. The offset is the median over common drivers of (latest-session best − this-session best). It needs ≥ 3 common drivers; otherwise the offset is 0 and a warning is emitted.
3. **Compound offset** vs SOFT: the median over drivers who set push laps on both compounds in the same session. It is used if ≥ 4 pairs exist and the median is positive; otherwise the prior is used. Each offset is reported with its source.
4. **Point estimate:** per session, the driver's best adjusted lap; these are averaged with recency weights `w = session index + 1` (FP1 = 1, FP2 = 2, FP3 = 3), then `qualifyingImprovement.mean` is subtracted. v1 used the single best adjusted lap over all sessions; that minimum is biased toward drivers with more attempts and toward outlier laps (e.g. slipstream at Monza), and was replaced.
5. **Uncertainty:** `σ² = 0.12² + min(0.5, between)²/k + [0.15² if the best lap is compound-adjusted] + [0.10² if k > 1] + 0.15²`. Here `k` is the number of sessions with push laps, `between` is the sd of the per-session estimates (0.25 when k = 1), and the final 0.15² term stands for unknown practice fuel load and engine mode. Lap-time interval at level 0.8: `±z·√(σ² + improvement.sd²)`.
6. **Monte Carlo:** independent normal draws per driver. The improvement term is shared by everyone, so it does not affect ranks. Outputs: rank distribution, expected rank, P(pole), P(front row), P(advance Q1) = P(rank ≤ 10 + ⌊(n − 10)/2⌋), P(advance Q2) = P(top 10), teammate gap mean and sd.
7. **Explanation per driver:** strongest relative sector against the field median of best sectors, gap to the car ahead, and the uncertainty drivers.

### Single-weekend check (2025 Italian GP, FP1–FP3 → qualifying)

Run against real OpenF1 data with default (uncalibrated) priors. One weekend is a sanity check, not calibration evidence.

| Metric | v1 (single best lap) | v2 (recency-weighted per-session) |
|---|---|---|
| Spearman (expected rank vs actual position) | worse: SAI projected 1st (actual 13th), NOR 9th (actual 2nd) | 0.747 |
| Predicted top-5 set vs actual top-5 set | 3 of 5 | 5 of 5 (VER, NOR, PIA, LEC, HAM) |
| Lap-time MAE vs each driver's best qualifying lap | — | 0.345 s |
| 80 % interval coverage | — | 18 / 22 (82 %) |

Drivers eliminated in Q1/Q2 only set laps on an earlier, slower track, which inflates the lap-time MAE.

## Race pace (`race-pace-v1`)

From long-run fits (see [TYRE_DEGRADATION.md](TYRE_DEGRADATION.md)):

- **Reference pace per run** = fuel-corrected pace at tyre age 5, shifted to MEDIUM: `(paceAtAge1 − pooledSlope) + 5·pooledSlope + (prior[MEDIUM] − prior[compound])`.
- **Driver pace** = lap-weighted mean over runs. `se = √(consistency²/laps + [0.1² if one run] + 0.5²)`, where 0.5 s (`FUEL_LOAD_SD`) is the unknown between-driver fuel-load sd. Practice fuel loads plausibly differ by 20–40 kg (≈ 0.7–1.4 s); the earlier 0.25 s made race forecasts overconfident. Interval at level 0.8.
- **Team pace** = mean of its drivers' pace.
- `paceByAge` gives ages 1–30 on the driver's most-used compound.

## Persistence, history and leakage

`predict_qualifying` with `persist=true` (signed-in callers only) stores a `predictions` row with:
- `model_version`, `params_version`,
- `input_hash` = sha256 of (sessions, as_of, params version),
- `as_of` = the latest lap end among the input data,
- the full output.

The previous snapshot for the same meeting is diffed into `changesSincePrevious`.

`get_prediction_history` scores qualifying snapshots against the actual result of the given qualifying session:
- lap-time MAE,
- Spearman correlation of expected rank against actual position,
- pole Brier score.

`validForEvaluation` is true only if `as_of` is earlier than the qualifying session start, so a forecast made with later data is never treated as genuine.

## Offline backtesting and calibration (Python)

`services/analytics/src/lemontea_analytics/qualifying.py`, run via the `lemontea-analytics` CLI.

- **Data:** public sessions only. Practice laps that started after qualifying are excluded (leakage guard, covered by a test).
- **Target:** each driver's qualifying best as gap to pole.
- **Rolling origin:** weekend *k* is predicted from weekends < *k* (asserted). At least 4 training weekends are required; otherwise the result is `insufficient_data`.
- **Models:**
  - `baseline_latest`: gap in the driver's latest practice session,
  - `baseline_median`: median gap across practice sessions,
  - `ridge` (α = 1),
  - `hgb`: HistGradientBoosting (depth 3, 150 iterations, learning rate 0.05).

  Features: latest, median and minimum gap, push-lap count, sessions, team mean gap. The report states whether the ML models beat both baselines.
- **Metrics:** MAE, RMSE, Spearman, pole Brier, pole log-loss, 80 % interval coverage. Each model's residual sd is estimated on its training data only.
- **Calibration:** `calibrate` estimates `qualifyingImprovement` (latest-session practice best − qualifying best, 5–95 % trimmed; needs ≥ 20 driver-weekends). It writes a `pace` model version marked `calibrated: true` only if the baseline's backtest 80 % coverage lies within [0.75, 0.85]. The version is stored as `candidate` unless `--activate` is passed.

The pipeline is tested on synthetic weekends. It has not yet been run against a real season: only the 2025 Monza weekend has been ingested, which is below the 5-weekend minimum. Ingesting at least `timing` for more weekends is the next step.

## Race result forecast

`predict_race_result` runs the strategy simulator for the whole field (see [STRATEGY_SIMULATION.md](STRATEGY_SIMULATION.md)). Its output is labelled `simulated` and `uncalibrated_probability`.
