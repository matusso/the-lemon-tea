"""Practice -> qualifying: features and rolling-origin backtesting.

Target: each driver's best qualifying lap as gap to pole (seconds).
Features use ONLY practice laps that started before qualifying of the same weekend. Weekends are
split chronologically: a model evaluated on weekend k was trained on weekends < k only.

Models compared (ML must beat the baselines to be worth deploying):
  baseline_latest  gap of the driver's best push lap to the session best in their latest practice
  baseline_median  median of that gap over the weekend's practice sessions
  ridge            linear model on per-session gaps, push-lap count and team mean gap
  hgb              histogram gradient boosting on the same features
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

import numpy as np
import polars as pl
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.linear_model import Ridge

from . import metrics as M

PUSH_THRESHOLD = 1.03  # same rule as DEFAULT_CLASSIFIER_CONFIG.pushThreshold in telemetry-core
FEATURES = ["gap_latest", "gap_median", "gap_min", "push_laps", "sessions", "team_gap"]


@dataclass
class Weekend:
    meeting_id: str
    start: object
    frame: pl.DataFrame  # one row per driver: FEATURES + latest_best + quali_best + gap_to_pole


def build_weekends(laps: pl.DataFrame) -> list[Weekend]:
    out: list[Weekend] = []
    for (meeting_id,), g in laps.group_by(["meeting_id"]):
        quali = g.filter(pl.col("session_type") == "qualifying")
        practice = g.filter(pl.col("session_type") == "practice")
        if quali.is_empty() or practice.is_empty():
            continue
        q_start = quali["session_start"].min()
        # Leakage guard: only practice laps that started before qualifying.
        practice = practice.filter(pl.col("date_start").is_not_null() & (pl.col("date_start") < q_start))
        qbest = quali.filter(pl.col("lap_time").is_not_null()).group_by("driver_number").agg(pl.col("lap_time").min().alias("quali_best"))
        if qbest.height < 10:
            continue
        target = qbest.with_columns((pl.col("quali_best") - pl.col("quali_best").min()).alias("gap_to_pole"))

        timed = practice.filter(pl.col("lap_time").is_not_null() & ~pl.col("is_pit_out_lap"))
        if timed.is_empty():
            continue
        best = timed.group_by("session_id").agg(pl.col("lap_time").min().alias("session_best"))
        push = timed.join(best, on="session_id").filter(pl.col("lap_time") <= pl.col("session_best") * PUSH_THRESHOLD)
        per_session = (
            push.group_by(["session_id", "session_start", "driver_number", "team_name"])
            .agg(pl.col("lap_time").min().alias("best"), pl.len().alias("push_laps"), pl.col("session_best").first())
            .with_columns((pl.col("best") - pl.col("session_best")).alias("gap"))
            .sort("session_start")
        )
        feats = per_session.group_by("driver_number").agg(
            pl.col("gap").last().alias("gap_latest"),
            pl.col("best").last().alias("latest_best"),
            pl.col("gap").median().alias("gap_median"),
            pl.col("gap").min().alias("gap_min"),
            pl.col("push_laps").sum().alias("push_laps"),
            pl.col("session_id").n_unique().alias("sessions"),
            pl.col("team_name").last().alias("team_name"),
        )
        feats = feats.join(feats.group_by("team_name").agg(pl.col("gap_median").mean().alias("team_gap")), on="team_name", how="left")
        frame = feats.join(target, on="driver_number", how="inner")
        if frame.height >= 10:
            out.append(Weekend(meeting_id=meeting_id, start=q_start, frame=frame))
    return sorted(out, key=lambda w: w.start)


def _xy(ws: list[Weekend]) -> tuple[np.ndarray, np.ndarray]:
    df = pl.concat([w.frame for w in ws])
    return np.nan_to_num(df.select(FEATURES).to_numpy().astype(float)), df["gap_to_pole"].to_numpy().astype(float)


def _models() -> dict[str, Callable[[list[Weekend], pl.DataFrame], tuple[np.ndarray, float]]]:
    """Each model returns (test predictions, residual sd estimated on its training data only)."""

    def baseline(col: str):
        def run(train: list[Weekend], test: pl.DataFrame):
            tr = pl.concat([w.frame for w in train])
            sigma = float(np.nanstd(tr["gap_to_pole"].to_numpy() - tr[col].to_numpy()))
            return test[col].to_numpy().astype(float), sigma

        return run

    def sk(factory):
        def run(train: list[Weekend], test: pl.DataFrame):
            X, y = _xy(train)
            model = factory().fit(X, y)
            sigma = float(np.std(y - model.predict(X)))
            return model.predict(np.nan_to_num(test.select(FEATURES).to_numpy().astype(float))), sigma

        return run

    return {
        "baseline_latest": baseline("gap_latest"),
        "baseline_median": baseline("gap_median"),
        "ridge": sk(lambda: Ridge(alpha=1.0)),
        "hgb": sk(lambda: HistGradientBoostingRegressor(max_depth=3, max_iter=150, learning_rate=0.05, random_state=0)),
    }


def rolling_backtest(weekends: list[Weekend], min_train: int = 4, level: float = 0.8) -> dict:
    if len(weekends) < min_train + 1:
        return {"status": "insufficient_data", "weekends": len(weekends), "required": min_train + 1}
    z = {0.8: 1.2816, 0.9: 1.6449}[level]
    models = _models()
    rows: dict[str, list[dict]] = {m: [] for m in models}
    for k in range(min_train, len(weekends)):
        train, test = weekends[:k], weekends[k]
        if not all(w.start < test.start for w in train):
            raise AssertionError("temporal leakage in backtest split")
        y = test.frame["gap_to_pole"].to_numpy().astype(float)
        pole = int(np.argmin(y))
        for name, run in models.items():
            p, sigma = run(train, test.frame)
            p = np.nan_to_num(p, nan=float(np.nanmedian(p)))
            sigma = max(sigma, 0.05)
            probs = M.pole_probabilities(p, sigma)
            rows[name].append(
                {
                    "meeting": test.meeting_id,
                    "mae": M.mae(y, p),
                    "rmse": M.rmse(y, p),
                    "spearman": M.spearman(p, y),
                    "pole_brier": M.brier(probs, (np.arange(len(y)) == pole).astype(float)),
                    "pole_log_loss": M.log_loss_winner(probs, pole),
                    "coverage": M.interval_coverage(y, p - z * sigma, p + z * sigma),
                    "sigma": sigma,
                }
            )
    summary = {
        name: {
            "weekends": len(r),
            "mae_s": float(np.mean([x["mae"] for x in r])),
            "rmse_s": float(np.mean([x["rmse"] for x in r])),
            "spearman": float(np.nanmean([x["spearman"] for x in r])),
            "pole_brier": float(np.mean([x["pole_brier"] for x in r])),
            "pole_log_loss": float(np.mean([x["pole_log_loss"] for x in r])),
            f"interval_coverage_{int(level * 100)}": float(np.mean([x["coverage"] for x in r])),
        }
        for name, r in rows.items()
    }
    baseline_best = min(summary["baseline_latest"]["mae_s"], summary["baseline_median"]["mae_s"])
    return {
        "status": "ok",
        "weekends": len(weekends),
        "evaluated": len(weekends) - min_train,
        "level": level,
        "summary": summary,
        "best_model": min(summary, key=lambda m: summary[m]["mae_s"]),
        "ml_beats_baselines": {m: summary[m]["mae_s"] < baseline_best for m in ("ridge", "hgb")},
        "per_weekend": rows,
    }


def calibrate_improvement(weekends: list[Weekend]) -> dict:
    """Practice -> qualifying improvement: latest-session practice best minus qualifying best (s).

    This is the quantity the TypeScript model uses as `qualifyingImprovement` (it subtracts it from
    the session-evolution-adjusted practice best). Drivers whose best push lap was set in an earlier
    session are included on their latest session's best, which slightly overstates improvement;
    the effect is reported via the sample size and the sd.
    """
    vals = np.concatenate([(w.frame["latest_best"] - w.frame["quali_best"]).drop_nulls().to_numpy() for w in weekends]) if weekends else np.array([])
    if vals.size < 20:
        return {"n": int(vals.size), "status": "insufficient_data"}
    lo, hi = np.quantile(vals, [0.05, 0.95])
    trimmed = vals[(vals >= lo) & (vals <= hi)]
    return {"n": int(vals.size), "weekends": len(weekends), "mean": float(trimmed.mean()), "sd": float(trimmed.std(ddof=1)), "status": "ok"}
