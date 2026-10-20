import { describe, expect, it } from "vitest";
import { isSaaSReconciliationEnabled, loadSaaSFeatureFlags } from "./flags.js";

describe("billing reconciliation kill switch", () => {
  it("requires the explicit reconciliation flag even when billing UI is enabled", () => {
    expect(isSaaSReconciliationEnabled({ SAAS_BILLING_UI_ENABLED: "true", SAAS_RECONCILIATION_ENABLED: "false" })).toBe(false);
    expect(isSaaSReconciliationEnabled({ SAAS_BILLING_UI_ENABLED: "true" })).toBe(false);
    expect(isSaaSReconciliationEnabled({ SAAS_BILLING_UI_ENABLED: "false", SAAS_RECONCILIATION_ENABLED: "true" })).toBe(true);
    expect(isSaaSReconciliationEnabled({ SAAS_RECONCILIATION_ENABLED: " TRUE " })).toBe(true);
  });
});

describe("teacher coursework write kill switch", () => {
  it("stays disabled unless its own exact flag is explicitly true", () => {
    expect(loadSaaSFeatureFlags({ SAAS_TEACHER_FEATURES_ENABLED: "true" }).teacherDraftWrites).toBe(false);
    expect(loadSaaSFeatureFlags({ SAAS_TEACHER_DRAFT_WRITES_ENABLED: "false" }).teacherDraftWrites).toBe(false);
    expect(loadSaaSFeatureFlags({ SAAS_TEACHER_DRAFT_WRITES_ENABLED: " true " }).teacherDraftWrites).toBe(true);
  });
});

describe("referral reward feature flag", () => {
  it("normalizes the same flag for request and scheduled billing paths", () => {
    expect(loadSaaSFeatureFlags({ SAAS_REFERRAL_REWARDS_ENABLED: " TRUE " }).referralRewards).toBe(true);
    expect(loadSaaSFeatureFlags({ SAAS_REFERRAL_REWARDS_ENABLED: "False" }).referralRewards).toBe(false);
  });
});
