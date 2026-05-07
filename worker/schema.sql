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
