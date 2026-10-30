-- Routines: a prompt the bot runs on a schedule, each run in a new thread in its channel
-- (src/routines.ts the rules, src/routine-store.ts the queries, src/routine-fire.ts the firing).
CREATE TABLE IF NOT EXISTS routines (
  id TEXT PRIMARY KEY,
  -- Where it was made, and where every run posts. Taken from the sandbox's token, never its body.
  channel TEXT NOT NULL,
  prompt TEXT NOT NULL,
  -- Five-field cron, read in `timezone` (an IANA name such as Europe/London).
  cron TEXT NOT NULL,
  timezone TEXT NOT NULL,
  -- A model alias from src/models.ts, or NULL for the channel's default.
  model TEXT,
  -- 'active' or 'paused'.
  status TEXT NOT NULL DEFAULT 'active',
  -- The Worker's own address, so a run started by the Cron Trigger knows where the sandbox reports.
  origin TEXT NOT NULL,
  -- Who asked for it (a Slack user id) and the thread it was made in, for the record.
  created_by TEXT,
  created_thread_ts TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  -- When it fires next (ms). Stored so the sweep is one indexed query; NULL while paused.
  next_run_at INTEGER,
  last_run_at INTEGER
);

CREATE INDEX IF NOT EXISTS routines_due ON routines (status, next_run_at);
CREATE INDEX IF NOT EXISTS routines_by_channel ON routines (channel, created_at);

-- One row per run. The unique (routine_id, due_at) is the claim: two sweeps that read the same due
-- time cannot both insert it, so a run never fires twice.
CREATE TABLE IF NOT EXISTS routine_runs (
  id TEXT PRIMARY KEY,
  routine_id TEXT NOT NULL,
  due_at INTEGER NOT NULL,
  -- 'starting', then 'started' (its thread is up) or 'failed' (see error).
  status TEXT NOT NULL,
  -- The run's thread: the root message the bot posted.
  thread_ts TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (routine_id, due_at)
);

CREATE INDEX IF NOT EXISTS routine_runs_by_routine ON routine_runs (routine_id, due_at);
