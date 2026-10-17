/** Additive SaaS schema. Apply with a reviewed direct Neon migration, never at Worker request time. */
export const SAAS_SCHEMA_VERSION = 2;
export const SaaSMigration = `
CREATE TABLE IF NOT EXISTS classroom_desk_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  google_subject text NOT NULL UNIQUE,
  email text NOT NULL,
  display_name text NOT NULL,
  profile_ciphertext text,
  google_subject_hash text UNIQUE,
  email_hash text,
  display_name_hash text,
  role text NOT NULL DEFAULT 'STUDENT' CHECK (role IN ('SUPER_ADMIN','SUPPORT_ADMIN','STUDENT','TEACHER')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','deleted')),
  dashboard_preference text CHECK (dashboard_preference IN ('student','teacher')),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);
ALTER TABLE classroom_desk_users ADD COLUMN IF NOT EXISTS dashboard_preference text CHECK (dashboard_preference IN ('student','teacher'));
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
CREATE TABLE IF NOT EXISTS classroom_desk_entitlement_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES classroom_desk_users(id) ON DELETE CASCADE,
  plan text NOT NULL CHECK (plan IN ('student','teacher')),
  source text NOT NULL CHECK (source IN ('subscription','trial','referral','complimentary','manual')),
  starts_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  reason text
);
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
  created_at timestamptz NOT NULL DEFAULT now()
);
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
CREATE TABLE IF NOT EXISTS classroom_desk_oauth_accounts (
  website_user_id uuid PRIMARY KEY REFERENCES classroom_desk_users(id) ON DELETE RESTRICT,
  mcp_user_id text NOT NULL UNIQUE,
  connected_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS classroom_desk_referrals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_user_id uuid NOT NULL REFERENCES classroom_desk_users(id) ON DELETE RESTRICT,
  referred_user_id uuid NOT NULL UNIQUE REFERENCES classroom_desk_users(id) ON DELETE RESTRICT,
  code text NOT NULL,
  qualified_at timestamptz,
  counted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (referrer_user_id <> referred_user_id)
);
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
