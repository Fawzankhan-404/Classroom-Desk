export interface SaaSFeatureFlags {
  billingUi: boolean;
  teacherFeatures: boolean;
  teacherDraftWrites: boolean;
  referralRewards: boolean;
  enforceEntitlements: boolean;
}

export function loadSaaSFeatureFlags(env: Record<string, unknown>): SaaSFeatureFlags {
  const enabled = (key: string) => typeof env[key] === "string" && (env[key] as string).trim().toLowerCase() === "true";
  return { billingUi: enabled("SAAS_BILLING_UI_ENABLED"), teacherFeatures: enabled("SAAS_TEACHER_FEATURES_ENABLED"), teacherDraftWrites: enabled("SAAS_TEACHER_DRAFT_WRITES_ENABLED"), referralRewards: enabled("SAAS_REFERRAL_REWARDS_ENABLED"), enforceEntitlements: enabled("SAAS_ENFORCE_ENTITLEMENTS") };
}

export function isSaaSReconciliationEnabled(env: Record<string, unknown>): boolean {
  return typeof env.SAAS_RECONCILIATION_ENABLED === "string" && env.SAAS_RECONCILIATION_ENABLED.trim().toLowerCase() === "true";
}
