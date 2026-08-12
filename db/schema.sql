-- SwarmReview Data Layer — frozen DDL (see schema.md)
-- SQLite; applied by server.js at startup (idempotent).

CREATE TABLE IF NOT EXISTS sessions (
  id              TEXT PRIMARY KEY,
  agent_name      TEXT NOT NULL DEFAULT '',
  branch          TEXT NOT NULL DEFAULT '',
  first_seen_at   TEXT NOT NULL,
  last_updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS hunks (
  id         TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  file_path  TEXT NOT NULL,
  diff_text  TEXT NOT NULL,
  summary    TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL DEFAULT 'pending'
             CHECK (status IN ('pending','approved','rejected','needs_revision')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hunks_status ON hunks (status);
CREATE INDEX IF NOT EXISTS idx_hunks_session ON hunks (session_id);

CREATE TABLE IF NOT EXISTS decisions (
  id         TEXT PRIMARY KEY,
  hunk_id    TEXT NOT NULL REFERENCES hunks (id),
  action     TEXT NOT NULL CHECK (action IN ('approve','reject','revise')),
  comment    TEXT NOT NULL DEFAULT '',
  decided_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_decisions_hunk ON decisions (hunk_id);
