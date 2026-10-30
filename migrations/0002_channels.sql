-- Per-channel settings, set on the web UI's Channels page (src/channels.ts, src/channel-store.ts).
-- A channel with no row has the defaults: not watched, the default model, no secrets.
CREATE TABLE IF NOT EXISTS channel_settings (
  channel TEXT PRIMARY KEY,
  -- 1: answer every root message without an @mention.
  watched INTEGER NOT NULL DEFAULT 0,
  -- A model alias from src/models.ts, or NULL for the default.
  default_model TEXT,
  updated_at INTEGER NOT NULL,
  -- Who changed it last (the web UI's signed-in email), for the record.
  updated_by TEXT
);

-- A channel's secrets, AES-GCM encrypted with the CHANNEL_SECRETS_KEY Worker secret. Only that
-- channel's sandboxes get them, as env vars. The plain value is never stored or read back out.
CREATE TABLE IF NOT EXISTS channel_secrets (
  channel TEXT NOT NULL,
  name TEXT NOT NULL,
  iv TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT,
  PRIMARY KEY (channel, name)
);
