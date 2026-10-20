-- Reserve one subscription creation per account before calling the payment provider.
-- Ambiguous provider outcomes stay blocked for manual reconciliation.
CREATE TABLE IF NOT EXISTS classroom_desk_subscription_creation_reservations (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES classroom_desk_users(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL UNIQUE,
  plan TEXT NOT NULL CHECK (plan IN ('student','teacher')),
  state TEXT NOT NULL CHECK (state IN ('creating','unknown')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
