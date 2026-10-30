-- One row per transcript backup in R2 (src/transcripts.ts). R2 holds the bytes; this lets a page
-- list a thread's turns, newest first, without listing the bucket.
CREATE TABLE IF NOT EXISTS transcripts (
  key TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  thread_ts TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS transcripts_by_thread ON transcripts (channel, thread_ts, created_at);
