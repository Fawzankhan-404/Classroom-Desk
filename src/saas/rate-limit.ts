import { ipKeyGenerator } from "express-rate-limit";

export type RateLimitBinding = { limit(input: { key: string }): Promise<{ success: boolean }> };
export type RateLimitDecision =
  | { allowed: true }
  | { allowed: false; status: 429 | 503; error: "rate_limited" | "rate_limit_unavailable" };

const AUTHENTICATION_PATH = /^\/(?:login(?:\/|$)|logout(?:\/|$)|auth\/|oauth\/|authorize(?:\/|$)|connect\/|api\/|admin(?:\/|$))/;

/** Apply the public bucket to every public request and an additional bucket to auth/API/admin routes. */
export async function checkRequestRateLimits(
  path: string,
  clientIp: string,
  publicLimiter: RateLimitBinding,
  authLimiter: RateLimitBinding,
): Promise<RateLimitDecision> {
  try {
    const key = ipKeyGenerator(clientIp, 56);
    if (!(await publicLimiter.limit({ key })).success) return { allowed: false, status: 429, error: "rate_limited" };
    if (AUTHENTICATION_PATH.test(path) && !(await authLimiter.limit({ key })).success) return { allowed: false, status: 429, error: "rate_limited" };
    return { allowed: true };
  } catch {
    return { allowed: false, status: 503, error: "rate_limit_unavailable" };
  }
}
