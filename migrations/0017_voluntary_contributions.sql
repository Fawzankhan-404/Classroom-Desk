-- Isolated voluntary one-time contribution tracking. This data never grants
-- subscriptions or Classroom entitlements and is separate from billing rows.
CREATE TABLE IF NOT EXISTS classroom_desk_contributions (
  id TEXT PRIMARY KEY NOT NULL,
  request_key_hash TEXT NOT NULL UNIQUE,
  amount_paise INTEGER NOT NULL CHECK (amount_paise >= 1000),
  currency TEXT NOT NULL DEFAULT 'INR' CHECK (currency = 'INR'),
  status TEXT NOT NULL CHECK (status IN ('creating','pending','paid','reconciliation_required')),
  provider_order_id TEXT UNIQUE,
  provider_payment_id TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  paid_at TEXT
);

CREATE INDEX IF NOT EXISTS classroom_desk_contributions_created_idx
  ON classroom_desk_contributions(created_at);

CREATE TABLE IF NOT EXISTS classroom_desk_contribution_webhook_events (
  event_id TEXT PRIMARY KEY NOT NULL,
  payload_hash TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
