# Strategy simulation (`race-sim-v1`)

Code: `telemetry-core/src/strategy.ts`; field assembly in `StrategySimulationService` (`packages/domain/src/services/predictions.ts`). Outputs are labelled **simulated**. Interactive calls are capped at 2,000 iterations; larger runs go through `create_analysis_job`.

## Lap model

For each car on each lap:

```
lapTime = pace + compoundOffset[c] + m_c·(slope_c·age + quad_c·age²) − fuelEffect·(lap − 1) + N(0, lapNoiseSd)
          + outLapPenalty (first lap on new tyres) + 1.5 s (lap 1, standing start)
```

- `pace = basePace + N(0, paceSd) + trackTempSensitivity·trackTempDeltaC`, drawn once per race.
- `m_c = exp(N(0, degradationLogSd))`, drawn per compound per race.
- Cars start 0.25 s apart in grid order.
- **SC:** every lap time = mean field pace × 1.4. When the SC ends, the order is kept and gaps compress to 0.6 s.
- **VSC:** lap time × 1.35, gaps preserved.
- Neutralisations can only begin between lap 2 and lap T − 2. Durations are uniform within `scDurationLaps` / `vscDurationLaps`.
- **Pit stop:** `pitLaneLoss × factor + LogNormal(stationaryMedian, stationaryLogSd)`, where factor is `scPitLossFactor` under SC and `vscPitLossFactor` under VSC.
- **Opportunistic stops:** under SC or VSC, a car whose next planned stop is within `opportunisticWindow` laps pits immediately. Its later stops shift by the same amount.
- **Overtaking:** cars are processed in running order. If a car would finish the lap within 0.2 s of the car ahead (neither pitting, no SC):
  - `advantage = lapTime(ahead) − lapTime(me)`
  - `threshold = 0.2 + 0.8·d`
  - `pPass = clamp(1 − exp(−max(0, advantage − threshold)/(0.3 + d)), 0, 0.95)`, with `d = overtakeDifficulty`
  - A failed pass sets the follower to `ahead + 0.3 + dirtyAirLoss`.
- **DNF:** per-lap hazard `1 − (1 − dnfProbability)^(1/T)`.
- **Traffic after a pit stop:** the car rejoins within 1.5 s behind another car.
- **Classification:** laps completed (descending), then cumulative time.

## Defaults (`DEFAULT_SIM_PARAMS`): uncalibrated priors

| Parameter | Value |
|---|---|
| pitLaneLoss | 20 s |
| stationaryMedian / stationaryLogSd | 2.6 s / 0.25 |
| scProbabilityPerLap / vscProbabilityPerLap | 0.012 / 0.008 |
| scDurationLaps / vscDurationLaps | [3, 6] / [1, 3] |
| scPitLossFactor / vscPitLossFactor | 0.45 / 0.6 |
| fuelEffectPerLap | 0.06 s |
| compoundOffset vs MEDIUM | SOFT −0.45, HARD +0.4, INTERMEDIATE +4, WET +8 s |
| degradation slope / quad | SOFT 0.09/0.0015, MEDIUM 0.06/0.0006, HARD 0.04/0.0003, INTER/WET 0.08/0.001 |
| degradationLogSd | 0.25 |
| lapNoiseSd | 0.25 s |
| overtakeDifficulty | 0.5 |
| dirtyAirLoss | 0.25 s |
| outLapPenalty | 0.6 s |
| dnfProbability | 0.06 |
| opportunisticWindow | 6 laps |
| trackTempSensitivity / trackTempDeltaC | 0.015 s/°C / 0 |

## Field assembly

- **Pace:** each driver's gap to the field is an inverse-variance fusion of two measurements: the practice long-run gap (race-pace reference pace − 5 × mean degradation, minus the field median; variance from its interval, which includes the 0.5 s fuel-load sd) and, when `gridSessionId` is given, the qualifying one-lap gap (best measured lap minus pole, centred on the field median; variance 0.3² for how imperfectly one-lap pace transfers to race pace). `paceSd = max(0.15, √(1/Σw))`. If only one source exists it is used alone (qualifying-only adds 0.2² variance). Drivers with neither get field median + 1.0 s, `paceSd` 0.6, and a note. A fuel offset `fuelEffectPerLap × totalLaps / 2` (practice runs assumed at about half race fuel) shifts every car equally.

### Single-race check (2025 Italian GP)

Forecast from FP1–FP3 + qualifying grid, 2000 iterations, uncalibrated priors. Long-run pace alone gave ALO P(win) 0.65 (he retired; VER won, NOR second): practice fuel loads dominate. With the 0.5 s fuel sd and qualifying fusion: P(win) NOR 0.47, VER 0.48; expected top six {NOR, VER, PIA, HAM, RUS, LEC} equals the actual top-six set. One race is a sanity check, not calibration.
- **Degradation:** compound slopes from the degradation report (minimum 0.01) replace the defaults; quad terms stay at the defaults.
- **Grid:** the given qualifying session's results; otherwise the race's first position records; otherwise car-number order (noted).
- **Pit loss:** the median of measured lane durations in (10, 60) s, minus 3 s, if ≥ 3 stops are present; otherwise the default (noted).
- **Total laps:** the request value, or the race's maximum lap number.
- **Other cars** use the deterministic tyre-only optimum `bestDeterministicStrategy`. It searches 1 and 2 stops, minimum stint 6 laps (second-stint length in steps of 2 for 2 stops), dry compounds only, and enforces the two-compound rule. Stop cost = pitLaneLoss + stationaryMedian + outLapPenalty.

## Study output (`simulateStrategies`)

- **Common random numbers:** iteration *i* uses `Rng(seed·100003 + i)` for every candidate, so differences between strategies are not noise between runs.
- Per strategy:
  - planned pit laps,
  - position distribution, expected position, expected race time (finishers),
  - P(win), P(podium), P(points), DNF share,
  - expected positions gained vs grid,
  - traffic risk after a pit stop,
  - first-stop undercut gain = old-tyre lap cost at stop − (new compound offset + out-lap penalty).
- **Sensitivity:** degradation × 1.3, × 0.7, no neutralisations, SC probability × 2. Each uses `max(100, iterations/4)` iterations and seed + 1, and is reported as the change in expected position.
- **Head-to-head:** share of paired iterations where A finishes ahead of B (ties count ½).
- **Recommendation:** the best expected position. The objective is stated explicitly. `distinguishable` is true only if the best strategy beats the runner-up in ≥ 60 % of paired iterations. The output never claims a strategy is optimal without that context.

Stint lengths that don't sum to the race distance are corrected by adjusting the last stint.

## Limitations

- SC/VSC rates, overtaking difficulty and DNF rate are uncalibrated and not circuit-specific.
- Weather transitions and red flags are not modelled; intermediate and wet compounds exist only as offsets.
- Blue flags and lapped traffic are not modelled separately.
- Track evolution is not modelled during the race.
