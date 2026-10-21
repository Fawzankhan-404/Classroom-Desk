-- A recovery request is created only after an independent ownership check.
-- The old ciphertext remains in place until one verified Google OAuth callback
-- replaces the profile and grant in a single D1 batch.
ALTER TABLE classroom_desk_users
  ADD COLUMN profile_recovery_status TEXT NOT NULL DEFAULT 'ready'
  CHECK (profile_recovery_status IN ('ready','recovery_pending'));

CREATE TABLE IF NOT EXISTS classroom_desk_account_recovery_requests (
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
);
CREATE UNIQUE INDEX IF NOT EXISTS classroom_desk_recovery_pending_subject_idx
  ON classroom_desk_account_recovery_requests(google_subject_hash) WHERE status='pending';
CREATE UNIQUE INDEX IF NOT EXISTS classroom_desk_recovery_pending_account_idx
  ON classroom_desk_account_recovery_requests(account_id) WHERE status='pending';

-- A completion row is the final atomic guard for profile + OAuth grant + code.
-- NOT NULL and unique constraints make a missing/duplicate completion abort D1 batch.
CREATE TABLE IF NOT EXISTS classroom_desk_account_recovery_claims (
  recovery_id TEXT PRIMARY KEY NOT NULL REFERENCES classroom_desk_account_recovery_requests(id) ON DELETE RESTRICT,
  account_id TEXT NOT NULL REFERENCES classroom_desk_users(id) ON DELETE RESTRICT,
  completed_at TEXT NOT NULL
);
