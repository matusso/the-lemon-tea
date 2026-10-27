# Tyre degradation (`tyre-degradation-v1`)

Code: `telemetry-core/src/degradation.ts`; service `TyreModelService`; tools `estimate_tyre_degradation` and `compare_tyres`.

## Inputs

Only laps classified `long_run` (and not `unrepresentative`) are used, grouped into runs. See [PREDICTION_MODELS.md](PREDICTION_MODELS.md#lap-classification-lap-classifier-v1). Tyre age comes from stints (`tyreAgeAtStart + lap − lapStart`). When the set's history is unknown, age falls back to the run's start age plus the lap index.

## Per-run fit

- **Fuel correction** (fuel is never measured): `fc_i = t_i + fuelEffectPerLap · i`, where `i` is laps into the run. Later laps are lighter, so adding the term back removes the fuel-burn improvement. Default 0.06 s/lap.
- `rawSlope`: Theil–Sen slope of raw lap time against lap index. This mixes fuel and tyre effects.
- `degradationSlope`: Theil–Sen slope of `fc` against tyre age (robust to ~29 % outliers). Its standard error uses the OLS formula on the residuals, defaulting to 0.05 when undefined.
- `quadratic`: least-squares `a + b·age + c·age²`.
- Also reported: mean, median, robust sd (MAD × 1.4826), pace at age 1, mean track temperature.

## Partial pooling (empirical Bayes, per compound)

For a compound with stints *j*, slopes *s_j*, standard errors *se_j* and prior `(μ₀, σ₀)`:

- Pooled mean `m`: inverse-variance weighted mean of `s_j` if there are ≥ 3 stints; otherwise `(μ₀ + n·mean(s))/(1 + n)`.
- Observed variance: `var = Σ(s_j − m)²/(n − 1)` (prior variance `σ₀²` when n = 1).
- `τ² = max(σ₀² · (n < 4 ? 1 : 0.25), var − mean(se²))`
- Shrinkage: `k_j = τ²/(τ² + se_j²)`; `pooledSlope_j = k_j·s_j + (1 − k_j)·m`

## Compound report

| Field | Definition |
|---|---|
| `slope` | lap-weighted mean of pooled slopes (s/lap) |
| `slopeInterval` | `slope ± z·√(se² + fuelEffectSd²)` at level 0.8, where `se` = sd of pooled slopes/√n (or the single stint's se). `calibrated: false` |
| `cliffIndicatorShare` | share of stints with quadratic coefficient `c > 0.004`. **Heuristic, not a probability** |
| `lapsToOneSecondLoss` | `round(1/slope)` if slope > 0.005, else null |
| `lossCurve` | `slope·age` for ages 0–40, signed (never clamped) |
| `warning` | set when the slope is negative: track evolution and/or a larger fuel effect than assumed outweigh tyre loss, so degradation is not identifiable from these runs. On 2025 Monza FP1–FP3 this fired for MEDIUM (−0.013 s/lap) and HARD (−0.018 s/lap) |

## Model comparison

For each stint with ≥ 8 laps, models are fitted on all but the last 3 laps and scored by mean absolute error on those 3. Models: OLS linear, Theil–Sen, quadratic, and pooled linear (pooled slope with a median intercept). The comparison is reported per request in `modelComparison`.

## Confounders and limits

- The fuel effect is an assumption. A wrong value biases the slope, and a unit test demonstrates this.
- Track evolution within a run is not separated; in practice sessions it biases slopes downward.
- Driver management, engine modes and traffic beyond the classifier rules are not observed.
- **No tyre temperatures or pressures are available**, and none are displayed. Inferred thermal quantities (warm-up likelihood, overheating risk) are **not implemented**.
