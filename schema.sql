-- qoder-cf-gw D1 schema
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  uid TEXT NOT NULL DEFAULT '',
  label TEXT NOT NULL,
  token TEXT NOT NULL,
  refresh_token TEXT,
  expires_at TEXT,
  refresh_expires_at TEXT,
  exp INTEGER DEFAULT 0,
  display_name TEXT,
  machine_id TEXT,
  machine_token TEXT,
  machine_type TEXT,
  machine_code TEXT,
  organization_id TEXT,
  organization_tags TEXT,
  data_policy_agreed INTEGER DEFAULT 0,
  cosy_version TEXT DEFAULT '1.1.69',
  session_seed TEXT,
  refresh_dead INTEGER DEFAULT 0,
  refresh_error TEXT,
  failed_at INTEGER DEFAULT 0,
  failed_status INTEGER DEFAULT 0,
  last_refresh_at INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_uid ON accounts(uid) WHERE uid != '';

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  name TEXT,
  key_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER DEFAULT 0,
  enabled INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS usage_daily (
  date TEXT PRIMARY KEY,
  requests INTEGER DEFAULT 0,
  prompt_tokens INTEGER DEFAULT 0,
  completion_tokens INTEGER DEFAULT 0,
  total_tokens INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS daily_checkins (
  date TEXT NOT NULL,
  account_id TEXT NOT NULL,
  status TEXT,
  secured INTEGER DEFAULT 0,
  amount INTEGER DEFAULT 0,
  add_on_total INTEGER,
  detail TEXT,
  updated_at INTEGER,
  PRIMARY KEY (date, account_id)
);
