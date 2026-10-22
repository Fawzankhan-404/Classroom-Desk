-- Forward-only rebuild of the D1 user FK graph to make Google bindings nullable.

-- The old user and dependent rows are copied inside this migration transaction,

-- then recreated with the same IDs, columns, constraints and indexes.

-- D1 enforces foreign keys; defer checks until the graph is restored.

PRAGMA defer_foreign_keys = ON;

CREATE TABLE cd15_backup_00 AS SELECT * FROM classroom_desk_users;

CREATE TABLE cd15_backup_01 AS SELECT * FROM classroom_desk_account_deletion_requests;

CREATE TABLE cd15_backup_02 AS SELECT * FROM classroom_desk_account_recovery_claims;

CREATE TABLE cd15_backup_03 AS SELECT * FROM classroom_desk_account_recovery_intakes;

CREATE TABLE cd15_backup_04 AS SELECT * FROM classroom_desk_account_recovery_requests;

CREATE TABLE cd15_backup_05 AS SELECT * FROM classroom_desk_account_recovery_review_claims;

CREATE TABLE cd15_backup_06 AS SELECT * FROM classroom_desk_admin_audit;

CREATE TABLE cd15_backup_07 AS SELECT * FROM classroom_desk_connections;

CREATE TABLE cd15_backup_08 AS SELECT * FROM classroom_desk_entitlement_grants;

CREATE TABLE cd15_backup_09 AS SELECT * FROM classroom_desk_link_tokens;

CREATE TABLE cd15_backup_10 AS SELECT * FROM classroom_desk_oauth_accounts;

CREATE TABLE cd15_backup_11 AS SELECT * FROM classroom_desk_payments;

CREATE TABLE cd15_backup_12 AS SELECT * FROM classroom_desk_referral_codes;

CREATE TABLE cd15_backup_13 AS SELECT * FROM classroom_desk_referral_rewards;

CREATE TABLE cd15_backup_14 AS SELECT * FROM classroom_desk_referrals;

CREATE TABLE cd15_backup_15 AS SELECT * FROM classroom_desk_sessions;

CREATE TABLE cd15_backup_16 AS SELECT * FROM classroom_desk_subscription_creation_reservations;

CREATE TABLE cd15_backup_17 AS SELECT * FROM classroom_desk_subscriptions;

CREATE TABLE cd15_backup_18 AS SELECT * FROM classroom_desk_trials;

CREATE TABLE cd15_backup_19 AS SELECT * FROM classroom_desk_user_preferences;

UPDATE classroom_desk_account_recovery_requests SET source_intake_id = NULL;

UPDATE classroom_desk_account_recovery_intakes SET recovery_request_id = NULL;

DROP TABLE classroom_desk_account_recovery_review_claims;

DROP TABLE classroom_desk_account_recovery_claims;

DROP TABLE classroom_desk_account_recovery_intakes;

DROP TABLE classroom_desk_account_recovery_requests;

DROP TABLE classroom_desk_referral_rewards;

DROP TABLE classroom_desk_account_deletion_requests;

DROP TABLE classroom_desk_admin_audit;

DROP TABLE classroom_desk_connections;

DROP TABLE classroom_desk_entitlement_grants;

DROP TABLE classroom_desk_link_tokens;

DROP TABLE classroom_desk_oauth_accounts;

DROP TABLE classroom_desk_payments;

DROP TABLE classroom_desk_referral_codes;

DROP TABLE classroom_desk_referrals;

DROP TABLE classroom_desk_sessions;

DROP TABLE classroom_desk_subscription_creation_reservations;

DROP TABLE classroom_desk_subscriptions;

DROP TABLE classroom_desk_trials;

DROP TABLE classroom_desk_user_preferences;

DROP TABLE classroom_desk_users;

CREATE TABLE classroom_desk_users (
  id TEXT PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab', (abs(random()) % 4) + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  google_subject TEXT,
  email TEXT NOT NULL,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'STUDENT' CHECK (role IN ('SUPER_ADMIN','SUPPORT_ADMIN','STUDENT','TEACHER')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','deleted')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_login_at TEXT
, profile_ciphertext TEXT, google_subject_hash TEXT, email_hash TEXT, display_name_hash TEXT, dashboard_preference TEXT
  CHECK (dashboard_preference IN ('student', 'teacher')), profile_recovery_status TEXT NOT NULL DEFAULT 'ready'
  CHECK (profile_recovery_status IN ('ready','recovery_pending')));

CREATE TABLE classroom_desk_account_deletion_requests (
  id TEXT PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab', (abs(random()) % 4) + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  user_id TEXT NOT NULL REFERENCES classroom_desk_users(id) ON DELETE RESTRICT,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','cancelled','completed')),
  requested_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at TEXT
);

CREATE TABLE classroom_desk_account_recovery_claims (
  recovery_id TEXT PRIMARY KEY NOT NULL REFERENCES classroom_desk_account_recovery_requests(id) ON DELETE RESTRICT,
  account_id TEXT NOT NULL REFERENCES classroom_desk_users(id) ON DELETE RESTRICT,
  completed_at TEXT NOT NULL
);

CREATE TABLE classroom_desk_account_recovery_intakes (
  id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL REFERENCES classroom_desk_users(id) ON DELETE RESTRICT,
  google_subject_hash TEXT NOT NULL,
  google_subject_ciphertext TEXT NOT NULL,
  expected_legacy_ciphertext_hash TEXT NOT NULL,
  claim_evidence_type TEXT NOT NULL CHECK (claim_evidence_type IN ('preexisting_support_record','billing_provider_record','account_specific_recovery_material','other_independent_record')),
  claim_evidence_reference_ciphertext TEXT NOT NULL,
  claim_evidence_reference_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','approved','rejected','expired')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  reviewed_by TEXT REFERENCES classroom_desk_users(id) ON DELETE RESTRICT,
  reviewed_at TEXT,
  review_evidence_type TEXT CHECK (review_evidence_type IS NULL OR review_evidence_type IN ('preexisting_support_record','billing_provider_record','account_specific_recovery_material','other_independent_record')),
  review_evidence_reference_ciphertext TEXT,
  review_evidence_reference_hash TEXT,
  rejection_reason_code TEXT CHECK (rejection_reason_code IS NULL OR rejection_reason_code IN ('insufficient_evidence','account_mismatch','identity_conflict','other')),
  recovery_request_id TEXT REFERENCES classroom_desk_account_recovery_requests(id) ON DELETE RESTRICT
);

CREATE TABLE classroom_desk_account_recovery_requests (
  id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL REFERENCES classroom_desk_users(id) ON DELETE RESTRICT,
  google_subject_hash TEXT NOT NULL,
  expected_legacy_ciphertext_hash TEXT NOT NULL,
  proof_method TEXT NOT NULL CHECK (proof_method = 'independent_manual_review'),
  proof_reference_hash TEXT NOT NULL,
  verified_by TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','completed','revoked','expired')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at TEXT
, source_intake_id TEXT
  REFERENCES classroom_desk_account_recovery_intakes(id) ON DELETE RESTRICT);

CREATE TABLE classroom_desk_account_recovery_review_claims (
  intake_id TEXT PRIMARY KEY NOT NULL REFERENCES classroom_desk_account_recovery_intakes(id) ON DELETE RESTRICT,
  recovery_request_id TEXT UNIQUE REFERENCES classroom_desk_account_recovery_requests(id) ON DELETE RESTRICT,
  reviewed_by TEXT NOT NULL REFERENCES classroom_desk_users(id) ON DELETE RESTRICT,
  reviewed_at TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('approved','rejected'))
);

CREATE TABLE classroom_desk_admin_audit (
  id TEXT PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab', (abs(random()) % 4) + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  actor_user_id TEXT NOT NULL REFERENCES classroom_desk_users(id) ON DELETE RESTRICT,
  target_user_id TEXT REFERENCES classroom_desk_users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  reason TEXT NOT NULL,
  previous_state TEXT,
  new_state TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE classroom_desk_connections (
  website_user_id TEXT PRIMARY KEY NOT NULL REFERENCES classroom_desk_users(id) ON DELETE CASCADE,
  mcp_user_id TEXT NOT NULL UNIQUE,
  connected_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE classroom_desk_entitlement_grants (
  id TEXT PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab', (abs(random()) % 4) + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  user_id TEXT NOT NULL REFERENCES classroom_desk_users(id) ON DELETE CASCADE,
  plan TEXT NOT NULL CHECK (plan IN ('student','teacher')),
  source TEXT NOT NULL CHECK (source IN ('subscription','trial','referral','complimentary','manual')),
  starts_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  reason TEXT
, last_operation_id TEXT);

CREATE TABLE classroom_desk_link_tokens (
  token_hash TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES classroom_desk_users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  used_at TEXT
, consumed_by TEXT);

CREATE TABLE classroom_desk_oauth_accounts (
  website_user_id TEXT PRIMARY KEY REFERENCES classroom_desk_users(id) ON DELETE RESTRICT,
  mcp_user_id TEXT NOT NULL UNIQUE,
  connected_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE classroom_desk_payments (
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
, last_operation_id TEXT, amount_refunded_paise INTEGER NOT NULL DEFAULT 0 CHECK (amount_refunded_paise >= 0 AND amount_refunded_paise <= amount_paise));

CREATE TABLE classroom_desk_referral_codes (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES classroom_desk_users(id) ON DELETE CASCADE,
  code TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE classroom_desk_referral_rewards (
  id TEXT PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab', (abs(random()) % 4) + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  user_id TEXT NOT NULL REFERENCES classroom_desk_users(id) ON DELETE RESTRICT,
  referral_count INTEGER NOT NULL CHECK (referral_count > 0),
  grant_id TEXT NOT NULL REFERENCES classroom_desk_entitlement_grants(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(user_id, referral_count)
);

CREATE TABLE classroom_desk_referrals (
  id TEXT PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab', (abs(random()) % 4) + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  referrer_user_id TEXT NOT NULL REFERENCES classroom_desk_users(id) ON DELETE RESTRICT,
  referred_user_id TEXT NOT NULL UNIQUE REFERENCES classroom_desk_users(id) ON DELETE RESTRICT,
  code TEXT NOT NULL,
  qualified_at TEXT,
  counted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), qualified_operation_id TEXT,
  CHECK (referrer_user_id <> referred_user_id)
);

CREATE TABLE classroom_desk_sessions (
  id TEXT PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab', (abs(random()) % 4) + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  user_id TEXT NOT NULL REFERENCES classroom_desk_users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE classroom_desk_subscription_creation_reservations (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES classroom_desk_users(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL UNIQUE,
  plan TEXT NOT NULL CHECK (plan IN ('student','teacher')),
  state TEXT NOT NULL CHECK (state IN ('creating','unknown')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE classroom_desk_subscriptions (
  id TEXT PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab', (abs(random()) % 4) + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  user_id TEXT NOT NULL REFERENCES classroom_desk_users(id) ON DELETE CASCADE,
  plan TEXT NOT NULL CHECK (plan IN ('student','teacher')),
  status TEXT NOT NULL CHECK (status IN ('pending','active','cancelled','past_due','expired','refunded')),
  paid_through TEXT,
  cancelled_at TEXT,
  provider_subscription_id TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE classroom_desk_trials (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES classroom_desk_users(id) ON DELETE CASCADE,
  payment_id TEXT UNIQUE,
  paid_at TEXT,
  starts_at TEXT,
  expires_at TEXT,
  status TEXT NOT NULL DEFAULT 'eligible' CHECK (status IN ('eligible','pending','active','expired','refunded')),
  pending_at TEXT
);

CREATE TABLE classroom_desk_user_preferences (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES classroom_desk_users(id) ON DELETE CASCADE,
  experience TEXT NOT NULL CHECK (experience IN ('student','teacher')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

INSERT INTO classroom_desk_users (id, google_subject, email, display_name, role, status, created_at, last_login_at, profile_ciphertext, google_subject_hash, email_hash, display_name_hash, dashboard_preference, profile_recovery_status) SELECT id, google_subject, email, display_name, role, status, created_at, last_login_at, profile_ciphertext, google_subject_hash, email_hash, display_name_hash, dashboard_preference, profile_recovery_status FROM cd15_backup_00;

INSERT INTO classroom_desk_account_deletion_requests SELECT * FROM cd15_backup_01;

INSERT INTO classroom_desk_account_recovery_claims SELECT * FROM cd15_backup_02;

INSERT INTO classroom_desk_account_recovery_intakes SELECT * FROM cd15_backup_03;

INSERT INTO classroom_desk_account_recovery_requests SELECT * FROM cd15_backup_04;

INSERT INTO classroom_desk_account_recovery_review_claims SELECT * FROM cd15_backup_05;

INSERT INTO classroom_desk_admin_audit SELECT * FROM cd15_backup_06;

INSERT INTO classroom_desk_connections SELECT * FROM cd15_backup_07;

INSERT INTO classroom_desk_entitlement_grants SELECT * FROM cd15_backup_08;

INSERT INTO classroom_desk_link_tokens SELECT * FROM cd15_backup_09;

INSERT INTO classroom_desk_oauth_accounts SELECT * FROM cd15_backup_10;

INSERT INTO classroom_desk_payments SELECT * FROM cd15_backup_11;

INSERT INTO classroom_desk_referral_codes SELECT * FROM cd15_backup_12;

INSERT INTO classroom_desk_referral_rewards SELECT * FROM cd15_backup_13;

INSERT INTO classroom_desk_referrals SELECT * FROM cd15_backup_14;

INSERT INTO classroom_desk_sessions SELECT * FROM cd15_backup_15;

INSERT INTO classroom_desk_subscription_creation_reservations SELECT * FROM cd15_backup_16;

INSERT INTO classroom_desk_subscriptions SELECT * FROM cd15_backup_17;

INSERT INTO classroom_desk_trials SELECT * FROM cd15_backup_18;

INSERT INTO classroom_desk_user_preferences SELECT * FROM cd15_backup_19;

CREATE INDEX classroom_desk_grants_user_idx ON classroom_desk_entitlement_grants(user_id, expires_at);

CREATE INDEX classroom_desk_link_tokens_expiry_idx ON classroom_desk_link_tokens(expires_at);

CREATE UNIQUE INDEX classroom_desk_open_deletion_request_idx
  ON classroom_desk_account_deletion_requests(user_id) WHERE status = 'requested';

CREATE INDEX classroom_desk_payments_order_idx ON classroom_desk_payments(provider_order_id);

CREATE UNIQUE INDEX classroom_desk_payments_provider_order_unique_idx
  ON classroom_desk_payments(provider_order_id)
  WHERE provider_order_id IS NOT NULL;

CREATE INDEX classroom_desk_payments_subscription_idx ON classroom_desk_payments(provider_subscription_id);

CREATE INDEX classroom_desk_recovery_intake_expiry_idx
  ON classroom_desk_account_recovery_intakes(expires_at) WHERE status='submitted';

CREATE UNIQUE INDEX classroom_desk_recovery_intake_pending_account_idx
  ON classroom_desk_account_recovery_intakes(account_id) WHERE status='submitted';

CREATE UNIQUE INDEX classroom_desk_recovery_intake_pending_subject_idx
  ON classroom_desk_account_recovery_intakes(google_subject_hash) WHERE status='submitted';

CREATE UNIQUE INDEX classroom_desk_recovery_intake_request_idx
  ON classroom_desk_account_recovery_intakes(recovery_request_id) WHERE recovery_request_id IS NOT NULL;

CREATE UNIQUE INDEX classroom_desk_recovery_pending_account_idx
  ON classroom_desk_account_recovery_requests(account_id) WHERE status='pending';

CREATE UNIQUE INDEX classroom_desk_recovery_pending_subject_idx
  ON classroom_desk_account_recovery_requests(google_subject_hash) WHERE status='pending';

CREATE UNIQUE INDEX classroom_desk_recovery_request_source_idx
  ON classroom_desk_account_recovery_requests(source_intake_id) WHERE source_intake_id IS NOT NULL;

CREATE INDEX classroom_desk_sessions_expiry_idx ON classroom_desk_sessions(expires_at);

CREATE INDEX classroom_desk_subscriptions_user_idx ON classroom_desk_subscriptions(user_id, status, paid_through);

CREATE INDEX classroom_desk_users_email_hash_idx
  ON classroom_desk_users(email_hash) WHERE email_hash IS NOT NULL;

CREATE UNIQUE INDEX classroom_desk_users_google_subject_hash_idx
  ON classroom_desk_users(google_subject_hash) WHERE google_subject_hash IS NOT NULL;

CREATE UNIQUE INDEX classroom_desk_users_google_subject_active_idx ON classroom_desk_users(google_subject) WHERE google_subject IS NOT NULL;

CREATE TABLE classroom_desk_detached_google_identities (
  account_id TEXT PRIMARY KEY NOT NULL REFERENCES classroom_desk_users(id) ON DELETE RESTRICT,
  google_subject TEXT,
  google_subject_hash TEXT,
  detached_at TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason = 'owner_authorized_auth_reset'),
  CHECK (google_subject IS NOT NULL OR google_subject_hash IS NOT NULL)
);

-- Private migration guard. The reset migration inserts only rows that pass its
-- exact precondition checks; CHECK constraints make count mismatches abort it.
CREATE TABLE classroom_desk_auth_reset_guard (
  id INTEGER PRIMARY KEY,
  asserted INTEGER NOT NULL CHECK (asserted = 1)
);

-- Aggregate-only evidence for the one-time authentication reset. No identity,
-- token, email, or account payload is recorded here.
CREATE TABLE classroom_desk_auth_reset_audit (
  id TEXT PRIMARY KEY NOT NULL,
  applied_at TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason = 'owner_authorized_auth_reset'),
  detached_users INTEGER NOT NULL,
  revoked_grants INTEGER NOT NULL,
  revoked_refresh_records INTEGER NOT NULL,
  revoked_sessions INTEGER NOT NULL,
  removed_connection_mappings INTEGER NOT NULL,
  preserved_oauth_clients INTEGER NOT NULL,
  preserved_trials INTEGER NOT NULL,
  preserved_subscriptions INTEGER NOT NULL,
  preserved_payments INTEGER NOT NULL,
  preserved_webhook_events INTEGER NOT NULL
);

DROP TABLE cd15_backup_19;

DROP TABLE cd15_backup_18;

DROP TABLE cd15_backup_17;

DROP TABLE cd15_backup_16;

DROP TABLE cd15_backup_15;

DROP TABLE cd15_backup_14;

DROP TABLE cd15_backup_13;

DROP TABLE cd15_backup_12;

DROP TABLE cd15_backup_11;

DROP TABLE cd15_backup_10;

DROP TABLE cd15_backup_09;

DROP TABLE cd15_backup_08;

DROP TABLE cd15_backup_07;

DROP TABLE cd15_backup_06;

DROP TABLE cd15_backup_05;

DROP TABLE cd15_backup_04;

DROP TABLE cd15_backup_03;

DROP TABLE cd15_backup_02;

DROP TABLE cd15_backup_01;

DROP TABLE cd15_backup_00;

-- The migration transaction fails if any deferred FK remains invalid.
