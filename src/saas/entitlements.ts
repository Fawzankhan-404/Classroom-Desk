import type { EffectiveEntitlement, EntitlementInput, Plan } from "./types.js";

export function resolveEntitlement(input: EntitlementInput): EffectiveEntitlement {
  const { now, user } = input;
  if (user.status === "suspended") return { allowed: false, reason: "suspended", plan: null, expiresAt: null };
  if (user.status === "deleted") return { allowed: false, reason: "deleted", plan: null, expiresAt: null };

  const activeSubscription = (input.subscriptions ?? [])
    .filter((item) => (item.status === "active" || item.status === "cancelled") && item.paidThrough && item.paidThrough.getTime() > now.getTime())
    .sort((a, b) => b.paidThrough!.getTime() - a.paidThrough!.getTime())[0];
  if (activeSubscription?.paidThrough) return active("active_subscription", activeSubscription.plan, activeSubscription.paidThrough);

  const trial = input.trial;
  if (trial?.status === "active" && trial.expiresAt && trial.expiresAt.getTime() > now.getTime()) {
    return active("active_trial", "student", trial.expiresAt);
  }

  const grant = (input.grants ?? [])
    .filter((item) => !item.revokedAt && item.startsAt.getTime() <= now.getTime() && item.expiresAt.getTime() > now.getTime())
    .sort((a, b) => b.expiresAt.getTime() - a.expiresAt.getTime())[0];
  if (grant) return active("active_grant", grant.plan, grant.expiresAt);
  return { allowed: false, reason: "expired", plan: null, expiresAt: null };
}

function active(reason: EffectiveEntitlement["reason"], plan: Plan, expiresAt: Date): EffectiveEntitlement {
  return { allowed: true, reason, plan, expiresAt };
}

export function assertEntitled(input: EntitlementInput): EffectiveEntitlement {
  const result = resolveEntitlement(input);
  if (!result.allowed) throw new Error(`entitlement_required:${result.reason}`);
  return result;
}
