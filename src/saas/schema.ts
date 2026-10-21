/** Additive SaaS schema. Apply with a reviewed direct Neon migration, never at Worker request time. */
export const SAAS_SCHEMA_VERSION = 8;
export const SaaSMigration = `
CREATE TABLE IF NOT EXISTS classroom_desk_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  google_subject text NOT NULL UNIQUE,
  email text NOT NULL,
  display_name text NOT NULL,
  profile_ciphertext text,
  google_subject_hash text,
  email_hash text,
  display_name_hash text,
  role text NOT NULL DEFAULT 'STUDENT' CHECK (role IN ('SUPER_ADMIN','SUPPORT_ADMIN','STUDENT','TEACHER')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','deleted')),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);
-- These columns are also added conditionally so existing installations can upgrade in place.
ALTER TABLE classroom_desk_users ADD COLUMN IF NOT EXISTS profile_ciphertext text;
ALTER TABLE classroom_desk_users ADD COLUMN IF NOT EXISTS google_subject_hash text;
ALTER TABLE classroom_desk_users ADD COLUMN IF NOT EXISTS email_hash text;
ALTER TABLE classroom_desk_users ADD COLUMN IF NOT EXISTS display_name_hash text;
ALTER TABLE classroom_desk_users ADD COLUMN IF NOT EXISTS profile_recovery_status text NOT NULL DEFAULT 'ready' CHECK (profile_recovery_status IN ('ready','recovery_pending'));
CREATE UNIQUE INDEX IF NOT EXISTS classroom_desk_users_google_subject_hash_idx ON classroom_desk_users(google_subject_hash) WHERE google_subject_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS classroom_desk_users_email_hash_idx ON classroom_desk_users(email_hash) WHERE email_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS classroom_desk_users_display_name_hash_idx ON classroom_desk_users(display_name_hash) WHERE display_name_hash IS NOT NULL;
CREATE TABLE IF NOT EXISTS classroom_desk_account_recovery_requests (
  id text PRIMARY KEY NOT NULL,
  account_id uuid NOT NULL REFERENCES classroom_desk_users(id) ON DELETE RESTRICT,
  google_subject_hash text NOT NULL,
  expected_legacy_ciphertext_hash text NOT NULL,
  proof_method text NOT NULL CHECK (proof_method='independent_manual_review'),
  proof_reference_hash text NOT NULL,
  verified_by text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','completed','revoked','expired')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS classroom_desk_recovery_pending_subject_idx ON classroom_desk_account_recovery_requests(google_subject_hash) WHERE status='pending';
CREATE UNIQUE INDEX IF NOT EXISTS classroom_desk_recovery_pending_account_idx ON classroom_desk_account_recovery_requests(account_id) WHERE status='pending';
CREATE TABLE IF NOT EXISTS classroom_desk_account_recovery_claims (
  recovery_id text PRIMARY KEY NOT NULL REFERENCES classroom_desk_account_recovery_requests(id) ON DELETE RESTRICT,
  account_id uuid NOT NULL REFERENCES classroom_desk_users(id) ON DELETE RESTRICT,
  completed_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS classroom_desk_recovery_access_sessions (
  token_hash text PRIMARY KEY NOT NULL,
  google_subject_hash text NOT NULL,
  google_subject_ciphertext text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS classroom_desk_recovery_access_expiry_idx ON classroom_desk_recovery_access_sessions(expires_at);
CREATE TABLE IF NOT EXISTS classroom_desk_account_recovery_intakes (
  id text PRIMARY KEY NOT NULL,
  account_id uuid NOT NULL REFERENCES classroom_desk_users(id) ON DELETE RESTRICT,
  google_subject_hash text NOT NULL,
  google_subject_ciphertext text NOT NULL,
  expected_legacy_ciphertext_hash text NOT NULL,
  claim_evidence_type text NOT NULL CHECK (claim_evidence_type IN ('preexisting_support_record','billing_provider_record','account_specific_recovery_material','other_independent_record')),
  claim_evidence_reference_ciphertext text NOT NULL,
  claim_evidence_reference_hash text NOT NULL,
  status text NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','approved','rejected','expired')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  reviewed_by uuid REFERENCES classroom_desk_users(id) ON DELETE RESTRICT,
  reviewed_at timestamptz,
  review_evidence_type text CHECK (review_evidence_type IS NULL OR review_evidence_type IN ('preexisting_support_record','billing_provider_record','account_specific_recovery_material','other_independent_record')),
  review_evidence_reference_ciphertext text,
  review_evidence_reference_hash text,
  rejection_reason_code text CHECK (rejection_reason_code IS NULL OR rejection_reason_code IN ('insufficient_evidence','account_mismatch','identity_conflict','other')),
  recovery_request_id text REFERENCES classroom_desk_account_recovery_requests(id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX IF NOT EXISTS classroom_desk_recovery_intake_pending_account_idx ON classroom_desk_account_recovery_intakes(account_id) WHERE status='submitted';
CREATE UNIQUE INDEX IF NOT EXISTS classroom_desk_recovery_intake_pending_subject_idx ON classroom_desk_account_recovery_intakes(google_subject_hash) WHERE status='submitted';
CREATE INDEX IF NOT EXISTS classroom_desk_recovery_intake_expiry_idx ON classroom_desk_account_recovery_intakes(expires_at) WHERE status='submitted';
CREATE UNIQUE INDEX IF NOT EXISTS classroom_desk_recovery_intake_request_idx ON classroom_desk_account_recovery_intakes(recovery_request_id) WHERE recovery_request_id IS NOT NULL;
ALTER TABLE classroom_desk_account_recovery_requests ADD COLUMN IF NOT EXISTS source_intake_id text REFERENCES classroom_desk_account_recovery_intakes(id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX IF NOT EXISTS classroom_desk_recovery_request_source_idx ON classroom_desk_account_recovery_requests(source_intake_id) WHERE source_intake_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS classroom_desk_account_recovery_review_claims (
  intake_id text PRIMARY KEY NOT NULL REFERENCES classroom_desk_account_recovery_intakes(id) ON DELETE RESTRICT,
  recovery_request_id text UNIQUE REFERENCES classroom_desk_account_recovery_requests(id) ON DELETE RESTRICT,
  reviewed_by uuid NOT NULL REFERENCES classroom_desk_users(id) ON DELETE RESTRICT,
  reviewed_at timestamptz NOT NULL,
  decision text NOT NULL CHECK (decision IN ('approved','rejected'))
);
CREATE TABLE IF NOT EXISTS classroom_desk_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES classroom_desk_users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS classroom_desk_sessions_expiry_idx ON classroom_desk_sessions(expires_at);
CREATE TABLE IF NOT EXISTS classroom_desk_trials (
  user_id uuid PRIMARY KEY REFERENCES classroom_desk_users(id) ON DELETE CASCADE,
  payment_id text UNIQUE,
  paid_at timestamptz,
  starts_at timestamptz,
  expires_at timestamptz,
  status text NOT NULL DEFAULT 'eligible' CHECK (status IN ('eligible','pending','active','expired','refunded'))
);
ALTER TABLE classroom_desk_trials ADD COLUMN IF NOT EXISTS pending_at timestamptz;
CREATE TABLE IF NOT EXISTS classroom_desk_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES classroom_desk_users(id) ON DELETE CASCADE,
  plan text NOT NULL CHECK (plan IN ('student','teacher')),
  status text NOT NULL CHECK (status IN ('pending','active','cancelled','past_due','expired','refunded')),
  paid_through timestamptz,
  cancelled_at timestamptz,
  provider_subscription_id text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS classroom_desk_subscriptions_user_idx ON classroom_desk_subscriptions(user_id, status, paid_through);
CREATE TABLE IF NOT EXISTS classroom_desk_subscription_creation_reservations (
  user_id uuid PRIMARY KEY REFERENCES classroom_desk_users(id) ON DELETE CASCADE,
  request_id uuid NOT NULL UNIQUE,
  plan text NOT NULL CHECK (plan IN ('student','teacher')),
  state text NOT NULL CHECK (state IN ('creating','unknown')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS classroom_desk_entitlement_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES classroom_desk_users(id) ON DELETE CASCADE,
  plan text NOT NULL CHECK (plan IN ('student','teacher')),
  source text NOT NULL CHECK (source IN ('subscription','trial','referral','complimentary','manual')),
  starts_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  reason text,
  last_operation_id text
);
ALTER TABLE classroom_desk_entitlement_grants ADD COLUMN IF NOT EXISTS last_operation_id text;
CREATE INDEX IF NOT EXISTS classroom_desk_grants_user_idx ON classroom_desk_entitlement_grants(user_id, expires_at);
CREATE TABLE IF NOT EXISTS classroom_desk_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES classroom_desk_users(id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('trial','subscription','refund')),
  plan text CHECK (plan IN ('student','teacher')),
  amount_paise integer NOT NULL CHECK (amount_paise >= 0),
  currency text NOT NULL DEFAULT 'INR',
  provider_order_id text,
  provider_payment_id text UNIQUE,
  provider_subscription_id text,
  status text NOT NULL,
  amount_refunded_paise integer NOT NULL DEFAULT 0 CHECK (amount_refunded_paise >= 0 AND amount_refunded_paise <= amount_paise),
  last_operation_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE classroom_desk_payments ADD COLUMN IF NOT EXISTS amount_refunded_paise integer NOT NULL DEFAULT 0 CHECK (amount_refunded_paise >= 0 AND amount_refunded_paise <= amount_paise);
ALTER TABLE classroom_desk_payments ADD COLUMN IF NOT EXISTS last_operation_id text;
CREATE TABLE IF NOT EXISTS classroom_desk_webhook_events (
  event_id text PRIMARY KEY,
  event_type text NOT NULL,
  payload_hash text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  status text NOT NULL DEFAULT 'received'
);
CREATE TABLE IF NOT EXISTS classroom_desk_referral_codes (
  user_id uuid PRIMARY KEY REFERENCES classroom_desk_users(id) ON DELETE CASCADE,
  code text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS classroom_desk_link_tokens (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES classroom_desk_users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);
CREATE TABLE IF NOT EXISTS classroom_desk_connections (
  website_user_id uuid PRIMARY KEY REFERENCES classroom_desk_users(id) ON DELETE CASCADE,
  mcp_user_id text NOT NULL UNIQUE,
  connected_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS classroom_desk_user_preferences (
  user_id uuid PRIMARY KEY REFERENCES classroom_desk_users(id) ON DELETE CASCADE,
  experience text NOT NULL CHECK (experience IN ('student','teacher')),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS classroom_desk_referrals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_user_id uuid NOT NULL REFERENCES classroom_desk_users(id) ON DELETE RESTRICT,
  referred_user_id uuid NOT NULL UNIQUE REFERENCES classroom_desk_users(id) ON DELETE RESTRICT,
  code text NOT NULL,
  qualified_at timestamptz,
  counted_at timestamptz,
  qualified_operation_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (referrer_user_id <> referred_user_id)
);
ALTER TABLE classroom_desk_referrals ADD COLUMN IF NOT EXISTS qualified_operation_id text;
CREATE TABLE IF NOT EXISTS classroom_desk_referral_rewards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES classroom_desk_users(id) ON DELETE RESTRICT,
  referral_count integer NOT NULL CHECK (referral_count > 0),
  grant_id uuid NOT NULL REFERENCES classroom_desk_entitlement_grants(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id, referral_count)
);
CREATE TABLE IF NOT EXISTS classroom_desk_admin_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id uuid NOT NULL REFERENCES classroom_desk_users(id) ON DELETE RESTRICT,
  target_user_id uuid REFERENCES classroom_desk_users(id) ON DELETE SET NULL,
  action text NOT NULL,
  reason text NOT NULL,
  previous_state jsonb,
  new_state jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS classroom_desk_feature_flags (
  key text PRIMARY KEY,
  enabled boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS classroom_desk_account_deletion_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES classroom_desk_users(id) ON DELETE RESTRICT,
  reason text,
  status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','cancelled','completed')),
  requested_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS classroom_desk_open_deletion_request_idx ON classroom_desk_account_deletion_requests(user_id) WHERE status = 'requested';
`;
