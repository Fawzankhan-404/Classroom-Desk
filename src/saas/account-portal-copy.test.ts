import { describe, expect, it } from "vitest";
import { renderConnection, renderProfile, renderReferrals, renderSubscription } from "./account-portal.js";
import type { AccountOverview } from "./account-portal.js";
import type { SaaSUser } from "./types.js";

const user = {
  id: "account-1", googleSubject: "google-subject-1", email: "reviewer@example.test", displayName: "Reviewer",
  role: "STUDENT", status: "active", createdAt: new Date("2026-01-01T00:00:00Z"), lastLoginAt: null,
} as SaaSUser;

function overview(overrides: Partial<AccountOverview> = {}): AccountOverview {
  return {
    user,
    entitlement: { allowed: false, reason: "expired", plan: null, expiresAt: null },
    history: { trialStatus: "eligible", trialExpiresAt: null, subscriptions: [], grants: [], referralsMade: 0, referralsReceived: 0 },
    payments: [], linked: false, deletionRequested: false,
    ...overrides,
  } as AccountOverview;
}

describe("account portal customer-facing copy", () => {
  it("explains website sign-in and Classroom authorization as separate steps", () => {
    const html = renderProfile(overview());
    expect(html).toContain('<meta name="robots" content="noindex, nofollow">');
    expect(html).toContain("Your website sign-in and Google Classroom access are separate.");
    expect(html).toContain("Signing in to this website alone does not grant Classroom access.");
    expect(html).toContain("Switching here changes the website account only.");
    expect(html).toContain('href="/app/connection">Manage connection</a>');
    expect(html).not.toContain("verified subject");
    expect(html).not.toContain("MCP user");
  });

  it("styles Google access management as a secondary action", () => {
    const html = renderConnection(overview().user);
    expect(html).toContain('class="button secondary" href="https://myaccount.google.com/connections"');
  });

  it("keeps checkout closed and renders account history without backend status codes", () => {
    const html = renderSubscription(overview({
      history: { trialStatus: "eligible", trialExpiresAt: null, subscriptions: [{ plan: "student", status: "past_due", paidThrough: null, providerSubscriptionId: null }], grants: [], referralsMade: 0, referralsReceived: 0 },
      payments: [{ createdAt: new Date("2026-10-01T00:00:00Z"), kind: "subscription", currency: "INR", amountPaise: 9900, status: "past_due" } as never],
    }), false, false, new Date("2026-10-21T00:00:00Z"));
    expect(html).toContain("Checkout is unavailable right now.");
    expect(html).toContain("This page still shows your current access and payment history.");
    expect(html.match(/Checkout is unavailable right now/g)).toHaveLength(1);
    expect(html).toContain("Payment past due");
    expect(html).not.toContain('data-checkout=');
    expect(html).not.toContain("past_due");
    expect(html).not.toContain("isolated test environment");
    const expiredOffer = renderSubscription(overview(), true, false, new Date("2026-10-21T00:00:00Z"));
    expect(expiredOffer).toContain("The introductory offer has ended.");
    expect(expiredOffer).not.toContain('data-checkout="trial"');
    expect(expiredOffer).not.toContain('data-checkout="teacher"');
  });

  it("does not expose a personal referral code when referrals are paused", () => {
    const html = renderReferrals(user, {
      code: "private-referral-code", total: 1, pending: 1, qualified: 0, rewards: 0, extraDays: 0,
      history: [{ createdAt: new Date("2026-10-01T00:00:00Z"), expiresAt: new Date("2026-10-31T00:00:00Z"), revoked: false }],
    }, false, "https://classroom.jarvis404.com");
    expect(html).toContain("Referral program paused");
    expect(html).toContain("Your recorded reward history remains available");
    expect(html).toContain("30 days");
    expect(html).not.toContain("private-referral-code");
    expect(html).not.toContain("Copy referral link");
  });

  it("explains active access separately from Google authorization", () => {
    const html = renderSubscription(overview({ entitlement: { allowed: true, reason: "active_subscription", plan: "student", expiresAt: new Date("2026-11-24T00:00:00Z") } }), true, false);
    expect(html).toContain("Student access is active.");
    expect(html).toContain("Google authorization is a separate step");
    expect(html).toContain("Connect or reconnect Google Classroom");
  });

  it("states the existing referral qualification rules without adding unsupported rewards", () => {
    const html = renderReferrals(user, { code: "reviewer-code", total: 0, pending: 0, qualified: 0, rewards: 0, extraDays: 0 }, true, "https://classroom.jarvis404.com");
    expect(html).toContain("Earn 30 bonus days for every two qualifying referrals");
    expect(html).toContain("first verified monthly subscription payment");
    expect(html).toContain("Trial payments do not count");
    expect(html).toContain("Refunds can reverse a recorded reward");
    expect(html).toContain("opening a link does not earn one");
    expect(html).not.toContain("duplicate account");
    expect(html).toContain("https://classroom.jarvis404.com/pricing?ref=reviewer-code");
  });
});
