import { Plan } from "./types.js";

export const TRIAL_PRICE_PAISE = 900;
export const TRIAL_DURATION_MS = 168 * 60 * 60 * 1000;
export const CAMPAIGN_TIME_ZONE = "Asia/Kolkata";
export const CAMPAIGN_END_ISO = "2026-10-20T18:29:59.999Z";

export function isTrialPurchaseOpen(now: Date): boolean {
  return now.getTime() <= new Date(CAMPAIGN_END_ISO).getTime();
}

export function trialExpiry(paidAt: Date): Date {
  return new Date(paidAt.getTime() + TRIAL_DURATION_MS);
}

export function planPricePaise(plan: Plan): number {
  return plan === "student" ? 9900 : 19900;
}
