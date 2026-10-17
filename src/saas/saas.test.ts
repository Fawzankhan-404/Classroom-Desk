import { describe, expect, it } from "vitest";
import { CAMPAIGN_END_ISO, TRIAL_DURATION_MS, isTrialPurchaseOpen, planPricePaise, trialExpiry } from "./campaign.js";
import { resolveEntitlement } from "./entitlements.js";
import { acceptWebhook, verifyCheckoutSignature } from "./razorpay.js";
import { qualifiesReferral, referralRewardCount } from "./referrals.js";
import { createHmac } from "node:crypto";
import { clearSessionCookie, hashSessionToken, readSessionCookie, sessionExpiry, sessionCookie, WebsiteSessionStore } from "./sessions.js";
import { buildWebsiteGoogleUrl, createLoginState, pkceChallenge, WEBSITE_IDENTITY_SCOPES } from "./website-auth.js";
import { assertCanPerform, canPerform, validateRoleChange } from "./admin.js";
import { parseRazorpayEvent } from "./billing-events.js";
import { newReferralCode } from "./referral-service.js";
import { renderAdminBilling, renderAdminCRM, renderAdminReferrals, renderAdminUser } from "./admin.js";
import { sameOriginMutation } from "./csrf.js";
import { safeWebsiteReturnPath } from "./website-routes.js";
import express from "express";
import { createServer as createHttpServer } from "node:http";
import { registerWebsiteRoutes } from "./website-routes.js";
import { SaaSStore } from "./store.js";

const now = new Date("2026-10-09T12:00:00.000Z");
const user = { status: "active" as const };

describe("Classroom Desk SaaS rules", () => {
  it("opens the ₹9 trial only through the campaign deadline and gives 168 hours", () => {
    expect(isTrialPurchaseOpen(new Date("2026-10-20T18:29:59.999Z"))).toBe(true);
    expect(isTrialPurchaseOpen(new Date("2026-10-20T18:30:00.000Z"))).toBe(false);
    expect(trialExpiry(now).getTime() - now.getTime()).toBe(TRIAL_DURATION_MS);
    expect(CAMPAIGN_END_ISO).toContain("2026-10-20");
    expect(planPricePaise("student")).toBe(9900);
    expect(planPricePaise("teacher")).toBe(19900);
  });
  it("resolves subscription before trial and never grants suspended users", () => {
    const expiry = new Date("2026-11-01T00:00:00Z");
    expect(resolveEntitlement({ now, user, subscriptions: [{ id: "s", userId: "u", plan: "teacher", status: "cancelled", paidThrough: expiry, cancelledAt: now, providerSubscriptionId: null }] })).toMatchObject({ allowed: true, plan: "teacher" });
    expect(resolveEntitlement({ now, user: { status: "suspended" } })).toMatchObject({ allowed: false, reason: "suspended" });
  });
  it("awards one referral reward per two counted referrals", () => {
    expect(referralRewardCount({ qualifiedCount: 4, rewardsGranted: 1 })).toBe(1);
    expect(qualifiesReferral({ referredUserId: "a", referrerUserId: "b", hasValidAttribution: true, firstMonthlyPaymentVerified: true, refunded: false, alreadyCounted: false })).toBe(true);
    expect(qualifiesReferral({ referredUserId: "a", referrerUserId: "a", hasValidAttribution: true, firstMonthlyPaymentVerified: true, refunded: false, alreadyCounted: false })).toBe(false);
  });
  it("verifies Razorpay checkout signatures and rejects replayed webhooks", () => {
    const secret = "test-secret";
    const signature = createHmac("sha256", secret).update("order|payment").digest("hex");
    expect(verifyCheckoutSignature("order", "payment", signature, secret)).toBe(true);
    expect(acceptWebhook("evt_1", new Set(), true).reason).toBe("new");
    expect(acceptWebhook("evt_1", new Set(["evt_1"]), true).reason).toBe("duplicate");
  });
  it("creates bounded website sessions with secure cookie attributes", () => {
    expect(hashSessionToken("secret")).toHaveLength(64);
    expect(sessionExpiry(now).getTime() - now.getTime()).toBe(30 * 24 * 60 * 60 * 1000);
    expect(sessionCookie("a".repeat(43))).toContain("HttpOnly");
    const token = "a".repeat(43);
    expect(readSessionCookie(`other=x; cd_session=${token}; theme=dark`)).toBe(token);
    expect(readSessionCookie("cd_session=short")).toBeNull();
    expect(clearSessionCookie).toContain("Max-Age=0");
  });
  it("revokes the hashed server-side session and rejects it after logout", async () => {
    const rows = new Map<string, { id: string; user_id: string; expires_at: Date }>();
    const db = { query: async <T extends Record<string, unknown>>(sql: string, values: unknown[] = []) => {
      if (sql.startsWith("INSERT INTO classroom_desk_sessions")) { rows.set(String(values[2]), { id: String(values[0]), user_id: String(values[1]), expires_at: values[3] as Date }); return { rows: [] as T[] }; }
      if (sql.startsWith("SELECT id,user_id,expires_at")) { const row = rows.get(String(values[0])); return { rows: (row && row.expires_at > (values[1] as Date) ? [row] : []) as T[] }; }
      if (sql.startsWith("UPDATE classroom_desk_sessions")) return { rows: [] as T[] };
      if (sql.startsWith("DELETE FROM classroom_desk_sessions")) { rows.delete(String(values[0])); return { rows: [] as T[] }; }
      throw new Error(`unexpected query: ${sql}`);
    } } as never;
    const store = new WebsiteSessionStore(db);
    const created = await store.create("user-1", now);
    expect(await store.find(created.token, now)).toMatchObject({ userId: "user-1" });
    await store.revoke(created.token);
    expect(await store.find(created.token, now)).toBeNull();
  });
  it("keeps website Google identity OAuth separate from Classroom/MCP scopes", () => {
    const login = createLoginState(1);
    const url = new URL(buildWebsiteGoogleUrl({ clientId: "website-client", clientSecret: "unused-in-builder", callbackUrl: "https://classroom.example/auth/google/callback", origin: "https://classroom.example" }, login));
    expect(url.searchParams.get("scope")?.split(" ")).toEqual([...WEBSITE_IDENTITY_SCOPES]);
    expect(url.searchParams.get("code_challenge")).toBe(pkceChallenge(login.verifier));
    expect(url.searchParams.get("state")).toBe(login.state);
  });
  it("keeps website OAuth return paths same-origin and inside the authenticated app", () => {
    expect(safeWebsiteReturnPath("/app/settings")).toBe("/app/settings");
    expect(safeWebsiteReturnPath("https://evil.example")).toBe("/app");
    expect(safeWebsiteReturnPath("//evil.example/app")).toBe("/app");
    expect(safeWebsiteReturnPath("/mcp")).toBe("/app");
  });
  it("keeps support admins below role and privilege escalation", () => {
    expect(canPerform({ role: "SUPPORT_ADMIN" }, "grant_access")).toBe(true);
    expect(canPerform({ role: "SUPPORT_ADMIN" }, "change_role")).toBe(false);
    expect(() => assertCanPerform({ role: "STUDENT" }, "view_billing")).toThrow("admin_permission_required");
    expect(() => validateRoleChange({ role: "SUPPORT_ADMIN" }, "SUPER_ADMIN")).toThrow("super_admin_required");
  });
  it("keeps manual access controls distinct from payment records", () => {
    expect(assertCanPerform({ role: "SUPER_ADMIN" }, "extend_access")).toBeUndefined();
    expect(assertCanPerform({ role: "SUPER_ADMIN" }, "revoke_access")).toBeUndefined();
    expect(() => assertCanPerform({ role: "SUPPORT_ADMIN" }, "revoke_access")).toThrow("admin_permission_required");
  });
  it("classifies only correlated Razorpay payment events", () => {
    expect(parseRazorpayEvent({ event: "payment.captured", payload: { payment: { entity: { id: "pay_1", amount: 900, currency:"INR",status:"captured",created_at:Math.floor(now.getTime()/1000),notes: { user_id: "u", kind: "trial" } } } } }, now)).toMatchObject({ kind: "trial_captured", userId: "u", amountPaise: 900 });
    expect(parseRazorpayEvent({ event: "payment.captured", payload: { payment: { entity: { id: "pay_2", amount: 900, notes: {} } } } }, now)).toBeNull();
    expect(parseRazorpayEvent({ event: "payment.captured", payload: { payment: { entity: { id: "pay_wrong", amount: 100, notes: { user_id: "u", kind: "trial" } } } } }, now)).toBeNull();
    expect(parseRazorpayEvent({ event: "subscription.pending", payload: { subscription: { entity: { id: "sub_1", notes: { user_id: "u", plan: "student" } } } } }, now)).toMatchObject({ kind: "subscription_failed", subscriptionId: "sub_1" });
    expect(parseRazorpayEvent({ event: "payment.refunded", payload: { payment: { entity: { id: "pay_3",currency:"INR",refund_status:"full", notes: { user_id: "u" } } } } }, now)).toMatchObject({ kind: "payment_refunded", paymentId: "pay_3" });
    expect(parseRazorpayEvent({ event: "subscription.charged", payload: { payment: { entity: { id: "pay_4", amount: 9900,currency:"INR",status:"captured", notes: { user_id: "u" } } }, subscription: { entity: { id: "sub_2",current_end:1793481600, notes: { user_id: "u", plan: "student" } } } } }, now)).toMatchObject({ kind: "subscription_paid", plan: "student", amountPaise: 9900,paidThrough:new Date(1793481600000) });
    expect(parseRazorpayEvent({ event: "subscription.charged", payload: { payment: { entity: { id: "pay_wrong_sub", amount: 900, notes: { user_id: "u" } } }, subscription: { entity: { id: "sub_wrong", notes: { user_id: "u", plan: "student" } } } } }, now)).toBeNull();
  });
  it("validates captured INR trials and the configured processed-refund webhook",()=>{
    const payment={id:"pay_test",amount:900,currency:"INR",status:"captured",notes:{user_id:"u",kind:"trial"}};
    expect(parseRazorpayEvent({event:"payment.captured",payload:{payment:{entity:{...payment,currency:"USD"}}}})).toBeNull();
    expect(parseRazorpayEvent({event:"payment.captured",payload:{payment:{entity:{...payment,status:"authorized"}}}})).toBeNull();
    const payload={payment:{entity:{...payment,notes:{},refund_status:"full"}},refund:{entity:{payment_id:payment.id,status:"processed"}}};
    expect(parseRazorpayEvent({event:"refund.processed",payload},now,"u")).toMatchObject({kind:"payment_refunded",userId:"u"});
    expect(parseRazorpayEvent({event:"refund.processed",payload:{...payload,refund:{entity:{payment_id:"other",status:"processed"}}}},now,"u")).toBeNull();
  });
  it("creates non-guessable referral codes", () => {
    const code = newReferralCode();
    expect(code).toMatch(/^CD-[A-F0-9]{10}$/);
  });
  it("renders safe Admin CRM filters without exposing query markup", () => {
    const html = renderAdminCRM({ totalUsers: 1, newRegistrations: 0, activeTrials: 0, activeStudentSubscriptions: 0, activeTeacherSubscriptions: 0, expiredSubscriptions: 0, upcomingRenewals: 0, verifiedRevenuePaise: 0, trialConversions: 0, qualifiedReferrals: 0, recentPayments: 0, recentAdminActivity: 0 }, [], { search: "<admin>", role: "SUPPORT_ADMIN", status: "suspended", subscription: "none" });
    expect(html).toContain('name="search" value="&lt;admin&gt;"');
    expect(html).toContain('value="SUPPORT_ADMIN" selected');
    expect(html).toContain('value="none" selected');
    expect(html).not.toContain("<admin>");
  });
  it("requires a matching browser origin for cookie-authenticated mutations", () => {
    const request = (origin: string | undefined, host = "classroom.example") => ({ get: (name: string) => name === "origin" ? origin : host, method: "POST" }) as never;
    expect(sameOriginMutation(request("https://classroom.example"))).toBe(true);
    expect(sameOriginMutation(request("https://evil.example"))).toBe(false);
    expect(sameOriginMutation(request(undefined))).toBe(false);
  });
  it("renders billing records without payment secrets or card data", () => {
    const html = renderAdminBilling([{ id: "p", userId: "u", email: "student@example.com", kind: "subscription", plan: "student", amountPaise: 9900, currency: "INR", providerPaymentId: "pay_1", providerSubscriptionId: null, status: "paid", createdAt: now }]);
    expect(html).toContain("pay_1");
    expect(html).toContain("INR 99.00");
    expect(html).not.toContain("RAZORPAY_KEY_SECRET");
    expect(html).not.toContain("card_number");
  });
  it("renders referral administration without Google subjects", () => {
    const html = renderAdminReferrals([{ id: "r", referrerEmail: "one@example.com", referredEmail: "two@example.com", code: "CD-ABC123", qualifiedAt: now, countedAt: null, createdAt: now }]);
    expect(html).toContain("Qualified");
    expect(html).toContain("CD-ABC123");
    expect(html).not.toContain("google_subject");
  });
  it("renders safe account history fields", () => {
    const html = renderAdminUser({ id: "u", displayName: "Student", email: "student@example.com", role: "STUDENT", status: "active", createdAt: now, lastLoginAt: now }, { allowed: true, reason: "active_subscription", plan: "student", expiresAt: now }, { trialStatus: "expired", trialExpiresAt: now, subscriptions: [{ plan: "student", status: "cancelled", paidThrough: now, providerSubscriptionId: "sub_1" }], grants: [{ plan: "student", source: "manual", expiresAt: now, revokedAt: null }], referralsMade: 2, referralsReceived: 1 });
    expect(html).toContain("Trial eligibility");
    expect(html).toContain("2");
    expect(html).not.toContain("google_subject");
  });
  it("keeps referral routes disabled until the feature flag is enabled", async () => {
    const app = express();
    const unavailableDb = { query: async () => { throw new Error("database should not be queried"); }, transaction: async () => { throw new Error("database should not be queried"); } } as never;
    registerWebsiteRoutes(app, { store: new SaaSStore(unavailableDb), secureCookies: true, referralRewardsEnabled: false });
    const server = createHttpServer(app); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number };
    try {
      expect((await fetch(`http://127.0.0.1:${address.port}/api/referrals`)).status).toBe(410);
      expect((await fetch(`http://127.0.0.1:${address.port}/app/referrals`, {redirect:"manual"})).status).toBe(303);
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
});
