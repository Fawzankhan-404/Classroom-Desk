import { describe, expect, it, vi } from "vitest";
import { loadPricingReferralView } from "./pricing-referral-view.js";
import type { SaaSStore } from "./store.js";

const token = "s".repeat(48);

function fakeStore(overrides: Record<string, unknown> = {}) {
  const store = {
    sessions: { find: vi.fn(async () => ({ id: "session-1", userId: "account-1", expiresAt: new Date(Date.now() + 60_000) })) },
    getUser: vi.fn(async () => ({ id: "account-1", status: "active" })),
    referrals: { summary: vi.fn(async (userId: string) => ({ code: "CD-A1B2C3D4E5", total: 0, pending: 0, qualified: 0, rewards: 0, extraDays: 0, history: [], requestedUserId: userId })) },
    ...overrides,
  };
  return store as unknown as SaaSStore;
}

describe("pricing referral session projection", () => {
  it("does not resolve a signed-out visitor or fetch referral data", async () => {
    const store = fakeStore({ sessions: { find: vi.fn(async () => null) } });
    expect(await loadPricingReferralView(store, undefined, true)).toEqual({ state: "signed_out" });
    expect(await loadPricingReferralView(store, "cd_session=bad", true)).toEqual({ state: "signed_out" });
    expect(store.referrals.summary).not.toHaveBeenCalled();
  });

  it("does not create a code or query referral data while rewards are disabled", async () => {
    const store = fakeStore();
    expect(await loadPricingReferralView(store, `cd_session=${token}`, false)).toEqual({ state: "paused" });
    expect(store.referrals.summary).not.toHaveBeenCalled();
  });

  it("uses only the active account from the verified session", async () => {
    const store = fakeStore();
    const result = await loadPricingReferralView(store, `cd_session=${token}`, true);
    expect(result).toMatchObject({ state: "ready", summary: { code: "CD-A1B2C3D4E5", requestedUserId: "account-1" } });
    expect(store.sessions.find).toHaveBeenCalledWith(token);
    expect(store.getUser).toHaveBeenCalledWith("account-1");
    expect(store.referrals.summary).toHaveBeenCalledWith("account-1");
  });

  it("fails closed for inactive accounts and session or database errors", async () => {
    const inactive = fakeStore({ getUser: vi.fn(async () => ({ id: "account-1", status: "suspended" })) });
    expect(await loadPricingReferralView(inactive, `cd_session=${token}`, true)).toEqual({ state: "unavailable" });
    expect(inactive.referrals.summary).not.toHaveBeenCalled();

    const failedSession = fakeStore({ sessions: { find: vi.fn(async () => { throw new Error("db unavailable"); }) } });
    expect(await loadPricingReferralView(failedSession, `cd_session=${token}`, true)).toEqual({ state: "unavailable" });

    const failedSummary = fakeStore({ referrals: { summary: vi.fn(async () => { throw new Error("db unavailable"); }) } });
    expect(await loadPricingReferralView(failedSummary, `cd_session=${token}`, true)).toEqual({ state: "unavailable" });
  });
});
