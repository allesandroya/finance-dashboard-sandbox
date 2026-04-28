-- Cash Flow Bot — D1 schema (Phase 8.2: cloud sync)
--
-- Run once against the D1 database bound to the Worker as FB_DB:
--   wrangler d1 execute finance-bot-db --remote --file=docs/schema.sql
-- Or paste into the Cloudflare dashboard → D1 → Console.

CREATE TABLE IF NOT EXISTS user_state (
  user_id             TEXT PRIMARY KEY,
  state_json          TEXT NOT NULL,
  updated_at          INTEGER NOT NULL,
  size_bytes          INTEGER NOT NULL,
  last_device_label   TEXT
);

CREATE INDEX IF NOT EXISTS idx_user_state_updated_at ON user_state(updated_at);

-- Optional: when we add a /api/admin/users endpoint, this view lets us
-- enumerate plans from D1 cheaply. For now users live in KV; this is
-- future-proofing so `plan` upgrades can be scripted with a single
-- SQL UPDATE once migrated.
--
-- CREATE TABLE IF NOT EXISTS users (
--   user_id     TEXT PRIMARY KEY,
--   email       TEXT UNIQUE NOT NULL,
--   plan        TEXT NOT NULL DEFAULT 'free',
--   created_at  INTEGER NOT NULL,
--   last_seen   INTEGER NOT NULL
-- );
