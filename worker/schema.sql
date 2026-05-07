-- Each guess sent by a player. Drives the per-candidate "what others
-- voted" breakdown.
CREATE TABLE IF NOT EXISTS guesses (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id      INTEGER NOT NULL,
  guessed_party     TEXT    NOT NULL,
  actual_party      TEXT    NOT NULL,
  session_id        TEXT,
  time_to_guess_ms  INTEGER,
  ts                TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_guesses_candidate ON guesses(candidate_id);
CREATE INDEX IF NOT EXISTS idx_guesses_ts        ON guesses(ts);

-- Roster, seeded by build_candidates.py via worker/seed.sql.
-- The Worker reads from this table to issue /round and validate /answer,
-- which means the actual_party never appears in any client payload.
CREATE TABLE IF NOT EXISTS candidates (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  party      TEXT NOT NULL,
  role       TEXT NOT NULL,
  image_url  TEXT NOT NULL,
  source     TEXT
);

-- One row per browser. session_id is a UUID stored in the client's
-- localStorage. We never store IPs or user agents.
CREATE TABLE IF NOT EXISTS sessions (
  session_id      TEXT PRIMARY KEY,
  display_name    TEXT,
  current_streak  INTEGER NOT NULL DEFAULT 0,
  best_streak     INTEGER NOT NULL DEFAULT 0,
  total_correct   INTEGER NOT NULL DEFAULT 0,
  total_attempts  INTEGER NOT NULL DEFAULT 0,
  first_seen      TEXT    NOT NULL DEFAULT (datetime('now')),
  last_seen       TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sessions_best ON sessions(best_streak DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_last ON sessions(last_seen DESC);

-- Server-issued rounds. Without a fresh round_id you cannot submit
-- an /answer, so the answer is never visible to the client up front.
CREATE TABLE IF NOT EXISTS rounds (
  round_id      TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL,
  candidate_id  INTEGER NOT NULL,
  issued_at     TEXT NOT NULL DEFAULT (datetime('now')),
  answered_at   TEXT,
  guessed_party TEXT,
  is_correct    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_rounds_session ON rounds(session_id, issued_at DESC);
