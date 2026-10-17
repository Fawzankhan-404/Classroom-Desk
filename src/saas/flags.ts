export interface SaaSFeatureFlags {
  billingUi: boolean;
  billingAllowlistUuids?: ReadonlySet<string>;
  teacherFeatures: boolean;
  referralRewards: boolean;
  enforceEntitlements: boolean;
}

export function loadSaaSFeatureFlags(env: Record<string, unknown>): SaaSFeatureFlags {
  const enabled = (key: string) => typeof env[key] === "string" && (env[key] as string).trim().toLowerCase() === "true";
  const rawAllowlist = env.SAAS_BILLING_ALLOWLIST_UUIDS;
  const allowlistEntries = typeof rawAllowlist === "string" ? rawAllowlist.split(/[\s,]+/).map((value) => value.trim().toLowerCase()).filter(Boolean) : [];
  const validUuid = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
  // A missing, empty, or malformed allowlist must never open billing to everyone.
  const billingAllowlistUuids = new Set(allowlistEntries.length > 0 && allowlistEntries.every(validUuid) ? allowlistEntries : []);
  return { billingUi: enabled("SAAS_BILLING_UI_ENABLED"), billingAllowlistUuids, teacherFeatures: enabled("SAAS_TEACHER_FEATURES_ENABLED"), referralRewards: enabled("SAAS_REFERRAL_REWARDS_ENABLED"), enforceEntitlements: enabled("SAAS_ENFORCE_ENTITLEMENTS") };
}

/** Billing rollout access is denied unless an explicit valid allowlist includes the user. */
export function billingUserAllowed(userId: string, allowlist: ReadonlySet<string> | undefined): boolean {
  return Boolean(allowlist?.size && allowlist.has(userId.toLowerCase()));
}
