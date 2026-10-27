"""Read-only data access. Only PUBLIC sessions (owner_tenant_id IS NULL) are used for shared models,
so no tenant's private telemetry can influence parameters served to other users."""

from __future__ import annotations

import polars as pl
import psycopg

PUBLIC_LAPS_SQL = """
select s.id as session_id, s.meeting_id, s.type as session_type, s.name as session_name,
       s.date_start as session_start, s.year,
       l.driver_number, l.lap_number, l.date_start, l.lap_time, l.sector1, l.sector2, l.sector3,
       l.is_pit_out_lap, st.compound, st.tyre_age_at_start + (l.lap_number - st.lap_start) as tyre_age,
       d.team_name
from laps l
join sessions s on s.uid = l.session_uid and s.owner_tenant_id is null
left join stints st on st.session_uid = l.session_uid and st.driver_number = l.driver_number
     and l.lap_number between st.lap_start and st.lap_end
left join session_drivers d on d.session_uid = l.session_uid and d.driver_number = l.driver_number
where s.type in ('practice', 'qualifying') and s.year = any(%(years)s)
"""


def load_laps(dsn: str, years: list[int]) -> pl.DataFrame:
    with psycopg.connect(dsn) as conn, conn.cursor() as cur:
        cur.execute(PUBLIC_LAPS_SQL, {"years": years})
        cols = [c.name for c in cur.description]
        rows = cur.fetchall()
    return pl.DataFrame(rows, schema=cols, orient="row")


def write_model_version(dsn: str, model_id: str, family: str, params: dict, trained_on: dict, metrics: dict, activate: bool) -> None:
    import json

    with psycopg.connect(dsn) as conn, conn.cursor() as cur:
        if activate:
            cur.execute("update model_versions set status = 'retired' where family = %s and status = 'active'", (family,))
        cur.execute(
            """insert into model_versions (id, family, params, trained_on, metrics, status)
               values (%s, %s, %s, %s, %s, %s)
               on conflict (id) do update set params = excluded.params, trained_on = excluded.trained_on,
                 metrics = excluded.metrics, status = excluded.status""",
            (model_id, family, json.dumps(params), json.dumps(trained_on), json.dumps(metrics), "active" if activate else "candidate"),
        )


def write_backtest(dsn: str, model_version: str, family: str, window: str, metrics: dict, details: dict) -> None:
    import json

    with psycopg.connect(dsn) as conn, conn.cursor() as cur:
        cur.execute(
            "insert into backtest_runs (model_version, family, window_desc, metrics, details) values (%s, %s, %s, %s, %s)",
            (model_version, family, window, json.dumps(metrics), json.dumps(details)),
        )
