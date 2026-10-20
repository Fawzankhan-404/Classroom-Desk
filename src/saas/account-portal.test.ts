import { describe, expect, it } from "vitest";
import { renderReferrals } from "./account-portal.js";
import type { ReferralSummary } from "./referral-service.js";
import type { SaaSUser } from "./types.js";

const user: SaaSUser = {
  id: "account-1",
  googleSubject: "synthetic-subject",
  email: "reviewer@example.invalid",
  displayName: "Synthetic Reviewer",
  role: "STUDENT",
  status: "active",
  createdAt: new Date("2026-10-20T00:00:00Z"),
  lastLoginAt: null,
};

const summary: ReferralSummary = {
  code: "CD-A1B2C3D4E5",
  total: 2,
  pending: 0,
  qualified: 2,
  rewards: 1,
  extraDays: 30,
  history: [],
};

describe("referral account activation messaging", () => {
  it("matches an enabled server-side reward flag", () => {
    const html = renderReferrals(user, summary, true, "https://classroom.jarvis404.com");
    expect(html).toContain("Referral rewards are active for verified qualifying first monthly-plan payments.");
    expect(html).toContain("Your code");
    expect(html).toContain("CD-A1B2C3D4E5");
    expect(html).toContain("Copy referral link");
    expect(html).toContain("partial refunds do not currently reverse referral qualification");
    expect(html).not.toContain("pending billing acceptance");
    expect(html).not.toContain("once rewards are enabled");
  });

  it("does not present a personal referral link while the server-side flag is off", () => {
    const html = renderReferrals(user, summary, false, "https://classroom.jarvis404.com");
    expect(html).toContain("Referral rewards are paused.");
    expect(html).toContain("Unavailable while rewards are paused");
    expect(html).toContain("Personal referral link sharing is paused");
    expect(html).toContain("partial refunds do not currently reverse referral qualification");
    expect(html).not.toContain("CD-A1B2C3D4E5");
    expect(html).not.toContain("Copy referral link");
    expect(html).not.toContain("pending billing acceptance");
  });
});
