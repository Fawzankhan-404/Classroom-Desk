import express from "express";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type { QueryResultRow } from "pg";
import { D1SqlDatabase } from "../public/d1-database.js";
import type { SqlConnection, SqlDatabase } from "../public/postgres.js";
import { PostgresPublicAuthStore } from "../public/postgres.js";
import { registerAdminRoutes } from "./admin-routes.js";
import { renderAdminCRM } from "./admin.js";
import { registerWebsiteRoutes } from "./website-routes.js";
import { SaaSStore } from "./store.js";
import { SaaSProfileCipher } from "./privacy.js";

const legacyIdentity = { googleSubject: "synthetic-old-subject-001", email: "legacy@example.invalid", displayName: "Synthetic legacy owner" };
const recoveryIdentity = { googleSubject: "synthetic-new-subject-001", email: "new-login@example.invalid", displayName: "Synthetic recovery identity" };
const oauth = { clientId: "synthetic-client-id", clientSecret: "synthetic-client-secret", callbackUrl: "http://127.0.0.1/auth/google/callback", origin: "http://127.0.0.1" };

function migrationName(version: number): string {
  const names = [
    "0001_classroom_desk.sql", "0002_d1_link_claims.sql", "0003_d1_admin_operation_markers.sql",
    "0004_d1_unique_trial_orders.sql", "0005_d1_billing_operation_markers.sql", "0006_d1_reconciliation_claims.sql",
    "0007_saas_profile_privacy.sql", "0008_unified_oauth_accounts.sql", "0009_dashboard_preference.sql",
    "0010_user_experience_preferences.sql", "0011_subscription_creation_reservations.sql",
    "0012_payment_refund_totals.sql", "0013_legacy_account_recovery.sql", "0014_legacy_account_recovery_review.sql",
    "0015_detached_google_identities.sql",
  ];
  const name = names[version - 1];
  if (!name) throw new Error("test_migration_missing");
  return name;
}

function isolatedD1() {
  const sqlite = new DatabaseSync(":memory:");
  for (let version = 1; version <= 15; version += 1) {
    sqlite.exec(readFileSync(new URL(`../../migrations/${migrationName(version)}`, import.meta.url), "utf8"));
  }
  const statement = (sql: string, values: unknown[] = []) => ({
    all: async <T>() => {
      const query = sqlite.prepare(sql);
      const rows = query.columns().length ? query.all(...values) : (query.run(...values), []);
      return { success: true, results: rows as T[] };
    },
  });
  const binding = {
    prepare: (sql: string) => ({ bind: (...values: unknown[]) => statement(sql, values) }),
    batch: async <T>(items: ReturnType<typeof statement>[]) => {
      sqlite.exec("BEGIN");
      try {
        const results = [];
        for (const item of items) results.push(await item.all<T>());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };
  return { sqlite, db: new D1SqlDatabase(binding) };
}

function authDatabase(db: D1SqlDatabase): SqlDatabase {
  return {
    query: <T extends QueryResultRow = Record<string, unknown>>(sql: string, values?: unknown[]) => db.query<T>(sql, values),
    transaction: <T>(run: (tx: SqlConnection) => Promise<T>) => db.transaction(run),
    batch: <T extends QueryResultRow = Record<string, unknown>>(queries: Array<{ sql: string; values?: unknown[] }>) => db.batch<T>(queries),
  };
}

async function setup() {
  const { sqlite, db } = isolatedD1();
  const previousKey = randomBytes(32).toString("base64");
  const currentKey = randomBytes(32).toString("base64");
  const oldStore = new SaaSStore(db, { profileEncryptionKeyBase64: previousKey, requireProfileEncryption: true });
  const legacy = await oldStore.upsertGoogleIdentity({ ...legacyIdentity, now: new Date("2026-10-20T00:00:00.000Z") });
  const ciphertext = (await db.query<{ profile_ciphertext: string }>("SELECT profile_ciphertext FROM classroom_desk_users WHERE id=$1", [legacy.id])).rows[0]!.profile_ciphertext;
  await db.query("UPDATE classroom_desk_trials SET status='active',payment_id='synthetic-trial' WHERE user_id=$1", [legacy.id]);
  await db.query("INSERT INTO classroom_desk_subscriptions (id,user_id,plan,status,paid_through,provider_subscription_id) VALUES ($1,$2,'teacher','active',$3,$4)", ["00000000-0000-4000-8000-000000000141", legacy.id, "2026-12-01T00:00:00.000Z", "sub_synthetic_preserve"]);
  await db.query("INSERT INTO classroom_desk_entitlement_grants (id,user_id,plan,source,starts_at,expires_at) VALUES ($1,$2,'teacher','subscription',$3,$4)", ["00000000-0000-4000-8000-000000000142", legacy.id, "2026-10-01T00:00:00.000Z", "2026-12-01T00:00:00.000Z"]);
  await db.query("INSERT INTO classroom_desk_payments (id,user_id,kind,plan,amount_paise,provider_payment_id,provider_subscription_id,status) VALUES ($1,$2,'subscription','teacher',19900,$3,$4,'captured')", ["00000000-0000-4000-8000-000000000143", legacy.id, "pay_synthetic_preserve", "sub_synthetic_preserve"]);
  await db.query("INSERT INTO classroom_desk_connections (website_user_id,mcp_user_id) VALUES ($1,$2)", [legacy.id, "legacy-mcp-subject"]);
  const store = new SaaSStore(db, { profileEncryptionKeyBase64: currentKey, requireProfileEncryption: true });
  const admin = (await db.query<{ id: string }>("INSERT INTO classroom_desk_users (google_subject,email,display_name,role) VALUES ($1,$2,$3,'SUPER_ADMIN') RETURNING id", ["synthetic-owner-subject-002", "owner@example.invalid", "Synthetic authorized owner"])).rows[0]!;
  const applicantSession = await store.createLegacyRecoveryAccessSession(recoveryIdentity.googleSubject);
  const adminSession = await store.sessions.create(admin.id);
  const cipher = new SaaSProfileCipher(currentKey);
  const supportIdentity = { googleSubject: "synthetic-support-subject-003", email: "support@example.invalid", displayName: "Synthetic support account" };
  const supportSubjectHash = cipher.digest(supportIdentity.googleSubject);
  const supportEmailHash = cipher.digest(supportIdentity.email.toLowerCase());
  const supportNameHash = cipher.digest(supportIdentity.displayName);
  const support = (await db.query<{ id: string }>("INSERT INTO classroom_desk_users (google_subject,email,display_name,profile_ciphertext,google_subject_hash,email_hash,display_name_hash,role) VALUES ($1,$2,$3,$4,$5,$6,$7,'SUPPORT_ADMIN') RETURNING id", [`enc:${supportSubjectHash}`, `enc:${supportEmailHash}`, `enc:${supportNameHash}`, cipher.seal(supportIdentity), supportSubjectHash, supportEmailHash, supportNameHash])).rows[0]!;
  const supportSession = await store.sessions.create(support.id);
  const studentIdentity = { googleSubject: "synthetic-student-subject-004", email: "student@example.invalid", displayName: "Synthetic student" };
  const studentSubjectHash = cipher.digest(studentIdentity.googleSubject);
  const studentEmailHash = cipher.digest(studentIdentity.email.toLowerCase());
  const studentNameHash = cipher.digest(studentIdentity.displayName);
  const student = (await db.query<{ id: string }>("INSERT INTO classroom_desk_users (google_subject,email,display_name,profile_ciphertext,google_subject_hash,email_hash,display_name_hash,role) VALUES ($1,$2,$3,$4,$5,$6,$7,'STUDENT') RETURNING id", [`enc:${studentSubjectHash}`, `enc:${studentEmailHash}`, `enc:${studentNameHash}`, cipher.seal(studentIdentity), studentSubjectHash, studentEmailHash, studentNameHash])).rows[0]!;
  const studentSession = await store.sessions.create(student.id);
  return { sqlite, db, store, legacy, ciphertext, previousKey, currentKey, admin, adminSession, applicantSession, supportSession, studentSession };
}

async function createApp(store: SaaSStore) {
  const states = new Map<string, unknown>();
  const oauthStateStore = {
    putEphemeral: async (kind: string, key: string, value: unknown) => { states.set(`${kind}:${key}`, value); },
    takeEphemeral: async <T>(kind: string, key: string) => {
      const id = `${kind}:${key}`;
      const value = states.get(id) as T | undefined;
      states.delete(id);
      return value;
    },
  };
  const app = express();
  app.use(express.urlencoded({ extended: false, limit: "4kb" }));
  registerWebsiteRoutes(app, {
    store, oauth, oauthStateStore, secureCookies: false,
    completeRecoveryGoogleIdentity: async input => {
      if (input.code !== "synthetic-google-code" || !input.verifier || !input.nonce) throw new Error("synthetic_oauth_rejected");
      return recoveryIdentity;
    },
  });
  registerAdminRoutes(app, store);
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { server, origin };
}

const formHeaders = (origin: string, cookie: string) => ({ origin, cookie, "content-type": "application/x-www-form-urlencoded" });
const cookiesFrom = (response: Response) => response.headers.get("set-cookie") ?? "";
const cookieValue = (header: string, name: string) => header.match(new RegExp(`(?:^|,\\s*)${name}=([^;,]+)`))?.[1] ?? "";

describe("owner-admin legacy account recovery workflow", () => {
  const servers: Array<ReturnType<typeof createServer>> = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  });

  it("authenticates a recovery-only identity, requires owner review, then consumes approval through the existing OAuth recovery transaction", async () => {
    const fixture = await setup();
    try {
      const { server, origin } = await createApp(fixture.store); servers.push(server);
      const start = await fetch(`${origin}/account/recovery/start`, { redirect: "manual" });
      expect(start.status).toBe(302);
      const googleUrl = new URL(start.headers.get("location")!);
      expect(googleUrl.origin).toBe("https://accounts.google.com");
      expect(googleUrl.searchParams.get("scope")).toBe("openid email profile");
      expect(googleUrl.searchParams.get("code_challenge_method")).toBe("S256");
      const startCookie = start.headers.get("set-cookie")!.split(";")[0]!;
      const callback = await fetch(`${origin}/auth/google/callback?state=${encodeURIComponent(googleUrl.searchParams.get("state")!)}&code=synthetic-google-code`, { headers: { cookie: startCookie }, redirect: "manual" });
      expect(callback.status).toBe(303);
      expect(callback.headers.get("location")).toBe("/account/recovery");
      expect(callback.headers.get("cache-control")).toBe("no-store");
      const callbackCookies = cookiesFrom(callback);
      const recoveryToken = cookieValue(callbackCookies, "cd_recovery_session");
      expect(recoveryToken).toMatch(/^[A-Za-z0-9_-]{40,}$/);
      expect(callbackCookies).toContain("cd_recovery_login_state=; Path=/");
      expect(callbackCookies).not.toContain("cd_session=");
      expect((await fixture.db.query("SELECT count(*) AS count FROM classroom_desk_users")).rows).toEqual([{ count: 4 }]);
      const signedIn = await fetch(`${origin}/account/recovery`, { headers: { cookie: `cd_recovery_session=${recoveryToken}` } });
      expect(signedIn.status).toBe(200);
      expect(signedIn.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
      expect(await signedIn.text()).toContain("Send for owner review");

      const submitted = await fetch(`${origin}/account/recovery/request`, {
        method: "POST", headers: formHeaders(origin, `cd_recovery_session=${recoveryToken}`),
        body: new URLSearchParams({ accountId: fixture.legacy.id, evidenceType: "preexisting_support_record", evidenceReference: "claimant-case-0001" }), redirect: "manual",
      });
      expect(submitted.status).toBe(303);
      expect(submitted.headers.get("location")).toBe("/account/recovery?submitted=1");
      expect((await fixture.db.query("SELECT profile_ciphertext,profile_recovery_status FROM classroom_desk_users WHERE id=$1", [fixture.legacy.id])).rows).toEqual([{ profile_ciphertext: fixture.ciphertext, profile_recovery_status: "ready" }]);
      expect((await fixture.db.query("SELECT count(*) AS count FROM classroom_desk_account_recovery_requests")).rows).toEqual([{ count: 0 }]);

      const noSession = await fetch(`${origin}/admin/account-recovery`);
      const student = await fetch(`${origin}/admin/account-recovery`, { headers: { cookie: `cd_session=${fixture.studentSession.token}`, origin } });
      const support = await fetch(`${origin}/admin/account-recovery`, { headers: { cookie: `cd_session=${fixture.supportSession.token}`, origin } });
      const ownerPage = await fetch(`${origin}/admin/account-recovery`, { headers: { cookie: `cd_session=${fixture.adminSession.token}`, origin } });
      expect([noSession.status, student.status, support.status, ownerPage.status]).toEqual([403, 403, 403, 200]);
      const ownerHtml = await ownerPage.text();
      expect(ownerHtml).toContain(fixture.legacy.id);
      expect(ownerHtml).toContain("I checked this reference against an authoritative record");
      expect(ownerHtml).toContain("email equality");
      const supportCrm = renderAdminCRM({ totalUsers: 0, newRegistrations: 0, activeTrials: 0, activeStudentSubscriptions: 0, activeTeacherSubscriptions: 0, expiredSubscriptions: 0, upcomingRenewals: 0, verifiedRevenuePaise: 0, trialConversions: 0, qualifiedReferrals: 0, recentPayments: 0, recentAdminActivity: 0 }, [], {}, false);
      expect(supportCrm).not.toContain("/admin/account-recovery");

      const intake = (await fixture.db.query<{ id: string }>("SELECT id FROM classroom_desk_account_recovery_intakes WHERE account_id=$1", [fixture.legacy.id])).rows[0]!;
      const evidenceRef = "owner-verified-case-001";
      const approval = await fetch(`${origin}/admin/account-recovery/${intake.id}/approve`, {
        method: "POST", headers: formHeaders(origin, `cd_session=${fixture.adminSession.token}`),
        body: new URLSearchParams({ evidenceType: "preexisting_support_record", evidenceReference: evidenceRef, confirmedIndependentEvidence: "yes" }), redirect: "manual",
      });
      expect(approval.status).toBe(303);
      expect(approval.headers.get("location")).toContain("result=approved");
      expect((await fixture.db.query("SELECT decision FROM classroom_desk_account_recovery_review_claims WHERE intake_id=$1", [intake.id])).rows).toEqual([{ decision: "approved" }]);
      const approvalRequest = (await fixture.db.query<{ id: string; expires_at: string; status: string; source_intake_id: string }>("SELECT id,expires_at,status,source_intake_id FROM classroom_desk_account_recovery_requests WHERE source_intake_id=$1", [intake.id])).rows[0]!;
      expect(approvalRequest.status).toBe("pending");
      expect(approvalRequest.source_intake_id).toBe(intake.id);
      expect(Date.parse(approvalRequest.expires_at)).toBeGreaterThan(Date.now());
      expect(Date.parse(approvalRequest.expires_at)).toBeLessThanOrEqual(Date.now() + 24 * 60 * 60 * 1000 + 5000);
      expect((await fixture.db.query("SELECT profile_ciphertext,profile_recovery_status FROM classroom_desk_users WHERE id=$1", [fixture.legacy.id])).rows).toEqual([{ profile_ciphertext: fixture.ciphertext, profile_recovery_status: "recovery_pending" }]);
      expect((await fixture.db.query("SELECT action,actor_user_id,target_user_id FROM classroom_desk_admin_audit WHERE action='approve_legacy_account_recovery'")).rows).toEqual([{ action: "approve_legacy_account_recovery", actor_user_id: fixture.admin.id, target_user_id: fixture.legacy.id }]);

      const billingBefore = await Promise.all([
        fixture.db.query("SELECT * FROM classroom_desk_trials WHERE user_id=$1", [fixture.legacy.id]),
        fixture.db.query("SELECT * FROM classroom_desk_subscriptions WHERE user_id=$1", [fixture.legacy.id]),
        fixture.db.query("SELECT * FROM classroom_desk_entitlement_grants WHERE user_id=$1", [fixture.legacy.id]),
        fixture.db.query("SELECT * FROM classroom_desk_payments WHERE user_id=$1", [fixture.legacy.id]),
      ]);
      const binding = await fixture.store.resolveGoogleIdentityBinding({ ...recoveryIdentity, now: new Date() });
      expect(binding).toMatchObject({ accountId: fixture.legacy.id, mcpUserId: "legacy-mcp-subject", recovery: { requestId: approvalRequest.id } });
      const auth = new PostgresPublicAuthStore(authDatabase(fixture.db), fixture.currentKey, "classroom_desk_auth_records");
      await auth.migrate();
      await auth.putGrantAndCode(
        { userId: binding.mcpUserId, refreshToken: "synthetic-fresh-refresh", scopes: ["openid", "email"], createdAt: Date.now(), updatedAt: Date.now(), googleSubject: recoveryIdentity.googleSubject },
        { code: "synthetic-recovery-code", clientId: "synthetic-chatgpt-client", userId: binding.mcpUserId, redirectUri: "https://chatgpt.com/connector/oauth/callback", challenge: "synthetic-pkce-challenge", scopes: ["mcp:tools"], expiresAt: Date.now() + 30_000 },
        binding,
      );
      const recovered = (await fixture.db.query<{ id: string; profile_ciphertext: string; profile_recovery_status: string; google_subject: string }>("SELECT id,profile_ciphertext,profile_recovery_status,google_subject FROM classroom_desk_users WHERE id=$1", [fixture.legacy.id])).rows[0]!;
      expect(recovered.id).toBe(fixture.legacy.id);
      expect(recovered.profile_ciphertext).not.toBe(fixture.ciphertext);
      expect(recovered.profile_recovery_status).toBe("ready");
      expect(recovered.google_subject).toBeNull();
      expect((await fixture.db.query("SELECT status FROM classroom_desk_account_recovery_requests WHERE id=$1", [approvalRequest.id])).rows).toEqual([{ status: "completed" }]);
      expect((await fixture.db.query("SELECT recovery_id,account_id FROM classroom_desk_account_recovery_claims WHERE recovery_id=$1", [approvalRequest.id])).rows).toEqual([{ recovery_id: approvalRequest.id, account_id: fixture.legacy.id }]);
      expect(await auth.getGrant(binding.mcpUserId)).toMatchObject({ refreshToken: "synthetic-fresh-refresh", googleSubject: recoveryIdentity.googleSubject });
      expect(await auth.getCode("synthetic-recovery-code")).toMatchObject({ userId: binding.mcpUserId });
      expect(await Promise.all([
        fixture.db.query("SELECT * FROM classroom_desk_trials WHERE user_id=$1", [fixture.legacy.id]),
        fixture.db.query("SELECT * FROM classroom_desk_subscriptions WHERE user_id=$1", [fixture.legacy.id]),
        fixture.db.query("SELECT * FROM classroom_desk_entitlement_grants WHERE user_id=$1", [fixture.legacy.id]),
        fixture.db.query("SELECT * FROM classroom_desk_payments WHERE user_id=$1", [fixture.legacy.id]),
      ])).toEqual(billingBefore);

      const replay = await fetch(`${origin}/admin/account-recovery/${intake.id}/approve`, {
        method: "POST", headers: formHeaders(origin, `cd_session=${fixture.adminSession.token}`),
        body: new URLSearchParams({ evidenceType: "preexisting_support_record", evidenceReference: evidenceRef, confirmedIndependentEvidence: "yes" }), redirect: "manual",
      });
      expect(replay.headers.get("location")).toContain("result=error");
      expect((await fixture.db.query("SELECT count(*) AS count FROM classroom_desk_account_recovery_review_claims WHERE intake_id=$1", [intake.id])).rows).toEqual([{ count: 1 }]);
    } finally { fixture.sqlite.close(); }
  });

  it("rejects wrong-account evidence without changing account or billing and makes the decision single-use", async () => {
    const fixture = await setup();
    try {
      const intake = await fixture.store.submitLegacyRecoveryIntake({ sessionToken: fixture.applicantSession.token, accountId: fixture.legacy.id, evidenceType: "preexisting_support_record", evidenceReference: "claimant-case-0002" });
      const ownerReview = await fixture.store.rejectLegacyRecoveryIntake({ requestId: intake.requestId, reviewerId: fixture.admin.id, reason: "account_mismatch" });
      expect(ownerReview).toBeUndefined();
      expect((await fixture.db.query("SELECT i.status,u.profile_recovery_status FROM classroom_desk_account_recovery_intakes i JOIN classroom_desk_users u ON u.id=i.account_id WHERE i.id=$1", [intake.requestId])).rows).toEqual([{ status: "rejected", profile_recovery_status: "ready" }]);
      expect((await fixture.db.query("SELECT decision FROM classroom_desk_account_recovery_review_claims WHERE intake_id=$1", [intake.requestId])).rows).toEqual([{ decision: "rejected" }]);
      await expect(fixture.store.rejectLegacyRecoveryIntake({ requestId: intake.requestId, reviewerId: fixture.admin.id, reason: "other" })).rejects.toThrow("legacy_recovery_request_not_actionable");
      expect((await fixture.db.query("SELECT profile_ciphertext FROM classroom_desk_users WHERE id=$1", [fixture.legacy.id])).rows).toEqual([{ profile_ciphertext: fixture.ciphertext }]);
      expect((await fixture.db.query("SELECT count(*) AS count FROM classroom_desk_account_recovery_requests")).rows).toEqual([{ count: 0 }]);
      expect((await fixture.db.query("SELECT count(*) AS count FROM classroom_desk_admin_audit WHERE action='reject_legacy_account_recovery'")).rows).toEqual([{ count: 1 }]);
      expect((await fixture.db.query("SELECT reason FROM classroom_desk_admin_audit WHERE action='reject_legacy_account_recovery'")).rows).toEqual([{ reason: "recovery_rejected:account_mismatch" }]);
    } finally { fixture.sqlite.close(); }
  });

  it("rejects duplicate recovery subjects and account identities already recorded on another account", async () => {
    const fixture = await setup();
    try {
      const first = await fixture.store.submitLegacyRecoveryIntake({ sessionToken: fixture.applicantSession.token, accountId: fixture.legacy.id, evidenceType: "preexisting_support_record", evidenceReference: "claimant-case-duplicate" });
      const previousCipher = new SaaSProfileCipher(fixture.previousKey);
      const otherIdentity = { googleSubject: "synthetic-legacy-other-subject", email: "other-legacy@example.invalid", displayName: "Other synthetic legacy" };
      const otherSubjectHash = previousCipher.digest(otherIdentity.googleSubject);
      const otherEmailHash = previousCipher.digest(otherIdentity.email.toLowerCase());
      const otherNameHash = previousCipher.digest(otherIdentity.displayName);
      const other = (await fixture.db.query<{ id: string }>("INSERT INTO classroom_desk_users (google_subject,email,display_name,profile_ciphertext,google_subject_hash,email_hash,display_name_hash) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id", [`enc:${otherSubjectHash}`, `enc:${otherEmailHash}`, `enc:${otherNameHash}`, previousCipher.seal(otherIdentity), otherSubjectHash, otherEmailHash, otherNameHash])).rows[0]!;
      await expect(fixture.store.submitLegacyRecoveryIntake({ sessionToken: fixture.applicantSession.token, accountId: other.id, evidenceType: "preexisting_support_record", evidenceReference: "claimant-case-duplicate2" })).rejects.toThrow("legacy_recovery_request_not_created");
      expect((await fixture.db.query("SELECT count(*) AS count FROM classroom_desk_account_recovery_intakes WHERE google_subject_hash=(SELECT google_subject_hash FROM classroom_desk_account_recovery_intakes WHERE id=$1)", [first.requestId])).rows).toEqual([{ count: 1 }]);
      const identityHash = new SaaSProfileCipher(fixture.currentKey).digest(recoveryIdentity.googleSubject);
      await fixture.db.query("INSERT INTO classroom_desk_users (google_subject,email,display_name) VALUES ($1,$2,$3)", [recoveryIdentity.googleSubject, "duplicate-identity@example.invalid", "Visible duplicate synthetic identity"]);
      await expect(fixture.store.approveLegacyRecoveryIntake({ requestId: first.requestId, reviewerId: fixture.admin.id, evidenceType: "preexisting_support_record", evidenceReference: "owner-verified-case-dup", confirmedIndependentEvidence: true })).rejects.toThrow("legacy_recovery_identity_conflict");
      expect((await fixture.db.query("SELECT count(*) AS count FROM classroom_desk_account_recovery_requests WHERE status='pending'")).rows).toEqual([{ count: 0 }]);
    } finally { fixture.sqlite.close(); }
  });

  it("rolls back the owner approval and recovery-pending state when the atomic review claim fails", async () => {
    const fixture = await setup();
    try {
      const intake = await fixture.store.submitLegacyRecoveryIntake({ sessionToken: fixture.applicantSession.token, accountId: fixture.legacy.id, evidenceType: "preexisting_support_record", evidenceReference: "claimant-case-0003" });
      fixture.sqlite.exec("CREATE TRIGGER synthetic_interrupt_review_claim BEFORE INSERT ON classroom_desk_account_recovery_review_claims BEGIN SELECT RAISE(ABORT,'synthetic_review_interruption'); END;");
      await expect(fixture.store.approveLegacyRecoveryIntake({ requestId: intake.requestId, reviewerId: fixture.admin.id, evidenceType: "preexisting_support_record", evidenceReference: "owner-verified-case-003", confirmedIndependentEvidence: true })).rejects.toThrow();
      expect((await fixture.db.query("SELECT i.status,u.profile_recovery_status FROM classroom_desk_account_recovery_intakes i JOIN classroom_desk_users u ON u.id=i.account_id WHERE i.id=$1", [intake.requestId])).rows).toEqual([{ status: "submitted", profile_recovery_status: "ready" }]);
      expect((await fixture.db.query("SELECT profile_ciphertext FROM classroom_desk_users WHERE id=$1", [fixture.legacy.id])).rows).toEqual([{ profile_ciphertext: fixture.ciphertext }]);
      expect((await fixture.db.query("SELECT count(*) AS count FROM classroom_desk_account_recovery_requests")).rows).toEqual([{ count: 0 }]);
      expect((await fixture.db.query("SELECT count(*) AS count FROM classroom_desk_admin_audit WHERE action='approve_legacy_account_recovery'")).rows).toEqual([{ count: 0 }]);
    } finally { fixture.sqlite.close(); }
  });

  it("expires submitted requests and rejects approval after the intake window", async () => {
    const fixture = await setup();
    try {
      const createdAt = new Date("2026-10-01T00:00:00.000Z");
      const session = await fixture.store.createLegacyRecoveryAccessSession(recoveryIdentity.googleSubject, createdAt);
      const intake = await fixture.store.submitLegacyRecoveryIntake({ sessionToken: session.token, accountId: fixture.legacy.id, evidenceType: "preexisting_support_record", evidenceReference: "claimant-case-0004", now: createdAt });
      await expect(fixture.store.approveLegacyRecoveryIntake({ requestId: intake.requestId, reviewerId: fixture.admin.id, evidenceType: "preexisting_support_record", evidenceReference: "owner-verified-case-004", confirmedIndependentEvidence: true, now: new Date(createdAt.getTime() + 8 * 24 * 60 * 60 * 1000) })).rejects.toThrow("legacy_recovery_request_not_actionable");
      expect((await fixture.db.query("SELECT status FROM classroom_desk_account_recovery_intakes WHERE id=$1", [intake.requestId])).rows).toEqual([{ status: "expired" }]);
      expect((await fixture.db.query("SELECT profile_ciphertext,profile_recovery_status FROM classroom_desk_users WHERE id=$1", [fixture.legacy.id])).rows).toEqual([{ profile_ciphertext: fixture.ciphertext, profile_recovery_status: "ready" }]);
    } finally { fixture.sqlite.close(); }
  });
});
