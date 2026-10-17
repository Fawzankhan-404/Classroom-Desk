-- IDs and timestamps have SQLite defaults because application inserts often omit them.
-- D1 enables foreign key enforcement for Worker queries.
-- Keep timestamps in UTC ISO-8601 form so lexical comparisons remain chronological.
-- UUID values use RFC 4122 version-4/variant bits generated from SQLite randomness.
-- (The expressions below intentionally avoid requiring an extension.)

CREATE TABLE IF NOT EXISTS classroom_desk_users (
  id TEXT PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab', (abs(random()) % 4) + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  google_subject TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'STUDENT' CHECK (role IN ('SUPER_ADMIN','SUPPORT_ADMIN','STUDENT','TEACHER')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','deleted')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS classroom_desk_sessions (
  id TEXT PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab', (abs(random()) % 4) + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  user_id TEXT NOT NULL REFERENCES classroom_desk_users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS classroom_desk_sessions_expiry_idx ON classroom_desk_sessions(expires_at);

CREATE TABLE IF NOT EXISTS classroom_desk_trials (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES classroom_desk_users(id) ON DELETE CASCADE,
  payment_id TEXT UNIQUE,
  paid_at TEXT,
  starts_at TEXT,
  expires_at TEXT,
  status TEXT NOT NULL DEFAULT 'eligible' CHECK (status IN ('eligible','pending','active','expired','refunded')),
  pending_at TEXT
);

CREATE TABLE IF NOT EXISTS classroom_desk_subscriptions (
  id TEXT PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab', (abs(random()) % 4) + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  user_id TEXT NOT NULL REFERENCES classroom_desk_users(id) ON DELETE CASCADE,
  plan TEXT NOT NULL CHECK (plan IN ('student','teacher')),
  status TEXT NOT NULL CHECK (status IN ('pending','active','cancelled','past_due','expired','refunded')),
  paid_through TEXT,
  cancelled_at TEXT,
  provider_subscription_id TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS classroom_desk_subscriptions_user_idx ON classroom_desk_subscriptions(user_id, status, paid_through);

CREATE TABLE IF NOT EXISTS classroom_desk_entitlement_grants (
  id TEXT PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab', (abs(random()) % 4) + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  user_id TEXT NOT NULL REFERENCES classroom_desk_users(id) ON DELETE CASCADE,
  plan TEXT NOT NULL CHECK (plan IN ('student','teacher')),
  source TEXT NOT NULL CHECK (source IN ('subscription','trial','referral','complimentary','manual')),
  starts_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  reason TEXT
);
CREATE INDEX IF NOT EXISTS classroom_desk_grants_user_idx ON classroom_desk_entitlement_grants(user_id, expires_at);

CREATE TABLE IF NOT EXISTS classroom_desk_payments (
  id TEXT PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab', (abs(random()) % 4) + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  user_id TEXT NOT NULL REFERENCES classroom_desk_users(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('trial','subscription','refund')),
  plan TEXT CHECK (plan IN ('student','teacher')),
  amount_paise INTEGER NOT NULL CHECK (amount_paise >= 0),
  currency TEXT NOT NULL DEFAULT 'INR',
  provider_order_id TEXT,
  provider_payment_id TEXT UNIQUE,
  provider_subscription_id TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS classroom_desk_payments_order_idx ON classroom_desk_payments(provider_order_id);
CREATE INDEX IF NOT EXISTS classroom_desk_payments_subscription_idx ON classroom_desk_payments(provider_subscription_id);

CREATE TABLE IF NOT EXISTS classroom_desk_webhook_events (
  event_id TEXT PRIMARY KEY NOT NULL,
  event_type TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  processed_at TEXT,
  status TEXT NOT NULL DEFAULT 'received'
);

CREATE TABLE IF NOT EXISTS classroom_desk_referral_codes (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES classroom_desk_users(id) ON DELETE CASCADE,
  code TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS classroom_desk_link_tokens (
  token_hash TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES classroom_desk_users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  used_at TEXT
);

CREATE TABLE IF NOT EXISTS classroom_desk_connections (
  website_user_id TEXT PRIMARY KEY NOT NULL REFERENCES classroom_desk_users(id) ON DELETE CASCADE,
  mcp_user_id TEXT NOT NULL UNIQUE,
  connected_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS classroom_desk_referrals (
  id TEXT PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab', (abs(random()) % 4) + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  referrer_user_id TEXT NOT NULL REFERENCES classroom_desk_users(id) ON DELETE RESTRICT,
  referred_user_id TEXT NOT NULL UNIQUE REFERENCES classroom_desk_users(id) ON DELETE RESTRICT,
  code TEXT NOT NULL,
  qualified_at TEXT,
  counted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (referrer_user_id <> referred_user_id)
);

CREATE TABLE IF NOT EXISTS classroom_desk_referral_rewards (
  id TEXT PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab', (abs(random()) % 4) + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  user_id TEXT NOT NULL REFERENCES classroom_desk_users(id) ON DELETE RESTRICT,
  referral_count INTEGER NOT NULL CHECK (referral_count > 0),
  grant_id TEXT NOT NULL REFERENCES classroom_desk_entitlement_grants(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(user_id, referral_count)
);

CREATE TABLE IF NOT EXISTS classroom_desk_admin_audit (
  id TEXT PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab', (abs(random()) % 4) + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  actor_user_id TEXT NOT NULL REFERENCES classroom_desk_users(id) ON DELETE RESTRICT,
  target_user_id TEXT REFERENCES classroom_desk_users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  reason TEXT NOT NULL,
  previous_state TEXT,
  new_state TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS classroom_desk_feature_flags (
  key TEXT PRIMARY KEY NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS classroom_desk_account_deletion_requests (
  id TEXT PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab', (abs(random()) % 4) + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  user_id TEXT NOT NULL REFERENCES classroom_desk_users(id) ON DELETE RESTRICT,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','cancelled','completed')),
  requested_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS classroom_desk_open_deletion_request_idx
  ON classroom_desk_account_deletion_requests(user_id) WHERE status = 'requested';

CREATE TABLE IF NOT EXISTS classroom_desk_auth_records (
  kind TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  state_hash TEXT,
  owner_id TEXT,
  payload TEXT NOT NULL,
  expires_at INTEGER,
  started INTEGER NOT NULL DEFAULT 0 CHECK (started IN (0,1)),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (kind, key_hash)
);
CREATE UNIQUE INDEX IF NOT EXISTS classroom_desk_auth_state_idx
  ON classroom_desk_auth_records(kind, state_hash) WHERE state_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS classroom_desk_auth_owner_idx
  ON classroom_desk_auth_records(owner_id) WHERE owner_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS classroom_desk_auth_expiry_idx
  ON classroom_desk_auth_records(expires_at) WHERE expires_at IS NOT NULL;
