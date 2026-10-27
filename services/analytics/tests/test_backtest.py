"""Tests on SYNTHETIC weekends (not real F1 data) with a fixed seed."""

from datetime import UTC, datetime, timedelta

import numpy as np
import polars as pl
import pytest

from lemontea_analytics import metrics as M
from lemontea_analytics import qualifying as Q


def synthetic_laps(weekends: int = 8, drivers: int = 20, seed: int = 1) -> pl.DataFrame:
    rng = np.random.default_rng(seed)
    rows = []
    base = datetime(2025, 3, 1, tzinfo=UTC)
    for w in range(weekends):
        t0 = base + timedelta(days=14 * w)
        skill = np.linspace(0, 1.6, drivers) + rng.normal(0, 0.05, drivers)
        for si, (name, typ, offset_h) in enumerate([("FP1", "practice", 0), ("FP2", "practice", 4), ("FP3", "practice", 24), ("Q", "qualifying", 28)]):
            start = t0 + timedelta(hours=offset_h)
            for d in range(drivers):
                for lap in range(1, 5):
                    trim = 0.0 if typ == "qualifying" else 0.8 - 0.2 * si
                    t = 80 + skill[d] + trim + rng.normal(0, 0.12) + (5 if lap == 1 else 0)
                    rows.append(
                        dict(
                            session_id=f"s{w}-{si}", meeting_id=f"m{w}", session_type=typ, session_name=name, session_start=start, year=2025,
                            driver_number=d + 1, lap_number=lap, date_start=start + timedelta(minutes=lap * 2 + d * 0.1), lap_time=t,
                            sector1=None, sector2=None, sector3=None, is_pit_out_lap=lap == 1, compound="SOFT", tyre_age=lap, team_name=f"T{d // 2}",
                        )
                    )
    return pl.DataFrame(rows)


def test_metrics_basics():
    assert M.mae(np.array([1, 2]), np.array([2, 2])) == 0.5
    assert M.brier(np.array([1.0, 0.0]), np.array([1, 0])) == 0.0
    assert M.interval_coverage(np.array([1, 5]), np.array([0, 0]), np.array([2, 2])) == 0.5
    p = M.pole_probabilities(np.array([0.0, 0.5, 1.0]), 0.1)
    assert p.sum() == pytest.approx(1.0)
    assert p[0] > 0.9


def test_weekends_exclude_laps_after_qualifying_start():
    laps = synthetic_laps(2)
    leaked = laps.filter(pl.col("session_type") == "qualifying").head(5).with_columns(session_type=pl.lit("practice"), session_id=pl.lit("leak"))
    weekends = Q.build_weekends(pl.concat([laps, leaked]))
    assert all(w.frame["sessions"].max() <= 3 for w in weekends)


def test_rolling_backtest_is_temporal_and_baselines_are_reasonable():
    weekends = Q.build_weekends(synthetic_laps(8))
    assert len(weekends) == 8
    r = Q.rolling_backtest(weekends, min_train=4)
    assert r["status"] == "ok"
    assert r["evaluated"] == 4
    s = r["summary"]
    assert s["baseline_median"]["spearman"] > 0.8
    assert 0 <= s["baseline_latest"]["interval_coverage_80"] <= 1


def test_insufficient_data_is_reported_not_faked():
    r = Q.rolling_backtest(Q.build_weekends(synthetic_laps(3)), min_train=4)
    assert r["status"] == "insufficient_data"


def test_improvement_calibration_recovers_truth():
    # FP3 trim is 0.8 - 0.4 = 0.4 s above qualifying in the generator.
    imp = Q.calibrate_improvement(Q.build_weekends(synthetic_laps(8)))
    assert imp["status"] == "ok"
    assert imp["mean"] == pytest.approx(0.4, abs=0.1)
