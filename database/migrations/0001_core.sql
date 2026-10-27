-- The Lemon Tea — core schema
-- Conventions:
--   * high-frequency data lives in narrow, typed hypertables (never JSON blobs)
--   * every row of source data carries source + processing_version
--   * sessions are owned by a tenant (private) or by nobody (public); all telemetry hangs off
--     sessions.uid so authorisation is decided once, at session resolution

CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS timescaledb;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'timescaledb not available; continuing with plain PostgreSQL tables';
END $$;

-- ---------------------------------------------------------------- identity
CREATE TABLE tenants (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email          text NOT NULL UNIQUE,
  password_hash  text NOT NULL,
  role           text NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app_sessions (
  token_hash  text PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE api_tokens (
  token_hash   text PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         text NOT NULL,
  scopes       text[] NOT NULL,
  expires_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);

-- ---------------------------------------------------------------- OAuth for MCP
CREATE TABLE oauth_clients (
  client_id      text PRIMARY KEY,
  client_name    text NOT NULL,
  redirect_uris  text[] NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE oauth_codes (
  code_hash       text PRIMARY KEY,
  client_id       text NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scopes          text[] NOT NULL,
  code_challenge  text NOT NULL,
  redirect_uri    text NOT NULL,
  resource        text NOT NULL,
  expires_at      timestamptz NOT NULL,
  used_at         timestamptz
);

CREATE TABLE oauth_refresh_tokens (
  token_hash  text PRIMARY KEY,
  client_id   text NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scopes      text[] NOT NULL,
  resource    text NOT NULL,
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz
);

-- ---------------------------------------------------------------- governance
CREATE TABLE data_sources (
  id                   text PRIMARY KEY,
  name                 text NOT NULL,
  api_version          text,
  homepage             text,
  license              text NOT NULL,
  permitted_use        text NOT NULL,
  redistribution       text NOT NULL CHECK (redistribution IN ('permitted', 'attribution_required', 'non_commercial', 'link_only', 'forbidden', 'unknown')),
  attribution          text,
  update_frequency     text,
  historical_coverage  text,
  accuracy_notes       text,
  missing_channels     text[],
  rate_limit           text,
  retention            text,
  public_display_allowed boolean NOT NULL DEFAULT false,
  enabled              boolean NOT NULL DEFAULT true,
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE provider_connections (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider          text NOT NULL REFERENCES data_sources(id),
  config            jsonb NOT NULL DEFAULT '{}'::jsonb,  -- non-secret settings only
  secret_ciphertext bytea,                               -- AES-GCM, key from APP_ENCRYPTION_KEY
  status            text NOT NULL DEFAULT 'disabled',
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, provider)
);

CREATE TABLE regulation_eras (
  id          text PRIMARY KEY,
  from_year   int NOT NULL,
  to_year     int,
  notes       text NOT NULL
);

-- ---------------------------------------------------------------- calendar
CREATE TABLE circuits (
  id          text PRIMARY KEY,           -- '<source>:<key>'
  short_name  text NOT NULL,
  country     text,
  location    text
);

CREATE TABLE meetings (
  id           text PRIMARY KEY,
  year         int NOT NULL,
  name         text NOT NULL,
  country_name text,
  location     text,
  circuit_id   text NOT NULL REFERENCES circuits(id),
  date_start   timestamptz NOT NULL,
  source       text NOT NULL REFERENCES data_sources(id)
);
CREATE INDEX meetings_year_idx ON meetings (year, date_start);

CREATE TABLE sessions (
  uid               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  id                text NOT NULL,             -- public id '<source>:<key>'
  owner_tenant_id   uuid REFERENCES tenants(id) ON DELETE CASCADE,  -- NULL = public
  meeting_id        text NOT NULL REFERENCES meetings(id),
  year              int NOT NULL,
  name              text NOT NULL,
  type              text NOT NULL,
  circuit_id        text NOT NULL REFERENCES circuits(id),
  date_start        timestamptz NOT NULL,
  date_end          timestamptz,
  regulation_era    text NOT NULL REFERENCES regulation_eras(id),
  source            text NOT NULL REFERENCES data_sources(id),
  ingest_status     text NOT NULL DEFAULT 'not_ingested',
  ingested_channels text[] NOT NULL DEFAULT '{}',
  ingested_at       timestamptz,
  processing_version text NOT NULL DEFAULT 'normalize-v1'
);
CREATE UNIQUE INDEX sessions_public_uq ON sessions (id) WHERE owner_tenant_id IS NULL;
CREATE UNIQUE INDEX sessions_private_uq ON sessions (id, owner_tenant_id) WHERE owner_tenant_id IS NOT NULL;
CREATE INDEX sessions_meeting_idx ON sessions (meeting_id, date_start);

CREATE TABLE session_drivers (
  session_uid   uuid NOT NULL REFERENCES sessions(uid) ON DELETE CASCADE,
  driver_number smallint NOT NULL,
  code          text NOT NULL,
  full_name     text NOT NULL,
  team_name     text NOT NULL,
  team_colour   text NOT NULL,
  PRIMARY KEY (session_uid, driver_number)
);

-- ---------------------------------------------------------------- timing
CREATE TABLE laps (
  session_uid    uuid NOT NULL REFERENCES sessions(uid) ON DELETE CASCADE,
  driver_number  smallint NOT NULL,
  lap_number     smallint NOT NULL,
  date_start     timestamptz,
  lap_time       double precision,
  sector1        double precision,
  sector2        double precision,
  sector3        double precision,
  i1_speed       smallint,
  i2_speed       smallint,
  st_speed       smallint,
  is_pit_out_lap boolean NOT NULL DEFAULT false,
  mini_sectors   smallint[],
  source         text NOT NULL,
  processing_version text NOT NULL,
  PRIMARY KEY (session_uid, driver_number, lap_number)
);

CREATE TABLE stints (
  session_uid       uuid NOT NULL REFERENCES sessions(uid) ON DELETE CASCADE,
  driver_number     smallint NOT NULL,
  stint_number      smallint NOT NULL,
  lap_start         smallint NOT NULL,
  lap_end           smallint NOT NULL,
  compound          text NOT NULL,
  tyre_age_at_start smallint,
  PRIMARY KEY (session_uid, driver_number, stint_number)
);

CREATE TABLE pit_events (
  session_uid   uuid NOT NULL REFERENCES sessions(uid) ON DELETE CASCADE,
  driver_number smallint NOT NULL,
  lap_number    smallint NOT NULL,
  date          timestamptz NOT NULL,
  lane_duration double precision,
  stop_duration double precision,
  PRIMARY KEY (session_uid, driver_number, lap_number)
);

CREATE TABLE race_control (
  session_uid   uuid NOT NULL REFERENCES sessions(uid) ON DELETE CASCADE,
  seq           int NOT NULL,
  date          timestamptz NOT NULL,
  lap_number    smallint,
  category      text NOT NULL,
  flag          text,
  scope         text,
  sector        smallint,
  driver_number smallint,
  message       text NOT NULL,     -- untrusted source text
  PRIMARY KEY (session_uid, seq)
);
CREATE INDEX race_control_time_idx ON race_control (session_uid, date);

CREATE TABLE weather (
  session_uid       uuid NOT NULL REFERENCES sessions(uid) ON DELETE CASCADE,
  date              timestamptz NOT NULL,
  air_temperature   real,
  track_temperature real,
  humidity          real,
  pressure          real,
  rainfall          boolean,
  wind_speed        real,
  wind_direction    smallint,
  PRIMARY KEY (session_uid, date)
);

CREATE TABLE team_radio (
  session_uid    uuid NOT NULL REFERENCES sessions(uid) ON DELETE CASCADE,
  date           timestamptz NOT NULL,
  driver_number  smallint NOT NULL,
  recording_url  text,
  redistribution text NOT NULL DEFAULT 'link_only',
  PRIMARY KEY (session_uid, driver_number, date)
);

CREATE TABLE position_history (
  session_uid   uuid NOT NULL REFERENCES sessions(uid) ON DELETE CASCADE,
  date          timestamptz NOT NULL,
  driver_number smallint NOT NULL,
  position      smallint NOT NULL,
  PRIMARY KEY (session_uid, driver_number, date)
);

CREATE TABLE intervals (
  session_uid   uuid NOT NULL REFERENCES sessions(uid) ON DELETE CASCADE,
  date          timestamptz NOT NULL,
  driver_number smallint NOT NULL,
  gap_to_leader double precision,
  interval      double precision,
  laps_down     smallint,
  PRIMARY KEY (session_uid, driver_number, date)
);

CREATE TABLE session_results (
  session_uid   uuid NOT NULL REFERENCES sessions(uid) ON DELETE CASCADE,
  driver_number smallint NOT NULL,
  position      smallint,
  laps          smallint,
  status        text NOT NULL,
  duration      double precision,
  gap_to_leader double precision,
  points        real,
  PRIMARY KEY (session_uid, driver_number)
);

-- ---------------------------------------------------------------- high-frequency telemetry
CREATE TABLE car_samples (
  session_uid   uuid NOT NULL,
  driver_number smallint NOT NULL,
  t             timestamptz NOT NULL,
  speed         smallint NOT NULL,
  throttle      smallint NOT NULL,
  brake         smallint NOT NULL,
  rpm           integer,
  gear          smallint,
  drs           smallint
);
CREATE UNIQUE INDEX car_samples_uq ON car_samples (session_uid, driver_number, t);

CREATE TABLE position_samples (
  session_uid   uuid NOT NULL,
  driver_number smallint NOT NULL,
  t             timestamptz NOT NULL,
  x             real NOT NULL,
  y             real NOT NULL,
  z             real NOT NULL
);
CREATE UNIQUE INDEX position_samples_uq ON position_samples (session_uid, driver_number, t);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') THEN
    PERFORM create_hypertable('car_samples', 't', chunk_time_interval => INTERVAL '7 days', if_not_exists => TRUE);
    PERFORM create_hypertable('position_samples', 't', chunk_time_interval => INTERVAL '7 days', if_not_exists => TRUE);
    EXECUTE 'ALTER TABLE car_samples SET (timescaledb.compress, timescaledb.compress_segmentby = ''session_uid, driver_number'', timescaledb.compress_orderby = ''t'')';
    EXECUTE 'ALTER TABLE position_samples SET (timescaledb.compress, timescaledb.compress_segmentby = ''session_uid, driver_number'', timescaledb.compress_orderby = ''t'')';
    PERFORM add_compression_policy('car_samples', INTERVAL '30 days', if_not_exists => TRUE);
    PERFORM add_compression_policy('position_samples', INTERVAL '30 days', if_not_exists => TRUE);
  END IF;
END $$;

-- raw provider payloads are kept in object storage when the licence allows; this is the index
CREATE TABLE raw_payloads (
  session_uid   uuid NOT NULL REFERENCES sessions(uid) ON DELETE CASCADE,
  endpoint      text NOT NULL,
  part          int NOT NULL DEFAULT 0,
  object_key    text NOT NULL,
  sha256        text NOT NULL,
  bytes         bigint NOT NULL,
  fetched_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_uid, endpoint, part)
);

-- ---------------------------------------------------------------- circuits (derived geometry)
CREATE TABLE circuit_layouts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  circuit_id         text NOT NULL REFERENCES circuits(id),
  year               int NOT NULL,
  source_session_uid uuid REFERENCES sessions(uid) ON DELETE SET NULL,
  geometry           jsonb NOT NULL,     -- ~1k-point centreline, not time series
  length_m           double precision NOT NULL,
  provenance         jsonb NOT NULL,
  accuracy_m         double precision,
  confidence         text NOT NULL CHECK (confidence IN ('high', 'medium', 'low')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (circuit_id, year)
);

-- ---------------------------------------------------------------- quality & features
CREATE TABLE data_quality_reports (
  session_uid        uuid NOT NULL REFERENCES sessions(uid) ON DELETE CASCADE,
  created_at         timestamptz NOT NULL DEFAULT now(),
  processing_version text NOT NULL,
  report             jsonb NOT NULL,
  PRIMARY KEY (session_uid, created_at)
);

CREATE TABLE lap_features (
  session_uid        uuid NOT NULL REFERENCES sessions(uid) ON DELETE CASCADE,
  driver_number      smallint NOT NULL,
  lap_number         smallint NOT NULL,
  classifier_version text NOT NULL,
  primary_class      text NOT NULL,
  classes            text[] NOT NULL,
  run_id             text,
  compound           text,
  tyre_age           smallint,
  PRIMARY KEY (session_uid, driver_number, lap_number, classifier_version)
);

-- ---------------------------------------------------------------- models & predictions
CREATE TABLE model_versions (
  id          text PRIMARY KEY,
  family      text NOT NULL,   -- qualifying, race_pace, degradation, strategy, race_result
  params      jsonb NOT NULL,
  trained_on  jsonb,
  metrics     jsonb,
  status      text NOT NULL DEFAULT 'candidate' CHECK (status IN ('candidate', 'active', 'retired')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE predictions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_tenant_id   uuid REFERENCES tenants(id) ON DELETE CASCADE,  -- NULL = public
  kind              text NOT NULL,
  meeting_id        text REFERENCES meetings(id),
  input_session_ids text[] NOT NULL,
  target_session_id text,
  model_version     text NOT NULL,
  params_version    text NOT NULL,
  input_hash        text NOT NULL,
  as_of             timestamptz NOT NULL,  -- latest data timestamp used: guards against leakage
  created_at        timestamptz NOT NULL DEFAULT now(),
  output            jsonb NOT NULL
);
CREATE INDEX predictions_meeting_idx ON predictions (meeting_id, kind, created_at);

CREATE TABLE backtest_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  model_version text NOT NULL,
  family        text NOT NULL,
  window_desc   text NOT NULL,
  metrics       jsonb NOT NULL,
  details       jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- jobs
CREATE TABLE jobs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid REFERENCES tenants(id) ON DELETE CASCADE,
  user_id          uuid REFERENCES users(id) ON DELETE CASCADE,
  kind             text NOT NULL,
  input            jsonb NOT NULL,
  status           text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  progress         real NOT NULL DEFAULT 0,
  result           jsonb,
  error            jsonb,
  idempotency_key  text,
  attempts         int NOT NULL DEFAULT 0,
  cancel_requested boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  started_at       timestamptz,
  finished_at      timestamptz
);
CREATE UNIQUE INDEX jobs_idem_uq ON jobs (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX jobs_queue_idx ON jobs (status, created_at) WHERE status = 'queued';

-- ---------------------------------------------------------------- audit
CREATE TABLE audit_log (
  id         bigserial PRIMARY KEY,
  at         timestamptz NOT NULL DEFAULT now(),
  user_id    uuid,
  tenant_id  uuid,
  via        text NOT NULL,
  client_id  text,
  action     text NOT NULL,
  resource   text,
  outcome    text NOT NULL,
  details    jsonb
);
CREATE INDEX audit_log_at_idx ON audit_log (at);

-- ---------------------------------------------------------------- row level security
-- The application connects as `lemontea_app` (not owner, not superuser) and sets
-- app.tenant_id per transaction. Public rows (owner NULL) are visible to everyone.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lemontea_app') THEN
    CREATE ROLE lemontea_app LOGIN;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO lemontea_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO lemontea_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO lemontea_app;

ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions FORCE ROW LEVEL SECURITY;
-- Ingestion runs as the system (app.role = 'system') to update ingest status of any session.
CREATE POLICY sessions_visibility ON sessions
  USING (owner_tenant_id IS NULL OR owner_tenant_id::text = current_setting('app.tenant_id', true) OR current_setting('app.role', true) = 'system')
  WITH CHECK (owner_tenant_id IS NULL OR owner_tenant_id::text = current_setting('app.tenant_id', true) OR current_setting('app.role', true) = 'system');

ALTER TABLE predictions ENABLE ROW LEVEL SECURITY;
ALTER TABLE predictions FORCE ROW LEVEL SECURITY;
CREATE POLICY predictions_visibility ON predictions
  USING (owner_tenant_id IS NULL OR owner_tenant_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (owner_tenant_id IS NULL OR owner_tenant_id::text = current_setting('app.tenant_id', true));

ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE jobs FORCE ROW LEVEL SECURITY;
-- Job runners act as the system and set app.role = 'system'.
CREATE POLICY jobs_visibility ON jobs
  USING (tenant_id::text = current_setting('app.tenant_id', true) OR current_setting('app.role', true) = 'system')
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true) OR current_setting('app.role', true) = 'system');

ALTER TABLE provider_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider_connections FORCE ROW LEVEL SECURITY;
CREATE POLICY provider_connections_tenant ON provider_connections
  USING (tenant_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));
