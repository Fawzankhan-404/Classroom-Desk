export type PlatformRole = "SUPER_ADMIN" | "SUPPORT_ADMIN" | "STUDENT" | "TEACHER";
export type Plan = "student" | "teacher";
export type AccountStatus = "active" | "suspended" | "deleted";
export type SubscriptionStatus = "pending" | "active" | "cancelled" | "past_due" | "expired" | "refunded";

export interface SaaSUser {
  id: string;
  googleSubject: string;
  email: string;
  displayName: string;
  role: PlatformRole;
  status: AccountStatus;
  createdAt: Date;
  lastLoginAt: Date | null;
}

export interface TrialRecord {
  userId: string;
  paymentId: string | null;
  paidAt: Date | null;
  startsAt: Date | null;
  expiresAt: Date | null;
  status: "eligible" | "pending" | "active" | "expired" | "refunded";
}

export interface SubscriptionRecord {
  id: string;
  userId: string;
  plan: Plan;
  status: SubscriptionStatus;
  paidThrough: Date | null;
  cancelledAt: Date | null;
  providerSubscriptionId: string | null;
}

export interface EntitlementGrant {
  id: string;
  userId: string;
  plan: Plan;
  source: "subscription" | "trial" | "referral" | "complimentary" | "manual";
  startsAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
}

export interface EntitlementInput {
  now: Date;
  user: Pick<SaaSUser, "status">;
  trial?: TrialRecord | null;
  subscriptions?: SubscriptionRecord[];
  grants?: EntitlementGrant[];
}

export interface EffectiveEntitlement {
  allowed: boolean;
  reason: "free_access" | "active_subscription" | "active_trial" | "active_grant" | "suspended" | "deleted" | "expired" | "none";
  plan: Plan | null;
  expiresAt: Date | null;
}
