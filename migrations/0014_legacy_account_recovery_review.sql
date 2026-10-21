-- Add an authenticated claimant intake and owner-review record for legacy
-- account recovery. Intake never changes the account or its billing state.
CREATE TABLE IF NOT EXISTS classroom_desk_recovery_access_sessions (
  token_hash TEXT PRIMARY KEY NOT NULL,
  google_subject_hash TEXT NOT NULL,
  google_subject_ciphertext TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS classroom_desk_recovery_access_expiry_idx
  ON classroom_desk_recovery_access_sessions(expires_at);

CREATE TABLE IF NOT EXISTS classroom_desk_account_recovery_intakes (
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
CREATE UNIQUE INDEX IF NOT EXISTS classroom_desk_recovery_intake_pending_account_idx
  ON classroom_desk_account_recovery_intakes(account_id) WHERE status='submitted';
CREATE UNIQUE INDEX IF NOT EXISTS classroom_desk_recovery_intake_pending_subject_idx
  ON classroom_desk_account_recovery_intakes(google_subject_hash) WHERE status='submitted';
CREATE INDEX IF NOT EXISTS classroom_desk_recovery_intake_expiry_idx
  ON classroom_desk_account_recovery_intakes(expires_at) WHERE status='submitted';
CREATE UNIQUE INDEX IF NOT EXISTS classroom_desk_recovery_intake_request_idx
  ON classroom_desk_account_recovery_intakes(recovery_request_id) WHERE recovery_request_id IS NOT NULL;

ALTER TABLE classroom_desk_account_recovery_requests ADD COLUMN source_intake_id TEXT
  REFERENCES classroom_desk_account_recovery_intakes(id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX IF NOT EXISTS classroom_desk_recovery_request_source_idx
  ON classroom_desk_account_recovery_requests(source_intake_id) WHERE source_intake_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS classroom_desk_account_recovery_review_claims (
  intake_id TEXT PRIMARY KEY NOT NULL REFERENCES classroom_desk_account_recovery_intakes(id) ON DELETE RESTRICT,
  recovery_request_id TEXT UNIQUE REFERENCES classroom_desk_account_recovery_requests(id) ON DELETE RESTRICT,
  reviewed_by TEXT NOT NULL REFERENCES classroom_desk_users(id) ON DELETE RESTRICT,
  reviewed_at TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('approved','rejected'))
);
