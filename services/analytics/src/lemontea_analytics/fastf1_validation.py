"""Cross-source validation: compare lap times stored from OpenF1 with FastF1 for one session.

FastF1 data is used locally for validation only and is never stored or redistributed by the
platform (see docs/DATA_PROVIDERS.md). Requires the optional `fastf1` extra.

Since 2025 the F1 live timing archive FastF1 reads requires an F1 TV subscription token. FastF1
(>= 3.9) signs in with your Formula 1 account: run `python -m fastf1 auth f1tv` once, or set
F1_USERNAME / F1_PASSWORD for non-interactive use. Without it, loading fails or returns no laps.
"""

from __future__ import annotations

import numpy as np
import psycopg


def validate(dsn: str, year: int, event: str, session: str) -> dict:
    try:
        import fastf1  # type: ignore[import-not-found]
    except ImportError:
        return {"status": "unavailable", "reason": "install with: uv sync --extra fastf1"}
    fastf1.Cache.enable_cache(".cache/fastf1")
    s = fastf1.get_session(year, event, session)
    try:
        s.load(laps=True, telemetry=False, weather=False, messages=False)
    except Exception as exc:  # FastF1 raises several types for auth/availability problems
        return {"status": "unavailable", "reason": f"FastF1 could not load the session ({type(exc).__name__}). "
                "Sign in first: python -m fastf1 auth f1tv"}
    if s.laps is None or len(s.laps) == 0:
        return {"status": "unavailable", "reason": "FastF1 returned no laps; an F1 TV sign-in is required: python -m fastf1 auth f1tv"}
    ff = {(int(r.DriverNumber), int(r.LapNumber)): r.LapTime.total_seconds() for r in s.laps.itertuples() if r.LapTime is not None and not np.isnan(r.LapTime.total_seconds())}
    start = s.session_start_time if hasattr(s, "session_start_time") else None
    with psycopg.connect(dsn) as conn, conn.cursor() as cur:
        cur.execute(
            """select l.driver_number, l.lap_number, l.lap_time from laps l join sessions s on s.uid = l.session_uid
               where s.owner_tenant_id is null and s.year = %s and s.circuit_id in (select id from circuits where short_name ilike %s)
                 and s.name ilike %s and l.lap_time is not null""",
            (year, f"%{event}%", {"Q": "Qualifying", "R": "Race", "FP1": "Practice 1", "FP2": "Practice 2", "FP3": "Practice 3"}.get(session, session)),
        )
        ours = {(int(d), int(n)): float(t) for d, n, t in cur.fetchall()}
    common = sorted(set(ff) & set(ours))
    if not common:
        return {"status": "no_overlap", "fastf1_laps": len(ff), "stored_laps": len(ours), "session_start": str(start)}
    diff = np.array([ours[k] - ff[k] for k in common])
    return {
        "status": "ok",
        "common_laps": len(common),
        "only_fastf1": len(set(ff) - set(ours)),
        "only_stored": len(set(ours) - set(ff)),
        "max_abs_diff_s": float(np.max(np.abs(diff))),
        "laps_differing_over_1ms": int(np.sum(np.abs(diff) > 0.001)),
    }
