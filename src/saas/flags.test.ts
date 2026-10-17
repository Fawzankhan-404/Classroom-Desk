import { describe, expect, it } from "vitest";
import { billingUserAllowed, loadSaaSFeatureFlags } from "./flags.js";

const owner = "10000000-0000-4000-8000-000000000001";

describe("billing rollout configuration", () => {
  it("fails closed when the allowlist is missing, empty, or malformed", () => {
    for (const value of [undefined, "", "not-a-uuid", `${owner},bad`]) {
      const flags = loadSaaSFeatureFlags({ SAAS_BILLING_UI_ENABLED: "true", SAAS_BILLING_ALLOWLIST_UUIDS: value });
      expect(billingUserAllowed(owner, flags.billingAllowlistUuids)).toBe(false);
    }
    expect(billingUserAllowed(owner, undefined)).toBe(false);
    expect(billingUserAllowed(owner, new Set())).toBe(false);
  });

  it("allows only an exact configured UUID, case-insensitively", () => {
    const flags = loadSaaSFeatureFlags({ SAAS_BILLING_ALLOWLIST_UUIDS: ` ${owner.toUpperCase()} ` });
    expect(billingUserAllowed(owner, flags.billingAllowlistUuids)).toBe(true);
    expect(billingUserAllowed("10000000-0000-4000-8000-000000000002", flags.billingAllowlistUuids)).toBe(false);
  });
});