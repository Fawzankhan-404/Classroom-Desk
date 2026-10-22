import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { D1SqlDatabase } from "../public/d1-database.js";
import { PostgresPublicAuthStore } from "../public/postgres.js";
import { SaaSStore } from "./store.js";
import { SaaSProfileCipher } from "./privacy.js";

function detachedIdentityD1() {
  const sqlite = new DatabaseSync(":memory:");
  for (const migration of [
    "0001_classroom_desk.sql", "0002_d1_link_claims.sql", "0003_d1_admin_operation_markers.sql",
    "0004_d1_unique_trial_orders.sql", "0005_d1_billing_operation_markers.sql", "0006_d1_reconciliation_claims.sql",
    "0007_saas_profile_privacy.sql", "0008_unified_oauth_accounts.sql", "0009_dashboard_preference.sql",
    "0010_user_experience_preferences.sql", "0011_subscription_creation_reservations.sql",
    "0012_payment_refund_totals.sql", "0013_legacy_account_recovery.sql",
    "0014_legacy_account_recovery_review.sql", "0015_detached_google_identities.sql",
  ]) sqlite.exec(readFileSync(new URL(`../../migrations/${migration}`, import.meta.url), "utf8"));

  const prepare = (sql: string, values: unknown[] = []) => ({
    all: async <T>() => {
      const statement = sqlite.prepare(sql);
      const rows = statement.columns().length ? statement.all(...values) : (statement.run(...values), []);
      return { success: true, results: rows as T[] };
    },
  });
  let batchTail = Promise.resolve();
  const binding = {
    prepare: (sql: string) => ({ bind: (...values: unknown[]) => prepare(sql, values) }),
    batch: <T>(statements: ReturnType<typeof prepare>[]) => {
      const current = batchTail.then(async () => {
        sqlite.exec("BEGIN");
        try {
          const results = [];
          for (const statement of statements) results.push(await statement.all<T>());
          sqlite.exec("COMMIT");
          return results;
        } catch (error) {
          sqlite.exec("ROLLBACK");
          throw error;
        }
      });
      batchTail = current.then(() => undefined, () => undefined);
      return current;
    },
  };
  return { sqlite, db: new D1SqlDatabase(binding) };
}

const now = new Date("2026-10-22T00:00:00.000Z");
const input = (googleSubject: string, email = "verified@example.invalid") => ({ googleSubject, email, displayName: "Synthetic Verified User", now });

describe("detached Google identity model", () => {
  let sqlite: DatabaseSync | undefined;
  afterEach(() => { sqlite?.close(); sqlite = undefined; });

  it("creates a fresh account after detachment and leaves historical billing on the original account", async () => {
    const fixture = detachedIdentityD1(); sqlite = fixture.sqlite;
    const { db } = fixture;
    const key = randomBytes(32).toString("base64");
    const cipher = new SaaSProfileCipher(key);
    const store = new SaaSStore(db, { profileEncryptionKeyBase64: key, requireProfileEncryption: true });
    const legacySubject = "synthetic-legacy-google-subject";
    const legacy = (await db.query<{ id: string }>(`INSERT INTO classroom_desk_users (google_subject,email,display_name)
      VALUES ($1,$2,$3) RETURNING id`, [legacySubject, "old@example.invalid", "Old account"])).rows[0]!;
    await db.query(`INSERT INTO classroom_desk_trials (user_id,status,starts_at,expires_at) VALUES ($1,'active',$2,$3)`, [legacy.id, "2026-10-22T00:00:00.000Z", "2026-10-29T00:00:00.000Z"]);
    await db.query(`INSERT INTO classroom_desk_subscriptions (id,user_id,plan,status,paid_through) VALUES ($1,$2,'student','active',$3)`, ["00000000-0000-4000-8000-000000000901", legacy.id, "2026-11-01T00:00:00.000Z"]);
    await db.query(`INSERT INTO classroom_desk_payments (id,user_id,kind,amount_paise,status) VALUES ($1,$2,'subscription',0,'captured')`, ["00000000-0000-4000-8000-000000000902", legacy.id]);
    const subjectHash = cipher.digest(legacySubject);
    await db.query(`INSERT INTO classroom_desk_detached_google_identities
      (account_id,google_subject,google_subject_hash,detached_at,reason) VALUES ($1,$2,$3,$4,'owner_authorized_auth_reset')`,
      [legacy.id, legacySubject, subjectHash, now]);
    await db.query(`UPDATE classroom_desk_users SET google_subject=NULL,google_subject_hash=NULL WHERE id=$1`, [legacy.id]);

    const fresh = await store.resolveGoogleIdentityBinding(input(legacySubject));
    expect(fresh.accountId).not.toBe(legacy.id);
    expect(fresh.mcpUserId).toBe(fresh.accountId);
    expect((await db.query(`SELECT google_subject,google_subject_hash FROM classroom_desk_users WHERE id=$1`, [legacy.id])).rows)
      .toEqual([{ google_subject: null, google_subject_hash: null }]);
    expect((await db.query(`SELECT count(*) AS count FROM classroom_desk_subscriptions WHERE user_id=$1`, [legacy.id])).rows).toEqual([{ count: 1 }]);
    expect((await db.query(`SELECT count(*) AS count FROM classroom_desk_payments WHERE user_id=$1`, [legacy.id])).rows).toEqual([{ count: 1 }]);
    expect((await db.query(`SELECT status,starts_at,expires_at FROM classroom_desk_trials WHERE user_id=$1`, [legacy.id])).rows)
      .toEqual([{ status: "active", starts_at: "2026-10-22T00:00:00.000Z", expires_at: "2026-10-29T00:00:00.000Z" }]);
    expect((await db.query(`SELECT status FROM classroom_desk_trials WHERE user_id=$1`, [fresh.accountId])).rows).toEqual([{ status: "eligible" }]);
  });

  it("stores a fresh verified subject only as its keyed digest and persists OAuth credentials and binding", async () => {
    const fixture = detachedIdentityD1(); sqlite = fixture.sqlite;
    const key = randomBytes(32).toString("base64");
    const cipher = new SaaSProfileCipher(key);
    const store = new SaaSStore(fixture.db, { profileEncryptionKeyBase64: key, requireProfileEncryption: true });
    const identity = input("synthetic-new-google-subject", "same@example.invalid");
    const binding = await store.resolveGoogleIdentityBinding(identity);
    const row = (await fixture.db.query<{ google_subject: string | null; google_subject_hash: string; profile_ciphertext: string }>(
      `SELECT google_subject,google_subject_hash,profile_ciphertext FROM classroom_desk_users WHERE id=$1`, [binding.accountId])).rows[0]!;
    expect(row.google_subject).toBeNull();
    expect(row.google_subject_hash).toBe(cipher.digest(identity.googleSubject));
    expect(cipher.open(row.profile_ciphertext)).toMatchObject({ googleSubject: identity.googleSubject, email: identity.email, displayName: identity.displayName });

    const auth = new PostgresPublicAuthStore(fixture.db, key, "classroom_desk_auth_records");
    await auth.migrate();
    await auth.putGrantAndCode(
      { userId: binding.mcpUserId, refreshToken: "synthetic-refresh-token", scopes: ["openid", "email"], createdAt: now.getTime(), updatedAt: now.getTime(), googleSubject: identity.googleSubject },
      { code: "synthetic-auth-code", clientId: "synthetic-client", userId: binding.mcpUserId, redirectUri: "https://chatgpt.com/connector/oauth/callback", challenge: "synthetic-pkce", scopes: ["mcp:tools"], expiresAt: Date.now() + 60_000 },
      binding,
    );
    expect(await auth.getGrant(binding.mcpUserId)).toMatchObject({ refreshToken: "synthetic-refresh-token", googleSubject: identity.googleSubject });
    expect(await auth.getCode("synthetic-auth-code")).toMatchObject({ userId: binding.mcpUserId });
    await expect(store.upsertGoogleIdentity({ ...identity, email: "renamed@example.invalid" })).resolves.toMatchObject({ id: binding.accountId });
  });

  it("restores a detached historical account only after independent owner approval", async () => {
    const fixture = detachedIdentityD1(); sqlite = fixture.sqlite;
    const key = randomBytes(32).toString("base64");
    const cipher = new SaaSProfileCipher(key);
    const store = new SaaSStore(fixture.db, { profileEncryptionKeyBase64: key, requireProfileEncryption: true });
    const identity = input("synthetic-detached-recovery-subject", "claimant@example.invalid");
    const legacy = await store.upsertGoogleIdentity(identity);
    await fixture.db.query(`UPDATE classroom_desk_trials SET status='active',starts_at=$2,expires_at=$3 WHERE user_id=$1`, [legacy.id, "2026-10-22T00:00:00.000Z", "2026-10-29T00:00:00.000Z"]);
    await fixture.db.query(`INSERT INTO classroom_desk_subscriptions (id,user_id,plan,status,paid_through) VALUES ($1,$2,'student','active',$3)`, ["00000000-0000-4000-8000-000000000911", legacy.id, "2026-11-01T00:00:00.000Z"]);
    await fixture.db.query(`INSERT INTO classroom_desk_detached_google_identities (account_id,google_subject,google_subject_hash,detached_at,reason) VALUES ($1,$2,$3,$4,'owner_authorized_auth_reset')`, [legacy.id, identity.googleSubject, cipher.digest(identity.googleSubject), new Date()]);
    await fixture.db.query(`UPDATE classroom_desk_users SET google_subject=NULL,google_subject_hash=NULL WHERE id=$1`, [legacy.id]);
    const owner = (await fixture.db.query<{ id: string }>(`INSERT INTO classroom_desk_users (google_subject,email,display_name,role) VALUES ($1,$2,$3,'SUPER_ADMIN') RETURNING id`, ["synthetic-recovery-owner", "owner@example.invalid", "Synthetic owner"])).rows[0]!;
    const recoverySession = await store.createLegacyRecoveryAccessSession(identity.googleSubject);
    const intake = await store.submitLegacyRecoveryIntake({ sessionToken: recoverySession.token, accountId: legacy.id, evidenceType: "preexisting_support_record", evidenceReference: "support-case-detached-2026-001" });

    const approval = await store.approveLegacyRecoveryIntake({ requestId: intake.requestId, reviewerId: owner.id, evidenceType: "preexisting_support_record", evidenceReference: "independently-checked-case-001", confirmedIndependentEvidence: true });
    const binding = await store.resolveGoogleIdentityBinding({ ...identity, now: new Date() });
    expect(binding).toMatchObject({ accountId: legacy.id, mcpUserId: legacy.id, recovery: { requestId: approval.recoveryRequestId } });

    const auth = new PostgresPublicAuthStore(fixture.db, key, "classroom_desk_auth_records");
    await auth.migrate();
    await auth.putGrantAndCode(
      { userId: binding.mcpUserId, refreshToken: "synthetic-restored-refresh", scopes: ["openid", "email"], createdAt: Date.now(), updatedAt: Date.now(), googleSubject: identity.googleSubject },
      { code: "synthetic-restored-code", clientId: "synthetic-client", userId: binding.mcpUserId, redirectUri: "https://chatgpt.com/connector/oauth/callback", challenge: "synthetic-pkce", scopes: ["mcp:tools"], expiresAt: Date.now() + 60_000 },
      binding,
    );
    expect(await store.getUser(legacy.id)).toMatchObject({ id: legacy.id, googleSubject: identity.googleSubject });
    expect((await fixture.db.query(`SELECT count(*) AS count FROM classroom_desk_users`)).rows).toEqual([{ count: 2 }]);
    expect((await fixture.db.query(`SELECT count(*) AS count FROM classroom_desk_subscriptions WHERE user_id=$1 AND status='active'`, [legacy.id])).rows).toEqual([{ count: 1 }]);
    expect((await fixture.db.query(`SELECT status,starts_at,expires_at FROM classroom_desk_trials WHERE user_id=$1`, [legacy.id])).rows).toEqual([{ status: "active", starts_at: "2026-10-22T00:00:00.000Z", expires_at: "2026-10-29T00:00:00.000Z" }]);
    expect(await auth.getGrant(binding.mcpUserId)).toMatchObject({ refreshToken: "synthetic-restored-refresh" });
    expect((await fixture.db.query(`SELECT status FROM classroom_desk_account_recovery_requests WHERE id=$1`, [approval.recoveryRequestId])).rows).toEqual([{ status: "completed" }]);
  });

  it("rejects corrupt duplicate subject hashes instead of selecting either account", async () => {
    const fixture = detachedIdentityD1(); sqlite = fixture.sqlite;
    const key = randomBytes(32).toString("base64");
    const cipher = new SaaSProfileCipher(key);
    const store = new SaaSStore(fixture.db, { profileEncryptionKeyBase64: key, requireProfileEncryption: true });
    const identity = input("synthetic-duplicate-subject");
    const original = await store.upsertGoogleIdentity(identity);
    const row = (await fixture.db.query<{ profile_ciphertext: string }>(`SELECT profile_ciphertext FROM classroom_desk_users WHERE id=$1`, [original.id])).rows[0]!;
    fixture.sqlite.exec("DROP INDEX classroom_desk_users_google_subject_hash_idx");
    await fixture.db.query(`INSERT INTO classroom_desk_users (google_subject,email,display_name,profile_ciphertext,google_subject_hash,email_hash,display_name_hash)
      VALUES (NULL,$1,$2,$3,$4,$5,$6)`, ["enc:other-email", "enc:other-name", row.profile_ciphertext, cipher.digest(identity.googleSubject), cipher.digest(identity.email), cipher.digest(identity.displayName)]);
    await expect(store.upsertGoogleIdentity(identity)).rejects.toThrow("google_subject_account_conflict");
  });

  it("serializes concurrent sign-ins with the unique active subject hash", async () => {
    const fixture = detachedIdentityD1(); sqlite = fixture.sqlite;
    const key = randomBytes(32).toString("base64");
    const store = new SaaSStore(fixture.db, { profileEncryptionKeyBase64: key, requireProfileEncryption: true });
    const result = await Promise.all(Array.from({ length: 8 }, () => store.upsertGoogleIdentity(input("synthetic-concurrent-subject"))));
    expect(new Set(result.map(user => user.id)).size).toBe(1);
    expect((await fixture.db.query(`SELECT count(*) AS count FROM classroom_desk_users WHERE google_subject_hash=$1`, [new SaaSProfileCipher(key).digest("synthetic-concurrent-subject")])).rows).toEqual([{ count: 1 }]);
  });
});
