"""Command line entry points.

  lemontea-analytics backtest  --years 2024 2025           # rolling-origin backtest, stored in backtest_runs
  lemontea-analytics calibrate --years 2024 2025 [--activate]
  lemontea-analytics validate-fastf1 --year 2025 --event Monza --session Q   # optional, needs fastf1 extra

Calibration writes a `pace` model version consumed by the TypeScript engine. It is stored as
`candidate` unless --activate is passed, and is marked calibrated only if the rolling backtest's
80 % interval coverage is within [0.75, 0.85].
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import UTC, datetime

from . import data, qualifying


def _dsn() -> str:
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        sys.exit("DATABASE_URL is required")
    return dsn


def cmd_backtest(years: list[int], store: bool) -> dict:
    laps = data.load_laps(_dsn(), years)
    weekends = qualifying.build_weekends(laps)
    result = qualifying.rolling_backtest(weekends)
    if store and result["status"] == "ok":
        data.write_backtest(
            _dsn(),
            "quali-practice-research-v1",
            "qualifying",
            f"rolling origin over {result['weekends']} weekends ({','.join(map(str, years))})",
            {"summary": result["summary"], "best_model": result["best_model"], "ml_beats_baselines": result["ml_beats_baselines"]},
            {"per_weekend": result["per_weekend"]},
        )
    return result


def cmd_calibrate(years: list[int], activate: bool) -> dict:
    laps = data.load_laps(_dsn(), years)
    weekends = qualifying.build_weekends(laps)
    imp = qualifying.calibrate_improvement(weekends)
    bt = qualifying.rolling_backtest(weekends)
    if imp.get("status") != "ok":
        return {"status": "insufficient_data", "improvement": imp, "backtest": bt.get("status")}
    coverage = bt["summary"]["baseline_latest"]["interval_coverage_80"] if bt.get("status") == "ok" else None
    calibrated = coverage is not None and 0.75 <= coverage <= 0.85
    model_id = f"pace-{datetime.now(UTC).strftime('%Y%m%d%H%M')}"
    params = {"qualifyingImprovement": {"mean": round(imp["mean"], 3), "sd": round(imp["sd"], 3)}, "calibrated": calibrated}
    data.write_model_version(
        _dsn(),
        model_id,
        "pace",
        params,
        {"years": years, "weekends": imp["weekends"], "drivers": imp["n"], "public_data_only": True},
        {"backtest_coverage_80": coverage, "backtest_status": bt.get("status")},
        activate,
    )
    return {"status": "ok", "modelVersion": model_id, "params": params, "activated": activate}


def main() -> None:
    p = argparse.ArgumentParser(prog="lemontea-analytics")
    sub = p.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("backtest")
    b.add_argument("--years", type=int, nargs="+", required=True)
    b.add_argument("--no-store", action="store_true")
    c = sub.add_parser("calibrate")
    c.add_argument("--years", type=int, nargs="+", required=True)
    c.add_argument("--activate", action="store_true")
    v = sub.add_parser("validate-fastf1")
    v.add_argument("--year", type=int, required=True)
    v.add_argument("--event", required=True)
    v.add_argument("--session", default="Q")
    a = p.parse_args()
    if a.cmd == "backtest":
        out = cmd_backtest(a.years, not a.no_store)
        out.pop("per_weekend", None)
    elif a.cmd == "calibrate":
        out = cmd_calibrate(a.years, a.activate)
    else:
        from .fastf1_validation import validate

        out = validate(_dsn(), a.year, a.event, a.session)
    print(json.dumps(out, indent=2, default=str))


if __name__ == "__main__":
    main()
