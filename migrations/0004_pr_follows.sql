-- Pull requests the bot opened and follows: GitHub's webhook wakes the thread that opened one
-- (src/pr-follow.ts the rules, src/pr-follow-store.ts the queries, src/pr-follow-fire.ts the webhook
-- and the sweep).
CREATE TABLE IF NOT EXISTS pr_follows (
  -- owner/name, lower-case.
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  -- The thread that opened it. Taken from the sandbox's token, never its body.
  channel TEXT NOT NULL,
  thread_ts TEXT NOT NULL,
  -- The Worker's own address, so a wake started by the Cron Trigger knows where the sandbox reports.
  origin TEXT NOT NULL,
  url TEXT NOT NULL,
  title TEXT,
  -- Who was talking to the bot when it followed the PR (a Slack user id).
  followed_by TEXT,
  -- 'active', or 'ended' (merged, closed or unfollowed).
  status TEXT NOT NULL DEFAULT 'active',
  -- Event lines waiting to wake the thread, a JSON array, and when the first one arrived.
  pending TEXT,
  pending_since INTEGER,
  -- The daily cap: wakes on wake_day (UTC, YYYY-MM-DD), and the day the "stopped" note was posted.
  wake_day TEXT,
  wake_count INTEGER NOT NULL DEFAULT 0,
  stop_noted_day TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (repo, number)
);

CREATE INDEX IF NOT EXISTS pr_follows_due ON pr_follows (status, pending_since);
