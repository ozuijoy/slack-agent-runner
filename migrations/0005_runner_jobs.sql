-- ②: a turn waits here for a machine of your own instead of starting in a rented sandbox.
-- One row per turn. `payload` is the whole RunnerJob (src/runner-jobs.ts), so a machine that claims
-- a job needs nothing else from the Worker to run it.
CREATE TABLE IF NOT EXISTS runner_jobs (
  id          TEXT PRIMARY KEY,   -- the turn id
  channel     TEXT NOT NULL,
  thread_ts   TEXT NOT NULL,
  turn_id     TEXT NOT NULL,
  payload     TEXT NOT NULL,
  status      TEXT NOT NULL,      -- queued | leased | done | failed
  lease_until INTEGER,            -- ms since the epoch; past it, any machine may take the job
  attempts    INTEGER NOT NULL DEFAULT 0,
  runner      TEXT,               -- the machine holding the lease
  note        TEXT,               -- why a job failed, for the log and the UI
  created_at  INTEGER NOT NULL
);
-- The only query the queue makes: the oldest job nobody is holding.
CREATE INDEX IF NOT EXISTS runner_jobs_waiting ON runner_jobs (status, created_at);

-- A thread's Claude session, gzipped and cut into rows: D1 holds at most 2 MB in one.
CREATE TABLE IF NOT EXISTS session_chunks (
  key   TEXT NOT NULL,            -- channel/thread_ts (src/runner-jobs.ts)
  idx   INTEGER NOT NULL,
  bytes BLOB NOT NULL,
  PRIMARY KEY (key, idx)
);
-- The size, so a reader knows how many chunks to expect before reading them.
CREATE TABLE IF NOT EXISTS sessions (
  key        TEXT PRIMARY KEY,
  bytes      INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);