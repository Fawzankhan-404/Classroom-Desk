import type { SqlConnection, SqlDatabase } from "../public/postgres.js";
import type { SaaSUser } from "./types.js";
import { WebsiteSessionStore } from "./sessions.js";
import type { WebsiteIdentityStore } from "./website-auth.js";
import { resolveEntitlement } from "./entitlements.js";
import type { EffectiveEntitlement, EntitlementGrant, SubscriptionRecord, TrialRecord } from "./types.js";
import type { AdminMetrics, AdminAction, AdminPayment, AdminReferral, AdminUserHistory } from "./admin.js";
import { assertCanPerform, validateRoleChange } from "./admin.js";
import { randomUUID, timingSafeEqual } from "node:crypto";
import type { BillingEvent } from "./billing-events.js";
import { ReferralService } from "./referral-service.js";
import { isTrialPurchaseOpen, planPricePaise } from "./campaign.js";
import { SaaSProfileCipher, type PrivateSaaSProfile } from "./privacy.js";

const BILLING_OWNER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function requireProviderId(value: string, prefix: "pay" | "order" | "sub"): void {
  if (typeof value !== "string" || value.length > 128 || !new RegExp(`^${prefix}_[A-Za-z0-9_]+$`).test(value)) throw new Error("invalid_billing_provider_id");
}
function publicWebhookId(value: string): void {
  if (value.startsWith("internal:")) throw new Error("reserved_webhook_event_id");
}
function policyDatabaseError(stage: "account_lookup" | "entitlement_evaluation", error: unknown): Error & { policyStage: string; sqlState: string } {
  const sqlState = error && typeof error === "object" && "code" in error && typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : "unknown";
  const wrapped = new Error("policy_database_failure") as Error & { policyStage: string; sqlState: string };
  wrapped.policyStage = stage;
  wrapped.sqlState = /^[0-9A-Z]{5}$/.test(sqlState) ? sqlState : "unknown";
  return wrapped;
}

export class SaaSStore implements WebsiteIdentityStore {
  readonly sessions: WebsiteSessionStore;
  readonly referrals: ReferralService;
  private readonly profileCipher?: SaaSProfileCipher;
  constructor(readonly db: SqlDatabase, private readonly options: { referralRewardsEnabled?: boolean; profileEncryptionKeyBase64?: string; requireProfileEncryption?: boolean; encryptProfilesOnWrite?: boolean } = {}) {
    this.sessions = new WebsiteSessionStore(db); this.referrals = new ReferralService(db);
    if (options.profileEncryptionKeyBase64) this.profileCipher = new SaaSProfileCipher(options.profileEncryptionKeyBase64);
    if (options.requireProfileEncryption && !this.profileCipher) throw new Error("profile_encryption_configuration_unavailable");
  }

  async readyUnifiedOAuth(): Promise<void> {
    await this.db.query(`SELECT website_user_id,mcp_user_id,connected_at FROM classroom_desk_oauth_accounts LIMIT 1`);
  }

  private userFromRow(row: { id: string; google_subject: string; email: string; display_name: string; profile_ciphertext?: string | null; role: SaaSUser["role"]; status: SaaSUser["status"]; created_at: Date; last_login_at: Date | null }): SaaSUser {
    let profile: PrivateSaaSProfile | undefined;
    if (row.profile_ciphertext) {
      if (!this.profileCipher) throw new Error("stored_profile_unavailable");
      profile = this.profileCipher.open(row.profile_ciphertext);
    }
    return { id: String(row.id), googleSubject: profile?.googleSubject ?? row.google_subject, email: profile?.email ?? row.email, displayName: profile?.displayName ?? row.display_name, role: row.role, status: row.status, createdAt: new Date(row.created_at), lastLoginAt: row.last_login_at ? new Date(row.last_login_at) : null };
  }

  /**
   * Verify every encrypted profile before serving requests. This is read-only;
   * it prevents a valid-shaped but wrong key from creating duplicate accounts
   * through a failed HMAC lookup. The caller receives only a row count.
   */
  async verifyProfileStorageCompatibility(maxRows = 10_000): Promise<{ encryptedProfiles: number }> {
    if (!this.profileCipher) throw new Error("profile_encryption_configuration_unavailable");
    const bounded = Math.max(1, Math.min(10_000, Math.floor(maxRows)));
    const result = await this.db.query<{ google_subject: string; email: string; display_name: string; profile_ciphertext: string; google_subject_hash: string | null; email_hash: string | null; display_name_hash: string | null }>(
      `SELECT google_subject,email,display_name,profile_ciphertext,google_subject_hash,email_hash,display_name_hash FROM classroom_desk_users WHERE profile_ciphertext IS NOT NULL LIMIT $1`,
      [bounded + 1],
    );
    if (result.rows.length > bounded) throw new Error("profile_storage_validation_limit");
    for (const row of result.rows) {
      const profile = this.profileCipher.open(row.profile_ciphertext);
      const hashes = {
        subject: this.profileCipher.digest(profile.googleSubject),
        email: this.profileCipher.digest(profile.email.toLowerCase()),
        displayName: this.profileCipher.digest(profile.displayName),
      };
      const digestMatches = (expected: string, actual: string | null) => {
        if (!actual || !/^[0-9a-f]{64}$/i.test(actual)) return false;
        return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(actual, "hex"));
      };
      const markerMatches = (actual: string, plain: string, digest: string) => actual === plain || actual === `enc:${digest}`;
      if (!digestMatches(hashes.subject, row.google_subject_hash)
        || !digestMatches(hashes.email, row.email_hash)
        || !digestMatches(hashes.displayName, row.display_name_hash)
        || !markerMatches(row.google_subject, profile.googleSubject, hashes.subject)
        || !markerMatches(row.email, profile.email, hashes.email)
        || !markerMatches(row.display_name, profile.displayName, hashes.displayName)) {
        throw new Error("stored_profile_unavailable");
      }
    }
    return { encryptedProfiles: result.rows.length };
  }

  /** Always precedes account, order, subscription and webhook-row locks. */
  private async lockPayment(tx: SqlConnection, paymentId: string, userId: string): Promise<void> {
    requireProviderId(paymentId, "pay");
    if (!BILLING_OWNER_ID.test(userId)) throw new Error("invalid_billing_owner");
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`billing-payment:${paymentId}`]);
  }

  private async refundTombstone(tx: SqlConnection, paymentId: string, userId?: string): Promise<string | undefined> {
    const result = await tx.query<{ event_type: string; status: string; payload_hash: string }>(`SELECT event_type,status,payload_hash FROM classroom_desk_webhook_events WHERE event_id=$1`, [`internal:refund-tombstone:${paymentId}`]);
    const row = result.rows[0];
    if (!row) return undefined;
    if (row.event_type !== "internal.refund.tombstone" || row.status !== "terminal" || !BILLING_OWNER_ID.test(row.payload_hash)) throw new Error("refund_tombstone_conflict");
    if (userId && row.payload_hash.toLowerCase() !== userId.toLowerCase()) throw new Error("refund_tombstone_owner_mismatch");
    return row.payload_hash.toLowerCase();
  }

  async upsertGoogleIdentity(input: { googleSubject: string; email: string; displayName: string; now: Date }): Promise<SaaSUser> {
    const encryptOnWrite = Boolean(this.profileCipher && this.options.encryptProfilesOnWrite === true);
    const profile = encryptOnWrite ? this.profileCipher!.seal(input) : null;
    const subjectHash = this.profileCipher?.digest(input.googleSubject) ?? null;
    const emailHash = this.profileCipher?.digest(input.email.toLowerCase()) ?? null;
    const displayNameHash = this.profileCipher?.digest(input.displayName) ?? null;
    let result;
    if (this.profileCipher) {
      const existing = await this.db.query<{ id: string }>(`SELECT id FROM classroom_desk_users WHERE google_subject_hash=$1 OR google_subject=$2 LIMIT 1`, [subjectHash, input.googleSubject]);
      if (existing.rows[0]) {
        const stored = await this.db.query<{ id: string; google_subject: string; email: string; display_name: string; profile_ciphertext: string | null; google_subject_hash: string | null; email_hash: string | null; display_name_hash: string | null; role: SaaSUser["role"]; status: SaaSUser["status"]; created_at: Date; last_login_at: Date | null }>(`SELECT id,google_subject,email,display_name,profile_ciphertext,google_subject_hash,email_hash,display_name_hash,role,status,created_at,last_login_at FROM classroom_desk_users WHERE id=$1`, [existing.rows[0].id]);
        const row = stored.rows[0];
        if (!row) throw new Error("Account could not be found.");
        const current = this.userFromRow(row);
        if (current.googleSubject !== input.googleSubject) throw new Error("stored_profile_identity_mismatch");
        if (row.profile_ciphertext && !encryptOnWrite) {
          result = await this.db.query(`UPDATE classroom_desk_users SET last_login_at=$2 WHERE id=$1 RETURNING id,google_subject,email,display_name,profile_ciphertext,role,status,created_at,last_login_at`, [row.id, input.now]);
        } else if (encryptOnWrite) {
          result = await this.db.query(`UPDATE classroom_desk_users SET google_subject=$2,email=$3,display_name=$4,profile_ciphertext=$5,google_subject_hash=$6,email_hash=$7,display_name_hash=$8,last_login_at=$9 WHERE id=$1 RETURNING id,google_subject,email,display_name,profile_ciphertext,role,status,created_at,last_login_at`, [row.id, `enc:${subjectHash}`, `enc:${emailHash}`, `enc:${displayNameHash}`, profile, subjectHash, emailHash, displayNameHash, input.now]);
        } else {
          result = await this.db.query(`UPDATE classroom_desk_users SET google_subject=$2,email=$3,display_name=$4,last_login_at=$5 WHERE id=$1 RETURNING id,google_subject,email,display_name,profile_ciphertext,role,status,created_at,last_login_at`, [row.id, input.googleSubject, input.email, input.displayName, input.now]);
        }
      } else {
        if (encryptOnWrite) {
          result = await this.db.query(`INSERT INTO classroom_desk_users (google_subject,email,display_name,profile_ciphertext,google_subject_hash,email_hash,display_name_hash,last_login_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,google_subject,email,display_name,profile_ciphertext,role,status,created_at,last_login_at`, [`enc:${subjectHash}`, `enc:${emailHash}`, `enc:${displayNameHash}`, profile, subjectHash, emailHash, displayNameHash, input.now]);
        } else {
          result = await this.db.query(`INSERT INTO classroom_desk_users (google_subject,email,display_name,last_login_at) VALUES ($1,$2,$3,$4) RETURNING id,google_subject,email,display_name,profile_ciphertext,role,status,created_at,last_login_at`, [input.googleSubject, input.email, input.displayName, input.now]);
        }
      }
    } else {
      result = await this.db.query(`INSERT INTO classroom_desk_users (google_subject,email,display_name,last_login_at) VALUES ($1,$2,$3,$4) ON CONFLICT (google_subject) DO UPDATE SET email=EXCLUDED.email, display_name=EXCLUDED.display_name, last_login_at=EXCLUDED.last_login_at RETURNING id,google_subject,email,display_name,role,status,created_at,last_login_at`, [input.googleSubject, input.email, input.displayName, input.now]);
    }
    const row = result.rows[0] as { id: string; google_subject: string; email: string; display_name: string; profile_ciphertext?: string | null; role: SaaSUser["role"]; status: SaaSUser["status"]; created_at: Date; last_login_at: Date | null } | undefined;
    if (!row) throw new Error("Account could not be created.");
    await this.db.query(`INSERT INTO classroom_desk_trials (user_id,status) VALUES ($1,'eligible') ON CONFLICT (user_id) DO NOTHING`, [row.id]);
    return this.userFromRow(row);
  }

  async getUser(id: string): Promise<SaaSUser | null> {
    const result = await this.db.query<{ id: string; google_subject: string; email: string; display_name: string; profile_ciphertext?: string | null; role: SaaSUser["role"]; status: SaaSUser["status"]; created_at: Date; last_login_at: Date | null }>(`SELECT id,google_subject,email,display_name,profile_ciphertext,role,status,created_at,last_login_at FROM classroom_desk_users WHERE id=$1`, [id]);
    const row = result.rows[0];
    return row ? this.userFromRow(row) : null;
  }

  async dashboardPreference(userId: string): Promise<"student" | "teacher" | null> {
    const result = await this.db.query<{ dashboard_preference: string | null }>(`SELECT dashboard_preference FROM classroom_desk_users WHERE id=$1`, [userId]);
    const value = result.rows[0]?.dashboard_preference;
    return value === "student" || value === "teacher" ? value : null;
  }

  async setDashboardPreference(userId: string, preference: "student" | "teacher"): Promise<void> {
    const result = await this.db.query(`UPDATE classroom_desk_users SET dashboard_preference=$2 WHERE id=$1 AND status='active' RETURNING id`, [userId, preference]);
    if (result.rows.length !== 1) throw new Error("dashboard_preference_account_unavailable");
  }

  /** Encrypt legacy identity rows in small batches after the additive migration. */
  async protectLegacyProfiles(limit = 100): Promise<number> {
    if (!this.profileCipher) return 0;
    const bounded = Math.max(1, Math.min(100, Math.floor(limit)));
    const result = await this.db.query<{ id: string; google_subject: string; email: string; display_name: string }>(
      `SELECT id,google_subject,email,display_name FROM classroom_desk_users WHERE profile_ciphertext IS NULL LIMIT $1`, [bounded],
    );
    let protectedRows = 0;
    for (const row of result.rows) {
      if (!row.google_subject || row.google_subject.startsWith("enc:")) continue;
      const profile = { googleSubject: row.google_subject, email: row.email, displayName: row.display_name };
      const subjectHash = this.profileCipher.digest(profile.googleSubject);
      const emailHash = this.profileCipher.digest(profile.email.toLowerCase());
      const displayNameHash = this.profileCipher.digest(profile.displayName);
      const updated = await this.db.query(
        `UPDATE classroom_desk_users SET google_subject=$2,email=$3,display_name=$4,profile_ciphertext=$5,google_subject_hash=$6,email_hash=$7,display_name_hash=$8 WHERE id=$1 AND profile_ciphertext IS NULL`,
        [row.id, `enc:${subjectHash}`, `enc:${emailHash}`, `enc:${displayNameHash}`, this.profileCipher.seal(profile), subjectHash, emailHash, displayNameHash],
      );
      if (updated.rows.length === 1) protectedRows++;
    }
    return protectedRows;
  }

  async loadDashboardCounts(_userId: string): Promise<{ courses: number | null; upcomingAssignments: number | null; missingAssignments: number | null; sync: "connected" | "reauthorization_required" | "not_connected" }> {
    // Classroom records are deliberately not copied into the SaaS tables. The existing MCP grant remains the source of truth.
    return { courses: null, upcomingAssignments: null, missingAssignments: null, sync: "not_connected" };
  }

  async getLinkedMcpUserId(websiteUserId: string): Promise<string | null> {
    return await this.getUnifiedMcpUserId(websiteUserId) ?? await this.getLegacyMcpUserId(websiteUserId);
  }

  async getUnifiedMcpUserId(websiteUserId: string): Promise<string | null> {
    const result = await this.db.query<{ mcp_user_id: string }>(`SELECT mcp_user_id FROM classroom_desk_oauth_accounts WHERE website_user_id=$1`, [websiteUserId]);
    return result.rows[0]?.mcp_user_id ? String(result.rows[0].mcp_user_id) : null;
  }

  async getLegacyMcpUserId(websiteUserId: string): Promise<string | null> {
    const result = await this.db.query<{ mcp_user_id: string }>(`SELECT mcp_user_id FROM classroom_desk_connections WHERE website_user_id=$1`, [websiteUserId]);
    return result.rows[0]?.mcp_user_id ? String(result.rows[0].mcp_user_id) : null;
  }

  private async websiteUserForMcp(mcpUserId: string): Promise<string | null> {
    const result = await this.db.query<{ website_user_id: string }>(`SELECT website_user_id FROM classroom_desk_oauth_accounts WHERE mcp_user_id=$1 UNION SELECT website_user_id FROM classroom_desk_connections WHERE mcp_user_id=$1`, [mcpUserId]);
    if (result.rows.length > 1) throw new Error("account_ownership_conflict");
    return result.rows[0] ? String(result.rows[0].website_user_id) : null;
  }

  async accountIdentityForMcpUser(mcpUserId: string): Promise<{ id: string; displayName: string } | null> {
    const websiteUserId = await this.websiteUserForMcp(mcpUserId);
    const user = websiteUserId ? await this.getUser(websiteUserId) : null;
    return user?.status === "active" ? { id: user.id, displayName: user.displayName } : null;
  }

  async accountOverview(user: SaaSUser) {
    const [entitlement, history, payments, link, deletion] = await Promise.all([
      this.entitlement(user.id), this.adminUserHistory(user.id),
      this.db.query<{ id: string; kind: string; plan: string | null; amount_paise: number; currency: string; status: string; created_at: Date }>(`SELECT id,kind,plan,amount_paise,currency,status,created_at FROM classroom_desk_payments WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100`, [user.id]),
      this.getLinkedMcpUserId(user.id),
      this.db.query(`SELECT 1 FROM classroom_desk_account_deletion_requests WHERE user_id=$1 AND status='requested'`, [user.id]),
    ]);
    return { user, entitlement, history, linked: Boolean(link), deletionRequested: deletion.rows.length > 0,
      payments: payments.rows.map(p => ({ id: String(p.id), userId: user.id, email: user.email, kind: p.kind, plan: p.plan, amountPaise: Number(p.amount_paise), currency: p.currency, status: p.status, createdAt: new Date(p.created_at), providerPaymentId: null, providerSubscriptionId: null })) };
  }

  async entitlementForMcpUser(mcpUserId: string, now = new Date()): Promise<EffectiveEntitlement> {
    let websiteUserId;
    try { websiteUserId = await this.websiteUserForMcp(mcpUserId); }
    catch (error) { throw policyDatabaseError("account_lookup", error); }
    if (!websiteUserId) return { allowed: false, reason: "none", plan: null, expiresAt: null };
    try {
      const user = await this.getUser(String(websiteUserId));
      if (!user) return { allowed: false, reason: "none", plan: null, expiresAt: null };
      if (user.status === "suspended") return { allowed: false, reason: "suspended", plan: null, expiresAt: null };
      if (user.status === "deleted") return { allowed: false, reason: "deleted", plan: null, expiresAt: null };
      if (user.status !== "active") return { allowed: false, reason: "none", plan: null, expiresAt: null };
      return { allowed: true, reason: "free_access", plan: null, expiresAt: null };
    }
    catch (error) { throw policyDatabaseError("entitlement_evaluation", error); }
  }

  async accountStatusForMcpUser(mcpUserId: string, origin: string, now = new Date()): Promise<{ state: string; message: string; activationUrl: string; billingUrl: string; settingsUrl: string; plan: string | null; expiresAt: string | null; linked: boolean }> {
    const activationUrl = new URL("/login", origin).toString();
    const billingUrl = new URL("/app", origin).toString();
    const settingsUrl = new URL("/app/settings", origin).toString();
    const websiteUserId = await this.websiteUserForMcp(mcpUserId);
    if (!websiteUserId) return { state: "ACCOUNT_SETUP_REQUIRED", message: "Reconnect Classroom Desk in ChatGPT and authorize your Google account.", activationUrl, billingUrl, settingsUrl, plan: null, expiresAt: null, linked: false };
    const user = await this.getUser(websiteUserId);
    if (!user || user.status === "deleted") return { state: "ACCOUNT_DISABLED", message: "Your Classroom Desk account is currently unavailable. Contact support for assistance.", activationUrl, billingUrl, settingsUrl, plan: null, expiresAt: null, linked: true };
    if (user.status === "suspended") return { state: "ACCOUNT_SUSPENDED", message: "Your Classroom Desk account is currently unavailable. Contact support for assistance.", activationUrl, billingUrl, settingsUrl, plan: null, expiresAt: null, linked: true };
    if (user.status !== "active") return { state: "ACCOUNT_DISABLED", message: "Your Classroom Desk account is currently unavailable. Contact support for assistance.", activationUrl, billingUrl, settingsUrl, plan: null, expiresAt: null, linked: true };
    return { state: "FREE_ACCESS_ACTIVE", message: "Your Classroom Desk account is connected. Product access is free; Google permissions still control which Classroom data is available.", activationUrl, billingUrl, settingsUrl, plan: null, expiresAt: null, linked: true };
  }

  async requestAccountDeletion(userId: string, reason?: string): Promise<string> {
    const result = await this.db.query<{ id: string }>(`INSERT INTO classroom_desk_account_deletion_requests (user_id,reason) VALUES ($1,$2) ON CONFLICT (user_id) WHERE status='requested' DO UPDATE SET reason=EXCLUDED.reason RETURNING id`, [userId, reason?.trim() || null]);
    const id = result.rows[0]?.id;
    if (!id) throw new Error("Deletion request could not be recorded.");
    return String(id);
  }

  async beginTrialPurchase(userId: string, now = new Date()): Promise<boolean> {
    if (!isTrialPurchaseOpen(now)) return false;
    const staleBefore = new Date(now.getTime() - 30 * 60 * 1000);
    const result = await this.db.query(`UPDATE classroom_desk_trials SET status='pending',pending_at=$2 WHERE user_id=$1 AND (status='eligible' OR (status='pending' AND pending_at IS NOT NULL AND pending_at<$3)) RETURNING user_id`, [userId, now, staleBefore]);
    return result.rows.length === 1;
  }

  async releaseTrialPurchase(userId: string): Promise<void> {
    await this.db.query(`UPDATE classroom_desk_trials SET status='eligible',pending_at=NULL WHERE user_id=$1 AND status='pending'`, [userId]);
  }
  async pendingTrialOrder(userId: string): Promise<{ orderId: string; status: string; paymentId: string | null } | null> {
    const result = await this.db.query<{ provider_order_id: string; status: string; provider_payment_id: string | null }>(
      `SELECT p.provider_order_id,p.status,p.provider_payment_id
       FROM classroom_desk_payments p
       JOIN classroom_desk_trials t ON t.user_id=p.user_id
       WHERE p.user_id=$1 AND p.kind='trial' AND t.status='pending' AND p.provider_order_id IS NOT NULL
       ORDER BY p.created_at DESC LIMIT 1`, [userId]);
    const row = result.rows[0];
    return row?.provider_order_id ? { orderId: String(row.provider_order_id), status: row.status, paymentId: row.provider_payment_id ? String(row.provider_payment_id) : null } : null;
  }
  async expirePendingTrialOrder(userId: string, orderId: string): Promise<boolean> {
    if (this.db.batch) {
      const result = await this.db.query(`UPDATE classroom_desk_trials SET status='eligible',pending_at=NULL WHERE user_id=$1 AND status='pending' AND EXISTS (SELECT 1 FROM classroom_desk_payments WHERE user_id=$1 AND provider_order_id=$2 AND kind='trial' AND status IN ('pending','failed')) RETURNING user_id`, [userId, orderId]);
      return result.rows.length === 1;
    }
    return this.db.transaction(async tx => {
      await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`trial-order:${orderId}`]);
      const result = await tx.query(`UPDATE classroom_desk_trials SET status='eligible',pending_at=NULL WHERE user_id=$1 AND status='pending' AND EXISTS (SELECT 1 FROM classroom_desk_payments WHERE user_id=$1 AND provider_order_id=$2 AND kind='trial' AND status IN ('pending','failed')) RETURNING user_id`, [userId, orderId]);
      return result.rows.length === 1;
    });
  }
  async recordPendingSubscription(userId: string, plan: "student" | "teacher", providerSubscriptionId: string): Promise<void> {
    await this.db.query(`INSERT INTO classroom_desk_subscriptions (user_id,plan,status,provider_subscription_id) VALUES ($1,$2,'pending',$3) ON CONFLICT (provider_subscription_id) DO NOTHING`, [userId, plan, providerSubscriptionId]);
  }

  async recordPendingTrialOrder(userId: string, orderId: string, amountPaise: number, currency: string): Promise<void> {
    if (!/^order_[A-Za-z0-9_]+$/.test(orderId) || amountPaise !== 900 || currency !== "INR") throw new Error("invalid_trial_order");
    if (this.db.batch) {
      const inserted = await this.db.query(`INSERT INTO classroom_desk_payments (user_id,kind,amount_paise,currency,provider_order_id,status) VALUES ($1,'trial',$2,$3,$4,'pending') ON CONFLICT DO NOTHING RETURNING id`, [userId, amountPaise, currency, orderId]);
      if (inserted.rows.length === 1) return;
      const existing = await this.db.query<{ user_id: string }>(`SELECT user_id FROM classroom_desk_payments WHERE provider_order_id=$1`, [orderId]);
      if (existing.rows.some(row => row.user_id !== userId)) throw new Error("trial_order_owner_mismatch");
      if (!existing.rows.length) throw new Error("trial_order_record_failed");
      return;
    }
    await this.db.transaction(async tx => {
      await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`,[`trial-order:${orderId}`]);
      const existing = await tx.query<{user_id:string}>(`SELECT user_id FROM classroom_desk_payments WHERE provider_order_id=$1 FOR UPDATE`,[orderId]);
      if (existing.rows.some(row => row.user_id !== userId)) throw new Error("trial_order_owner_mismatch");
      if (!existing.rows.length) await tx.query(`INSERT INTO classroom_desk_payments (user_id,kind,amount_paise,currency,provider_order_id,status) VALUES ($1,'trial',$2,$3,$4,'pending')`,[userId,amountPaise,currency,orderId]);
    });
  }

  async entitlement(userId: string, now = new Date()): Promise<EffectiveEntitlement> {
    const user = await this.getUser(userId);
    if (!user) return { allowed: false, reason: "none", plan: null, expiresAt: null };
    const [trialRows, subscriptions, grants] = await Promise.all([
      this.db.query<TrialRecord & { user_id: string; payment_id: string | null; paid_at: Date | null; starts_at: Date | null; expires_at: Date | null }>(`SELECT user_id,payment_id,paid_at,starts_at,expires_at,status FROM classroom_desk_trials WHERE user_id=$1`, [userId]),
      this.db.query<SubscriptionRecord & { user_id: string; provider_subscription_id: string | null; paid_through: Date | null; cancelled_at: Date | null }>(`SELECT id,user_id,plan,status,paid_through,cancelled_at,provider_subscription_id FROM classroom_desk_subscriptions WHERE user_id=$1`, [userId]),
      this.db.query<EntitlementGrant & { user_id: string; starts_at: Date; expires_at: Date; revoked_at: Date | null }>(`SELECT id,user_id,plan,source,starts_at,expires_at,revoked_at FROM classroom_desk_entitlement_grants WHERE user_id=$1`, [userId]),
    ]);
    const trialRow = trialRows.rows[0];
    const trial = trialRow ? { userId: String(trialRow.user_id), paymentId: trialRow.payment_id, paidAt: dateOrNull(trialRow.paid_at), startsAt: dateOrNull(trialRow.starts_at), expiresAt: dateOrNull(trialRow.expires_at), status: trialRow.status } : null;
    return resolveEntitlement({ now, user, trial, subscriptions: subscriptions.rows.map((row) => ({ ...row, id: String(row.id), userId: String(row.user_id), paidThrough: dateOrNull(row.paid_through), cancelledAt: dateOrNull(row.cancelled_at), providerSubscriptionId: row.provider_subscription_id })), grants: grants.rows.map((row) => ({ ...row, id: String(row.id), userId: String(row.user_id), startsAt: new Date(row.starts_at), expiresAt: new Date(row.expires_at), revokedAt: dateOrNull(row.revoked_at) })) });
  }

  async recordWebhook(eventId: string, eventType: string, payloadHash: string): Promise<boolean> {
    publicWebhookId(eventId);
    const result = await this.db.query(`INSERT INTO classroom_desk_webhook_events (event_id,event_type,payload_hash) VALUES ($1,$2,$3) ON CONFLICT (event_id) DO NOTHING RETURNING event_id`, [eventId, eventType, payloadHash]);
    return result.rows.length === 1;
  }

  async processWebhook(eventId:string,eventType:string,payloadHash:string,event:BillingEvent|null):Promise<boolean> {
    publicWebhookId(eventId);
    if (this.db.batch) {
      const inserted = await this.db.query(`INSERT INTO classroom_desk_webhook_events (event_id,event_type,payload_hash) VALUES ($1,$2,$3) ON CONFLICT (event_id) DO NOTHING RETURNING event_id`, [eventId, eventType, payloadHash]);
      if (!inserted.rows.length) {
        const existing = await this.db.query<{ status: string; payload_hash: string }>(`SELECT status,payload_hash FROM classroom_desk_webhook_events WHERE event_id=$1`, [eventId]);
        const row = existing.rows[0];
        if (!row || row.payload_hash !== payloadHash) throw new Error("webhook_payload_conflict");
        if (row.status === "processed" || row.status === "ignored") return false;
      }
      try {
        if (event) await this.processBillingEvent(event);
        await this.markWebhook(eventId, event ? "processed" : "ignored");
        return true;
      } catch (error) {
        await this.markWebhook(eventId, "failed");
        throw error;
      }
    }
    return this.db.transaction(async tx=>{
      if (event && "paymentId" in event) await this.lockPayment(tx,event.paymentId,event.userId);
      await tx.query(`INSERT INTO classroom_desk_webhook_events (event_id,event_type,payload_hash) VALUES ($1,$2,$3) ON CONFLICT (event_id) DO NOTHING`,[eventId,eventType,payloadHash]);
      const result=await tx.query<{status:string;payload_hash:string}>(`SELECT status,payload_hash FROM classroom_desk_webhook_events WHERE event_id=$1 FOR UPDATE`,[eventId]);
      const row=result.rows[0];
      if(!row||row.payload_hash!==payloadHash)throw new Error("webhook_payload_conflict");
      if(row.status==='processed'||row.status==='ignored')return false;
      const scoped=new SaaSStore({query:tx.query.bind(tx),transaction:async run=>run(tx)},this.options);
      if(event)await scoped.processBillingEvent(event);
      await tx.query(`UPDATE classroom_desk_webhook_events SET status=$2,processed_at=now() WHERE event_id=$1`,[eventId,event?'processed':'ignored']);
      return true;
    });
  }

  async paymentOwner(paymentId:string, orderId?:string, subId?:string):Promise<string|undefined> {
    requireProviderId(paymentId,"pay");
    if (orderId !== undefined) requireProviderId(orderId,"order");
    if (subId !== undefined) requireProviderId(subId,"sub");
    const result=await this.db.query<{user_id:string;kind:string;amount_paise:number;currency:string;provider_payment_id:string|null;provider_order_id:string|null;provider_subscription_id:string|null}>(`SELECT user_id,kind,amount_paise,currency,provider_payment_id,provider_order_id,provider_subscription_id FROM classroom_desk_payments WHERE provider_payment_id=$1 OR ($2::text IS NOT NULL AND provider_order_id=$2)`,[paymentId,orderId??null]);
    const payments=result.rows.filter(row=>row.provider_payment_id===paymentId);
    const orders=orderId ? result.rows.filter(row=>row.provider_order_id===orderId) : [];
    if (payments.length>1 || orders.length>1) throw new Error("payment_owner_ambiguous");
    if (payments.some(row=>(orderId && row.provider_order_id && row.provider_order_id!==orderId)||(subId && row.provider_subscription_id && row.provider_subscription_id!==subId))) throw new Error("payment_association_mismatch");
    if (orders.some(row=>row.kind!=="trial"||Number(row.amount_paise)!==900||row.currency!=="INR"||(row.provider_payment_id && row.provider_payment_id!==paymentId))) throw new Error("payment_order_association_mismatch");
    const subscriptions=subId ? await this.db.query<{user_id:string;plan:string}>(`SELECT user_id,plan FROM classroom_desk_subscriptions WHERE provider_subscription_id=$1`,[subId]) : {rows:[]};
    if (subscriptions.rows.length>1 || subscriptions.rows.some(row=>!["student","teacher"].includes(row.plan))) throw new Error("payment_owner_ambiguous");
    const tombstone=await this.refundTombstone(this.db,paymentId);
    const owners=[...result.rows.map(row=>row.user_id),...subscriptions.rows.map(row=>row.user_id),...(tombstone?[tombstone]:[])];
    if (owners.some(owner=>!BILLING_OWNER_ID.test(owner))) throw new Error("invalid_billing_owner");
    const unique=new Set(owners.map(owner=>owner.toLowerCase()));
    if (unique.size>1) throw new Error("payment_owner_conflict");
    return [...unique][0];
  }

  async markWebhook(eventId: string, status: "processed" | "ignored" | "failed"): Promise<void> {
    publicWebhookId(eventId);
    await this.db.query(`UPDATE classroom_desk_webhook_events SET status=$2,processed_at=now() WHERE event_id=$1`, [eventId, status]);
  }

  async activateTrial(userId: string, paymentId: string, paidAt: Date, amountPaise: number, orderId?: string): Promise<boolean> {
    if (amountPaise !== 900) return false;
    if (orderId !== undefined) requireProviderId(orderId,"order");
    if (this.db.batch) return this.activateTrialD1(userId, paymentId, paidAt, orderId);
    return this.db.transaction(async (tx) => {
      await this.lockPayment(tx,paymentId,userId);
      const tombstoned=Boolean(await this.refundTombstone(tx,paymentId,userId));
      await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`,[`trial:${userId}`]);
      let refundedOrder=false;
      let placeholderId:string|undefined;
      if (orderId) {
        await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`,[`trial-order:${orderId}`]);
        const association=await tx.query<{id:string;user_id:string;kind:string;currency:string;provider_payment_id:string|null;status:string;amount_paise:number}>(`SELECT id,user_id,kind,currency,provider_payment_id,status,amount_paise FROM classroom_desk_payments WHERE provider_order_id=$1 FOR UPDATE`,[orderId]);
        if(association.rows.length>1||association.rows.some(row=>row.user_id!==userId||row.kind!=="trial"||row.currency!=="INR"||Number(row.amount_paise)!==amountPaise||(row.provider_payment_id&&row.provider_payment_id!==paymentId)))throw new Error("trial_order_owner_mismatch");
        refundedOrder=association.rows.some(row=>row.status==='refunded');
        placeholderId=association.rows[0]?.id;
      }
      const existing = await tx.query<{ id:string;user_id: string; kind: string; currency:string;amount_paise: number; status: string;provider_order_id:string|null }>(`SELECT id,user_id,kind,currency,amount_paise,status,provider_order_id FROM classroom_desk_payments WHERE provider_payment_id=$1 FOR UPDATE`, [paymentId]);
      const previous=existing.rows[0];
      if (previous && (previous.user_id !== userId || previous.kind !== "trial" || previous.currency!=="INR" || Number(previous.amount_paise) !== amountPaise)) throw new Error("trial_payment_owner_mismatch");
      if (previous && ((orderId && previous.provider_order_id && previous.provider_order_id!==orderId)||(placeholderId && placeholderId!==previous.id))) throw new Error("trial_payment_association_mismatch");
      const refunded=tombstoned||refundedOrder||previous?.status==="refunded";
      const status=refunded?"refunded":"captured";
      // A capture fills its pending placeholder even when an earlier refund
      // makes it terminal. Never grant access just to repair the ledger.
      if (!previous && placeholderId) await tx.query(`UPDATE classroom_desk_payments SET provider_payment_id=$2,status=$3 WHERE id=$1`,[placeholderId,paymentId,status]);
      else if (!previous) await tx.query(`INSERT INTO classroom_desk_payments (user_id,kind,amount_paise,currency,provider_payment_id,provider_order_id,status) VALUES ($1,'trial',$2,'INR',$3,$4,$5)`, [userId, amountPaise, paymentId, orderId ?? null,status]);
      else await tx.query(`UPDATE classroom_desk_payments SET status=$2,provider_order_id=COALESCE(provider_order_id,$3) WHERE provider_payment_id=$1`, [paymentId,status,orderId??null]);
      if (refunded) {
        await tx.query(`UPDATE classroom_desk_trials SET payment_id=$2,paid_at=COALESCE(paid_at,$3),starts_at=COALESCE(starts_at,$3),expires_at=COALESCE(expires_at,$4),pending_at=NULL,status='refunded' WHERE user_id=$1 AND (status IN ('eligible','pending') OR payment_id=$2)`,[userId,paymentId,paidAt,new Date(paidAt.getTime()+168*60*60*1000)]);
        return false;
      }
      const active = await tx.query(`SELECT 1 FROM classroom_desk_trials WHERE user_id=$1 AND status='active' AND payment_id=$2 FOR UPDATE`, [userId, paymentId]);
      if (active.rows.length === 1) return false;
      const trial = await tx.query(`UPDATE classroom_desk_trials SET payment_id=$2,paid_at=$3,starts_at=$3,expires_at=$4,pending_at=NULL,status='active' WHERE user_id=$1 AND status IN ('eligible','pending') RETURNING user_id`, [userId, paymentId, paidAt, new Date(paidAt.getTime() + 168 * 60 * 60 * 1000)]);
      return trial.rows.length === 1;
    });
  }

  private async activateTrialD1(userId: string, paymentId: string, paidAt: Date, orderId?: string): Promise<boolean> {
    await this.lockPaymentD1(paymentId, userId);
    const tombstoned = Boolean(await this.refundTombstone(this.db, paymentId, userId));
    const association = orderId
      ? await this.db.query<{ id: string; user_id: string; kind: string; currency: string; provider_payment_id: string | null; status: string; amount_paise: number }>(`SELECT id,user_id,kind,currency,provider_payment_id,status,amount_paise FROM classroom_desk_payments WHERE provider_order_id=$1`, [orderId])
      : { rows: [] };
    if (association.rows.length > 1 || association.rows.some(row => row.user_id !== userId || row.kind !== "trial" || row.currency !== "INR" || Number(row.amount_paise) !== 900 || (row.provider_payment_id && row.provider_payment_id !== paymentId))) throw new Error("trial_order_owner_mismatch");
    const placeholder = association.rows[0];
    const existing = await this.db.query<{ id: string; user_id: string; kind: string; currency: string; amount_paise: number; status: string; provider_order_id: string | null }>(`SELECT id,user_id,kind,currency,amount_paise,status,provider_order_id FROM classroom_desk_payments WHERE provider_payment_id=$1`, [paymentId]);
    const previous = existing.rows[0];
    if (previous && (previous.user_id !== userId || previous.kind !== "trial" || previous.currency !== "INR" || Number(previous.amount_paise) !== 900)) throw new Error("trial_payment_owner_mismatch");
    if (previous && ((orderId && previous.provider_order_id && previous.provider_order_id !== orderId) || (placeholder && placeholder.id !== previous.id))) throw new Error("trial_payment_association_mismatch");
    const refundedOrder = placeholder?.status === "refunded";
    const paidAtText = paidAt.toISOString();
    const expiresAtText = new Date(paidAt.getTime() + 168 * 60 * 60 * 1000).toISOString();
    let committed: Awaited<ReturnType<NonNullable<SqlDatabase["batch"]>>>;
    try {
      committed = await this.db.batch!([
        { sql: `UPDATE classroom_desk_payments SET provider_payment_id=$2,status=CASE WHEN status='refunded' OR $3 OR EXISTS (SELECT 1 FROM classroom_desk_webhook_events WHERE event_id=$4 AND event_type='internal.refund.tombstone' AND status='terminal' AND payload_hash=$5) THEN 'refunded' ELSE 'captured' END WHERE id=$1 AND user_id=$6 AND kind='trial' AND amount_paise=900 AND currency='INR' AND provider_payment_id IS NULL RETURNING id`, values: [placeholder?.id ?? null, paymentId, refundedOrder, `internal:refund-tombstone:${paymentId}`, userId.toLowerCase(), userId] },
        { sql: `INSERT INTO classroom_desk_payments (user_id,kind,amount_paise,currency,provider_payment_id,provider_order_id,status) VALUES ($1,'trial',900,'INR',$2,$3,CASE WHEN $4 OR EXISTS (SELECT 1 FROM classroom_desk_webhook_events WHERE event_id=$5 AND event_type='internal.refund.tombstone' AND status='terminal' AND payload_hash=$6) OR EXISTS (SELECT 1 FROM classroom_desk_payments WHERE provider_order_id=$3 AND status='refunded') THEN 'refunded' ELSE 'captured' END) ON CONFLICT (provider_payment_id) DO UPDATE SET status=CASE WHEN classroom_desk_payments.status='refunded' OR $4 OR EXISTS (SELECT 1 FROM classroom_desk_webhook_events WHERE event_id=$5 AND event_type='internal.refund.tombstone' AND status='terminal' AND payload_hash=$6) OR EXISTS (SELECT 1 FROM classroom_desk_payments WHERE provider_order_id=$3 AND status='refunded') THEN 'refunded' ELSE 'captured' END,provider_order_id=COALESCE(classroom_desk_payments.provider_order_id,EXCLUDED.provider_order_id) WHERE classroom_desk_payments.user_id=EXCLUDED.user_id AND classroom_desk_payments.kind='trial' AND classroom_desk_payments.amount_paise=900 AND classroom_desk_payments.currency='INR' AND (classroom_desk_payments.provider_order_id IS NULL OR EXCLUDED.provider_order_id IS NULL OR classroom_desk_payments.provider_order_id=EXCLUDED.provider_order_id) RETURNING id,status`, values: [userId, paymentId, orderId ?? null, refundedOrder, `internal:refund-tombstone:${paymentId}`, userId.toLowerCase()] },
        { sql: `UPDATE classroom_desk_trials SET payment_id=$2,paid_at=CASE WHEN $3 OR EXISTS (SELECT 1 FROM classroom_desk_webhook_events WHERE event_id=$4 AND event_type='internal.refund.tombstone' AND status='terminal' AND payload_hash=$5) OR EXISTS (SELECT 1 FROM classroom_desk_payments WHERE provider_payment_id=$2 AND status='refunded') THEN COALESCE(paid_at,$6) ELSE $6 END,starts_at=CASE WHEN $3 OR EXISTS (SELECT 1 FROM classroom_desk_webhook_events WHERE event_id=$4 AND event_type='internal.refund.tombstone' AND status='terminal' AND payload_hash=$5) OR EXISTS (SELECT 1 FROM classroom_desk_payments WHERE provider_payment_id=$2 AND status='refunded') THEN COALESCE(starts_at,$6) ELSE $6 END,expires_at=CASE WHEN $3 OR EXISTS (SELECT 1 FROM classroom_desk_webhook_events WHERE event_id=$4 AND event_type='internal.refund.tombstone' AND status='terminal' AND payload_hash=$5) OR EXISTS (SELECT 1 FROM classroom_desk_payments WHERE provider_payment_id=$2 AND status='refunded') THEN COALESCE(expires_at,$7) ELSE $7 END,pending_at=NULL,status=CASE WHEN $3 OR EXISTS (SELECT 1 FROM classroom_desk_webhook_events WHERE event_id=$4 AND event_type='internal.refund.tombstone' AND status='terminal' AND payload_hash=$5) OR EXISTS (SELECT 1 FROM classroom_desk_payments WHERE provider_payment_id=$2 AND status='refunded') THEN 'refunded' ELSE 'active' END WHERE user_id=$1 AND (status IN ('eligible','pending') OR (payment_id=$2 AND (EXISTS (SELECT 1 FROM classroom_desk_payments WHERE provider_payment_id=$2 AND status='refunded') OR $3 OR EXISTS (SELECT 1 FROM classroom_desk_webhook_events WHERE event_id=$4 AND event_type='internal.refund.tombstone' AND status='terminal' AND payload_hash=$5)))) AND EXISTS (SELECT 1 FROM classroom_desk_payments WHERE provider_payment_id=$2 AND user_id=$1 AND kind='trial' AND amount_paise=900 AND currency='INR' AND (provider_order_id IS NULL OR $8 IS NULL OR provider_order_id=$8)) RETURNING status`, values: [userId, paymentId, refundedOrder, `internal:refund-tombstone:${paymentId}`, userId.toLowerCase(), paidAtText, expiresAtText, orderId ?? null] },
      ]);
    } catch (error) {
      if (orderId) {
        const current = await this.db.query<{ user_id: string; provider_payment_id: string | null }>(`SELECT user_id,provider_payment_id FROM classroom_desk_payments WHERE provider_order_id=$1`, [orderId]);
        if (current.rows.some(row => row.user_id !== userId || (row.provider_payment_id && row.provider_payment_id !== paymentId))) throw new Error("trial_order_owner_mismatch");
      }
      throw error;
    }
    if (!committed[1]?.rows.length) {
      const payment = await this.db.query(`SELECT 1 FROM classroom_desk_payments WHERE provider_payment_id=$1 AND user_id=$2 AND kind='trial' AND amount_paise=900 AND currency='INR'`, [paymentId, userId]);
      if (!payment.rows.length) throw new Error("trial_payment_owner_mismatch");
      return false;
    }
    return committed[2]?.rows[0]?.status === "active";
  }

  private async lockPaymentD1(paymentId: string, userId: string): Promise<void> {
    requireProviderId(paymentId, "pay");
    if (!BILLING_OWNER_ID.test(userId)) throw new Error("invalid_billing_owner");
  }

  async processBillingEvent(event: BillingEvent): Promise<boolean> {
    if (event.kind === "trial_captured") return this.activateTrial(event.userId, event.paymentId, event.paidAt, event.amountPaise,event.orderId);
    if (event.kind === "subscription_paid" && event.amountPaise !== planPricePaise(event.plan)) return false;
    if (this.db.batch) return this.processBillingEventD1(event);
    return this.db.transaction(async (tx) => {
      if ("paymentId" in event) await this.lockPayment(tx,event.paymentId,event.userId);
      if (event.kind === "subscription_paid") {
        requireProviderId(event.subscriptionId,"sub");
        const tombstoned=Boolean(await this.refundTombstone(tx,event.paymentId,event.userId));
        await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`,[`billing:${event.userId}`]);
        const firstPayment = await tx.query(`SELECT 1 FROM classroom_desk_payments WHERE user_id=$1 AND kind='subscription' AND status IN ('paid','captured','refunded') LIMIT 1`,[event.userId]);
        const owner=await tx.query<{user_id:string;status:string;plan:string}>(`SELECT user_id,status,plan FROM classroom_desk_subscriptions WHERE provider_subscription_id=$1 FOR UPDATE`,[event.subscriptionId]);
        if(owner.rows[0]&&owner.rows[0].user_id!==event.userId)throw new Error("subscription_owner_mismatch");
        if(owner.rows[0]&&owner.rows[0].plan!==event.plan)throw new Error("subscription_plan_mismatch");
        const existing=await tx.query<{user_id:string;kind:string;plan:string;amount_paise:number;currency:string;provider_subscription_id:string|null;status:string}>(`SELECT user_id,kind,plan,amount_paise,currency,provider_subscription_id,status FROM classroom_desk_payments WHERE provider_payment_id=$1 FOR UPDATE`,[event.paymentId]);
        const previous=existing.rows[0];
        if(previous&&(previous.user_id!==event.userId||previous.kind!=="subscription"||previous.plan!==event.plan||Number(previous.amount_paise)!==event.amountPaise||previous.currency!=="INR"||previous.provider_subscription_id!==event.subscriptionId))throw new Error("subscription_payment_owner_mismatch");
        if(tombstoned||previous?.status==='refunded'){
          if(previous)await tx.query(`UPDATE classroom_desk_payments SET status='refunded' WHERE provider_payment_id=$1`,[event.paymentId]);
          else await tx.query(`INSERT INTO classroom_desk_payments (user_id,kind,plan,amount_paise,currency,provider_payment_id,provider_subscription_id,status) VALUES ($1,'subscription',$2,$3,'INR',$4,$5,'refunded')`,[event.userId,event.plan,event.amountPaise,event.paymentId,event.subscriptionId]);
          await tx.query(`INSERT INTO classroom_desk_subscriptions (user_id,plan,status,provider_subscription_id) VALUES ($1,$2,'refunded',$3) ON CONFLICT (provider_subscription_id) DO UPDATE SET status='refunded' WHERE classroom_desk_subscriptions.user_id=EXCLUDED.user_id`,[event.userId,event.plan,event.subscriptionId]);
          return false;
        }
        if(owner.rows[0]?.status==='refunded')return false;
        const payment = await tx.query(`INSERT INTO classroom_desk_payments (user_id,kind,plan,amount_paise,currency,provider_payment_id,provider_subscription_id,status) VALUES ($1,'subscription',$2,$3,'INR',$4,$5,'paid') ON CONFLICT (provider_payment_id) DO NOTHING RETURNING id`, [event.userId, event.plan, event.amountPaise, event.paymentId, event.subscriptionId]);
        if (!payment.rows.length) return false;
        await tx.query(`INSERT INTO classroom_desk_subscriptions (user_id,plan,status,paid_through,provider_subscription_id) VALUES ($1,$2,'active',$3,$4) ON CONFLICT (provider_subscription_id) DO UPDATE SET status=CASE WHEN classroom_desk_subscriptions.status='cancelled' THEN 'cancelled' ELSE 'active' END,paid_through=GREATEST(classroom_desk_subscriptions.paid_through,EXCLUDED.paid_through),plan=EXCLUDED.plan WHERE classroom_desk_subscriptions.user_id=EXCLUDED.user_id`, [event.userId, event.plan, event.paidThrough, event.subscriptionId]);
        if (payment.rows.length === 1 && firstPayment.rows.length === 0 && this.options.referralRewardsEnabled === true) await this.qualifyReferralTx(tx, event.userId, new Date());
        return payment.rows.length === 1;
      }
      if (event.kind === "subscription_cancelled") {
        const result = await tx.query(`UPDATE classroom_desk_subscriptions SET status='cancelled',cancelled_at=$2 WHERE provider_subscription_id=$1 AND user_id=$3 AND status<>'refunded' RETURNING id`, [event.subscriptionId, event.cancelledAt,event.userId]); return result.rows.length === 1;
      }
      if (event.kind === "subscription_failed") {
        const result = await tx.query(`UPDATE classroom_desk_subscriptions SET status='past_due' WHERE provider_subscription_id=$1 AND user_id=$2 AND status NOT IN ('refunded','cancelled') AND (paid_through IS NULL OR paid_through<=now()) RETURNING id`, [event.subscriptionId,event.userId]); return result.rows.length === 1;
      }
      await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`,[`billing:${event.userId}`]);
      await this.refundTombstone(tx,event.paymentId,event.userId);
      const existing=await tx.query<{user_id:string}>(`SELECT user_id FROM classroom_desk_payments WHERE provider_payment_id=$1 FOR UPDATE`,[event.paymentId]);
      if(existing.rows[0]&&existing.rows[0].user_id!==event.userId)throw new Error("refund_payment_owner_mismatch");
      const user=await tx.query(`SELECT id FROM classroom_desk_users WHERE id=$1`,[event.userId]);
      if(!user.rows.length)throw new Error("refund_owner_missing");
      const marker=await tx.query(`INSERT INTO classroom_desk_webhook_events (event_id,event_type,payload_hash,status,processed_at) VALUES ($1,'internal.refund.tombstone',$2,'terminal',now()) ON CONFLICT (event_id) DO NOTHING RETURNING event_id`,[`internal:refund-tombstone:${event.paymentId}`,event.userId.toLowerCase()]);
      if(!existing.rows.length)return marker.rows.length===1;
      const payment = await tx.query(`UPDATE classroom_desk_payments SET status='refunded' WHERE provider_payment_id=$1 AND user_id=$2 AND status <> 'refunded' RETURNING user_id`, [event.paymentId,event.userId]);
      if (!payment.rows.length) return false;
      await tx.query(`UPDATE classroom_desk_subscriptions SET status='refunded' WHERE provider_subscription_id IN (SELECT provider_subscription_id FROM classroom_desk_payments WHERE provider_payment_id=$1 AND provider_subscription_id IS NOT NULL)`, [event.paymentId]);
      await tx.query(`UPDATE classroom_desk_trials SET status='refunded' WHERE payment_id=$1 AND user_id=$2`, [event.paymentId,event.userId]);
      const referral = await tx.query<{referrer_user_id:string}>(`SELECT referrer_user_id FROM classroom_desk_referrals WHERE referred_user_id=$1 AND counted_at IS NOT NULL`, [event.userId]);
      const referrer = referral.rows[0]?.referrer_user_id;
      if (referrer) {
        await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [referrer]);
        await tx.query(`UPDATE classroom_desk_referrals SET qualified_at=NULL,counted_at=NULL WHERE referred_user_id=$1`, [event.userId]);
        await tx.query(`UPDATE classroom_desk_entitlement_grants SET revoked_at=now() WHERE id IN (SELECT grant_id FROM classroom_desk_referral_rewards WHERE user_id=$1 AND referral_count>(SELECT count(*) FROM classroom_desk_referrals WHERE referrer_user_id=$1 AND counted_at IS NOT NULL))`, [referrer]);
      }
      return true;
    });
  }

  private async processBillingEventD1(event: Exclude<BillingEvent, { kind: "trial_captured" }>): Promise<boolean> {
    if (event.kind === "subscription_cancelled") {
      requireProviderId(event.subscriptionId, "sub");
      const result = await this.db.query(`UPDATE classroom_desk_subscriptions SET status='cancelled',cancelled_at=$2 WHERE provider_subscription_id=$1 AND user_id=$3 AND status<>'refunded' RETURNING id`, [event.subscriptionId, event.cancelledAt, event.userId]);
      return result.rows.length === 1;
    }
    if (event.kind === "subscription_failed") {
      requireProviderId(event.subscriptionId, "sub");
      const result = await this.db.query(`UPDATE classroom_desk_subscriptions SET status='past_due' WHERE provider_subscription_id=$1 AND user_id=$2 AND status NOT IN ('refunded','cancelled') AND (paid_through IS NULL OR paid_through<=now()) RETURNING id`, [event.subscriptionId, event.userId]);
      return result.rows.length === 1;
    }
    if (event.kind === "subscription_paid") {
      requireProviderId(event.subscriptionId, "sub");
      requireProviderId(event.paymentId, "pay");
      const tombstoned = Boolean(await this.refundTombstone(this.db, event.paymentId, event.userId));
      const owner = await this.db.query<{ user_id: string; status: string; plan: string }>(`SELECT user_id,status,plan FROM classroom_desk_subscriptions WHERE provider_subscription_id=$1`, [event.subscriptionId]);
      if (owner.rows[0] && owner.rows[0].user_id !== event.userId) throw new Error("subscription_owner_mismatch");
      if (owner.rows[0] && owner.rows[0].plan !== event.plan) throw new Error("subscription_plan_mismatch");
      const previous = await this.db.query<{ user_id: string; kind: string; plan: string; amount_paise: number; currency: string; provider_subscription_id: string | null; status: string }>(`SELECT user_id,kind,plan,amount_paise,currency,provider_subscription_id,status FROM classroom_desk_payments WHERE provider_payment_id=$1`, [event.paymentId]);
      const priorPayment = previous.rows[0];
      if (priorPayment && (priorPayment.user_id !== event.userId || priorPayment.kind !== "subscription" || priorPayment.plan !== event.plan || Number(priorPayment.amount_paise) !== event.amountPaise || priorPayment.currency !== "INR" || priorPayment.provider_subscription_id !== event.subscriptionId)) throw new Error("subscription_payment_owner_mismatch");
      if (owner.rows[0]?.status === "refunded" && !tombstoned && priorPayment?.status !== "refunded") return false;
      if (tombstoned || priorPayment?.status === "refunded") {
        await this.recordRefundedSubscriptionPaymentD1(event);
        return false;
      }
      if (priorPayment) return false;
      const operationId = randomUUID(); const now = new Date(); const grantId = randomUUID();
      const queries = [
        { sql: `INSERT INTO classroom_desk_payments (user_id,kind,plan,amount_paise,currency,provider_payment_id,provider_subscription_id,status,last_operation_id) SELECT $1,'subscription',$2,$3,'INR',$4,$5,'paid',$6 WHERE NOT EXISTS (SELECT 1 FROM classroom_desk_webhook_events WHERE event_id=$7 AND event_type='internal.refund.tombstone' AND status='terminal' AND payload_hash=$8) AND NOT EXISTS (SELECT 1 FROM classroom_desk_subscriptions WHERE provider_subscription_id=$5 AND (user_id<>$1 OR status='refunded')) ON CONFLICT (provider_payment_id) DO NOTHING RETURNING id`, values: [event.userId, event.plan, event.amountPaise, event.paymentId, event.subscriptionId, operationId, `internal:refund-tombstone:${event.paymentId}`, event.userId.toLowerCase()] },
        { sql: `INSERT INTO classroom_desk_subscriptions (user_id,plan,status,paid_through,provider_subscription_id) SELECT $1,$2,'active',$3,$4 WHERE EXISTS (SELECT 1 FROM classroom_desk_payments WHERE provider_payment_id=$5 AND user_id=$1 AND status='paid' AND last_operation_id=$6) ON CONFLICT (provider_subscription_id) DO UPDATE SET status=CASE WHEN classroom_desk_subscriptions.status='cancelled' THEN 'cancelled' ELSE 'active' END,paid_through=CASE WHEN classroom_desk_subscriptions.paid_through IS NULL OR classroom_desk_subscriptions.paid_through<EXCLUDED.paid_through THEN EXCLUDED.paid_through ELSE classroom_desk_subscriptions.paid_through END,plan=EXCLUDED.plan WHERE classroom_desk_subscriptions.user_id=EXCLUDED.user_id AND classroom_desk_subscriptions.status<>'refunded' RETURNING id`, values: [event.userId, event.plan, event.paidThrough, event.subscriptionId, event.paymentId, operationId] },
      ] as Array<{ sql: string; values: unknown[] }>;
      if (this.options.referralRewardsEnabled === true) {
        queries.push(
          { sql: `UPDATE classroom_desk_referrals SET qualified_at=$1,counted_at=$1,qualified_operation_id=$2 WHERE referred_user_id=$3 AND counted_at IS NULL AND EXISTS (SELECT 1 FROM classroom_desk_payments p WHERE p.provider_payment_id=$4 AND p.user_id=$3 AND p.status='paid' AND p.last_operation_id=$2 AND NOT EXISTS (SELECT 1 FROM classroom_desk_payments prior WHERE prior.user_id=$3 AND prior.kind='subscription' AND prior.status IN ('paid','captured','refunded') AND prior.provider_payment_id<>$4)) RETURNING referrer_user_id`, values: [now, operationId, event.userId, event.paymentId] },
          { sql: `INSERT INTO classroom_desk_entitlement_grants (id,user_id,plan,source,starts_at,expires_at,reason) SELECT $1,r.referrer_user_id,'student','referral',$2,strftime('%Y-%m-%dT%H:%M:%fZ',CASE WHEN COALESCE((SELECT MAX(term) FROM (SELECT expires_at AS term FROM classroom_desk_entitlement_grants WHERE user_id=r.referrer_user_id AND revoked_at IS NULL UNION ALL SELECT paid_through AS term FROM classroom_desk_subscriptions WHERE user_id=r.referrer_user_id AND status IN ('active','cancelled') UNION ALL SELECT expires_at AS term FROM classroom_desk_trials WHERE user_id=r.referrer_user_id AND status='active')), $2)>$2 THEN (SELECT MAX(term) FROM (SELECT expires_at AS term FROM classroom_desk_entitlement_grants WHERE user_id=r.referrer_user_id AND revoked_at IS NULL UNION ALL SELECT paid_through AS term FROM classroom_desk_subscriptions WHERE user_id=r.referrer_user_id AND status IN ('active','cancelled') UNION ALL SELECT expires_at AS term FROM classroom_desk_trials WHERE user_id=r.referrer_user_id AND status='active')) ELSE $2 END,'+30 days'),'Reward for '||(SELECT COUNT(*) FROM classroom_desk_referrals n WHERE n.referrer_user_id=r.referrer_user_id AND n.counted_at IS NOT NULL)||' qualifying monthly referrals' FROM classroom_desk_referrals r WHERE r.referred_user_id=$3 AND r.qualified_operation_id=$4 AND (SELECT COUNT(*) FROM classroom_desk_referrals n WHERE n.referrer_user_id=r.referrer_user_id AND n.counted_at IS NOT NULL)>=2 AND (SELECT COUNT(*) FROM classroom_desk_referrals n WHERE n.referrer_user_id=r.referrer_user_id AND n.counted_at IS NOT NULL)%2=0 AND NOT EXISTS (SELECT 1 FROM classroom_desk_referral_rewards rr WHERE rr.user_id=r.referrer_user_id AND rr.referral_count=(SELECT COUNT(*) FROM classroom_desk_referrals n WHERE n.referrer_user_id=r.referrer_user_id AND n.counted_at IS NOT NULL))`, values: [grantId, now, event.userId, operationId] },
          { sql: `INSERT INTO classroom_desk_referral_rewards (user_id,referral_count,grant_id) SELECT g.user_id,(SELECT COUNT(*) FROM classroom_desk_referrals r WHERE r.referrer_user_id=g.user_id AND r.counted_at IS NOT NULL),g.id FROM classroom_desk_entitlement_grants g WHERE g.id=$1 AND g.source='referral' AND NOT EXISTS (SELECT 1 FROM classroom_desk_referral_rewards rr WHERE rr.grant_id=g.id) ON CONFLICT (user_id,referral_count) DO NOTHING`, values: [grantId] },
        );
      }
      const committed = await this.db.batch!(queries);
      if (committed[0]?.rows.length !== 1) {
        const current = await this.db.query<{ user_id: string; kind: string; plan: string; amount_paise: number; currency: string; provider_subscription_id: string | null; status: string }>(`SELECT user_id,kind,plan,amount_paise,currency,provider_subscription_id,status FROM classroom_desk_payments WHERE provider_payment_id=$1`, [event.paymentId]);
        const raced = current.rows[0];
        if (raced && (raced.user_id !== event.userId || raced.kind !== "subscription" || raced.plan !== event.plan || Number(raced.amount_paise) !== event.amountPaise || raced.currency !== "INR" || raced.provider_subscription_id !== event.subscriptionId)) throw new Error("subscription_payment_owner_mismatch");
        const currentOwner = await this.db.query<{ user_id: string; plan: string }>(`SELECT user_id,plan FROM classroom_desk_subscriptions WHERE provider_subscription_id=$1`, [event.subscriptionId]);
        if (currentOwner.rows[0] && (currentOwner.rows[0].user_id !== event.userId || currentOwner.rows[0].plan !== event.plan)) throw new Error("subscription_owner_mismatch");
        if (await this.refundTombstone(this.db, event.paymentId, event.userId)) { await this.recordRefundedSubscriptionPaymentD1(event); }
        return false;
      }
      return true;
    }

    await this.lockPaymentD1(event.paymentId, event.userId);
    const existing = await this.db.query<{ user_id: string }>(`SELECT user_id FROM classroom_desk_payments WHERE provider_payment_id=$1`, [event.paymentId]);
    if (existing.rows[0] && existing.rows[0].user_id !== event.userId) throw new Error("refund_payment_owner_mismatch");
    const user = await this.db.query(`SELECT id FROM classroom_desk_users WHERE id=$1`, [event.userId]);
    if (!user.rows.length) throw new Error("refund_owner_missing");
    await this.refundTombstone(this.db, event.paymentId, event.userId);
    const markerId = `internal:refund-tombstone:${event.paymentId}`;
    const results = await this.db.batch!([
      { sql: `INSERT INTO classroom_desk_webhook_events (event_id,event_type,payload_hash,status,processed_at) VALUES ($1,'internal.refund.tombstone',$2,'terminal',now()) ON CONFLICT (event_id) DO NOTHING RETURNING event_id`, values: [markerId, event.userId.toLowerCase()] },
      { sql: `UPDATE classroom_desk_payments SET status='refunded' WHERE provider_payment_id=$1 AND user_id=$2 AND status<>'refunded' RETURNING user_id`, values: [event.paymentId, event.userId] },
      { sql: `UPDATE classroom_desk_subscriptions SET status='refunded' WHERE provider_subscription_id IN (SELECT provider_subscription_id FROM classroom_desk_payments WHERE provider_payment_id=$1 AND user_id=$2 AND provider_subscription_id IS NOT NULL)`, values: [event.paymentId, event.userId] },
      { sql: `UPDATE classroom_desk_trials SET status='refunded' WHERE payment_id=$1 AND user_id=$2`, values: [event.paymentId, event.userId] },
      { sql: `UPDATE classroom_desk_referrals SET qualified_at=NULL,counted_at=NULL WHERE referred_user_id=$1`, values: [event.userId] },
      { sql: `UPDATE classroom_desk_entitlement_grants SET revoked_at=now() WHERE id IN (SELECT rr.grant_id FROM classroom_desk_referral_rewards rr WHERE rr.user_id IN (SELECT referrer_user_id FROM classroom_desk_referrals WHERE referred_user_id=$1) AND rr.referral_count>(SELECT count(*) FROM classroom_desk_referrals r WHERE r.referrer_user_id=rr.user_id AND r.counted_at IS NOT NULL))`, values: [event.userId] },
    ]);
    if (!existing.rows.length) return (results[0]?.rows.length ?? 0) === 1;
    return (results[1]?.rows.length ?? 0) === 1;
  }

  private async recordRefundedSubscriptionPaymentD1(event: Extract<BillingEvent, { kind: "subscription_paid" }>): Promise<void> {
    const results = await this.db.batch!([
      { sql: `INSERT INTO classroom_desk_payments (user_id,kind,plan,amount_paise,currency,provider_payment_id,provider_subscription_id,status) SELECT $1,'subscription',$2,$3,'INR',$4,$5,'refunded' WHERE NOT EXISTS (SELECT 1 FROM classroom_desk_subscriptions WHERE provider_subscription_id=$5 AND user_id<>$1) ON CONFLICT (provider_payment_id) DO UPDATE SET status='refunded' WHERE classroom_desk_payments.user_id=EXCLUDED.user_id AND classroom_desk_payments.kind='subscription' AND classroom_desk_payments.plan=EXCLUDED.plan AND classroom_desk_payments.amount_paise=EXCLUDED.amount_paise AND classroom_desk_payments.currency='INR' AND classroom_desk_payments.provider_subscription_id=EXCLUDED.provider_subscription_id RETURNING id`, values: [event.userId, event.plan, event.amountPaise, event.paymentId, event.subscriptionId] },
      { sql: `INSERT INTO classroom_desk_subscriptions (user_id,plan,status,provider_subscription_id) SELECT $1,$2,'refunded',$3 WHERE EXISTS (SELECT 1 FROM classroom_desk_payments WHERE provider_payment_id=$4 AND user_id=$1 AND status='refunded') ON CONFLICT (provider_subscription_id) DO UPDATE SET status='refunded' WHERE classroom_desk_subscriptions.user_id=EXCLUDED.user_id RETURNING id`, values: [event.userId, event.plan, event.subscriptionId, event.paymentId] },
    ]);
    if (!results[0]?.rows.length) throw new Error("subscription_payment_owner_mismatch");
  }

  async ownsSubscription(userId: string, subscriptionId: string): Promise<boolean> {
    const result = await this.db.query(`SELECT 1 FROM classroom_desk_subscriptions WHERE user_id=$1 AND provider_subscription_id=$2 AND status IN ('active','past_due','pending')`, [userId, subscriptionId]);
    return result.rows.length === 1;
  }

  private async qualifyReferralTx(tx: SqlConnection, referredUserId: string, now: Date): Promise<void> {
    const attribution = await tx.query<{referrer_user_id:string}>(`SELECT referrer_user_id FROM classroom_desk_referrals WHERE referred_user_id=$1`, [referredUserId]);
    if (!attribution.rows[0]) return;
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [attribution.rows[0].referrer_user_id]);
    const referral = await tx.query<{ referrer_user_id: string }>(`UPDATE classroom_desk_referrals SET qualified_at=$2,counted_at=$2 WHERE referred_user_id=$1 AND counted_at IS NULL RETURNING referrer_user_id`, [referredUserId, now]);
    const referrerId = referral.rows[0]?.referrer_user_id;
    if (!referrerId) return;
    const countResult = await tx.query<{ count: string }>(`SELECT count(*) FROM classroom_desk_referrals WHERE referrer_user_id=$1 AND counted_at IS NOT NULL`, [referrerId]);
    const count = Number(countResult.rows[0]?.count ?? 0);
    if (count < 2 || count % 2 !== 0) return;
    const grantId = randomUUID();
    const access=await tx.query<{expires_at:Date|null}>(`SELECT max(expires_at) expires_at FROM (SELECT expires_at FROM classroom_desk_entitlement_grants WHERE user_id=$1 AND revoked_at IS NULL UNION ALL SELECT paid_through FROM classroom_desk_subscriptions WHERE user_id=$1 AND status IN ('active','cancelled') UNION ALL SELECT expires_at FROM classroom_desk_trials WHERE user_id=$1 AND status='active') access_terms`,[referrerId]);
    const expires = new Date(Math.max(now.getTime(),access.rows[0]?.expires_at?new Date(access.rows[0].expires_at).getTime():0) + 30 * 24 * 60 * 60 * 1000);
    const existing = await tx.query(`SELECT id FROM classroom_desk_referral_rewards WHERE user_id=$1 AND referral_count=$2`, [referrerId,count]);
    if (existing.rows.length) return;
    await tx.query(`INSERT INTO classroom_desk_entitlement_grants (id,user_id,plan,source,starts_at,expires_at,reason) VALUES ($1,$2,'student','referral',$3,$4,$5)`, [grantId, referrerId, now, expires, `Reward for ${count} qualifying monthly referrals`]);
    await tx.query(`INSERT INTO classroom_desk_referral_rewards (user_id,referral_count,grant_id) VALUES ($1,$2,$3)`, [referrerId, count, grantId]);
  }

  async listUsers(search = "", role?: string, status?: string, subscription?: string): Promise<SaaSUser[]> {
    const values: unknown[] = []; const filters: string[] = [];
    if (["SUPER_ADMIN", "SUPPORT_ADMIN", "STUDENT", "TEACHER"].includes(role ?? "")) { values.push(role); filters.push(`role=$${values.length}`); }
    if (["active", "suspended", "deleted"].includes(status ?? "")) { values.push(status); filters.push(`status=$${values.length}`); }
    if (subscription === "active" || subscription === "trial" || subscription === "none") {
      const hasSubscription = `(EXISTS (SELECT 1 FROM classroom_desk_subscriptions s WHERE s.user_id=classroom_desk_users.id AND s.status IN ('active','cancelled','past_due') AND (s.paid_through IS NULL OR s.paid_through>now())) OR EXISTS (SELECT 1 FROM classroom_desk_trials t WHERE t.user_id=classroom_desk_users.id AND t.status='active' AND t.expires_at>now()) OR EXISTS (SELECT 1 FROM classroom_desk_entitlement_grants g WHERE g.user_id=classroom_desk_users.id AND g.revoked_at IS NULL AND g.starts_at<=now() AND g.expires_at>now()))`;
      if (subscription === "active") filters.push(hasSubscription);
      if (subscription === "trial") filters.push(`EXISTS (SELECT 1 FROM classroom_desk_trials t WHERE t.user_id=classroom_desk_users.id AND t.status='active' AND t.expires_at>now())`);
      if (subscription === "none") filters.push(`NOT ${hasSubscription}`);
    }
    const result = await this.db.query<{ id: string; google_subject: string; email: string; display_name: string; profile_ciphertext?: string | null; role: SaaSUser["role"]; status: SaaSUser["status"]; created_at: Date; last_login_at: Date | null }>(`SELECT id,google_subject,email,display_name,profile_ciphertext,role,status,created_at,last_login_at FROM classroom_desk_users${filters.length ? ` WHERE ${filters.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT 500`, values);
    const needle = search.trim().toLocaleLowerCase();
    return result.rows.map((row) => this.userFromRow(row)).filter((user) => !needle || `${user.email} ${user.displayName}`.toLocaleLowerCase().includes(needle)).slice(0, 100);
  }

  async adminMetrics(): Promise<AdminMetrics> {
    const [users, registrations, trials, students, teachers, expired, renewals, revenue, conversions, payments, referrals, activity] = await Promise.all([
      this.db.query<{ count: string }>(`SELECT count(*) FROM classroom_desk_users WHERE status <> 'deleted'`),
      this.db.query<{ count: string }>(`SELECT count(*) FROM classroom_desk_users WHERE created_at>=now()-interval '30 days' AND status <> 'deleted'`),
      this.db.query<{ count: string }>(`SELECT count(*) FROM classroom_desk_trials WHERE status='active' AND expires_at>now()`),
      this.db.query<{ count: string }>(`SELECT count(*) FROM classroom_desk_subscriptions WHERE plan='student' AND status IN ('active','cancelled') AND paid_through>now()`),
      this.db.query<{ count: string }>(`SELECT count(*) FROM classroom_desk_subscriptions WHERE plan='teacher' AND status IN ('active','cancelled') AND paid_through>now()`),
      this.db.query<{ count: string }>(`SELECT count(*) FROM classroom_desk_subscriptions WHERE status IN ('expired','refunded') OR (paid_through IS NOT NULL AND paid_through<=now())`),
      this.db.query<{ count: string }>(`SELECT count(*) FROM classroom_desk_subscriptions WHERE status IN ('active','cancelled') AND paid_through>now() AND paid_through<=now()+interval '30 days'`),
      this.db.query<{ total: string }>(`SELECT coalesce(sum(amount_paise),0) total FROM classroom_desk_payments WHERE status IN ('captured','paid')`),
      this.db.query<{ count: string }>(`SELECT count(*) FROM classroom_desk_payments WHERE kind='subscription' AND status IN ('paid','captured') AND created_at>=now()-interval '30 days'`),
      this.db.query<{ count: string }>(`SELECT count(*) FROM classroom_desk_payments WHERE status IN ('paid','captured') AND created_at>=now()-interval '30 days'`),
      this.db.query<{ count: string }>(`SELECT count(*) FROM classroom_desk_referrals WHERE counted_at IS NOT NULL`),
      this.db.query<{ count: string }>(`SELECT count(*) FROM classroom_desk_admin_audit WHERE created_at>=now()-interval '30 days'`),
    ]);
    const count = (row: { count: string } | undefined) => Number(row?.count ?? 0);
    return { totalUsers: count(users.rows[0]), newRegistrations: count(registrations.rows[0]), activeTrials: count(trials.rows[0]), activeStudentSubscriptions: count(students.rows[0]), activeTeacherSubscriptions: count(teachers.rows[0]), expiredSubscriptions: count(expired.rows[0]), upcomingRenewals: count(renewals.rows[0]), verifiedRevenuePaise: Number(revenue.rows[0]?.total ?? 0), trialConversions: count(conversions.rows[0]), recentPayments: count(payments.rows[0]), qualifiedReferrals: count(referrals.rows[0]), recentAdminActivity: count(activity.rows[0]) };
  }

  async adminPayments(): Promise<AdminPayment[]> {
    const result = await this.db.query<{ id: string; user_id: string; email: string; display_name: string; google_subject: string; profile_ciphertext?: string | null; role: SaaSUser["role"]; user_status: SaaSUser["status"]; user_created_at: Date; user_last_login_at: Date | null; kind: string; plan: string | null; amount_paise: number; currency: string; provider_payment_id: string | null; provider_subscription_id: string | null; status: string; created_at: Date }>(`SELECT p.id,p.user_id,u.email,u.display_name,u.google_subject,u.profile_ciphertext,u.role,u.status user_status,u.created_at user_created_at,u.last_login_at user_last_login_at,p.kind,p.plan,p.amount_paise,p.currency,p.provider_payment_id,p.provider_subscription_id,p.status,p.created_at FROM classroom_desk_payments p JOIN classroom_desk_users u ON u.id=p.user_id ORDER BY p.created_at DESC LIMIT 100`);
    return result.rows.map((row) => ({ id: String(row.id), userId: String(row.user_id), email: this.userFromRow({ id: row.user_id, google_subject: row.google_subject, email: row.email, display_name: row.display_name, profile_ciphertext: row.profile_ciphertext, role: row.role, status: row.user_status, created_at: row.user_created_at, last_login_at: row.user_last_login_at }).email, kind: row.kind, plan: row.plan, amountPaise: Number(row.amount_paise), currency: row.currency, providerPaymentId: row.provider_payment_id, providerSubscriptionId: row.provider_subscription_id, status: row.status, createdAt: new Date(row.created_at) }));
  }

  async adminAudit():Promise<Array<{action:string;reason:string;created_at:Date}>> {
    const result=await this.db.query<{action:string;reason:string;created_at:Date}>(`SELECT action,reason,created_at FROM classroom_desk_admin_audit ORDER BY created_at DESC LIMIT 50`);
    return result.rows;
  }

  async adminReferrals(): Promise<AdminReferral[]> {
    const result = await this.db.query<{ id: string; referrer_user_id: string; referred_user_id: string; referrer_email: string; referred_email: string; referrer_display_name: string; referred_display_name: string; referrer_google_subject: string; referred_google_subject: string; referrer_profile_ciphertext?: string | null; referred_profile_ciphertext?: string | null; referrer_role: SaaSUser["role"]; referred_role: SaaSUser["role"]; referrer_status: SaaSUser["status"]; referred_status: SaaSUser["status"]; referrer_created_at: Date; referred_created_at: Date; referrer_last_login_at: Date | null; referred_last_login_at: Date | null; code: string; qualified_at: Date | null; counted_at: Date | null; created_at: Date }>(`SELECT r.id,r.referrer_user_id,r.referred_user_id,referrer.email referrer_email,referred.email referred_email,referrer.display_name referrer_display_name,referred.display_name referred_display_name,referrer.google_subject referrer_google_subject,referred.google_subject referred_google_subject,referrer.profile_ciphertext referrer_profile_ciphertext,referred.profile_ciphertext referred_profile_ciphertext,referrer.role referrer_role,referred.role referred_role,referrer.status referrer_status,referred.status referred_status,referrer.created_at referrer_created_at,referred.created_at referred_created_at,referrer.last_login_at referrer_last_login_at,referred.last_login_at referred_last_login_at,r.code,r.qualified_at,r.counted_at,r.created_at FROM classroom_desk_referrals r JOIN classroom_desk_users referrer ON referrer.id=r.referrer_user_id JOIN classroom_desk_users referred ON referred.id=r.referred_user_id ORDER BY r.created_at DESC LIMIT 100`);
    return result.rows.map((row) => {
      const referrer = this.userFromRow({ id: row.referrer_user_id, google_subject: row.referrer_google_subject, email: row.referrer_email, display_name: row.referrer_display_name, profile_ciphertext: row.referrer_profile_ciphertext, role: row.referrer_role, status: row.referrer_status, created_at: row.referrer_created_at, last_login_at: row.referrer_last_login_at });
      const referred = this.userFromRow({ id: row.referred_user_id, google_subject: row.referred_google_subject, email: row.referred_email, display_name: row.referred_display_name, profile_ciphertext: row.referred_profile_ciphertext, role: row.referred_role, status: row.referred_status, created_at: row.referred_created_at, last_login_at: row.referred_last_login_at });
      return { id: String(row.id), referrerEmail: referrer.email, referredEmail: referred.email, code: row.code, qualifiedAt: row.qualified_at ? new Date(row.qualified_at) : null, countedAt: row.counted_at ? new Date(row.counted_at) : null, createdAt: new Date(row.created_at) };
    });
  }

  async adminUserHistory(userId: string): Promise<AdminUserHistory> {
    const [trial, subscriptions, grants, made, received] = await Promise.all([
      this.db.query<{ status: string; expires_at: Date | null }>(`SELECT status,expires_at FROM classroom_desk_trials WHERE user_id=$1`, [userId]),
      this.db.query<{ plan: string; status: string; paid_through: Date | null; provider_subscription_id: string | null }>(`SELECT plan,status,paid_through,provider_subscription_id FROM classroom_desk_subscriptions WHERE user_id=$1 ORDER BY created_at DESC`, [userId]),
      this.db.query<{ plan: string; source: string; expires_at: Date; revoked_at: Date | null }>(`SELECT plan,source,expires_at,revoked_at FROM classroom_desk_entitlement_grants WHERE user_id=$1 ORDER BY starts_at DESC`, [userId]),
      this.db.query<{ count: string }>(`SELECT count(*) FROM classroom_desk_referrals WHERE referrer_user_id=$1`, [userId]),
      this.db.query<{ count: string }>(`SELECT count(*) FROM classroom_desk_referrals WHERE referred_user_id=$1`, [userId]),
    ]);
    const trialRow = trial.rows[0];
    return { trialStatus: trialRow?.status ?? "not_recorded", trialExpiresAt: trialRow?.expires_at ? new Date(trialRow.expires_at) : null, subscriptions: subscriptions.rows.map((row) => ({ plan: row.plan, status: row.status, paidThrough: row.paid_through ? new Date(row.paid_through) : null, providerSubscriptionId: row.provider_subscription_id })), grants: grants.rows.map((row) => ({ plan: row.plan, source: row.source, expiresAt: new Date(row.expires_at), revokedAt: row.revoked_at ? new Date(row.revoked_at) : null })), referralsMade: Number(made.rows[0]?.count ?? 0), referralsReceived: Number(received.rows[0]?.count ?? 0) };
  }

  async adminGrantAccess(actorId: string, targetId: string, plan: "student" | "teacher", durationMs: number, reason: string, now = new Date()): Promise<string> {
    if (!reason.trim() || durationMs <= 0 || durationMs > 366 * 24 * 60 * 60 * 1000) throw new Error("invalid_access_grant");
    const actor = await this.getUser(actorId); if (!actor) throw new Error("admin_not_found"); assertCanPerform(actor, "grant_access");
    const id = randomUUID(); const expires = new Date(now.getTime() + durationMs);
    if (this.db.batch) {
      await this.db.batch([
        { sql: `INSERT INTO classroom_desk_entitlement_grants (id,user_id,plan,source,starts_at,expires_at,reason) VALUES ($1,$2,$3,'manual',$4,$5,$6)`, values: [id, targetId, plan, now, expires, reason.trim()] },
        { sql: `INSERT INTO classroom_desk_admin_audit (actor_user_id,target_user_id,action,reason,previous_state,new_state) VALUES ($1,$2,$3,$4,$5,$6)`, values: [actorId, targetId, "grant_access", reason.trim(), "{}", JSON.stringify({ grantId: id, plan, expiresAt: expires.toISOString() })] },
      ]);
      return id;
    }
    await this.db.transaction(async (tx) => {
      await tx.query(`INSERT INTO classroom_desk_entitlement_grants (id,user_id,plan,source,starts_at,expires_at,reason) VALUES ($1,$2,$3,'manual',$4,$5,$6)`, [id, targetId, plan, now, expires, reason.trim()]);
      await tx.query(`INSERT INTO classroom_desk_admin_audit (actor_user_id,target_user_id,action,reason,previous_state,new_state) VALUES ($1,$2,$3,$4,$5,$6)`, [actorId, targetId, "grant_access", reason.trim(), JSON.stringify({}), JSON.stringify({ grantId: id, plan, expiresAt: expires.toISOString() })]);
    });
    return id;
  }

  async adminExtendAccess(actorId: string, grantId: string, durationMs: number, reason: string, now = new Date()): Promise<void> {
    if (!reason.trim() || durationMs <= 0 || durationMs > 366 * 24 * 60 * 60 * 1000) throw new Error("invalid_access_extension");
    const actor = await this.getUser(actorId); if (!actor) throw new Error("admin_not_found"); assertCanPerform(actor, "extend_access");
    if (this.db.batch) {
      const current = await this.db.query<{ user_id: string; starts_at: Date; expires_at: Date; revoked_at: Date | null }>(`SELECT user_id,starts_at,expires_at,revoked_at FROM classroom_desk_entitlement_grants WHERE id=$1 AND source IN ('manual','complimentary')`, [grantId]);
      const grant = current.rows[0]; if (!grant) throw new Error("grant_not_found");
      if (grant.revoked_at) throw new Error("grant_already_revoked");
      const previousExpires = new Date(grant.expires_at); const nextExpires = new Date(Math.max(previousExpires.getTime(), now.getTime()) + durationMs); const operationId = randomUUID();
      const committed = await this.db.batch([
        { sql: `UPDATE classroom_desk_entitlement_grants SET expires_at=$2,last_operation_id=$3 WHERE id=$1 AND source IN ('manual','complimentary') AND expires_at=$4 AND revoked_at IS NULL RETURNING id`, values: [grantId, nextExpires, operationId, previousExpires] },
        { sql: `INSERT INTO classroom_desk_admin_audit (actor_user_id,target_user_id,action,reason,previous_state,new_state,created_at) SELECT $1,$2,'extend_access',$3,$4,$5,$6 WHERE EXISTS (SELECT 1 FROM classroom_desk_entitlement_grants WHERE id=$7 AND last_operation_id=$8 AND expires_at=$9 AND revoked_at IS NULL)`, values: [actorId, grant.user_id, reason.trim(), JSON.stringify({ grantId, expiresAt: previousExpires.toISOString() }), JSON.stringify({ grantId, expiresAt: nextExpires.toISOString() }), now, grantId, operationId, nextExpires] },
      ]);
      if (committed[0]?.rows.length !== 1) throw new Error("grant_changed_concurrently");
      return;
    }
    await this.db.transaction(async (tx) => {
      const current = await tx.query<{ user_id: string; starts_at: Date; expires_at: Date; revoked_at: Date | null }>(`SELECT user_id,starts_at,expires_at,revoked_at FROM classroom_desk_entitlement_grants WHERE id=$1 AND source IN ('manual','complimentary') FOR UPDATE`, [grantId]);
      const grant = current.rows[0]; if (!grant) throw new Error("grant_not_found");
      if (grant.revoked_at) throw new Error("grant_already_revoked");
      const previousExpires = new Date(grant.expires_at); const nextExpires = new Date(Math.max(previousExpires.getTime(), now.getTime()) + durationMs);
      await tx.query(`UPDATE classroom_desk_entitlement_grants SET expires_at=$2 WHERE id=$1`, [grantId, nextExpires]);
      await tx.query(`INSERT INTO classroom_desk_admin_audit (actor_user_id,target_user_id,action,reason,previous_state,new_state,created_at) VALUES ($1,$2,'extend_access',$3,$4,$5,$6)`, [actorId, grant.user_id, reason.trim(), JSON.stringify({ grantId, expiresAt: previousExpires.toISOString() }), JSON.stringify({ grantId, expiresAt: nextExpires.toISOString() }), now]);
    });
  }

  async adminRevokeAccess(actorId: string, grantId: string, reason: string, now = new Date()): Promise<void> {
    if (!reason.trim()) throw new Error("audit_reason_required");
    const actor = await this.getUser(actorId); if (!actor) throw new Error("admin_not_found"); assertCanPerform(actor, "revoke_access");
    if (this.db.batch) {
      const current = await this.db.query<{ user_id: string; expires_at: Date; revoked_at: Date | null }>(`SELECT user_id,expires_at,revoked_at FROM classroom_desk_entitlement_grants WHERE id=$1 AND source IN ('manual','complimentary')`, [grantId]);
      const grant = current.rows[0]; if (!grant) throw new Error("grant_not_found");
      if (grant.revoked_at) throw new Error("grant_already_revoked");
      const operationId = randomUUID();
      const committed = await this.db.batch([
        { sql: `UPDATE classroom_desk_entitlement_grants SET revoked_at=$2,last_operation_id=$3 WHERE id=$1 AND source IN ('manual','complimentary') AND revoked_at IS NULL RETURNING id`, values: [grantId, now, operationId] },
        { sql: `INSERT INTO classroom_desk_admin_audit (actor_user_id,target_user_id,action,reason,previous_state,new_state,created_at) SELECT $1,$2,'revoke_access',$3,$4,$5,$6 WHERE EXISTS (SELECT 1 FROM classroom_desk_entitlement_grants WHERE id=$7 AND last_operation_id=$8 AND revoked_at=$6)`, values: [actorId, grant.user_id, reason.trim(), JSON.stringify({ grantId, expiresAt: new Date(grant.expires_at).toISOString(), revokedAt: null }), JSON.stringify({ grantId, revokedAt: now.toISOString() }), now, grantId, operationId] },
      ]);
      if (committed[0]?.rows.length !== 1) throw new Error("grant_changed_concurrently");
      return;
    }
    await this.db.transaction(async (tx) => {
      const current = await tx.query<{ user_id: string; expires_at: Date; revoked_at: Date | null }>(`SELECT user_id,expires_at,revoked_at FROM classroom_desk_entitlement_grants WHERE id=$1 AND source IN ('manual','complimentary') FOR UPDATE`, [grantId]);
      const grant = current.rows[0]; if (!grant) throw new Error("grant_not_found");
      if (grant.revoked_at) throw new Error("grant_already_revoked");
      await tx.query(`UPDATE classroom_desk_entitlement_grants SET revoked_at=$2 WHERE id=$1`, [grantId, now]);
      await tx.query(`INSERT INTO classroom_desk_admin_audit (actor_user_id,target_user_id,action,reason,previous_state,new_state,created_at) VALUES ($1,$2,'revoke_access',$3,$4,$5,$6)`, [actorId, grant.user_id, reason.trim(), JSON.stringify({ grantId, expiresAt: new Date(grant.expires_at).toISOString(), revokedAt: null }), JSON.stringify({ grantId, revokedAt: now.toISOString() }), now]);
    });
  }

  async adminChangeRole(actorId: string, targetId: string, role: SaaSUser["role"], reason: string, now = new Date()): Promise<void> {
    if (!reason.trim()) throw new Error("audit_reason_required");
    const actor = await this.getUser(actorId); if (!actor) throw new Error("admin_not_found"); validateRoleChange(actor, role);
    const target = await this.getUser(targetId); if (!target) throw new Error("target_not_found");
    if (this.db.batch) {
      await this.db.batch([
        { sql: `UPDATE classroom_desk_users SET role=$2 WHERE id=$1`, values: [targetId, role] },
        { sql: `INSERT INTO classroom_desk_admin_audit (actor_user_id,target_user_id,action,reason,previous_state,new_state,created_at) VALUES ($1,$2,'change_role',$3,$4,$5,$6)`, values: [actorId, targetId, reason.trim(), JSON.stringify({ role: target.role }), JSON.stringify({ role }), now] },
      ]);
      return;
    }
    await this.db.transaction(async (tx) => {
      await tx.query(`UPDATE classroom_desk_users SET role=$2 WHERE id=$1`, [targetId, role]);
      await tx.query(`INSERT INTO classroom_desk_admin_audit (actor_user_id,target_user_id,action,reason,previous_state,new_state,created_at) VALUES ($1,$2,'change_role',$3,$4,$5,$6)`, [actorId, targetId, reason.trim(), JSON.stringify({ role: target.role }), JSON.stringify({ role }), now]);
    });
  }

  async adminSetStatus(actorId: string, targetId: string, status: "active" | "suspended", reason: string, now = new Date()): Promise<void> {
    if (!reason.trim()) throw new Error("audit_reason_required");
    const actor = await this.getUser(actorId); if (!actor) throw new Error("admin_not_found");
    assertCanPerform(actor, status === "suspended" ? "suspend_user" : "restore_user");
    if (actorId === targetId && status === "suspended") throw new Error("cannot_suspend_self");
    const target = await this.getUser(targetId); if (!target) throw new Error("target_not_found");
    if (this.db.batch) {
      await this.db.batch([
        { sql: `UPDATE classroom_desk_users SET status=$2 WHERE id=$1`, values: [targetId, status] },
        { sql: `INSERT INTO classroom_desk_admin_audit (actor_user_id,target_user_id,action,reason,previous_state,new_state,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`, values: [actorId, targetId, status === "suspended" ? "suspend_user" : "restore_user", reason.trim(), JSON.stringify({ status: target.status }), JSON.stringify({ status }), now] },
      ]);
      return;
    }
    await this.db.transaction(async (tx) => {
      await tx.query(`UPDATE classroom_desk_users SET status=$2 WHERE id=$1`, [targetId, status]);
      await tx.query(`INSERT INTO classroom_desk_admin_audit (actor_user_id,target_user_id,action,reason,previous_state,new_state,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [actorId, targetId, status === "suspended" ? "suspend_user" : "restore_user", reason.trim(), JSON.stringify({ status: target.status }), JSON.stringify({ status }), now]);
    });
  }
}

function dateOrNull(value: Date | string | null): Date | null { return value ? new Date(value) : null; }
