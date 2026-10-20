import type { ReferralSummary } from "./referral-service.js";
import { readSessionCookie } from "./sessions.js";
import type { SaaSStore } from "./store.js";

export type PricingReferralView =
  | { state: "signed_out" }
  | { state: "paused" }
  | { state: "ready"; summary: ReferralSummary }
  | { state: "unavailable" };

/** Resolve referral details only from a verified, active website session. */
export async function loadPricingReferralView(
  store: SaaSStore,
  cookieHeader: string | undefined,
  rewardsEnabled: boolean,
): Promise<PricingReferralView> {
  const token = readSessionCookie(cookieHeader);
  if (!token) return { state: "signed_out" };

  let session;
  try {
    session = await store.sessions.find(token);
  } catch {
    return { state: "unavailable" };
  }
  if (!session) return { state: "signed_out" };

  let user;
  try {
    user = await store.getUser(session.userId);
  } catch {
    return { state: "unavailable" };
  }
  if (!user || user.status !== "active") return { state: "unavailable" };
  if (!rewardsEnabled) return { state: "paused" };

  try {
    return { state: "ready", summary: await store.referrals.summary(user.id) };
  } catch {
    return { state: "unavailable" };
  }
}
