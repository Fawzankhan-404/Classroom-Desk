import type { SqlConnection, SqlDatabase } from "../public/postgres.js";
import type { DashboardExperience, SaaSUser } from "./types.js";
import { WebsiteSessionStore } from "./sessions.js";
import type { WebsiteIdentityStore } from "./website-auth.js";
import { resolveEntitlement } from "./entitlements.js";
import type { EffectiveEntitlement, EntitlementGrant, SubscriptionRecord, TrialRecord } from "./types.js";
import type { AdminAuditEvent, AdminMetrics, AdminAction, AdminPayment, AdminReferral, AdminSubscriptionCreationReservation, AdminUserHistory } from "./admin.js";
import { assertCanPerform, validateRoleChange } from "./admin.js";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { BillingEvent } from "./billing-events.js";
import { ReferralService } from "./referral-service.js";
import { AccountLinkService } from "./linking.js";
import { isTrialPurchaseOpen, planPricePaise } from "./campaign.js";
import { SaaSProfileCipher, type PrivateSaaSProfile } from "./privacy.js";

export interface LegacyRecoveryOwnershipProofVerifier {
  /** Must independently verify account ownership and bind the approved stable subject. */
  verify(input: { accountId: string; googleSubject: string; proof: string }): Promise<{
    verifiedAccountId: string;
    verifiedGoogleSubject: string;
    reviewerIndependent: true;
    verifiedBy: string;
    caseReference: string;
  } | undefined>;
}

export type LegacyRecoveryRequestInput = {
  accountId: string;
  identity: PrivateSaaSProfile;
  proof: string;
  expiresAt: Date;
};

export const LEGACY_RECOVERY_EVIDENCE_TYPES = [
  "preexisting_support_record", "billing_provider_record", "account_specific_recovery_material", "other_independent_record",
] as const;
export type LegacyRecoveryEvidenceType = typeof LEGACY_RECOVERY_EVIDENCE_TYPES[number];
export type LegacyRecoveryIntake = {
  id: string; accountId: string; googleSubjectFingerprint: string; expectedCiphertextFingerprint: string;
  claimEvidenceType: LegacyRecoveryEvidenceType; claimEvidenceReference: string; createdAt: Date; expiresAt: Date;
};
export type LegacyRecoveryApprovalInput = {
  requestId: string; reviewerId: string; evidenceType: LegacyRecoveryEvidenceType; evidenceReference: string;
  confirmedIndependentEvidence: boolean; now?: Date;
};
const RECOVERY_SESSION_TTL_MS = 30 * 60 * 1000;
const RECOVERY_INTAKE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const RECOVERY_APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

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
function databaseErrorDetails(error: unknown): { code: string; message: string } {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 3 && current; depth += 1) {
    if (typeof current === "string") { parts.push(current); break; }
    if (typeof current !== "object") break;
    const value = current as { code?: unknown; message?: unknown; cause?: unknown };
    if (typeof value.code === "string") parts.push(value.code);
    if (typeof value.message === "string") parts.push(value.message);
    current = value.cause;
  }
  return { code: parts.find(part => /^[0-9A-Z]{5}$/.test(part)) ?? "", message: parts.join(" ") };
}
function isMissingSchemaField(error: unknown, field: string): boolean {
  const { code, message } = databaseErrorDetails(error);
  const lower = message.toLowerCase();
  if (!lower.includes(field.toLowerCase())) return false;
  if (field === "classroom_desk_oauth_accounts") {
    return code === "42P01" || lower.includes("no such table") || (lower.includes("relation") && lower.includes("does not exist"));
  }
  if (field === "dashboard_preference") {
    return code === "42703" || lower.includes("no such column") || (lower.includes("column") && lower.includes("does not exist"));
  }
  return false;
}

export class SaaSStore implements WebsiteIdentityStore {
  readonly sessions: WebsiteSessionStore;
  readonly referrals: ReferralService;
  readonly linking: AccountLinkService;
  private readonly profileCipher?: SaaSProfileCipher;
  private profileCompatibilityCheck?: Promise<number>;
  constructor(readonly db: SqlDatabase, private readonly options: { referralRewardsEnabled?: boolean; profileEncryptionKeyBase64?: string; requireProfileEncryption?: boolean; legacyRecoveryOwnershipVerifier?: LegacyRecoveryOwnershipProofVerifier } = {}) {
    this.sessions = new WebsiteSessionStore(db); this.referrals = new ReferralService(db); this.linking = new AccountLinkService(db);
    if (options.profileEncryptionKeyBase64) this.profileCipher = new SaaSProfileCipher(options.profileEncryptionKeyBase64);
    if (options.requireProfileEncryption && !this.profileCipher) throw new Error("profile_encryption_configuration_unavailable");
  }

  private profileFromRow(row: { google_subject: string; email: string; display_name: string; profile_ciphertext?: string | null }): PrivateSaaSProfile | undefined {
    if (row.profile_ciphertext) {
      if (!this.profileCipher) throw new Error("stored_profile_unavailable");
      return this.profileCipher.open(row.profile_ciphertext);
    }
    if (this.options.requireProfileEncryption) return undefined;
    return { googleSubject: row.google_subject, email: row.email, displayName: row.display_name };
  }

  private userFromRow(row: { id: string; google_subject: string; email: string; display_name: string; profile_ciphertext?: string | null; role: SaaSUser["role"]; status: SaaSUser["status"]; created_at: Date; last_login_at: Date | null }): SaaSUser {
    const profile = this.profileFromRow(row);
    if (!profile) throw new Error("stored_profile_unavailable");
    return { id: String(row.id), googleSubject: profile.googleSubject, email: profile.email, displayName: profile.displayName, role: row.role, status: row.status, createdAt: new Date(row.created_at), lastLoginAt: row.last_login_at ? new Date(row.last_login_at) : null };
  }

  private adminUserFromRow(row: { id: string; google_subject: string; email: string; display_name: string; profile_ciphertext?: string | null; role: SaaSUser["role"]; status: SaaSUser["status"]; created_at: Date; last_login_at: Date | null }): SaaSUser {
    const profile = this.profileFromRow(row);
    return { id: String(row.id), googleSubject: profile?.googleSubject ?? "", email: profile?.email ?? "Profile unavailable", displayName: profile?.displayName ?? "Profile unavailable", role: row.role, status: row.status, createdAt: new Date(row.created_at), lastLoginAt: row.last_login_at ? new Date(row.last_login_at) : null };
  }

  async verifyProfileStorageCompatibility(maxRows = 10_000): Promise<number> {
    if (!this.profileCipher) throw new Error("profile_encryption_configuration_unavailable");
    if (!this.profileCompatibilityCheck) this.profileCompatibilityCheck = (async () => {
      const result = await this.db.query<{ google_subject: string; email: string; display_name: string; profile_ciphertext: string; google_subject_hash: string | null; email_hash: string | null; display_name_hash: string | null }>(
        `SELECT google_subject,email,display_name,profile_ciphertext,google_subject_hash,email_hash,display_name_hash FROM classroom_desk_users WHERE profile_ciphertext IS NOT NULL LIMIT $1`, [maxRows + 1]);
      if (result.rows.length > maxRows) throw new Error("profile_storage_validation_limit");
      const equalHash = (expected: string, actual: string | null) => {
        if (!actual || !/^[a-f0-9]{64}$/i.test(actual)) return false;
        return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(actual, "hex"));
      };
      for (const row of result.rows) {
        const profile = this.profileCipher!.open(row.profile_ciphertext);
        const subject = this.profileCipher!.digest(profile.googleSubject);
        const email = this.profileCipher!.digest(profile.email.toLowerCase());
        const display = this.profileCipher!.digest(profile.displayName);
        const markerMatches = (actual: string, plain: string, hash: string) => actual === plain || actual === `enc:${hash}`;
        if (!equalHash(subject, row.google_subject_hash) || !equalHash(email, row.email_hash) || !equalHash(display, row.display_name_hash)
          || !markerMatches(row.google_subject, profile.googleSubject, subject)
          || !markerMatches(row.email, profile.email, email)
          || !markerMatches(row.display_name, profile.displayName, display)) throw new Error("profile_storage_compatibility_failed");
      }
      return result.rows.length;
    })();
    try { return await this.profileCompatibilityCheck; }
    catch (error) { this.profileCompatibilityCheck = undefined; throw error; }
  }

  private async recoveryBatch(statements: Array<{ sql: string; values?: unknown[] }>) {
    if (this.db.batch) return this.db.batch(statements);
    return this.db.transaction(async tx => {
      const results = [];
      for (const statement of statements) results.push(await tx.query(statement.sql, statement.values));
      return results;
    });
  }

  private recoverySubjectHash(googleSubject: string): string {
    if (!this.profileCipher || !/^[A-Za-z0-9_-]{8,256}$/.test(googleSubject)) throw new Error("legacy_recovery_identity_invalid");
    return this.profileCipher.digest(googleSubject);
  }

  private validateRecoveryEvidence(type: string, reference: string): asserts type is LegacyRecoveryEvidenceType {
    if (!(LEGACY_RECOVERY_EVIDENCE_TYPES as readonly string[]).includes(type)
      || typeof reference !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/#-]{7,255}$/.test(reference)) {
      throw new Error("legacy_recovery_evidence_invalid");
    }
  }

  private async expireLegacyRecoveryItems(now: Date): Promise<void> {
    await this.recoveryBatch([
      { sql: `UPDATE classroom_desk_account_recovery_intakes SET status='expired'
        WHERE status='submitted' AND expires_at<=$1`, values: [now] },
      { sql: `UPDATE classroom_desk_account_recovery_requests SET status='expired'
        WHERE status='pending' AND expires_at<=$1`, values: [now] },
      { sql: `UPDATE classroom_desk_users SET profile_recovery_status='ready'
        WHERE profile_recovery_status='recovery_pending' AND NOT EXISTS (
          SELECT 1 FROM classroom_desk_account_recovery_requests r
          WHERE r.account_id=classroom_desk_users.id AND r.status='pending' AND r.expires_at>$1
        )`, values: [now] },
      { sql: `DELETE FROM classroom_desk_recovery_access_sessions WHERE expires_at<=$1`, values: [now] },
    ]);
  }

  /** Recovery-only session minted after a fresh, verified Google OIDC login. */
  async createLegacyRecoveryAccessSession(googleSubject: string, now = new Date()): Promise<{ token: string; expiresAt: Date }> {
    if (!this.profileCipher || !this.options.requireProfileEncryption) throw new Error("profile_encryption_configuration_unavailable");
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(now.getTime() + RECOVERY_SESSION_TTL_MS);
    await this.db.query(`INSERT INTO classroom_desk_recovery_access_sessions (token_hash,google_subject_hash,google_subject_ciphertext,expires_at,created_at)
      VALUES ($1,$2,$3,$4,$5)`, [createHash("sha256").update(token, "utf8").digest("hex"), this.recoverySubjectHash(googleSubject), this.profileCipher.sealRecoveryEvidenceReference(googleSubject), expiresAt, now]);
    return { token, expiresAt };
  }

  async findLegacyRecoveryAccessSession(token: string, now = new Date()): Promise<{ googleSubjectHash: string; googleSubject: string; expiresAt: Date } | undefined> {
    if (!this.profileCipher || !this.options.requireProfileEncryption || !/^[A-Za-z0-9_-]{40,}$/.test(token)) return undefined;
    const tokenHash = createHash("sha256").update(token, "utf8").digest("hex");
    const result = await this.db.query<{ google_subject_hash: string; google_subject_ciphertext: string; expires_at: Date | string }>(
      `SELECT google_subject_hash,google_subject_ciphertext,expires_at FROM classroom_desk_recovery_access_sessions WHERE token_hash=$1 AND expires_at>$2`, [tokenHash, now]);
    const row = result.rows[0];
    return row ? { googleSubjectHash: row.google_subject_hash, googleSubject: this.profileCipher!.openRecoveryEvidenceReference(row.google_subject_ciphertext), expiresAt: new Date(row.expires_at) } : undefined;
  }

  async revokeLegacyRecoveryAccessSession(token: string): Promise<void> {
    if (!/^[A-Za-z0-9_-]{40,}$/.test(token)) return;
    await this.db.query(`DELETE FROM classroom_desk_recovery_access_sessions WHERE token_hash=$1`, [createHash("sha256").update(token, "utf8").digest("hex")]);
  }

  /** Public request intake. It records no Google email and never changes the legacy account. */
  async submitLegacyRecoveryIntake(input: { sessionToken: string; accountId: string; evidenceType: string; evidenceReference: string; now?: Date }): Promise<{ requestId: string; expiresAt: Date }> {
    if (!this.profileCipher || !this.options.requireProfileEncryption) throw new Error("profile_encryption_configuration_unavailable");
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.accountId)) throw new Error("legacy_recovery_request_invalid");
    this.validateRecoveryEvidence(input.evidenceType, input.evidenceReference);
    const now = input.now ?? new Date();
    const session = await this.findLegacyRecoveryAccessSession(input.sessionToken, now);
    if (!session) throw new Error("legacy_recovery_session_required");
    await this.expireLegacyRecoveryItems(now);
    const account = (await this.db.query<{ id: string; status: string; profile_ciphertext: string | null; profile_recovery_status: string }>(
      `SELECT id,status,profile_ciphertext,profile_recovery_status FROM classroom_desk_users WHERE id=$1 LIMIT 1`, [input.accountId])).rows[0];
    if (!account || account.status !== "active" || account.profile_recovery_status !== "ready" || !account.profile_ciphertext) throw new Error("legacy_recovery_account_unavailable");
    try { this.profileCipher.open(account.profile_ciphertext); throw new Error("legacy_recovery_not_required"); }
    catch (error) {
      if (error instanceof Error && error.message === "legacy_recovery_not_required") throw error;
      if (!(error instanceof Error) || error.message !== "stored_profile_unavailable") throw new Error("legacy_recovery_profile_invalid");
    }
    const conflict = await this.db.query<{ id: string }>(`SELECT id FROM classroom_desk_users
      WHERE id<>$1 AND (google_subject_hash=$2 OR google_subject=$3) LIMIT 2`, [input.accountId, session.googleSubjectHash, session.googleSubject]);
    if (conflict.rows.length) throw new Error("legacy_recovery_identity_conflict");
    const existing = await this.db.query<{ id: string }>(`SELECT id FROM classroom_desk_account_recovery_requests
      WHERE status='pending' AND expires_at>$3 AND (account_id=$1 OR google_subject_hash=$2) LIMIT 1`, [input.accountId, session.googleSubjectHash, now]);
    if (existing.rows.length) throw new Error("legacy_recovery_request_exists");
    const requestId = randomUUID();
    const expiresAt = new Date(now.getTime() + RECOVERY_INTAKE_TTL_MS);
    const ciphertextHash = createHash("sha256").update(account.profile_ciphertext, "utf8").digest("hex");
    const referenceHash = this.profileCipher.digestRecoveryEvidenceReference(input.evidenceReference);
    const referenceCiphertext = this.profileCipher.sealRecoveryEvidenceReference(input.evidenceReference);
    const inserted = await this.db.query<{ id: string }>(`INSERT INTO classroom_desk_account_recovery_intakes
      (id,account_id,google_subject_hash,google_subject_ciphertext,expected_legacy_ciphertext_hash,claim_evidence_type,claim_evidence_reference_ciphertext,claim_evidence_reference_hash,status,expires_at,created_at)
      SELECT $1,$2,$3,$4,$5,$6,$7,$8,'submitted',$9,$10
      WHERE EXISTS (SELECT 1 FROM classroom_desk_users WHERE id=$2 AND status='active' AND profile_recovery_status='ready' AND profile_ciphertext=$11)
        AND NOT EXISTS (SELECT 1 FROM classroom_desk_account_recovery_intakes WHERE status='submitted' AND expires_at>$10 AND (account_id=$2 OR google_subject_hash=$3))
        AND NOT EXISTS (SELECT 1 FROM classroom_desk_account_recovery_requests WHERE status='pending' AND expires_at>$10 AND (account_id=$2 OR google_subject_hash=$3))
      RETURNING id`, [requestId, input.accountId, session.googleSubjectHash, this.profileCipher.sealRecoveryEvidenceReference(session.googleSubject), ciphertextHash, input.evidenceType, referenceCiphertext, referenceHash, expiresAt, now, account.profile_ciphertext]);
    if (inserted.rows.length !== 1) throw new Error("legacy_recovery_request_not_created");
    return { requestId, expiresAt };
  }

  async listOwnLegacyRecoveryIntakes(sessionToken: string, now = new Date()): Promise<Array<{ id: string; status: string; expiresAt: Date; createdAt: Date }>> {
    const session = await this.findLegacyRecoveryAccessSession(sessionToken, now);
    if (!session) throw new Error("legacy_recovery_session_required");
    const result = await this.db.query<{ id: string; status: string; expires_at: Date | string; created_at: Date | string }>(
      `SELECT id,status,expires_at,created_at FROM classroom_desk_account_recovery_intakes WHERE google_subject_hash=$1 ORDER BY created_at DESC LIMIT 20`, [session.googleSubjectHash]);
    return result.rows.map(row => ({ id: row.id, status: row.status, expiresAt: new Date(row.expires_at), createdAt: new Date(row.created_at) }));
  }

  /** Role lookup deliberately avoids profile decryption so an authorized SUPER_ADMIN can review recovery. */
  async getRecoveryAdminActor(userId: string): Promise<{ id: string; role: "SUPER_ADMIN" } | undefined> {
    const result = await this.db.query<{ id: string; role: string; status: string }>(`SELECT id,role,status FROM classroom_desk_users WHERE id=$1 LIMIT 1`, [userId]);
    const row = result.rows[0];
    return row?.status === "active" && row.role === "SUPER_ADMIN" ? { id: row.id, role: "SUPER_ADMIN" } : undefined;
  }

  async listLegacyRecoveryIntakesForAdmin(actorId: string, now = new Date()): Promise<LegacyRecoveryIntake[]> {
    if (!(await this.getRecoveryAdminActor(actorId)) || !this.profileCipher) throw new Error("super_admin_required");
    await this.expireLegacyRecoveryItems(now);
    const result = await this.db.query<{
      id: string; account_id: string; google_subject_hash: string; expected_legacy_ciphertext_hash: string;
      claim_evidence_type: LegacyRecoveryEvidenceType; claim_evidence_reference_ciphertext: string; created_at: Date | string; expires_at: Date | string;
    }>(`SELECT id,account_id,google_subject_hash,expected_legacy_ciphertext_hash,claim_evidence_type,claim_evidence_reference_ciphertext,created_at,expires_at
      FROM classroom_desk_account_recovery_intakes WHERE status='submitted' AND expires_at>$1 ORDER BY created_at ASC LIMIT 50`, [now]);
    return result.rows.map(row => ({
      id: row.id, accountId: row.account_id, googleSubjectFingerprint: row.google_subject_hash.slice(0, 16),
      expectedCiphertextFingerprint: row.expected_legacy_ciphertext_hash.slice(0, 16), claimEvidenceType: row.claim_evidence_type,
      claimEvidenceReference: this.profileCipher!.openRecoveryEvidenceReference(row.claim_evidence_reference_ciphertext),
      createdAt: new Date(row.created_at), expiresAt: new Date(row.expires_at),
    }));
  }

  /** Owner attests to an independently checked source; the resulting approval is consumed by the existing OAuth callback. */
  async approveLegacyRecoveryIntake(input: LegacyRecoveryApprovalInput): Promise<{ recoveryRequestId: string; expiresAt: Date }> {
    if (!this.profileCipher || !this.options.requireProfileEncryption) throw new Error("profile_encryption_configuration_unavailable");
    if (!/^[0-9a-f-]{36}$/i.test(input.requestId) || !input.confirmedIndependentEvidence) throw new Error("legacy_recovery_review_invalid");
    this.validateRecoveryEvidence(input.evidenceType, input.evidenceReference);
    const now = input.now ?? new Date();
    if (!(await this.getRecoveryAdminActor(input.reviewerId))) throw new Error("super_admin_required");
    await this.expireLegacyRecoveryItems(now);
    const intake = (await this.db.query<{
      id: string; account_id: string; google_subject_hash: string; google_subject_ciphertext: string; expected_legacy_ciphertext_hash: string;
      status: string; expires_at: Date | string;
    }>(`SELECT id,account_id,google_subject_hash,google_subject_ciphertext,expected_legacy_ciphertext_hash,status,expires_at
      FROM classroom_desk_account_recovery_intakes WHERE id=$1 LIMIT 1`, [input.requestId])).rows[0];
    if (!intake || intake.status !== "submitted" || new Date(intake.expires_at) <= now) throw new Error("legacy_recovery_request_not_actionable");
    const account = (await this.db.query<{ status: string; profile_recovery_status: string; profile_ciphertext: string | null }>(
      `SELECT status,profile_recovery_status,profile_ciphertext FROM classroom_desk_users WHERE id=$1 LIMIT 1`, [intake.account_id])).rows[0];
    if (!account || account.status !== "active" || account.profile_recovery_status !== "ready" || !account.profile_ciphertext
      || createHash("sha256").update(account.profile_ciphertext, "utf8").digest("hex") !== intake.expected_legacy_ciphertext_hash) throw new Error("legacy_recovery_account_changed");
    try { this.profileCipher.open(account.profile_ciphertext); throw new Error("legacy_recovery_not_required"); }
    catch (error) {
      if (error instanceof Error && error.message === "legacy_recovery_not_required") throw error;
      if (!(error instanceof Error) || error.message !== "stored_profile_unavailable") throw new Error("legacy_recovery_profile_invalid");
    }
    const googleSubject = this.profileCipher.openRecoveryEvidenceReference(intake.google_subject_ciphertext);
    const duplicate = await this.db.query<{ id: string }>(`SELECT id FROM classroom_desk_users
      WHERE id<>$1 AND (google_subject_hash=$2 OR google_subject=$3) LIMIT 2`, [intake.account_id, intake.google_subject_hash, googleSubject]);
    if (duplicate.rows.length) throw new Error("legacy_recovery_identity_conflict");
    const recoveryRequestId = randomUUID();
    const expiresAt = new Date(now.getTime() + RECOVERY_APPROVAL_TTL_MS);
    const evidenceHash = this.profileCipher.digestRecoveryEvidenceReference(input.evidenceReference);
    const evidenceCiphertext = this.profileCipher.sealRecoveryEvidenceReference(input.evidenceReference);
    const baseValues = [intake.id, input.reviewerId, input.evidenceType, evidenceCiphertext, evidenceHash, now,
      recoveryRequestId, expiresAt, intake.account_id, intake.expected_legacy_ciphertext_hash, intake.google_subject_hash,
      account.profile_ciphertext, googleSubject, JSON.stringify({ intakeId: intake.id, status: "submitted" }),
      JSON.stringify({ recoveryRequestId, evidenceType: input.evidenceType, evidenceReferenceHash: evidenceHash })];
    const baseGuard = `EXISTS (SELECT 1 FROM classroom_desk_account_recovery_intakes i
      JOIN classroom_desk_users u ON u.id=i.account_id
      JOIN classroom_desk_users admin ON admin.id=$2
      WHERE i.id=$1 AND i.account_id=$9 AND i.google_subject_hash=$11 AND i.expected_legacy_ciphertext_hash=$10
        AND i.status='submitted' AND i.expires_at>$6 AND u.status='active' AND u.profile_recovery_status IN ('ready','recovery_pending')
        AND u.profile_ciphertext=$12 AND admin.status='active' AND admin.role='SUPER_ADMIN')
      AND NOT EXISTS (SELECT 1 FROM classroom_desk_account_recovery_intakes WHERE id=$1 AND status<>'submitted')
      AND NOT EXISTS (SELECT 1 FROM classroom_desk_account_recovery_requests WHERE status='pending' AND expires_at>$6 AND (account_id=$9 OR google_subject_hash=$11))
      AND NOT EXISTS (SELECT 1 FROM classroom_desk_users WHERE id<>$9 AND (google_subject_hash=$11 OR google_subject=$13))
      AND NOT EXISTS (SELECT 1 FROM classroom_desk_account_recovery_review_claims WHERE intake_id=$1)`;
    const statements = [
      { sql: `UPDATE classroom_desk_users SET profile_recovery_status='recovery_pending'
        WHERE id=$9 AND status='active' AND profile_recovery_status='ready' AND profile_ciphertext=$12 AND ${baseGuard} RETURNING id`, values: baseValues.slice(0, 13) },
      { sql: `INSERT INTO classroom_desk_account_recovery_requests
        (id,account_id,google_subject_hash,expected_legacy_ciphertext_hash,proof_method,proof_reference_hash,verified_by,status,expires_at,source_intake_id)
        SELECT $7,$9,$11,$10,'independent_manual_review',$5,$2,'pending',$8,$1
        WHERE ${baseGuard} AND EXISTS (SELECT 1 FROM classroom_desk_users WHERE id=$9 AND profile_recovery_status='recovery_pending')
        RETURNING id`, values: baseValues.slice(0, 13) },
      { sql: `UPDATE classroom_desk_account_recovery_intakes SET status='approved',reviewed_by=$2,reviewed_at=$6,
        review_evidence_type=$3,review_evidence_reference_ciphertext=$4,review_evidence_reference_hash=$5,recovery_request_id=$7
        WHERE id=$1 AND status='submitted' AND expires_at>$6
          AND EXISTS (SELECT 1 FROM classroom_desk_account_recovery_requests WHERE id=$7 AND source_intake_id=$1 AND status='pending')
        RETURNING id`, values: baseValues.slice(0, 7) },
      { sql: `INSERT INTO classroom_desk_admin_audit (actor_user_id,target_user_id,action,reason,previous_state,new_state,created_at)
        SELECT $2,$9,'approve_legacy_account_recovery','independent_evidence_verified',$14,$15,$6
        WHERE EXISTS (SELECT 1 FROM classroom_desk_account_recovery_intakes WHERE id=$1 AND status='approved' AND recovery_request_id=$7)`,
        values: baseValues },
      { sql: `INSERT INTO classroom_desk_account_recovery_review_claims (intake_id,recovery_request_id,reviewed_by,reviewed_at,decision)
        SELECT $1,$7,$2,$6,'approved' WHERE EXISTS (SELECT 1 FROM classroom_desk_account_recovery_intakes WHERE id=$1 AND status='approved' AND reviewed_by=$2 AND recovery_request_id=$7)
          AND EXISTS (SELECT 1 FROM classroom_desk_account_recovery_requests WHERE id=$7 AND account_id=$9 AND google_subject_hash=$11 AND status='pending' AND source_intake_id=$1)
        UNION ALL SELECT NULL,NULL,NULL,NULL,'approved' WHERE NOT (EXISTS (SELECT 1 FROM classroom_desk_account_recovery_intakes WHERE id=$1 AND status='approved' AND reviewed_by=$2 AND recovery_request_id=$7)
          AND EXISTS (SELECT 1 FROM classroom_desk_account_recovery_requests WHERE id=$7 AND account_id=$9 AND google_subject_hash=$11 AND status='pending' AND source_intake_id=$1))`, values: baseValues.slice(0, 11) },
    ];
    // SQLite/D1 rejects the deliberately-null sentinel row if any preceding step did not commit its guarded write.
    await this.recoveryBatch(statements);
    const claim = await this.db.query<{ intake_id: string }>(`SELECT intake_id FROM classroom_desk_account_recovery_review_claims WHERE intake_id=$1`, [intake.id]);
    if (claim.rows.length !== 1) throw new Error("legacy_recovery_review_not_committed");
    return { recoveryRequestId, expiresAt };
  }

  async rejectLegacyRecoveryIntake(input: { requestId: string; reviewerId: string; reason: string; now?: Date }): Promise<void> {
    if (!/^[0-9a-f-]{36}$/i.test(input.requestId) || !["insufficient_evidence", "account_mismatch", "identity_conflict", "other"].includes(input.reason)
      || !(await this.getRecoveryAdminActor(input.reviewerId))) throw new Error("super_admin_required");
    const now = input.now ?? new Date();
    await this.expireLegacyRecoveryItems(now);
    const claimValues = [input.requestId, input.reviewerId, now];
    const auditValues = [input.requestId, input.reviewerId, now, `recovery_rejected:${input.reason}`,
      JSON.stringify({ intakeId: input.requestId, status: "submitted" }),
      JSON.stringify({ status: "rejected", reason: input.reason })];
    try { await this.recoveryBatch([
      { sql: `UPDATE classroom_desk_account_recovery_intakes SET status='rejected',reviewed_by=$2,reviewed_at=$3,rejection_reason_code=$4
        WHERE id=$1 AND status='submitted' AND expires_at>$3 AND EXISTS (SELECT 1 FROM classroom_desk_users WHERE id=$2 AND status='active' AND role='SUPER_ADMIN')
          AND NOT EXISTS (SELECT 1 FROM classroom_desk_account_recovery_review_claims WHERE intake_id=$1) RETURNING account_id`,
        values: [input.requestId, input.reviewerId, now, input.reason] },
      { sql: `INSERT INTO classroom_desk_admin_audit (actor_user_id,target_user_id,action,reason,previous_state,new_state,created_at)
        SELECT $2,account_id,'reject_legacy_account_recovery','recovery_rejected:'||$4,$5,$6,$3 FROM classroom_desk_account_recovery_intakes
        WHERE id=$1 AND status='rejected' AND reviewed_by=$2 AND reviewed_at=$3`, values: auditValues },
      { sql: `INSERT INTO classroom_desk_account_recovery_review_claims (intake_id,recovery_request_id,reviewed_by,reviewed_at,decision)
        SELECT $1,NULL,$2,$3,'rejected' FROM classroom_desk_account_recovery_intakes
        WHERE id=$1 AND status='rejected' AND reviewed_by=$2 AND reviewed_at=$3
          AND NOT EXISTS (SELECT 1 FROM classroom_desk_account_recovery_review_claims WHERE intake_id=$1)
        UNION ALL SELECT NULL,NULL,NULL,NULL,'rejected' WHERE NOT EXISTS (
          SELECT 1 FROM classroom_desk_account_recovery_intakes WHERE id=$1 AND status='rejected' AND reviewed_by=$2 AND reviewed_at=$3
            AND NOT EXISTS (SELECT 1 FROM classroom_desk_account_recovery_review_claims WHERE intake_id=$1))`, values: claimValues },
    ]); } catch { throw new Error("legacy_recovery_request_not_actionable"); }
    const claim = await this.db.query<{ intake_id: string }>(`SELECT intake_id FROM classroom_desk_account_recovery_review_claims WHERE intake_id=$1 AND decision='rejected' AND reviewed_by=$2 AND reviewed_at=$3`, [input.requestId, input.reviewerId, now]);
    if (claim.rows.length !== 1) throw new Error("legacy_recovery_request_not_actionable");
  }

  /**
   * Create a recovery-pending request only after an independent verifier
   * confirms ownership of this account and the verified Google subject.
   * This method is intentionally not exposed as a public website route.
   */
  async requestLegacyAccountRecovery(input: LegacyRecoveryRequestInput): Promise<{ requestId: string; status: "recovery_pending" }> {
    if (!this.profileCipher || !this.options.requireProfileEncryption) throw new Error("profile_encryption_configuration_unavailable");
    const verifier = this.options.legacyRecoveryOwnershipVerifier;
    if (!verifier) throw new Error("legacy_recovery_verifier_unavailable");
    if (!/^[0-9a-f-]{36}$/i.test(input.accountId)
      || !/^[A-Za-z0-9_-]{8,256}$/.test(input.identity.googleSubject)
      || input.identity.email.length > 320
      || !/^[^\s@]+@[^\s@]+$/.test(input.identity.email)
      || input.identity.displayName.length > 256
      || !input.identity.displayName.trim()
      || typeof input.proof !== "string" || input.proof.length < 16 || input.proof.length > 4096
      || !Number.isFinite(input.expiresAt.getTime()) || input.expiresAt.getTime() <= Date.now()
      || input.expiresAt.getTime() > Date.now() + 24 * 60 * 60 * 1000) throw new Error("legacy_recovery_request_invalid");
    const verified = await verifier.verify({ accountId: input.accountId, googleSubject: input.identity.googleSubject, proof: input.proof });
    if (!verified || verified.verifiedAccountId !== input.accountId
      || verified.verifiedGoogleSubject !== input.identity.googleSubject
      || verified.reviewerIndependent !== true
      || typeof verified.verifiedBy !== "string" || !verified.verifiedBy.trim()
      || typeof verified.caseReference !== "string" || !verified.caseReference.trim()) throw new Error("legacy_account_ownership_unverified");

    const row = (await this.db.query<{ id: string; status: string; profile_ciphertext: string | null; profile_recovery_status: string }>(
      `SELECT id,status,profile_ciphertext,profile_recovery_status FROM classroom_desk_users WHERE id=$1 LIMIT 1`, [input.accountId],
    )).rows[0];
    if (!row || row.status !== "active" || !row.profile_ciphertext) throw new Error("legacy_recovery_account_unavailable");
    try {
      this.profileCipher.open(row.profile_ciphertext);
      throw new Error("legacy_recovery_not_required");
    } catch (error) {
      if (error instanceof Error && error.message === "legacy_recovery_not_required") throw error;
      if (!(error instanceof Error) || error.message !== "stored_profile_unavailable") throw new Error("legacy_recovery_profile_invalid");
    }

    const subjectHash = this.profileCipher.digest(input.identity.googleSubject);
    const emailHash = this.profileCipher.digest(input.identity.email.toLowerCase());
    const displayNameHash = this.profileCipher.digest(input.identity.displayName);
    const duplicate = await this.db.query<{ id: string }>(
      `SELECT id FROM classroom_desk_users WHERE (google_subject_hash=$1 OR google_subject=$2) AND id<>$3 LIMIT 2`,
      [subjectHash, input.identity.googleSubject, input.accountId],
    );
    if (duplicate.rows.length) throw new Error("legacy_recovery_identity_conflict");
    const pending = await this.db.query<{ id: string }>(
      `SELECT id FROM classroom_desk_account_recovery_requests WHERE status='pending' AND (account_id=$1 OR google_subject_hash=$2) LIMIT 2`,
      [input.accountId, subjectHash],
    );
    if (pending.rows.length) throw new Error(pending.rows.length > 1 ? "legacy_recovery_ambiguous" : "legacy_recovery_request_exists");

    const requestId = randomUUID();
    const oldCiphertextHash = createHash("sha256").update(row.profile_ciphertext, "utf8").digest("hex");
    const proofReferenceHash = createHash("sha256").update(verified.caseReference, "utf8").digest("hex");
    const parameters = [requestId, input.accountId, subjectHash, oldCiphertextHash,
      proofReferenceHash, verified.verifiedBy, input.expiresAt, null, row.profile_ciphertext];
    const update = {
      sql: `UPDATE classroom_desk_users SET profile_recovery_status='recovery_pending'
        WHERE id=$2 AND status='active' AND profile_recovery_status IN ('ready','recovery_pending') AND profile_ciphertext=$9
        RETURNING id`,
      values: parameters,
    };
    const condition = `EXISTS (SELECT 1 FROM classroom_desk_users WHERE id=$2 AND status='active' AND profile_recovery_status='recovery_pending' AND profile_ciphertext=$9)
      AND NOT EXISTS (SELECT 1 FROM classroom_desk_account_recovery_requests WHERE status='pending' AND (account_id=$2 OR google_subject_hash=$3))`;
    const insert = {
      sql: `INSERT INTO classroom_desk_account_recovery_requests
        (id,account_id,google_subject_hash,expected_legacy_ciphertext_hash,proof_method,proof_reference_hash,verified_by,status,expires_at)
        SELECT $1,$2,$3,$4,'independent_manual_review',$5,$6,'pending',$7 WHERE ${condition}
        UNION ALL SELECT NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL WHERE NOT (${condition})`,
      values: parameters,
    };
    if (this.db.batch) {
      await this.db.batch([update, insert]);
    } else {
      await this.db.transaction(async tx => {
        const changed = await tx.query<{ id: string }>(update.sql, update.values);
        if (changed.rows.length !== 1) throw new Error("legacy_recovery_account_changed");
        const created = await tx.query<{ id: string }>(insert.sql, insert.values);
        if (created.rows.length !== 1) throw new Error("legacy_recovery_request_not_created");
      });
    }
    return { requestId, status: "recovery_pending" };
  }

  /**
   * Encrypt legacy identity fields that predate migration 0007. The identity
   * columns remain in place as keyed markers so old schema readers do not see
   * plaintext. Rows with partial markers or conflicting hashes fail closed.
   */
  async backfillLegacyProfiles(maxRows = 1_000, googleSubjectPrefix?: string): Promise<number> {
    if (!this.profileCipher) throw new Error("profile_encryption_configuration_unavailable");
    if (!Number.isInteger(maxRows) || maxRows < 1 || maxRows > 10_000) throw new Error("profile_backfill_limit_invalid");
    if (googleSubjectPrefix !== undefined && !/^[A-Za-z0-9.-]{1,64}$/.test(googleSubjectPrefix)) throw new Error("profile_backfill_prefix_invalid");

    const selectSql = `SELECT id,google_subject,email,display_name,profile_ciphertext,google_subject_hash,email_hash,display_name_hash
      FROM classroom_desk_users WHERE profile_ciphertext IS NULL${googleSubjectPrefix === undefined ? "" : " AND substr(google_subject,1,length($2))=$2"} LIMIT $1`;
    const selected = await this.db.query<{
      id: string; google_subject: string; email: string; display_name: string;
      profile_ciphertext: string | null; google_subject_hash: string | null;
      email_hash: string | null; display_name_hash: string | null;
    }>(selectSql, googleSubjectPrefix === undefined ? [maxRows + 1] : [maxRows + 1, googleSubjectPrefix]);
    if (selected.rows.length > maxRows) throw new Error("profile_backfill_limit_exceeded");

    let migrated = 0;
    for (const row of selected.rows) {
      const values = [row.google_subject, row.email, row.display_name];
      if (values.some(value => typeof value !== "string" || value.length === 0 || value.length > 4096 || value.startsWith("enc:"))) {
        throw new Error("legacy_profile_record_unreadable");
      }
      const profile: PrivateSaaSProfile = { googleSubject: row.google_subject, email: row.email, displayName: row.display_name };
      const subjectHash = this.profileCipher.digest(profile.googleSubject);
      const emailHash = this.profileCipher.digest(profile.email.toLowerCase());
      const displayHash = this.profileCipher.digest(profile.displayName);
      const hashes = [row.google_subject_hash, row.email_hash, row.display_name_hash];
      const expectedHashes = [subjectHash, emailHash, displayHash];
      if (hashes.some((value, index) => value !== null && value !== expectedHashes[index])) {
        throw new Error("legacy_profile_hash_conflict");
      }
      const conflict = await this.db.query<{ id: string }>(`SELECT id FROM classroom_desk_users
        WHERE id<>$1 AND google_subject_hash=$2 LIMIT 1`, [row.id, subjectHash]);
      if (conflict.rows.length) throw new Error("legacy_profile_subject_conflict");

      const ciphertext = this.profileCipher.seal(profile);
      const updated = await this.db.query<{
        id: string; google_subject: string; email: string; display_name: string; profile_ciphertext: string;
        role: SaaSUser["role"]; status: SaaSUser["status"]; created_at: Date; last_login_at: Date | null;
      }>(`UPDATE classroom_desk_users SET google_subject=$2,email=$3,display_name=$4,profile_ciphertext=$5,
        google_subject_hash=$6,email_hash=$7,display_name_hash=$8
        WHERE id=$1 AND profile_ciphertext IS NULL AND google_subject=$9 AND email=$10 AND display_name=$11
          AND (google_subject_hash IS NULL OR google_subject_hash=$6)
          AND (email_hash IS NULL OR email_hash=$7)
          AND (display_name_hash IS NULL OR display_name_hash=$8)
        RETURNING id,google_subject,email,display_name,profile_ciphertext,role,status,created_at,last_login_at`,
      [row.id, `enc:${subjectHash}`, `enc:${emailHash}`, `enc:${displayHash}`, ciphertext, subjectHash, emailHash, displayHash,
        profile.googleSubject, profile.email, profile.displayName]);

      let stored = updated.rows[0];
      if (!stored) {
        const current = await this.db.query<typeof updated.rows[number]>(`SELECT id,google_subject,email,display_name,profile_ciphertext,role,status,created_at,last_login_at
          FROM classroom_desk_users WHERE id=$1`, [row.id]);
        stored = current.rows[0];
        if (!stored?.profile_ciphertext) throw new Error("legacy_profile_backfill_conflict");
      } else {
        migrated++;
      }
      const reopened = this.userFromRow(stored);
      if (reopened.googleSubject !== profile.googleSubject || reopened.email !== profile.email || reopened.displayName !== profile.displayName) {
        throw new Error("legacy_profile_roundtrip_failed");
      }
    }

    this.profileCompatibilityCheck = undefined;
    await this.verifyProfileStorageCompatibility(maxRows);
    return migrated;
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
    let row: { id: string; google_subject: string; email: string; display_name: string; profile_ciphertext?: string | null; role: SaaSUser["role"]; status: SaaSUser["status"]; created_at: Date; last_login_at: Date | null } | undefined;
    if (this.profileCipher) {
      await this.verifyProfileStorageCompatibility();
      const subjectHash = this.profileCipher.digest(input.googleSubject);
      const emailHash = this.profileCipher.digest(input.email.toLowerCase());
      const displayHash = this.profileCipher.digest(input.displayName);
      const markers = [`enc:${subjectHash}`, `enc:${emailHash}`, `enc:${displayHash}`];
      const profile = this.profileCipher.seal(input);
      const existing = await this.db.query<{ id: string; google_subject_hash: string | null }>(`SELECT id,google_subject_hash FROM classroom_desk_users WHERE google_subject_hash=$1 OR google_subject=$2 LIMIT 2`, [subjectHash, input.googleSubject]);
      if (existing.rows.length > 1) throw new Error("google_subject_account_conflict");
      let saved;
      if (existing.rows[0]) {
        const existingSubjectHash = existing.rows[0].google_subject_hash;
        if (existingSubjectHash && existingSubjectHash.toLowerCase() !== subjectHash) throw new Error("google_subject_account_conflict");
        saved = await this.db.query(`UPDATE classroom_desk_users SET google_subject=$2,email=$3,display_name=$4,profile_ciphertext=$5,google_subject_hash=$6,email_hash=$7,display_name_hash=$8,last_login_at=$9 WHERE id=$1 RETURNING id,google_subject,email,display_name,profile_ciphertext,role,status,created_at,last_login_at`, [existing.rows[0].id, ...markers, profile, subjectHash, emailHash, displayHash, input.now]);
      } else {
        saved = await this.db.query(`INSERT INTO classroom_desk_users (google_subject,email,display_name,profile_ciphertext,google_subject_hash,email_hash,display_name_hash,last_login_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING RETURNING id,google_subject,email,display_name,profile_ciphertext,role,status,created_at,last_login_at`, [...markers, profile, subjectHash, emailHash, displayHash, input.now]);
        if (!saved.rows[0]) {
          const raced = await this.db.query<{ id: string; google_subject_hash: string | null }>(`SELECT id,google_subject_hash FROM classroom_desk_users WHERE google_subject_hash=$1 OR google_subject=$2 LIMIT 2`, [subjectHash, input.googleSubject]);
          if (raced.rows.length !== 1) throw new Error("google_subject_account_conflict");
          const racedSubjectHash = raced.rows[0]!.google_subject_hash;
          if (racedSubjectHash && racedSubjectHash.toLowerCase() !== subjectHash) throw new Error("google_subject_account_conflict");
          saved = await this.db.query(`UPDATE classroom_desk_users SET google_subject=$2,email=$3,display_name=$4,profile_ciphertext=$5,google_subject_hash=$6,email_hash=$7,display_name_hash=$8,last_login_at=$9 WHERE id=$1 RETURNING id,google_subject,email,display_name,profile_ciphertext,role,status,created_at,last_login_at`, [raced.rows[0]!.id, ...markers, profile, subjectHash, emailHash, displayHash, input.now]);
        }
      }
      row = saved.rows[0] as typeof row;
    } else {
      const result = await this.db.query(`INSERT INTO classroom_desk_users (google_subject,email,display_name,last_login_at) VALUES ($1,$2,$3,$4) ON CONFLICT (google_subject) DO UPDATE SET email=EXCLUDED.email, display_name=EXCLUDED.display_name, last_login_at=EXCLUDED.last_login_at RETURNING id,google_subject,email,display_name,role,status,created_at,last_login_at`, [input.googleSubject, input.email, input.displayName, input.now]);
      row = result.rows[0] as typeof row;
    }
    if (!row) throw new Error("Account could not be created.");
    await this.db.query(`INSERT INTO classroom_desk_trials (user_id,status) VALUES ($1,'eligible') ON CONFLICT (user_id) DO NOTHING`, [row.id]);
    return this.userFromRow(row);
  }

  async resolveGoogleIdentityBinding(input: { googleSubject: string; email: string; displayName: string; now: Date }): Promise<{ accountId: string; mcpUserId: string; recovery?: import("../public/store.js").GoogleAccountBinding["recovery"] }> {
    let user: SaaSUser;
    try {
      user = await this.upsertGoogleIdentity(input);
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "stored_profile_unavailable") throw error;
      return this.resolvePendingLegacyAccountRecovery(input);
    }
    if (user.status !== "active") throw new Error("account_unavailable");
    // Prefer the unified OAuth map, then retain legacy pairing identities.
    const linked = await this.getUnifiedMcpUserId(user.id) ?? await this.getLegacyMcpUserId(user.id);
    return { accountId: user.id, mcpUserId: linked ?? user.id };
  }

  private async resolvePendingLegacyAccountRecovery(input: { googleSubject: string; email: string; displayName: string }): Promise<{ accountId: string; mcpUserId: string; recovery: NonNullable<import("../public/store.js").GoogleAccountBinding["recovery"]> }> {
    if (!this.profileCipher) throw new Error("account_recovery_required");
    const subjectHash = this.profileCipher.digest(input.googleSubject);
    const requests = await this.db.query<{
      id: string; account_id: string; google_subject_hash: string; expected_legacy_ciphertext_hash: string;
      status: string; expires_at: Date | string; verified_by: string;
    }>(`SELECT id,account_id,google_subject_hash,expected_legacy_ciphertext_hash,status,expires_at,verified_by
      FROM classroom_desk_account_recovery_requests WHERE google_subject_hash=$1 AND status='pending' AND expires_at>$2 LIMIT 2`, [subjectHash, new Date()]);
    if (requests.rows.length !== 1) throw new Error(requests.rows.length > 1 ? "legacy_recovery_ambiguous" : "account_recovery_required");
    const request = requests.rows[0]!;
    const account = (await this.db.query<{
      id: string; status: string; profile_ciphertext: string | null; profile_recovery_status: string;
    }>(`SELECT id,status,profile_ciphertext,profile_recovery_status FROM classroom_desk_users WHERE id=$1 LIMIT 1`, [request.account_id])).rows[0];
    if (!account || account.status !== "active" || account.profile_recovery_status !== "recovery_pending" || !account.profile_ciphertext) throw new Error("legacy_recovery_account_changed");
    const expectedCiphertextHash = createHash("sha256").update(account.profile_ciphertext, "utf8").digest("hex");
    if (expectedCiphertextHash !== request.expected_legacy_ciphertext_hash) throw new Error("legacy_recovery_ciphertext_changed");
    if (request.google_subject_hash !== subjectHash) throw new Error("legacy_recovery_subject_mismatch");
    const duplicates = await this.db.query<{ id: string }>(`SELECT id FROM classroom_desk_users WHERE google_subject_hash=$1 OR google_subject=$2 LIMIT 3`, [subjectHash, input.googleSubject]);
    if (duplicates.rows.some(row => String(row.id) !== String(request.account_id))) throw new Error("legacy_recovery_identity_conflict");

    const legacy = await this.db.query<{ mcp_user_id: string }>(`SELECT mcp_user_id FROM classroom_desk_connections WHERE website_user_id=$1 LIMIT 2`, [request.account_id]);
    let unified: { mcp_user_id: string }[] = [];
    try {
      unified = (await this.db.query<{ mcp_user_id: string }>(`SELECT mcp_user_id FROM classroom_desk_oauth_accounts WHERE website_user_id=$1 LIMIT 2`, [request.account_id])).rows;
    } catch (error) {
      if (!isMissingSchemaField(error, "classroom_desk_oauth_accounts")) throw error;
    }
    if (legacy.rows.length > 1 || unified.length > 1) throw new Error("legacy_recovery_ambiguous");
    const legacyId = legacy.rows[0]?.mcp_user_id;
    const unifiedId = unified[0]?.mcp_user_id;
    if (legacyId && unifiedId && legacyId !== unifiedId) throw new Error("oauth_account_binding_conflict");
    const mcpUserId = unifiedId ?? legacyId ?? String(request.account_id);
    for (const table of ["classroom_desk_connections", ...(unified.length || unifiedId ? ["classroom_desk_oauth_accounts"] : [])]) {
      const owners = await this.db.query<{ website_user_id: string }>(`SELECT website_user_id FROM ${table} WHERE mcp_user_id=$1 LIMIT 2`, [mcpUserId]);
      if (owners.rows.some(owner => String(owner.website_user_id) !== String(request.account_id))) throw new Error("oauth_account_binding_conflict");
    }

    const recoveredProfile: PrivateSaaSProfile = {
      googleSubject: input.googleSubject,
      email: input.email,
      displayName: input.displayName,
    };
    const emailHash = this.profileCipher.digest(recoveredProfile.email.toLowerCase());
    const displayNameHash = this.profileCipher.digest(recoveredProfile.displayName);
    return {
      accountId: String(request.account_id), mcpUserId,
      recovery: {
        requestId: String(request.id), googleSubjectHash: subjectHash, emailHash, displayNameHash,
        profile: recoveredProfile, expectedLegacyCiphertext: account.profile_ciphertext,
        expectedLegacyCiphertextHash: request.expected_legacy_ciphertext_hash,
      },
    };
  }

  async getUser(id: string): Promise<SaaSUser | null> {
    const result = await this.db.query<{ id: string; google_subject: string; email: string; display_name: string; profile_ciphertext?: string | null; role: SaaSUser["role"]; status: SaaSUser["status"]; created_at: Date; last_login_at: Date | null }>(`SELECT id,google_subject,email,display_name,profile_ciphertext,role,status,created_at,last_login_at FROM classroom_desk_users WHERE id=$1`, [id]);
    const row = result.rows[0];
    return row ? this.userFromRow(row) : null;
  }

  async loadDashboardCounts(_userId: string): Promise<{ courses: number | null; upcomingAssignments: number | null; missingAssignments: number | null; sync: "connected" | "reauthorization_required" | "not_connected" }> {
    // Classroom records are deliberately not copied into the SaaS tables. The existing MCP grant remains the source of truth.
    return { courses: null, upcomingAssignments: null, missingAssignments: null, sync: "not_connected" };
  }

  async getLinkedMcpUserId(websiteUserId: string): Promise<string | null> {
    return await this.getUnifiedMcpUserId(websiteUserId) ?? await this.getLegacyMcpUserId(websiteUserId);
  }

  async getUnifiedMcpUserId(websiteUserId: string): Promise<string | null> {
    try {
      const result = await this.db.query<{ mcp_user_id: string }>(`SELECT mcp_user_id FROM classroom_desk_oauth_accounts WHERE website_user_id=$1`, [websiteUserId]);
      return result.rows[0]?.mcp_user_id ? String(result.rows[0].mcp_user_id) : null;
    } catch (error) {
      if (isMissingSchemaField(error, "classroom_desk_oauth_accounts")) return null;
      throw error;
    }
  }

  async getLegacyMcpUserId(websiteUserId: string): Promise<string | null> {
    const result = await this.db.query<{ mcp_user_id: string }>(`SELECT mcp_user_id FROM classroom_desk_connections WHERE website_user_id=$1`, [websiteUserId]);
    return result.rows[0]?.mcp_user_id ? String(result.rows[0].mcp_user_id) : null;
  }

  private async websiteUserForMcpUser(mcpUserId: string): Promise<string | null> {
    const legacy = await this.db.query<{ website_user_id: string }>(`SELECT website_user_id FROM classroom_desk_connections WHERE mcp_user_id=$1`, [mcpUserId]);
    let unified: { website_user_id: string }[] = [];
    try {
      unified = (await this.db.query<{ website_user_id: string }>(`SELECT website_user_id FROM classroom_desk_oauth_accounts WHERE mcp_user_id=$1`, [mcpUserId])).rows;
    } catch (error) {
      if (!isMissingSchemaField(error, "classroom_desk_oauth_accounts")) throw error;
    }
    const owners = [...new Set([...legacy.rows, ...unified].map(row => String(row.website_user_id)))];
    if (owners.length > 1) throw new Error("account_ownership_conflict");
    if (owners[0]) return owners[0];
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(mcpUserId)) return null;
    const direct = await this.db.query<{ id: string }>(`SELECT id FROM classroom_desk_users WHERE id=$1`, [mcpUserId]);
    return direct.rows[0]?.id ? String(direct.rows[0].id) : null;
  }

  /** Resolve the authenticated website account to its Classroom grant subject.
   * An explicit legacy link wins; unified OAuth uses the canonical account UUID.
   */
  async getClassroomMcpUserId(websiteUserId: string): Promise<string | null> {
    const linked = await this.getLinkedMcpUserId(websiteUserId);
    if (linked) return linked;
    const user = await this.getUser(websiteUserId);
    return user?.status === "active" ? user.id : null;
  }

  async getDashboardExperience(userId: string): Promise<DashboardExperience | null> {
    const result = await this.db.query<{ experience: string }>(`SELECT experience FROM classroom_desk_user_preferences WHERE user_id=$1`, [userId]);
    const value = result.rows[0]?.experience;
    if (value === "student" || value === "teacher") return value;
    // Public main used the 0009 column before the source port. Read it as a
    // fallback so existing account preferences remain visible after 0010.
    try {
      const legacy = await this.db.query<{ dashboard_preference: string | null }>(`SELECT dashboard_preference FROM classroom_desk_users WHERE id=$1`, [userId]);
      const preference = legacy.rows[0]?.dashboard_preference;
      return preference === "student" || preference === "teacher" ? preference : null;
    } catch (error) {
      if (isMissingSchemaField(error, "dashboard_preference")) return null;
      throw error;
    }
  }

  async setDashboardExperience(userId: string, experience: DashboardExperience, now = new Date()): Promise<void> {
    const result = await this.db.query(`INSERT INTO classroom_desk_user_preferences (user_id,experience,updated_at)
      VALUES ($1,$2,$3) ON CONFLICT (user_id) DO UPDATE SET experience=EXCLUDED.experience,updated_at=EXCLUDED.updated_at
      WHERE EXISTS (SELECT 1 FROM classroom_desk_users WHERE id=$1 AND status='active') RETURNING user_id`, [userId, experience, now]);
    if (result.rows.length !== 1) throw new Error("dashboard_preference_account_unavailable");
  }

  async accountOverview(user: SaaSUser) {
    const [entitlement, history, payments, link, deletion] = await Promise.all([
      this.entitlement(user.id), this.adminUserHistory(user.id),
      this.db.query<{ id: string; kind: string; plan: string | null; amount_paise: number; currency: string; status: string; created_at: Date }>(`SELECT id,kind,plan,amount_paise,currency,status,created_at FROM classroom_desk_payments WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100`, [user.id]),
      this.getClassroomMcpUserId(user.id),
      this.db.query(`SELECT 1 FROM classroom_desk_account_deletion_requests WHERE user_id=$1 AND status='requested'`, [user.id]),
    ]);
    return { user, entitlement, history, linked: Boolean(link), deletionRequested: deletion.rows.length > 0,
      payments: payments.rows.map(p => ({ id: String(p.id), userId: user.id, email: user.email, kind: p.kind, plan: p.plan, amountPaise: Number(p.amount_paise), currency: p.currency, status: p.status, createdAt: new Date(p.created_at), providerPaymentId: null, providerSubscriptionId: null })) };
  }

  async entitlementForMcpUser(mcpUserId: string, now = new Date()): Promise<EffectiveEntitlement> {
    let websiteUserId: string | undefined;
    try {
      websiteUserId = await this.websiteUserForMcpUser(mcpUserId) ?? undefined;
    }
    catch (error) { throw policyDatabaseError("account_lookup", error); }
    if (!websiteUserId) return { allowed: false, reason: "none", plan: null, expiresAt: null };
    try { return await this.entitlement(String(websiteUserId), now); }
    catch (error) { throw policyDatabaseError("entitlement_evaluation", error); }
  }

  async accountStatusForMcpUser(mcpUserId: string, origin: string, now = new Date()): Promise<{ state: string; message: string; activationUrl: string; billingUrl: string; settingsUrl: string; plan: string | null; expiresAt: string | null }> {
    const activationUrl = new URL("/login", origin).toString();
    const billingUrl = new URL("/app/billing", origin).toString();
    const settingsUrl = new URL("/app/settings", origin).toString();
    const websiteUserId = await this.websiteUserForMcpUser(mcpUserId);
    if (!websiteUserId) return { state: "ACCOUNT_SETUP_REQUIRED", message: `Your Classroom Desk connection is authenticated, but it is not linked to a website account yet. Start at ${activationUrl}.`, activationUrl, billingUrl, settingsUrl, plan: null, expiresAt: null };
    const entitlement = await this.entitlement(websiteUserId, now);
    const user = await this.getUser(websiteUserId);
    if (!user || user.status === "deleted") return { state: "ACCOUNT_DISABLED", message: "Your Classroom Desk account is currently unavailable. Contact support for assistance.", activationUrl, billingUrl, settingsUrl, plan: null, expiresAt: null };
    if (user.status === "suspended") return { state: "ACCOUNT_SUSPENDED", message: "Your Classroom Desk account is currently unavailable. Contact support for assistance.", activationUrl, billingUrl, settingsUrl, plan: null, expiresAt: null };
    if (entitlement.allowed) {
      const state = entitlement.reason === "active_trial" ? "TRIAL_ACTIVE"
        : entitlement.reason === "active_subscription" ? "SUBSCRIPTION_ACTIVE" : "ACCESS_ACTIVE";
      return { state, message: `Your Classroom Desk access is active. Manage it at ${billingUrl}.`, activationUrl, billingUrl, settingsUrl, plan: entitlement.plan, expiresAt: entitlement.expiresAt?.toISOString() ?? null };
    }
    return { state: entitlement.reason === "expired" ? "TRIAL_OR_SUBSCRIPTION_EXPIRED" : "ACCOUNT_INACTIVE", message: `Your Classroom Desk account is connected, but access is not active yet. Choose a plan at ${billingUrl}.`, activationUrl, billingUrl, settingsUrl, plan: null, expiresAt: null };
  }

  async requestAccountDeletion(userId: string, reason?: string): Promise<string> {
    const result = await this.db.query<{ id: string }>(`INSERT INTO classroom_desk_account_deletion_requests (user_id,reason) VALUES ($1,$2) ON CONFLICT (user_id) WHERE status='requested' DO UPDATE SET reason=EXCLUDED.reason RETURNING id`, [userId, reason?.trim() || null]);
    const id = result.rows[0]?.id;
    if (!id) throw new Error("Deletion request could not be recorded.");
    return String(id);
  }

  async beginTrialPurchase(userId: string, now = new Date()): Promise<boolean> {
    if (!isTrialPurchaseOpen(now)) return false;
    const result = await this.db.query(`UPDATE classroom_desk_trials SET status='pending',pending_at=$2
      WHERE user_id=$1 AND status='eligible' RETURNING user_id`, [userId, now]);
    return result.rows.length === 1;
  }

  async pendingTrialOrder(userId: string): Promise<
    | { kind: "order"; orderId: string; status: string; paymentId: string | null }
    | { kind: "reconciliation_required" }
    | null
  > {
    const result = await this.db.query<{ provider_order_id: string | null; status: string | null; provider_payment_id: string | null }>(
      `SELECT p.provider_order_id,p.status,p.provider_payment_id
       FROM classroom_desk_trials t
       LEFT JOIN classroom_desk_payments p ON p.user_id=t.user_id AND p.kind='trial' AND p.provider_order_id IS NOT NULL
       WHERE t.user_id=$1 AND t.status='pending'
       ORDER BY p.created_at DESC LIMIT 1`, [userId]);
    const row = result.rows[0];
    if (!row) return null;
    return row.provider_order_id
      ? { kind: "order", orderId: String(row.provider_order_id), status: String(row.status), paymentId: row.provider_payment_id ? String(row.provider_payment_id) : null }
      : { kind: "reconciliation_required" };
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

  async reserveSubscriptionCreation(userId: string, plan: "student" | "teacher"):
    Promise<{ kind: "reserved"; requestId: string } | { kind: "resume"; subscriptionId: string } | { kind: "blocked"; reason: "creation_in_progress" | "creation_requires_reconciliation" | "subscription_exists" }> {
    const requestId = randomUUID();
    const reservation = await this.db.query<{ request_id: string }>(`INSERT INTO classroom_desk_subscription_creation_reservations (user_id,request_id,plan,state)
      SELECT $1,$2,$3,'creating'
      WHERE NOT EXISTS (SELECT 1 FROM classroom_desk_subscriptions WHERE user_id=$1 AND status IN ('pending','active','past_due'))
      ON CONFLICT (user_id) DO NOTHING RETURNING request_id`, [userId, requestId, plan]);
    if (reservation.rows.length === 1) return { kind: "reserved", requestId };

    // A Worker may terminate before its request handler can mark an ambiguous
    // provider result. Age the reservation into the existing fail-closed
    // reconciliation state; never retry the external create automatically.
    const staleCreatingBefore = new Date(Date.now() - 30 * 60 * 1000);
    await this.db.query(`UPDATE classroom_desk_subscription_creation_reservations SET state='unknown',updated_at=now()
      WHERE user_id=$1 AND state='creating' AND updated_at<$2`, [userId, staleCreatingBefore]);

    const [inFlight, existing] = await Promise.all([
      this.db.query<{ state: "creating" | "unknown" }>(`SELECT state FROM classroom_desk_subscription_creation_reservations WHERE user_id=$1`, [userId]),
      this.db.query<{ provider_subscription_id: string | null; plan: string; status: string }>(`SELECT provider_subscription_id,plan,status FROM classroom_desk_subscriptions
        WHERE user_id=$1 AND status IN ('pending','active','past_due') ORDER BY created_at DESC LIMIT 1`, [userId]),
    ]);
    const uncertain = inFlight.rows[0]?.state;
    if (uncertain === "creating") return { kind: "blocked", reason: "creation_in_progress" };
    if (uncertain === "unknown") return { kind: "blocked", reason: "creation_requires_reconciliation" };
    const subscription = existing.rows[0];
    if (subscription?.status === "pending" && subscription.plan === plan && subscription.provider_subscription_id
      && /^sub_[A-Za-z0-9_]+$/.test(subscription.provider_subscription_id)) return { kind: "resume", subscriptionId: subscription.provider_subscription_id };
    return { kind: "blocked", reason: "subscription_exists" };
  }

  async markSubscriptionCreationUnknown(userId: string, requestId: string): Promise<void> {
    await this.db.query(`UPDATE classroom_desk_subscription_creation_reservations SET state='unknown',updated_at=now() WHERE user_id=$1 AND request_id=$2 AND state='creating'`, [userId, requestId]);
  }

  async completeSubscriptionCreation(userId: string, plan: "student" | "teacher", requestId: string, providerSubscriptionId: string): Promise<void> {
    const insert = { sql: `INSERT INTO classroom_desk_subscriptions (user_id,plan,status,provider_subscription_id)
      SELECT $1,$2,'pending',$4 FROM classroom_desk_subscription_creation_reservations
      WHERE user_id=$1 AND request_id=$3 AND plan=$2 AND state='creating' RETURNING id`, values: [userId, plan, requestId, providerSubscriptionId] };
    const remove = { sql: `DELETE FROM classroom_desk_subscription_creation_reservations WHERE user_id=$1 AND request_id=$2 AND state='creating'
      AND EXISTS (SELECT 1 FROM classroom_desk_subscriptions WHERE user_id=$1 AND plan=$3 AND provider_subscription_id=$4) RETURNING user_id`, values: [userId, requestId, plan, providerSubscriptionId] };
    if (this.db.batch) {
      const result = await this.db.batch([insert, remove]);
      if (result[0]?.rows.length !== 1 || result[1]?.rows.length !== 1) throw new Error("subscription_creation_commit_failed");
      return;
    }
    await this.db.transaction(async tx => {
      const inserted = await tx.query(insert.sql, insert.values);
      if (inserted.rows.length !== 1) throw new Error("subscription_creation_reservation_missing");
      const removed = await tx.query(remove.sql, remove.values);
      if (removed.rows.length !== 1) throw new Error("subscription_creation_reservation_missing");
    });
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
      let partiallyRefundedOrder=false;
      let placeholderId:string|undefined;
      if (orderId) {
        await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`,[`trial-order:${orderId}`]);
        const association=await tx.query<{id:string;user_id:string;kind:string;currency:string;provider_payment_id:string|null;status:string;amount_paise:number}>(`SELECT id,user_id,kind,currency,provider_payment_id,status,amount_paise FROM classroom_desk_payments WHERE provider_order_id=$1 FOR UPDATE`,[orderId]);
        if(association.rows.length>1||association.rows.some(row=>row.user_id!==userId||row.kind!=="trial"||row.currency!=="INR"||Number(row.amount_paise)!==amountPaise||(row.provider_payment_id&&row.provider_payment_id!==paymentId)))throw new Error("trial_order_owner_mismatch");
        refundedOrder=association.rows.some(row=>row.status==='refunded');
        partiallyRefundedOrder=association.rows.some(row=>row.status==='partially_refunded');
        placeholderId=association.rows[0]?.id;
      }
      const existing = await tx.query<{ id:string;user_id: string; kind: string; currency:string;amount_paise: number; status: string;provider_order_id:string|null }>(`SELECT id,user_id,kind,currency,amount_paise,status,provider_order_id FROM classroom_desk_payments WHERE provider_payment_id=$1 FOR UPDATE`, [paymentId]);
      const previous=existing.rows[0];
      if (previous && (previous.user_id !== userId || previous.kind !== "trial" || previous.currency!=="INR" || Number(previous.amount_paise) !== amountPaise)) throw new Error("trial_payment_owner_mismatch");
      if (previous && ((orderId && previous.provider_order_id && previous.provider_order_id!==orderId)||(placeholderId && placeholderId!==previous.id))) throw new Error("trial_payment_association_mismatch");
      const refunded=tombstoned||refundedOrder||previous?.status==="refunded";
      const partiallyRefunded=partiallyRefundedOrder||previous?.status==="partially_refunded";
      const status=refunded?"refunded":partiallyRefunded?"partially_refunded":"captured";
      // A capture fills its pending placeholder even when an earlier refund
      // makes it terminal. Never grant access just to repair the ledger.
      if (!previous && placeholderId) await tx.query(`UPDATE classroom_desk_payments SET provider_payment_id=$2,status=$3,amount_refunded_paise=CASE WHEN $3='refunded' THEN amount_paise ELSE amount_refunded_paise END WHERE id=$1`,[placeholderId,paymentId,status]);
      else if (!previous) await tx.query(`INSERT INTO classroom_desk_payments (user_id,kind,amount_paise,currency,provider_payment_id,provider_order_id,status,amount_refunded_paise) VALUES ($1,'trial',$2,'INR',$3,$4,$5,CASE WHEN $5='refunded' THEN $2 ELSE 0 END)`, [userId, amountPaise, paymentId, orderId ?? null,status]);
      else await tx.query(`UPDATE classroom_desk_payments SET status=$2,amount_refunded_paise=CASE WHEN $2='refunded' THEN amount_paise ELSE amount_refunded_paise END,provider_order_id=COALESCE(provider_order_id,$3) WHERE provider_payment_id=$1`, [paymentId,status,orderId??null]);
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
        { sql: `UPDATE classroom_desk_payments SET provider_payment_id=$2,status=CASE WHEN status='refunded' OR $3 OR EXISTS (SELECT 1 FROM classroom_desk_webhook_events WHERE event_id=$4 AND event_type='internal.refund.tombstone' AND status='terminal' AND payload_hash=$5) THEN 'refunded' WHEN status='partially_refunded' THEN 'partially_refunded' ELSE 'captured' END,amount_refunded_paise=CASE WHEN status='refunded' OR $3 OR EXISTS (SELECT 1 FROM classroom_desk_webhook_events WHERE event_id=$4 AND event_type='internal.refund.tombstone' AND status='terminal' AND payload_hash=$5) THEN amount_paise ELSE amount_refunded_paise END WHERE id=$1 AND user_id=$6 AND kind='trial' AND amount_paise=900 AND currency='INR' AND provider_payment_id IS NULL RETURNING id`, values: [placeholder?.id ?? null, paymentId, refundedOrder, `internal:refund-tombstone:${paymentId}`, userId.toLowerCase(), userId] },
        { sql: `INSERT INTO classroom_desk_payments (user_id,kind,amount_paise,currency,provider_payment_id,provider_order_id,status,amount_refunded_paise) VALUES ($1,'trial',900,'INR',$2,$3,CASE WHEN $4 OR EXISTS (SELECT 1 FROM classroom_desk_webhook_events WHERE event_id=$5 AND event_type='internal.refund.tombstone' AND status='terminal' AND payload_hash=$6) OR EXISTS (SELECT 1 FROM classroom_desk_payments WHERE provider_order_id=$3 AND status='refunded') THEN 'refunded' ELSE 'captured' END,CASE WHEN $4 OR EXISTS (SELECT 1 FROM classroom_desk_webhook_events WHERE event_id=$5 AND event_type='internal.refund.tombstone' AND status='terminal' AND payload_hash=$6) OR EXISTS (SELECT 1 FROM classroom_desk_payments WHERE provider_order_id=$3 AND status='refunded') THEN 900 ELSE 0 END) ON CONFLICT (provider_payment_id) DO UPDATE SET status=CASE WHEN classroom_desk_payments.status='refunded' OR $4 OR EXISTS (SELECT 1 FROM classroom_desk_webhook_events WHERE event_id=$5 AND event_type='internal.refund.tombstone' AND status='terminal' AND payload_hash=$6) OR EXISTS (SELECT 1 FROM classroom_desk_payments WHERE provider_order_id=$3 AND status='refunded') THEN 'refunded' WHEN classroom_desk_payments.status='partially_refunded' THEN 'partially_refunded' ELSE 'captured' END,amount_refunded_paise=CASE WHEN classroom_desk_payments.status='refunded' OR $4 OR EXISTS (SELECT 1 FROM classroom_desk_webhook_events WHERE event_id=$5 AND event_type='internal.refund.tombstone' AND status='terminal' AND payload_hash=$6) OR EXISTS (SELECT 1 FROM classroom_desk_payments WHERE provider_order_id=$3 AND status='refunded') THEN classroom_desk_payments.amount_paise ELSE classroom_desk_payments.amount_refunded_paise END,provider_order_id=COALESCE(classroom_desk_payments.provider_order_id,EXCLUDED.provider_order_id) WHERE classroom_desk_payments.user_id=EXCLUDED.user_id AND classroom_desk_payments.kind='trial' AND classroom_desk_payments.amount_paise=900 AND classroom_desk_payments.currency='INR' AND (classroom_desk_payments.provider_order_id IS NULL OR EXCLUDED.provider_order_id IS NULL OR classroom_desk_payments.provider_order_id=EXCLUDED.provider_order_id) RETURNING id,status`, values: [userId, paymentId, orderId ?? null, refundedOrder, `internal:refund-tombstone:${paymentId}`, userId.toLowerCase()] },
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
    if (event.kind === "payment_partially_refunded") return this.processPartialRefund(event);
    if (this.db.batch) return this.processBillingEventD1(event);
    return this.db.transaction(async (tx) => {
      if ("paymentId" in event) await this.lockPayment(tx,event.paymentId,event.userId);
      if (event.kind === "subscription_paid") {
        requireProviderId(event.subscriptionId,"sub");
        const tombstoned=Boolean(await this.refundTombstone(tx,event.paymentId,event.userId));
        await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`,[`billing:${event.userId}`]);
        const firstPayment = await tx.query(`SELECT 1 FROM classroom_desk_payments WHERE user_id=$1 AND kind='subscription' AND status IN ('paid','captured','partially_refunded','refunded') AND provider_payment_id IS DISTINCT FROM $2 LIMIT 1`,[event.userId,event.paymentId]);
        const owner=await tx.query<{user_id:string;status:string;plan:string}>(`SELECT user_id,status,plan FROM classroom_desk_subscriptions WHERE provider_subscription_id=$1 FOR UPDATE`,[event.subscriptionId]);
        if(owner.rows[0]&&owner.rows[0].user_id!==event.userId)throw new Error("subscription_owner_mismatch");
        if(owner.rows[0]&&owner.rows[0].plan!==event.plan)throw new Error("subscription_plan_mismatch");
        const existing=await tx.query<{user_id:string;kind:string;plan:string;amount_paise:number;currency:string;provider_subscription_id:string|null;status:string;last_operation_id:string|null}>(`SELECT user_id,kind,plan,amount_paise,currency,provider_subscription_id,status,last_operation_id FROM classroom_desk_payments WHERE provider_payment_id=$1 FOR UPDATE`,[event.paymentId]);
        const previous=existing.rows[0];
        if(previous&&(previous.user_id!==event.userId||previous.kind!=="subscription"||previous.plan!==event.plan||Number(previous.amount_paise)!==event.amountPaise||previous.currency!=="INR"||previous.provider_subscription_id!==event.subscriptionId))throw new Error("subscription_payment_owner_mismatch");
        if(tombstoned||previous?.status==='refunded'){
          if(previous)await tx.query(`UPDATE classroom_desk_payments SET status='refunded',amount_refunded_paise=amount_paise WHERE provider_payment_id=$1`,[event.paymentId]);
          else await tx.query(`INSERT INTO classroom_desk_payments (user_id,kind,plan,amount_paise,currency,provider_payment_id,provider_subscription_id,status,amount_refunded_paise) VALUES ($1,'subscription',$2,$3,'INR',$4,$5,'refunded',$3)`,[event.userId,event.plan,event.amountPaise,event.paymentId,event.subscriptionId]);
          await tx.query(`INSERT INTO classroom_desk_subscriptions (user_id,plan,status,provider_subscription_id) VALUES ($1,$2,'refunded',$3) ON CONFLICT (provider_subscription_id) DO UPDATE SET status='refunded' WHERE classroom_desk_subscriptions.user_id=EXCLUDED.user_id`,[event.userId,event.plan,event.subscriptionId]);
          return false;
        }
        if(owner.rows[0]?.status==='refunded')return false;
        if(previous?.status==='partially_refunded'&&previous.last_operation_id)return false;
        const operationId=randomUUID();
        const payment=previous?.status==='partially_refunded'
          ? await tx.query(`UPDATE classroom_desk_payments SET last_operation_id=$2 WHERE provider_payment_id=$1 AND user_id=$3 AND kind='subscription' AND plan=$4 AND amount_paise=$5 AND currency='INR' AND provider_subscription_id=$6 AND status='partially_refunded' AND last_operation_id IS NULL RETURNING id`,[event.paymentId,operationId,event.userId,event.plan,event.amountPaise,event.subscriptionId])
          : await tx.query(`INSERT INTO classroom_desk_payments (user_id,kind,plan,amount_paise,currency,provider_payment_id,provider_subscription_id,status,last_operation_id) VALUES ($1,'subscription',$2,$3,'INR',$4,$5,'paid',$6) ON CONFLICT (provider_payment_id) DO NOTHING RETURNING id`, [event.userId, event.plan, event.amountPaise, event.paymentId, event.subscriptionId,operationId]);
        if (!payment.rows.length) return false;
        await tx.query(`INSERT INTO classroom_desk_subscriptions (user_id,plan,status,paid_through,provider_subscription_id) VALUES ($1,$2,'active',$3,$4) ON CONFLICT (provider_subscription_id) DO UPDATE SET status=CASE WHEN classroom_desk_subscriptions.status='cancelled' THEN 'cancelled' ELSE 'active' END,paid_through=GREATEST(classroom_desk_subscriptions.paid_through,EXCLUDED.paid_through),plan=EXCLUDED.plan WHERE classroom_desk_subscriptions.user_id=EXCLUDED.user_id`, [event.userId, event.plan, event.paidThrough, event.subscriptionId]);
        if (firstPayment.rows.length === 0 && this.options.referralRewardsEnabled === true) await this.qualifyReferralTx(tx, event.userId, new Date());
        return payment.rows.length === 1;
      }
      if (event.kind === "subscription_cancelled") {
        const result = await tx.query(`UPDATE classroom_desk_subscriptions SET status='cancelled',cancelled_at=$2 WHERE provider_subscription_id=$1 AND user_id=$3 AND status<>'refunded' RETURNING id`, [event.subscriptionId, event.cancelledAt,event.userId]); return result.rows.length === 1;
      }
      if (event.kind === "subscription_failed") {
        const result = await tx.query(`UPDATE classroom_desk_subscriptions SET status='past_due' WHERE provider_subscription_id=$1 AND user_id=$2 AND status NOT IN ('refunded','cancelled','past_due') AND (paid_through IS NULL OR paid_through<=now()) RETURNING id`, [event.subscriptionId,event.userId]); return result.rows.length === 1;
      }
      await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`,[`billing:${event.userId}`]);
      await this.refundTombstone(tx,event.paymentId,event.userId);
      const existing=await tx.query<{user_id:string}>(`SELECT user_id FROM classroom_desk_payments WHERE provider_payment_id=$1 FOR UPDATE`,[event.paymentId]);
      if(existing.rows[0]&&existing.rows[0].user_id!==event.userId)throw new Error("refund_payment_owner_mismatch");
      const user=await tx.query(`SELECT id FROM classroom_desk_users WHERE id=$1`,[event.userId]);
      if(!user.rows.length)throw new Error("refund_owner_missing");
      const marker=await tx.query(`INSERT INTO classroom_desk_webhook_events (event_id,event_type,payload_hash,status,processed_at) VALUES ($1,'internal.refund.tombstone',$2,'terminal',now()) ON CONFLICT (event_id) DO NOTHING RETURNING event_id`,[`internal:refund-tombstone:${event.paymentId}`,event.userId.toLowerCase()]);
      if(!existing.rows.length)return marker.rows.length===1;
      const payment = await tx.query(`UPDATE classroom_desk_payments SET status='refunded',amount_refunded_paise=amount_paise WHERE provider_payment_id=$1 AND user_id=$2 AND status <> 'refunded' RETURNING user_id`, [event.paymentId,event.userId]);
      if (!payment.rows.length) return false;
      await tx.query(`UPDATE classroom_desk_subscriptions SET status='refunded' WHERE provider_subscription_id IN (SELECT provider_subscription_id FROM classroom_desk_payments WHERE provider_payment_id=$1 AND provider_subscription_id IS NOT NULL)`, [event.paymentId]);
      await tx.query(`UPDATE classroom_desk_trials SET status='refunded' WHERE payment_id=$1 AND user_id=$2`, [event.paymentId,event.userId]);
      const referral = await tx.query<{referrer_user_id:string}>(`SELECT r.referrer_user_id FROM classroom_desk_referrals r JOIN classroom_desk_payments p ON p.user_id=r.referred_user_id AND p.provider_payment_id=$2 AND p.status='refunded' AND p.kind='subscription' WHERE r.referred_user_id=$1 AND r.counted_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM classroom_desk_payments earlier WHERE earlier.user_id=p.user_id AND earlier.kind='subscription' AND earlier.status IN ('paid','captured','partially_refunded','refunded') AND earlier.provider_payment_id IS DISTINCT FROM p.provider_payment_id AND (earlier.created_at<p.created_at OR (earlier.created_at=p.created_at AND earlier.id<p.id)))`, [event.userId,event.paymentId]);
      const qualifyingReferral = referral.rows[0];
      if (qualifyingReferral) {
        const referrer = qualifyingReferral.referrer_user_id;
        await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [referrer]);
        await tx.query(`UPDATE classroom_desk_referrals SET qualified_at=NULL,counted_at=NULL WHERE referred_user_id=$1 AND counted_at IS NOT NULL`, [event.userId]);
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
      const result = await this.db.query(`UPDATE classroom_desk_subscriptions SET status='past_due' WHERE provider_subscription_id=$1 AND user_id=$2 AND status NOT IN ('refunded','cancelled','past_due') AND (paid_through IS NULL OR paid_through<=now()) RETURNING id`, [event.subscriptionId, event.userId]);
      return result.rows.length === 1;
    }
    if (event.kind === "subscription_paid") {
      requireProviderId(event.subscriptionId, "sub");
      requireProviderId(event.paymentId, "pay");
      const tombstoned = Boolean(await this.refundTombstone(this.db, event.paymentId, event.userId));
      const owner = await this.db.query<{ user_id: string; status: string; plan: string }>(`SELECT user_id,status,plan FROM classroom_desk_subscriptions WHERE provider_subscription_id=$1`, [event.subscriptionId]);
      if (owner.rows[0] && owner.rows[0].user_id !== event.userId) throw new Error("subscription_owner_mismatch");
      if (owner.rows[0] && owner.rows[0].plan !== event.plan) throw new Error("subscription_plan_mismatch");
        const previous = await this.db.query<{ user_id: string; kind: string; plan: string; amount_paise: number; currency: string; provider_subscription_id: string | null; status: string; last_operation_id: string | null }>(`SELECT user_id,kind,plan,amount_paise,currency,provider_subscription_id,status,last_operation_id FROM classroom_desk_payments WHERE provider_payment_id=$1`, [event.paymentId]);
      const priorPayment = previous.rows[0];
      if (priorPayment && (priorPayment.user_id !== event.userId || priorPayment.kind !== "subscription" || priorPayment.plan !== event.plan || Number(priorPayment.amount_paise) !== event.amountPaise || priorPayment.currency !== "INR" || priorPayment.provider_subscription_id !== event.subscriptionId)) throw new Error("subscription_payment_owner_mismatch");
      if (owner.rows[0]?.status === "refunded" && !tombstoned && priorPayment?.status !== "refunded") return false;
      if (tombstoned || priorPayment?.status === "refunded") {
        await this.recordRefundedSubscriptionPaymentD1(event);
        return false;
      }
      if (owner.rows[0]?.status === "refunded") return false;
      if (priorPayment?.status === "partially_refunded" && priorPayment.last_operation_id) return false;
      const operationId = randomUUID(); const now = new Date(); const grantId = randomUUID();
      const queries = [
        { sql: `INSERT INTO classroom_desk_payments (user_id,kind,plan,amount_paise,currency,provider_payment_id,provider_subscription_id,status,last_operation_id) SELECT $1,'subscription',$2,$3,'INR',$4,$5,'paid',$6 WHERE NOT EXISTS (SELECT 1 FROM classroom_desk_webhook_events WHERE event_id=$7 AND event_type='internal.refund.tombstone' AND status='terminal' AND payload_hash=$8) AND NOT EXISTS (SELECT 1 FROM classroom_desk_subscriptions WHERE provider_subscription_id=$5 AND (user_id<>$1 OR status='refunded')) ON CONFLICT (provider_payment_id) DO UPDATE SET last_operation_id=EXCLUDED.last_operation_id WHERE classroom_desk_payments.user_id=EXCLUDED.user_id AND classroom_desk_payments.kind='subscription' AND classroom_desk_payments.plan=EXCLUDED.plan AND classroom_desk_payments.amount_paise=EXCLUDED.amount_paise AND classroom_desk_payments.currency='INR' AND classroom_desk_payments.provider_subscription_id=EXCLUDED.provider_subscription_id AND classroom_desk_payments.status='partially_refunded' AND classroom_desk_payments.last_operation_id IS NULL RETURNING id`, values: [event.userId, event.plan, event.amountPaise, event.paymentId, event.subscriptionId, operationId, `internal:refund-tombstone:${event.paymentId}`, event.userId.toLowerCase()] },
        { sql: `INSERT INTO classroom_desk_subscriptions (user_id,plan,status,paid_through,provider_subscription_id) SELECT $1,$2,'active',$3,$4 WHERE EXISTS (SELECT 1 FROM classroom_desk_payments WHERE provider_payment_id=$5 AND user_id=$1 AND status IN ('paid','partially_refunded') AND last_operation_id=$6) ON CONFLICT (provider_subscription_id) DO UPDATE SET status=CASE WHEN classroom_desk_subscriptions.status='cancelled' THEN 'cancelled' ELSE 'active' END,paid_through=CASE WHEN classroom_desk_subscriptions.paid_through IS NULL OR classroom_desk_subscriptions.paid_through<EXCLUDED.paid_through THEN EXCLUDED.paid_through ELSE classroom_desk_subscriptions.paid_through END,plan=EXCLUDED.plan WHERE classroom_desk_subscriptions.user_id=EXCLUDED.user_id AND classroom_desk_subscriptions.status<>'refunded' RETURNING id`, values: [event.userId, event.plan, event.paidThrough, event.subscriptionId, event.paymentId, operationId] },
      ] as Array<{ sql: string; values: unknown[] }>;
      if (this.options.referralRewardsEnabled === true) {
        queries.push(
          { sql: `UPDATE classroom_desk_referrals SET qualified_at=$1,counted_at=$1,qualified_operation_id=$2 WHERE referred_user_id=$3 AND counted_at IS NULL AND EXISTS (SELECT 1 FROM classroom_desk_payments p WHERE p.provider_payment_id=$4 AND p.user_id=$3 AND p.status IN ('paid','partially_refunded') AND p.last_operation_id=$2 AND NOT EXISTS (SELECT 1 FROM classroom_desk_payments prior WHERE prior.user_id=$3 AND prior.kind='subscription' AND prior.status IN ('paid','captured','partially_refunded','refunded') AND prior.provider_payment_id<>$4)) RETURNING referrer_user_id`, values: [now, operationId, event.userId, event.paymentId] },
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
      { sql: `UPDATE classroom_desk_payments SET status='refunded',amount_refunded_paise=amount_paise WHERE provider_payment_id=$1 AND user_id=$2 AND status<>'refunded' RETURNING user_id`, values: [event.paymentId, event.userId] },
      { sql: `UPDATE classroom_desk_subscriptions SET status='refunded' WHERE provider_subscription_id IN (SELECT provider_subscription_id FROM classroom_desk_payments WHERE provider_payment_id=$1 AND user_id=$2 AND provider_subscription_id IS NOT NULL)`, values: [event.paymentId, event.userId] },
      { sql: `UPDATE classroom_desk_trials SET status='refunded' WHERE payment_id=$1 AND user_id=$2`, values: [event.paymentId, event.userId] },
      { sql: `UPDATE classroom_desk_referrals SET qualified_at=NULL,counted_at=NULL WHERE referred_user_id=$1 AND counted_at IS NOT NULL AND EXISTS (SELECT 1 FROM classroom_desk_payments p WHERE p.user_id=$1 AND p.provider_payment_id=$2 AND p.status='refunded' AND p.last_operation_id=classroom_desk_referrals.qualified_operation_id) RETURNING referrer_user_id`, values: [event.userId, event.paymentId] },
      { sql: `UPDATE classroom_desk_entitlement_grants SET revoked_at=now() WHERE id IN (SELECT rr.grant_id FROM classroom_desk_referral_rewards rr WHERE rr.user_id IN (SELECT r.referrer_user_id FROM classroom_desk_referrals r JOIN classroom_desk_payments p ON p.user_id=r.referred_user_id AND p.last_operation_id=r.qualified_operation_id WHERE r.referred_user_id=$1 AND p.provider_payment_id=$2 AND p.status='refunded') AND rr.referral_count>(SELECT count(*) FROM classroom_desk_referrals r WHERE r.referrer_user_id=rr.user_id AND r.counted_at IS NOT NULL))`, values: [event.userId, event.paymentId] },
    ]);
    if (!existing.rows.length) return (results[0]?.rows.length ?? 0) === 1;
    return (results[1]?.rows.length ?? 0) === 1;
  }

  private async processPartialRefund(event: Extract<BillingEvent, { kind: "payment_partially_refunded" }>): Promise<boolean> {
    requireProviderId(event.paymentId, "pay");
    if (event.orderId) requireProviderId(event.orderId, "order");
    if (event.subscriptionId) requireProviderId(event.subscriptionId, "sub");
    if (!Number.isSafeInteger(event.amountPaise) || event.amountPaise <= 0
      || !Number.isSafeInteger(event.amountRefundedPaise) || event.amountRefundedPaise <= 0
      || event.amountRefundedPaise >= event.amountPaise) throw new Error("invalid_partial_refund_amount");
    if (this.db.batch) return this.processPartialRefundD1(event);
    return this.db.transaction(async tx => {
      await this.lockPayment(tx,event.paymentId,event.userId);
      const current=await tx.query<{id:string;user_id:string;kind:string;plan:string|null;amount_paise:number;currency:string;provider_order_id:string|null;provider_subscription_id:string|null;status:string;amount_refunded_paise:number}>(`SELECT id,user_id,kind,plan,amount_paise,currency,provider_order_id,provider_subscription_id,status,amount_refunded_paise FROM classroom_desk_payments WHERE provider_payment_id=$1 FOR UPDATE`,[event.paymentId]);
      if(current.rows[0]) {
        const row=current.rows[0];
        this.validatePartialRefundPayment(row,event);
        if(row.status==="refunded"||Number(row.amount_refunded_paise)>=event.amountRefundedPaise)return false;
        const updated=await tx.query(`UPDATE classroom_desk_payments SET status='partially_refunded',amount_refunded_paise=$2 WHERE provider_payment_id=$1 AND user_id=$3 AND status<>'refunded' AND amount_paise=$4 AND currency='INR' AND amount_refunded_paise<$2 RETURNING id`,[event.paymentId,event.amountRefundedPaise,event.userId,event.amountPaise]);
        return updated.rows.length===1;
      }
      if(event.orderId) {
        const orders=await tx.query<{id:string;user_id:string;kind:string;plan:string|null;amount_paise:number;currency:string;provider_payment_id:string|null;provider_order_id:string|null;provider_subscription_id:string|null;status:string;amount_refunded_paise:number}>(`SELECT id,user_id,kind,plan,amount_paise,currency,provider_payment_id,provider_order_id,provider_subscription_id,status,amount_refunded_paise FROM classroom_desk_payments WHERE provider_order_id=$1 FOR UPDATE`,[event.orderId]);
        if(orders.rows.length>1)throw new Error("partial_refund_order_ambiguous");
        const order=orders.rows[0];
        if(order) {
          this.validatePartialRefundPayment(order,event);
          if(order.kind!=="trial"||(order.provider_payment_id&&order.provider_payment_id!==event.paymentId))throw new Error("partial_refund_order_mismatch");
          if(order.status==="refunded")return false;
          const linked=await tx.query(`UPDATE classroom_desk_payments SET provider_payment_id=$2,status='partially_refunded',amount_refunded_paise=$3 WHERE id=$1 AND user_id=$4 AND kind='trial' AND amount_paise=$5 AND currency='INR' AND provider_payment_id IS NULL AND status<>'refunded' RETURNING id`,[order.id,event.paymentId,event.amountRefundedPaise,event.userId,event.amountPaise]);
          if(linked.rows.length===1)return true;
        }
      }
      if(event.subscriptionId) {
        const subscriptions=await tx.query<{user_id:string;plan:string}>(`SELECT user_id,plan FROM classroom_desk_subscriptions WHERE provider_subscription_id=$1 FOR UPDATE`,[event.subscriptionId]);
        const sub=subscriptions.rows[0];
        if(sub&&sub.user_id===event.userId&&(sub.plan==="student"||sub.plan==="teacher")) {
          const inserted=await tx.query(`INSERT INTO classroom_desk_payments (user_id,kind,plan,amount_paise,currency,provider_payment_id,provider_subscription_id,status,amount_refunded_paise) VALUES ($1,'subscription',$2,$3,'INR',$4,$5,'partially_refunded',$6) ON CONFLICT (provider_payment_id) DO NOTHING RETURNING id`,[event.userId,sub.plan,event.amountPaise,event.paymentId,event.subscriptionId,event.amountRefundedPaise]);
          if(inserted.rows.length===1)return true;
          const raced=await tx.query<{user_id:string;kind:string;plan:string|null;amount_paise:number;currency:string;provider_order_id:string|null;provider_subscription_id:string|null;status:string;amount_refunded_paise:number}>(`SELECT user_id,kind,plan,amount_paise,currency,provider_order_id,provider_subscription_id,status,amount_refunded_paise FROM classroom_desk_payments WHERE provider_payment_id=$1 FOR UPDATE`,[event.paymentId]);
          if(raced.rows[0]){this.validatePartialRefundPayment(raced.rows[0],event);return false;}
        }
      }
      throw new Error("partial_refund_payment_unlinked");
    });
  }

  private validatePartialRefundPayment(row:{user_id:string;kind:string;amount_paise:number;currency:string;provider_order_id:string|null;provider_subscription_id:string|null},event:Extract<BillingEvent,{kind:"payment_partially_refunded"}>):void {
    if(row.user_id!==event.userId||!(["trial","subscription"] as string[]).includes(row.kind)||Number(row.amount_paise)!==event.amountPaise||row.currency!=="INR"
      ||(event.orderId&&row.provider_order_id&&row.provider_order_id!==event.orderId)
      ||(event.subscriptionId&&row.provider_subscription_id&&row.provider_subscription_id!==event.subscriptionId))throw new Error("partial_refund_payment_mismatch");
  }

  private async processPartialRefundD1(event:Extract<BillingEvent,{kind:"payment_partially_refunded"}>):Promise<boolean> {
    const current=await this.db.query<{id:string;user_id:string;kind:string;plan:string|null;amount_paise:number;currency:string;provider_order_id:string|null;provider_subscription_id:string|null;status:string;amount_refunded_paise:number}>(`SELECT id,user_id,kind,plan,amount_paise,currency,provider_order_id,provider_subscription_id,status,amount_refunded_paise FROM classroom_desk_payments WHERE provider_payment_id=$1`,[event.paymentId]);
    if(current.rows[0]) {
      const row=current.rows[0];this.validatePartialRefundPayment(row,event);
      if(row.status==="refunded"||Number(row.amount_refunded_paise)>=event.amountRefundedPaise)return false;
      const updated=await this.db.query(`UPDATE classroom_desk_payments SET status='partially_refunded',amount_refunded_paise=$2 WHERE provider_payment_id=$1 AND user_id=$3 AND status<>'refunded' AND amount_paise=$4 AND currency='INR' AND amount_refunded_paise<$2 RETURNING id`,[event.paymentId,event.amountRefundedPaise,event.userId,event.amountPaise]);
      return updated.rows.length===1;
    }
    if(event.orderId) {
      const orders=await this.db.query<{id:string;user_id:string;kind:string;plan:string|null;amount_paise:number;currency:string;provider_payment_id:string|null;provider_order_id:string|null;provider_subscription_id:string|null;status:string;amount_refunded_paise:number}>(`SELECT id,user_id,kind,plan,amount_paise,currency,provider_payment_id,provider_order_id,provider_subscription_id,status,amount_refunded_paise FROM classroom_desk_payments WHERE provider_order_id=$1`,[event.orderId]);
      if(orders.rows.length>1)throw new Error("partial_refund_order_ambiguous");
      const order=orders.rows[0];
      if(order) {
        this.validatePartialRefundPayment(order,event);
        if(order.kind!=="trial"||(order.provider_payment_id&&order.provider_payment_id!==event.paymentId))throw new Error("partial_refund_order_mismatch");
        if(order.status==="refunded")return false;
        const linked=await this.db.query(`UPDATE classroom_desk_payments SET provider_payment_id=$2,status='partially_refunded',amount_refunded_paise=$3 WHERE id=$1 AND user_id=$4 AND kind='trial' AND amount_paise=$5 AND currency='INR' AND provider_payment_id IS NULL AND status<>'refunded' RETURNING id`,[order.id,event.paymentId,event.amountRefundedPaise,event.userId,event.amountPaise]);
        if(linked.rows.length===1)return true;
      }
    }
    if(event.subscriptionId) {
      const subscriptions=await this.db.query<{user_id:string;plan:string}>(`SELECT user_id,plan FROM classroom_desk_subscriptions WHERE provider_subscription_id=$1`,[event.subscriptionId]);
      const sub=subscriptions.rows[0];
      if(sub&&sub.user_id===event.userId&&(sub.plan==="student"||sub.plan==="teacher")) {
        const inserted=await this.db.query(`INSERT INTO classroom_desk_payments (user_id,kind,plan,amount_paise,currency,provider_payment_id,provider_subscription_id,status,amount_refunded_paise) SELECT $1,'subscription',$2,$3,'INR',$4,$5,'partially_refunded',$6 WHERE EXISTS (SELECT 1 FROM classroom_desk_subscriptions WHERE provider_subscription_id=$5 AND user_id=$1 AND plan=$2) ON CONFLICT (provider_payment_id) DO NOTHING RETURNING id`,[event.userId,sub.plan,event.amountPaise,event.paymentId,event.subscriptionId,event.amountRefundedPaise]);
        if(inserted.rows.length===1)return true;
        const raced=await this.db.query<{user_id:string;kind:string;plan:string|null;amount_paise:number;currency:string;provider_order_id:string|null;provider_subscription_id:string|null;status:string;amount_refunded_paise:number}>(`SELECT user_id,kind,plan,amount_paise,currency,provider_order_id,provider_subscription_id,status,amount_refunded_paise FROM classroom_desk_payments WHERE provider_payment_id=$1`,[event.paymentId]);
        if(raced.rows[0]){this.validatePartialRefundPayment(raced.rows[0],event);return false;}
      }
    }
    throw new Error("partial_refund_payment_unlinked");
  }

  private async recordRefundedSubscriptionPaymentD1(event: Extract<BillingEvent, { kind: "subscription_paid" }>): Promise<void> {
    const results = await this.db.batch!([
      { sql: `INSERT INTO classroom_desk_payments (user_id,kind,plan,amount_paise,currency,provider_payment_id,provider_subscription_id,status,amount_refunded_paise) SELECT $1,'subscription',$2,$3,'INR',$4,$5,'refunded',$3 WHERE NOT EXISTS (SELECT 1 FROM classroom_desk_subscriptions WHERE provider_subscription_id=$5 AND user_id<>$1) ON CONFLICT (provider_payment_id) DO UPDATE SET status='refunded',amount_refunded_paise=EXCLUDED.amount_refunded_paise WHERE classroom_desk_payments.user_id=EXCLUDED.user_id AND classroom_desk_payments.kind='subscription' AND classroom_desk_payments.plan=EXCLUDED.plan AND classroom_desk_payments.amount_paise=EXCLUDED.amount_paise AND classroom_desk_payments.currency='INR' AND classroom_desk_payments.provider_subscription_id=EXCLUDED.provider_subscription_id RETURNING id`, values: [event.userId, event.plan, event.amountPaise, event.paymentId, event.subscriptionId] },
      { sql: `INSERT INTO classroom_desk_subscriptions (user_id,plan,status,provider_subscription_id) SELECT $1,$2,'refunded',$3 WHERE EXISTS (SELECT 1 FROM classroom_desk_payments WHERE provider_payment_id=$4 AND user_id=$1 AND status='refunded') ON CONFLICT (provider_subscription_id) DO UPDATE SET status='refunded' WHERE classroom_desk_subscriptions.user_id=EXCLUDED.user_id RETURNING id`, values: [event.userId, event.plan, event.subscriptionId, event.paymentId] },
    ]);
    if (!results[0]?.rows.length) throw new Error("subscription_payment_owner_mismatch");
  }

  async ownsSubscription(userId: string, subscriptionId: string): Promise<boolean> {
    const result = await this.db.query(`SELECT 1 FROM classroom_desk_subscriptions WHERE user_id=$1 AND provider_subscription_id=$2 AND status IN ('active','past_due')`, [userId, subscriptionId]);
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
    const searchTerm = search.trim();
    const filterSearchInMemory = this.options.requireProfileEncryption === true && Boolean(searchTerm);
    if (searchTerm && !filterSearchInMemory) { values.push(`%${searchTerm}%`); filters.push(`(display_name ILIKE $${values.length} OR email ILIKE $${values.length})`); }
    if (["SUPER_ADMIN", "SUPPORT_ADMIN", "STUDENT", "TEACHER"].includes(role ?? "")) { values.push(role); filters.push(`role=$${values.length}`); }
    if (["active", "suspended", "deleted"].includes(status ?? "")) { values.push(status); filters.push(`status=$${values.length}`); }
    if (subscription === "active" || subscription === "trial" || subscription === "none") {
      const hasSubscription = `(EXISTS (SELECT 1 FROM classroom_desk_subscriptions s WHERE s.user_id=classroom_desk_users.id AND s.status IN ('active','cancelled','past_due') AND (s.paid_through IS NULL OR s.paid_through>now())) OR EXISTS (SELECT 1 FROM classroom_desk_trials t WHERE t.user_id=classroom_desk_users.id AND t.status='active' AND t.expires_at>now()) OR EXISTS (SELECT 1 FROM classroom_desk_entitlement_grants g WHERE g.user_id=classroom_desk_users.id AND g.revoked_at IS NULL AND g.starts_at<=now() AND g.expires_at>now()))`;
      if (subscription === "active") filters.push(hasSubscription);
      if (subscription === "trial") filters.push(`EXISTS (SELECT 1 FROM classroom_desk_trials t WHERE t.user_id=classroom_desk_users.id AND t.status='active' AND t.expires_at>now())`);
      if (subscription === "none") filters.push(`NOT ${hasSubscription}`);
    }
    const limit = filterSearchInMemory ? 10_001 : 100;
    values.push(limit);
    const result = await this.db.query<{ id: string; google_subject: string; email: string; display_name: string; profile_ciphertext: string | null; role: SaaSUser["role"]; status: SaaSUser["status"]; created_at: Date; last_login_at: Date | null }>(`SELECT id,google_subject,email,display_name,profile_ciphertext,role,status,created_at,last_login_at FROM classroom_desk_users${filters.length ? ` WHERE ${filters.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT $${values.length}`, values);
    if (filterSearchInMemory && result.rows.length > 10_000) throw new Error("admin_user_search_limit");
    const users = result.rows.map((row) => this.adminUserFromRow(row));
    return filterSearchInMemory
      ? users.filter((user) => user.email !== "Profile unavailable" && (user.email.toLowerCase().includes(searchTerm.toLowerCase()) || user.displayName.toLowerCase().includes(searchTerm.toLowerCase()))).slice(0, 100)
      : users;
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
    const result = await this.db.query<{ id: string; user_id: string; google_subject: string; email: string; display_name: string; profile_ciphertext: string | null; kind: string; plan: string | null; amount_paise: number; currency: string; provider_payment_id: string | null; provider_subscription_id: string | null; status: string; created_at: Date }>(`SELECT p.id,p.user_id,u.google_subject,u.email,u.display_name,u.profile_ciphertext,p.kind,p.plan,p.amount_paise,p.currency,p.provider_payment_id,p.provider_subscription_id,p.status,p.created_at FROM classroom_desk_payments p JOIN classroom_desk_users u ON u.id=p.user_id ORDER BY p.created_at DESC LIMIT 100`);
    return result.rows.map((row) => ({ id: String(row.id), userId: String(row.user_id), email: this.profileFromRow(row)?.email ?? "Profile unavailable", kind: row.kind, plan: row.plan, amountPaise: Number(row.amount_paise), currency: row.currency, providerPaymentId: row.provider_payment_id, providerSubscriptionId: row.provider_subscription_id, status: row.status, createdAt: new Date(row.created_at) }));
  }

  async adminSubscriptionCreationReservations(): Promise<AdminSubscriptionCreationReservation[]> {
    const result = await this.db.query<{ user_id: string; request_id: string; plan: "student" | "teacher"; state: "creating" | "unknown"; created_at: Date; updated_at: Date }>(`SELECT user_id,request_id,plan,state,created_at,updated_at FROM classroom_desk_subscription_creation_reservations ORDER BY updated_at DESC LIMIT 100`);
    return result.rows.map((row) => ({ userId: String(row.user_id), requestId: row.request_id, plan: row.plan, state: row.state, createdAt: new Date(String(row.created_at)), updatedAt: new Date(String(row.updated_at)) }));
  }

  async adminAudit():Promise<AdminAuditEvent[]> {
    const result=await this.db.query<{actor_user_id:string;target_user_id:string|null;action:string;reason:string;previous_state:unknown;new_state:unknown;created_at:Date|string}>(`SELECT actor_user_id,target_user_id,action,reason,previous_state,new_state,created_at FROM classroom_desk_admin_audit ORDER BY created_at DESC LIMIT 50`);
    return result.rows.map(row => ({ actorUserId: String(row.actor_user_id), targetUserId: row.target_user_id === null ? null : String(row.target_user_id), action: row.action, reason: row.reason, previousState: row.previous_state, newState: row.new_state, createdAt: new Date(row.created_at) }));
  }

  async adminReferrals(): Promise<AdminReferral[]> {
    const result = await this.db.query<{ id: string; referrer_google_subject: string; referrer_email: string; referrer_display_name: string; referrer_profile_ciphertext: string | null; referred_google_subject: string; referred_email: string; referred_display_name: string; referred_profile_ciphertext: string | null; code: string; qualified_at: Date | null; counted_at: Date | null; created_at: Date }>(`SELECT r.id,referrer.google_subject referrer_google_subject,referrer.email referrer_email,referrer.display_name referrer_display_name,referrer.profile_ciphertext referrer_profile_ciphertext,referred.google_subject referred_google_subject,referred.email referred_email,referred.display_name referred_display_name,referred.profile_ciphertext referred_profile_ciphertext,r.code,r.qualified_at,r.counted_at,r.created_at FROM classroom_desk_referrals r JOIN classroom_desk_users referrer ON referrer.id=r.referrer_user_id JOIN classroom_desk_users referred ON referred.id=r.referred_user_id ORDER BY r.created_at DESC LIMIT 100`);
    return result.rows.map((row) => ({ id: String(row.id), referrerEmail: this.profileFromRow({ google_subject: row.referrer_google_subject, email: row.referrer_email, display_name: row.referrer_display_name, profile_ciphertext: row.referrer_profile_ciphertext })?.email ?? "Profile unavailable", referredEmail: this.profileFromRow({ google_subject: row.referred_google_subject, email: row.referred_email, display_name: row.referred_display_name, profile_ciphertext: row.referred_profile_ciphertext })?.email ?? "Profile unavailable", code: row.code, qualifiedAt: row.qualified_at ? new Date(row.qualified_at) : null, countedAt: row.counted_at ? new Date(row.counted_at) : null, createdAt: new Date(row.created_at) }));
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
    await this.requireActiveAdmin(actorId, "grant_access");
    const id = randomUUID(); const expires = new Date(now.getTime() + durationMs);
    if (this.db.batch) {
      const results = await this.db.batch([
        { sql: `INSERT INTO classroom_desk_entitlement_grants (id,user_id,plan,source,starts_at,expires_at,reason)
          SELECT $1,$2,$3,'manual',$4,$5,$6 WHERE EXISTS (
            SELECT 1 FROM classroom_desk_users actor WHERE actor.id=$7 AND actor.status='active' AND actor.role IN ('SUPER_ADMIN','SUPPORT_ADMIN')
          ) RETURNING id`, values: [id, targetId, plan, now, expires, reason.trim(), actorId] },
        { sql: `INSERT INTO classroom_desk_admin_audit (actor_user_id,target_user_id,action,reason,previous_state,new_state)
          SELECT $1,$2,'grant_access',$3,$4,$5 WHERE changes()=1`, values: [actorId, targetId, reason.trim(), "{}", JSON.stringify({ grantId: id, plan, expiresAt: expires.toISOString() })] },
      ]);
      if (!results[0]?.rows.length) {
        await this.requireActiveAdmin(actorId, "grant_access");
        const target = await this.db.query(`SELECT 1 FROM classroom_desk_users WHERE id=$1`, [targetId]);
        if (!target.rows.length) throw new Error("target_not_found");
        throw new Error("admin_operation_not_applied");
      }
      return id;
    }
    await this.db.transaction(async (tx) => {
      await this.lockActiveAdmin(tx, actorId, "grant_access");
      await tx.query(`INSERT INTO classroom_desk_entitlement_grants (id,user_id,plan,source,starts_at,expires_at,reason) VALUES ($1,$2,$3,'manual',$4,$5,$6)`, [id, targetId, plan, now, expires, reason.trim()]);
      await tx.query(`INSERT INTO classroom_desk_admin_audit (actor_user_id,target_user_id,action,reason,previous_state,new_state) VALUES ($1,$2,$3,$4,$5,$6)`, [actorId, targetId, "grant_access", reason.trim(), JSON.stringify({}), JSON.stringify({ grantId: id, plan, expiresAt: expires.toISOString() })]);
    });
    return id;
  }

  async adminExtendAccess(actorId: string, grantId: string, durationMs: number, reason: string, now = new Date()): Promise<void> {
    if (!reason.trim() || durationMs <= 0 || durationMs > 366 * 24 * 60 * 60 * 1000) throw new Error("invalid_access_extension");
    await this.requireActiveAdmin(actorId, "extend_access");
    if (this.db.batch) {
      const current = await this.db.query<{ user_id: string; starts_at: Date; expires_at: Date; revoked_at: Date | null }>(`SELECT user_id,starts_at,expires_at,revoked_at FROM classroom_desk_entitlement_grants WHERE id=$1 AND source IN ('manual','complimentary')`, [grantId]);
      const grant = current.rows[0]; if (!grant) throw new Error("grant_not_found");
      if (grant.revoked_at) throw new Error("grant_already_revoked");
      const previousExpires = new Date(grant.expires_at); const nextExpires = new Date(Math.max(previousExpires.getTime(), now.getTime()) + durationMs); const operationId = randomUUID();
      const committed = await this.db.batch([
        { sql: `UPDATE classroom_desk_entitlement_grants SET expires_at=$2,last_operation_id=$3 WHERE id=$1 AND source IN ('manual','complimentary') AND expires_at=$4 AND revoked_at IS NULL
          AND EXISTS (SELECT 1 FROM classroom_desk_users actor WHERE actor.id=$5 AND actor.status='active' AND actor.role IN ('SUPER_ADMIN','SUPPORT_ADMIN')) RETURNING id`, values: [grantId, nextExpires, operationId, previousExpires, actorId] },
        { sql: `INSERT INTO classroom_desk_admin_audit (actor_user_id,target_user_id,action,reason,previous_state,new_state,created_at) SELECT $1,$2,'extend_access',$3,$4,$5,$6 WHERE EXISTS (SELECT 1 FROM classroom_desk_entitlement_grants WHERE id=$7 AND last_operation_id=$8 AND expires_at=$9 AND revoked_at IS NULL)`, values: [actorId, grant.user_id, reason.trim(), JSON.stringify({ grantId, expiresAt: previousExpires.toISOString() }), JSON.stringify({ grantId, expiresAt: nextExpires.toISOString() }), now, grantId, operationId, nextExpires] },
      ]);
      if (committed[0]?.rows.length !== 1) {
        await this.requireActiveAdmin(actorId, "extend_access");
        throw new Error("grant_changed_concurrently");
      }
      return;
    }
    await this.db.transaction(async (tx) => {
      await this.lockActiveAdmin(tx, actorId, "extend_access");
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
    await this.requireActiveAdmin(actorId, "revoke_access");
    if (this.db.batch) {
      const current = await this.db.query<{ user_id: string; expires_at: Date; revoked_at: Date | null }>(`SELECT user_id,expires_at,revoked_at FROM classroom_desk_entitlement_grants WHERE id=$1 AND source IN ('manual','complimentary')`, [grantId]);
      const grant = current.rows[0]; if (!grant) throw new Error("grant_not_found");
      if (grant.revoked_at) throw new Error("grant_already_revoked");
      const operationId = randomUUID();
      const committed = await this.db.batch([
        { sql: `UPDATE classroom_desk_entitlement_grants SET revoked_at=$2,last_operation_id=$3 WHERE id=$1 AND source IN ('manual','complimentary') AND revoked_at IS NULL AND expires_at=$5
          AND EXISTS (SELECT 1 FROM classroom_desk_users actor WHERE actor.id=$4 AND actor.status='active' AND actor.role='SUPER_ADMIN') RETURNING id`, values: [grantId, now, operationId, actorId, grant.expires_at] },
        { sql: `INSERT INTO classroom_desk_admin_audit (actor_user_id,target_user_id,action,reason,previous_state,new_state,created_at) SELECT $1,$2,'revoke_access',$3,$4,$5,$6 WHERE EXISTS (SELECT 1 FROM classroom_desk_entitlement_grants WHERE id=$7 AND last_operation_id=$8 AND revoked_at=$6)`, values: [actorId, grant.user_id, reason.trim(), JSON.stringify({ grantId, expiresAt: new Date(grant.expires_at).toISOString(), revokedAt: null }), JSON.stringify({ grantId, revokedAt: now.toISOString() }), now, grantId, operationId] },
      ]);
      if (committed[0]?.rows.length !== 1) {
        await this.requireActiveAdmin(actorId, "revoke_access");
        throw new Error("grant_changed_concurrently");
      }
      return;
    }
    await this.db.transaction(async (tx) => {
      await this.lockActiveAdmin(tx, actorId, "revoke_access");
      const current = await tx.query<{ user_id: string; expires_at: Date; revoked_at: Date | null }>(`SELECT user_id,expires_at,revoked_at FROM classroom_desk_entitlement_grants WHERE id=$1 AND source IN ('manual','complimentary') FOR UPDATE`, [grantId]);
      const grant = current.rows[0]; if (!grant) throw new Error("grant_not_found");
      if (grant.revoked_at) throw new Error("grant_already_revoked");
      await tx.query(`UPDATE classroom_desk_entitlement_grants SET revoked_at=$2 WHERE id=$1`, [grantId, now]);
      await tx.query(`INSERT INTO classroom_desk_admin_audit (actor_user_id,target_user_id,action,reason,previous_state,new_state,created_at) VALUES ($1,$2,'revoke_access',$3,$4,$5,$6)`, [actorId, grant.user_id, reason.trim(), JSON.stringify({ grantId, expiresAt: new Date(grant.expires_at).toISOString(), revokedAt: null }), JSON.stringify({ grantId, revokedAt: now.toISOString() }), now]);
    });
  }

  async adminChangeRole(actorId: string, targetId: string, role: SaaSUser["role"], reason: string, now = new Date()): Promise<void> {
    if (!reason.trim()) throw new Error("audit_reason_required");
    const actor = await this.requireActiveAdmin(actorId, "change_role"); validateRoleChange(actor, role);
    const target = await this.getUser(targetId); if (!target) throw new Error("target_not_found");
    if (this.db.batch) {
      const changed = await this.db.batch([
        { sql: `UPDATE classroom_desk_users SET role=$2 WHERE id=$1 AND role=$3 AND EXISTS (
            SELECT 1 FROM classroom_desk_users actor WHERE actor.id=$4 AND actor.status='active' AND actor.role='SUPER_ADMIN'
          ) AND ($3 <> 'SUPER_ADMIN' OR status <> 'active' OR $2 = 'SUPER_ADMIN' OR (
            SELECT count(*) FROM classroom_desk_users WHERE role='SUPER_ADMIN' AND status='active'
          ) > 1) RETURNING id`, values: [targetId, role, target.role, actorId] },
        { sql: `INSERT INTO classroom_desk_admin_audit (actor_user_id,target_user_id,action,reason,previous_state,new_state,created_at)
          SELECT $1,$2,'change_role',$3,$4,$5,$6 WHERE changes()=1`, values: [actorId, targetId, reason.trim(), JSON.stringify({ role: target.role }), JSON.stringify({ role }), now] },
      ]);
      if (!changed[0]?.rows.length) {
        const currentActor = await this.requireActiveAdmin(actorId, "change_role"); validateRoleChange(currentActor, role);
        const currentTarget = await this.db.query<{ role: SaaSUser["role"]; status: SaaSUser["status"]; active_super_admin_count: number | string }>(
          `SELECT target.role,target.status,(SELECT count(*) FROM classroom_desk_users WHERE role='SUPER_ADMIN' AND status='active') AS active_super_admin_count
           FROM classroom_desk_users target WHERE target.id=$1`, [targetId]);
        if (!currentTarget.rows[0]) throw new Error("target_not_found");
        if (currentTarget.rows[0].role === "SUPER_ADMIN" && currentTarget.rows[0].status === "active" && role !== "SUPER_ADMIN" && Number(currentTarget.rows[0].active_super_admin_count) <= 1) {
          throw new Error("last_super_admin_required");
        }
        throw new Error("target_changed_concurrently");
      }
      return;
    }
    await this.db.transaction(async (tx) => {
      // Serialize role changes so concurrent demotions cannot both observe the same last-admin count.
      await tx.query("SELECT pg_advisory_xact_lock(4410451, 1)");
      const lockedActor = await this.lockActiveAdmin(tx, actorId, "change_role"); validateRoleChange(lockedActor, role);
      const currentTarget = await tx.query<{ role: SaaSUser["role"]; status: SaaSUser["status"] }>(`SELECT role,status FROM classroom_desk_users WHERE id=$1 FOR UPDATE`, [targetId]);
      const previousRole = currentTarget.rows[0]?.role; if (!previousRole) throw new Error("target_not_found");
      if (previousRole === "SUPER_ADMIN" && currentTarget.rows[0]!.status === "active" && role !== "SUPER_ADMIN") {
        const activeAdmins = await tx.query<{ count: number | string }>(`SELECT count(*) AS count FROM classroom_desk_users WHERE role='SUPER_ADMIN' AND status='active'`);
        if (Number(activeAdmins.rows[0]?.count ?? 0) <= 1) throw new Error("last_super_admin_required");
      }
      await tx.query(`UPDATE classroom_desk_users SET role=$2 WHERE id=$1`, [targetId, role]);
      await tx.query(`INSERT INTO classroom_desk_admin_audit (actor_user_id,target_user_id,action,reason,previous_state,new_state,created_at) VALUES ($1,$2,'change_role',$3,$4,$5,$6)`, [actorId, targetId, reason.trim(), JSON.stringify({ role: previousRole }), JSON.stringify({ role }), now]);
    });
  }

  async adminSetStatus(actorId: string, targetId: string, status: "active" | "suspended", reason: string, now = new Date()): Promise<void> {
    if (!reason.trim()) throw new Error("audit_reason_required");
    const action = status === "suspended" ? "suspend_user" : "restore_user";
    const actor = await this.requireActiveAdmin(actorId, action);
    if (actorId === targetId && status === "suspended") throw new Error("cannot_suspend_self");
    const target = await this.getUser(targetId); if (!target) throw new Error("target_not_found");
    if (actor.role === "SUPPORT_ADMIN" && (target.role === "SUPER_ADMIN" || target.role === "SUPPORT_ADMIN")) throw new Error("admin_target_forbidden");
    const updateSql = `UPDATE classroom_desk_users SET status=$2 WHERE id=$1 AND status=$5
      AND ($3='SUPER_ADMIN' OR role IN ('STUDENT','TEACHER'))
      AND EXISTS (SELECT 1 FROM classroom_desk_users actor WHERE actor.id=$4 AND actor.role=$3 AND actor.status='active')
      RETURNING id`;
    const updateValues = [targetId, status, actor.role, actorId, target.status];
    const auditSql = `INSERT INTO classroom_desk_admin_audit (actor_user_id,target_user_id,action,reason,previous_state,new_state,created_at)
      SELECT $1,$2,$3,$4,$5,$6,$7 WHERE EXISTS (
        SELECT 1 FROM classroom_desk_users target WHERE target.id=$2 AND target.status=$8
          AND ($9='SUPER_ADMIN' OR target.role IN ('STUDENT','TEACHER'))
          AND EXISTS (SELECT 1 FROM classroom_desk_users actor WHERE actor.id=$1 AND actor.role=$9 AND actor.status='active')
      )`;
    const d1AuditSql = `${auditSql} AND changes()=1`;
    const auditValues = [actorId, targetId, status === "suspended" ? "suspend_user" : "restore_user", reason.trim(), JSON.stringify({ status: target.status }), JSON.stringify({ status }), now, status, actor.role];
    if (this.db.batch) {
      const results = await this.db.batch([ { sql: updateSql, values: updateValues }, { sql: d1AuditSql, values: auditValues } ]);
      if (!results[0]?.rows.length) {
        const currentActor = await this.requireActiveAdmin(actorId, action);
        const currentTarget = await this.db.query<{ role: SaaSUser["role"]; status: SaaSUser["status"] }>(`SELECT role,status FROM classroom_desk_users WHERE id=$1`, [targetId]);
        const changedTarget = currentTarget.rows[0];
        if (!changedTarget) throw new Error("target_not_found");
        if (currentActor.role === "SUPPORT_ADMIN" && (changedTarget.role === "SUPER_ADMIN" || changedTarget.role === "SUPPORT_ADMIN")) throw new Error("admin_target_forbidden");
        throw new Error("target_changed_concurrently");
      }
      return;
    }
    await this.db.transaction(async (tx) => {
      const lockedActor = await this.lockActiveAdmin(tx, actorId, action);
      const currentTarget = await tx.query<{ role: SaaSUser["role"]; status: SaaSUser["status"] }>(`SELECT role,status FROM classroom_desk_users WHERE id=$1 FOR UPDATE`, [targetId]);
      const lockedTarget = currentTarget.rows[0];
      if (!lockedTarget) throw new Error("target_not_found");
      if (lockedActor.role === "SUPPORT_ADMIN" && (lockedTarget.role === "SUPER_ADMIN" || lockedTarget.role === "SUPPORT_ADMIN")) throw new Error("admin_target_forbidden");
      updateValues[2] = lockedActor.role;
      updateValues[4] = lockedTarget.status;
      auditValues[8] = lockedActor.role;
      auditValues[4] = JSON.stringify({ status: lockedTarget.status });
      const updated = await tx.query<{ id: string }>(updateSql, updateValues);
      if (!updated.rows.length) throw new Error("admin_target_forbidden");
      await tx.query(auditSql, auditValues);
    });
  }

  private async requireActiveAdmin(actorId: string, action: AdminAction): Promise<SaaSUser> {
    const actor = await this.getUser(actorId);
    if (!actor) throw new Error("admin_not_found");
    if (actor.status !== "active") throw new Error("admin_permission_required");
    assertCanPerform(actor, action);
    return actor;
  }

  private async lockActiveAdmin(tx: SqlConnection, actorId: string, action: AdminAction): Promise<Pick<SaaSUser, "role" | "status">> {
    const result = await tx.query<Pick<SaaSUser, "role" | "status">>(`SELECT role,status FROM classroom_desk_users WHERE id=$1 FOR UPDATE`, [actorId]);
    const actor = result.rows[0];
    if (!actor) throw new Error("admin_not_found");
    if (actor.status !== "active") throw new Error("admin_permission_required");
    assertCanPerform(actor, action);
    return actor;
  }
}

function dateOrNull(value: Date | string | null): Date | null { return value ? new Date(value) : null; }
