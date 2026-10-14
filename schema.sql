CREATE TABLE IF NOT EXISTS events (
  id BIGSERIAL PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  type TEXT NOT NULL,
  subtype TEXT,
  citizenid TEXT,
  player_name TEXT,
  src INT,
  data JSONB
);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events (ts DESC);
CREATE INDEX IF NOT EXISTS idx_events_type_ts ON events (type, ts DESC);
CREATE INDEX IF NOT EXISTS idx_events_cid_ts ON events (citizenid, ts DESC);

CREATE TABLE IF NOT EXISTS economy_snapshots (
  ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  player_count INT,
  chars_total INT,
  total_cash BIGINT,
  total_bank BIGINT,
  total_crypto NUMERIC,
  society_total BIGINT,
  data JSONB
);
CREATE INDEX IF NOT EXISTS idx_econ_ts ON economy_snapshots (ts DESC);

CREATE TABLE IF NOT EXISTS player_snapshots (
  ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  citizenid TEXT NOT NULL,
  name TEXT,
  job TEXT,
  job_grade INT,
  gang TEXT,
  cash BIGINT,
  bank BIGINT,
  crypto NUMERIC,
  online BOOLEAN DEFAULT false,
  data JSONB
);
CREATE INDEX IF NOT EXISTS idx_psnap_cid_ts ON player_snapshots (citizenid, ts DESC);
CREATE INDEX IF NOT EXISTS idx_psnap_ts ON player_snapshots (ts DESC);

CREATE TABLE IF NOT EXISTS purchases (
  id BIGSERIAL PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  citizenid TEXT,
  player_name TEXT,
  shop TEXT,
  item TEXT,
  label TEXT,
  qty INT DEFAULT 1,
  unit_price NUMERIC,
  total NUMERIC,
  currency TEXT DEFAULT 'cash',
  data JSONB
);
CREATE INDEX IF NOT EXISTS idx_purch_ts ON purchases (ts DESC);
CREATE INDEX IF NOT EXISTS idx_purch_cid ON purchases (citizenid, ts DESC);

CREATE TABLE IF NOT EXISTS deaths (
  id BIGSERIAL PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  citizenid TEXT,
  player_name TEXT,
  cause TEXT,
  killer_cid TEXT,
  killer_name TEXT,
  weapon TEXT,
  x REAL, y REAL, z REAL,
  screenshot_url TEXT,
  data JSONB
);
CREATE INDEX IF NOT EXISTS idx_deaths_ts ON deaths (ts DESC);
CREATE INDEX IF NOT EXISTS idx_deaths_cid ON deaths (citizenid, ts DESC);

CREATE TABLE IF NOT EXISTS sessions (
  id BIGSERIAL PRIMARY KEY,
  citizenid TEXT,
  player_name TEXT,
  license TEXT,
  src INT,
  start_ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  end_ts TIMESTAMPTZ,
  duration_min REAL,
  drop_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_cid ON sessions (citizenid, start_ts DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_start ON sessions (start_ts DESC);

CREATE TABLE IF NOT EXISTS vehicles_owned (
  ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  citizenid TEXT,
  owner_name TEXT,
  plate TEXT,
  model TEXT,
  garage TEXT,
  state INT,
  data JSONB
);
CREATE INDEX IF NOT EXISTS idx_veh_ts ON vehicles_owned (ts DESC);
CREATE INDEX IF NOT EXISTS idx_veh_cid ON vehicles_owned (citizenid, ts DESC);

CREATE TABLE IF NOT EXISTS admin_actions (
  id BIGSERIAL PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  action TEXT,
  admin_name TEXT,
  target_cid TEXT,
  target_name TEXT,
  reason TEXT,
  duration TEXT,
  data JSONB
);
CREATE INDEX IF NOT EXISTS idx_admin_ts ON admin_actions (ts DESC);

CREATE TABLE IF NOT EXISTS server_logs (
  id BIGSERIAL PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  channel TEXT,
  level TEXT,
  source TEXT,
  line TEXT,
  labels JSONB
);
CREATE INDEX IF NOT EXISTS idx_slogs_ts ON server_logs (ts DESC);
CREATE INDEX IF NOT EXISTS idx_slogs_chan ON server_logs (channel, ts DESC);

CREATE TABLE IF NOT EXISTS perf_metrics (
  ts TIMESTAMPTZ NOT NULL,
  metric TEXT NOT NULL,
  thread TEXT,
  le DOUBLE PRECISION,
  value DOUBLE PRECISION
);
CREATE INDEX IF NOT EXISTS idx_perf_ts ON perf_metrics (metric, ts DESC);

CREATE TABLE IF NOT EXISTS alerts (
  id BIGSERIAL PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  kind TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'warn',
  title TEXT NOT NULL,
  detail TEXT,
  citizenid TEXT,
  data JSONB,
  notified BOOLEAN DEFAULT false
);
CREATE INDEX IF NOT EXISTS idx_alerts_ts ON alerts (ts DESC);

CREATE TABLE IF NOT EXISTS db_snapshots (
  name TEXT PRIMARY KEY,
  label TEXT,
  kind TEXT,
  pos INT,
  ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  columns JSONB,
  rows JSONB
);

CREATE TABLE IF NOT EXISTS db_table_stats (
  ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  table_name TEXT NOT NULL,
  rows BIGINT,
  bytes BIGINT
);
CREATE INDEX IF NOT EXISTS idx_dbstats_ts ON db_table_stats (ts DESC);

CREATE TABLE IF NOT EXISTS panel_users (
  discord_id TEXT PRIMARY KEY,
  username TEXT,
  global_name TEXT,
  avatar TEXT,
  access TEXT,                 -- 'granted' | 'revoked' | NULL (selon les rôles Discord)
  role_ok BOOLEAN DEFAULT false,
  first_login TIMESTAMPTZ,
  last_login TIMESTAMPTZ,
  added_by TEXT,
  note TEXT,
  updated_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS panel_logins (
  id BIGSERIAL PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  discord_id TEXT,
  username TEXT,
  allowed BOOLEAN,
  ip TEXT
);
CREATE INDEX IF NOT EXISTS idx_panel_logins_ts ON panel_logins (ts DESC);

CREATE TABLE IF NOT EXISTS commands (
  id BIGSERIAL PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  type TEXT NOT NULL,
  payload JSONB,
  author TEXT,
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | sent | done | failed | expired
  sent_at TIMESTAMPTZ,
  done_at TIMESTAMPTZ,
  result TEXT
);
CREATE INDEX IF NOT EXISTS idx_commands_status ON commands (status, id);
