-- Additive ownership records for unified OAuth. Legacy mappings, Google grants,
-- tokens, subscriptions and entitlements are deliberately retained unchanged.
CREATE TABLE IF NOT EXISTS classroom_desk_oauth_accounts (
  website_user_id TEXT PRIMARY KEY REFERENCES classroom_desk_users(id) ON DELETE RESTRICT,
  mcp_user_id TEXT NOT NULL UNIQUE,
  connected_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
