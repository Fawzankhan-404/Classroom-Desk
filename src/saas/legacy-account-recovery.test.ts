import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { QueryResultRow } from "pg";
import { D1SqlDatabase } from "../public/d1-database.js";
import type { SqlConnection, SqlDatabase } from "../public/postgres.js";
import { PostgresPublicAuthStore } from "../public/postgres.js";
import { SaaSStore } from "./store.js";
import { SaaSProfileCipher } from "./privacy.js";

function isolatedD1(): { sqlite: DatabaseSync; db: D1SqlDatabase } {
  const sqlite = new DatabaseSync(":memory:");
  for (let version = 1; version <= 14; version += 1) {
    const name = String(version).padStart(4, "0");
    const file = version === 1 ? "0001_classroom_desk.sql"
      : version === 2 ? "0002_d1_link_claims.sql"
      : version === 3 ? "0003_d1_admin_operation_markers.sql"
      : version === 4 ? "0004_d1_unique_trial_orders.sql"
      : version === 5 ? "0005_d1_billing_operation_markers.sql"
      : version === 6 ? "0006_d1_reconciliation_claims.sql"
      : version === 7 ? "0007_saas_profile_privacy.sql"
      : version === 8 ? "0008_unified_oauth_accounts.sql"
      : version === 9 ? "0009_dashboard_preference.sql"
      : version === 10 ? "0010_user_experience_preferences.sql"
      : version === 11 ? "0011_subscription_creation_reservations.sql"
      : version === 12 ? "0012_payment_refund_totals.sql"
      : version === 13 ? "0013_legacy_account_recovery.sql"
      : "0014_legacy_account_recovery_review.sql";
    sqlite.exec(readFileSync(new URL(`../../migrations/${file}`, import.meta.url), "utf8"));
    void name;
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

function transactionDatabase(db: D1SqlDatabase): SqlDatabase {
  return {
    query: <T extends QueryResultRow = Record<string, unknown>>(sql: string, values?: unknown[]) => db.query<T>(sql, values),
    transaction: <T>(run: (tx: SqlConnection) => Promise<T>) => db.transaction(run),
    batch: <T extends QueryResultRow = Record<string, unknown>>(queries: Array<{ sql: string; values?: unknown[] }>) => db.batch<T>(queries),
  };
}

const identity = { googleSubject: "synthetic-legacy-subject-001", email: "legacy-owner@example.invalid", displayName: "Synthetic Legacy Owner" };
const proof = "synthetic-independent-owner-case-001";

async function setup() {
  const { sqlite, db } = isolatedD1();
  const oldKey = randomBytes(32).toString("base64");
  const newKey = randomBytes(32).toString("base64");
  const oldStore = new SaaSStore(db, { profileEncryptionKeyBase64: oldKey, requireProfileEncryption: true });
  const user = await oldStore.upsertGoogleIdentity({ ...identity, now: new Date("2026-10-20T00:00:00.000Z") });
  const original = (await db.query<{ profile_ciphertext: string }>("SELECT profile_ciphertext FROM classroom_desk_users WHERE id=$1", [user.id])).rows[0]!.profile_ciphertext;
  await db.query("UPDATE classroom_desk_trials SET status='active',payment_id='synthetic-trial-payment' WHERE user_id=$1", [user.id]);
  await db.query("INSERT INTO classroom_desk_subscriptions (id,user_id,plan,status,paid_through,provider_subscription_id) VALUES ($1,$2,'teacher','active',$3,$4)", ["00000000-0000-4000-8000-000000000131", user.id, "2026-12-01T00:00:00.000Z", "sub_synthetic_legacy"]);
  await db.query("INSERT INTO classroom_desk_entitlement_grants (id,user_id,plan,source,starts_at,expires_at) VALUES ($1,$2,'teacher','subscription',$3,$4)", ["00000000-0000-4000-8000-000000000132", user.id, "2026-10-01T00:00:00.000Z", "2026-12-01T00:00:00.000Z"]);
  await db.query("INSERT INTO classroom_desk_payments (id,user_id,kind,plan,amount_paise,provider_payment_id,provider_subscription_id,status) VALUES ($1,$2,'subscription','teacher',19900,$3,$4,'captured')", ["00000000-0000-4000-8000-000000000133", user.id, "pay_synthetic_legacy", "sub_synthetic_legacy"]);
  await db.query("INSERT INTO classroom_desk_connections (website_user_id,mcp_user_id) VALUES ($1,$2)", [user.id, "legacy-mcp-subject"]);
  const verifier = { verify: async (input: { accountId: string; googleSubject: string; proof: string }) =>
    input.accountId === user.id && input.googleSubject === identity.googleSubject && input.proof === proof
      ? { verifiedAccountId: user.id, verifiedGoogleSubject: identity.googleSubject, reviewerIndependent: true as const, verifiedBy: "synthetic-independent-reviewer", caseReference: "synthetic-case-reference-001" }
      : undefined };
  const store = new SaaSStore(db, { profileEncryptionKeyBase64: newKey, requireProfileEncryption: true, legacyRecoveryOwnershipVerifier: verifier });
  return { sqlite, db, oldKey, newKey, user, original, store };
}

async function begin(store: SaaSStore, accountId: string) {
  return store.requestLegacyAccountRecovery({ accountId, identity, proof, expiresAt: new Date(Date.now() + 60_000) });
}

describe("legacy encrypted account recovery", () => {
  it("recovers the original account only with fresh Google authorization and preserves billing", async () => {
    const { sqlite, db, newKey, user, original, store } = await setup();
    try {
      const billingBefore = await Promise.all([
        db.query("SELECT * FROM classroom_desk_trials WHERE user_id=$1", [user.id]),
        db.query("SELECT * FROM classroom_desk_subscriptions WHERE user_id=$1", [user.id]),
        db.query("SELECT * FROM classroom_desk_entitlement_grants WHERE user_id=$1", [user.id]),
        db.query("SELECT * FROM classroom_desk_payments WHERE user_id=$1", [user.id]),
      ]);
      const request = await begin(store, user.id);
      expect((await db.query("SELECT profile_ciphertext,profile_recovery_status FROM classroom_desk_users WHERE id=$1", [user.id])).rows).toEqual([{ profile_ciphertext: original, profile_recovery_status: "recovery_pending" }]);
      expect(sqlite.prepare("PRAGMA table_info(classroom_desk_account_recovery_requests)").all().some((column: { name: string }) => column.name === "profile_ciphertext")).toBe(false);
      const binding = await store.resolveGoogleIdentityBinding({ ...identity, now: new Date() });
      expect(binding).toMatchObject({ accountId: user.id, mcpUserId: "legacy-mcp-subject", recovery: { requestId: request.requestId } });
      const auth = new PostgresPublicAuthStore(transactionDatabase(db), newKey, "classroom_desk_auth_records");
      await auth.migrate();
      await auth.putGrantAndCode(
        { userId: binding.mcpUserId, refreshToken: "synthetic-fresh-google-refresh", scopes: ["openid", "email"], createdAt: Date.now(), updatedAt: Date.now(), googleSubject: identity.googleSubject },
        { code: "synthetic-recovery-code", clientId: "synthetic-client", userId: binding.mcpUserId, redirectUri: "https://chatgpt.com/connector/oauth/callback", challenge: "synthetic-pkce", scopes: ["mcp:tools"], expiresAt: Date.now() + 30_000 },
        binding,
      );
      const row = (await db.query<{ id: string; google_subject: string; profile_ciphertext: string; profile_recovery_status: string }>("SELECT id,google_subject,profile_ciphertext,profile_recovery_status FROM classroom_desk_users WHERE id=$1", [user.id])).rows[0]!;
      expect(row.id).toBe(user.id);
      expect(row.profile_ciphertext).not.toBe(original);
      expect(row.profile_recovery_status).toBe("ready");
      expect(new SaaSProfileCipher(newKey).open(row.profile_ciphertext)).toEqual(identity);
      expect(row.google_subject).toMatch(/^enc:[a-f0-9]{64}$/);
      expect((await db.query("SELECT status FROM classroom_desk_account_recovery_requests WHERE id=$1", [request.requestId])).rows).toEqual([{ status: "completed" }]);
      expect((await db.query("SELECT recovery_id,account_id FROM classroom_desk_account_recovery_claims WHERE recovery_id=$1", [request.requestId])).rows).toEqual([{ recovery_id: request.requestId, account_id: user.id }]);
      expect(await auth.getGrant(binding.mcpUserId)).toMatchObject({ refreshToken: "synthetic-fresh-google-refresh", googleSubject: identity.googleSubject });
      expect(await auth.getCode("synthetic-recovery-code")).toMatchObject({ userId: binding.mcpUserId });
      expect(await Promise.all([
        db.query("SELECT * FROM classroom_desk_trials WHERE user_id=$1", [user.id]),
        db.query("SELECT * FROM classroom_desk_subscriptions WHERE user_id=$1", [user.id]),
        db.query("SELECT * FROM classroom_desk_entitlement_grants WHERE user_id=$1", [user.id]),
        db.query("SELECT * FROM classroom_desk_payments WHERE user_id=$1", [user.id]),
      ])).toEqual(billingBefore);
    } finally { sqlite.close(); }
  });

  it("rejects a wrong-account proof and same-email different-subject callback without mutation", async () => {
    const { sqlite, db, user, original, store } = await setup();
    try {
      const other = await db.query<{ id: string }>("INSERT INTO classroom_desk_users (google_subject,email,display_name) VALUES ($1,$2,$3) RETURNING id", ["synthetic-other-subject", identity.email, "Other synthetic account"]);
      await expect(begin(store, other.rows[0]!.id)).rejects.toThrow("legacy_account_ownership_unverified");
      await expect(store.resolveGoogleIdentityBinding({ googleSubject: "synthetic-different-subject", email: identity.email, displayName: identity.displayName, now: new Date() })).rejects.toThrow("account_recovery_required");
      expect((await db.query("SELECT profile_ciphertext,profile_recovery_status FROM classroom_desk_users WHERE id=$1", [user.id])).rows).toEqual([{ profile_ciphertext: original, profile_recovery_status: "ready" }]);
      expect((await db.query("SELECT count(*) AS count FROM classroom_desk_account_recovery_requests")).rows).toEqual([{ count: 0 }]);
    } finally { sqlite.close(); }
  });

  it("keeps unreadable records recovery-blocked when no independent verifier is configured", async () => {
    const { sqlite, db, newKey, user, original } = await setup();
    try {
      const unverifiedStore = new SaaSStore(db, { profileEncryptionKeyBase64: newKey, requireProfileEncryption: true });
      await expect(begin(unverifiedStore, user.id)).rejects.toThrow("legacy_recovery_verifier_unavailable");
      expect((await db.query("SELECT profile_ciphertext,profile_recovery_status FROM classroom_desk_users WHERE id=$1", [user.id])).rows).toEqual([{ profile_ciphertext: original, profile_recovery_status: "ready" }]);
      expect((await db.query("SELECT count(*) AS count FROM classroom_desk_account_recovery_requests")).rows).toEqual([{ count: 0 }]);
    } finally { sqlite.close(); }
  });

  it("rejects a Google subject already present on another account", async () => {
    const { sqlite, db, user, original, store } = await setup();
    try {
      await db.query("INSERT INTO classroom_desk_users (google_subject,email,display_name) VALUES ($1,$2,$3)", [identity.googleSubject, "duplicate@example.invalid", "Duplicate synthetic identity"]);
      await expect(begin(store, user.id)).rejects.toThrow("legacy_recovery_identity_conflict");
      expect((await db.query("SELECT profile_ciphertext,profile_recovery_status FROM classroom_desk_users WHERE id=$1", [user.id])).rows).toEqual([{ profile_ciphertext: original, profile_recovery_status: "ready" }]);
      expect((await db.query("SELECT count(*) AS count FROM classroom_desk_account_recovery_requests")).rows).toEqual([{ count: 0 }]);
    } finally { sqlite.close(); }
  });

  it("rejects ambiguous pending matches for the verified stable subject", async () => {
    const { sqlite, db, user, store } = await setup();
    try {
      const request = await begin(store, user.id);
      sqlite.exec("DROP INDEX classroom_desk_recovery_pending_subject_idx; DROP INDEX classroom_desk_recovery_pending_account_idx;");
      await db.query(`INSERT INTO classroom_desk_account_recovery_requests (id,account_id,google_subject_hash,expected_legacy_ciphertext_hash,proof_method,proof_reference_hash,verified_by,status,expires_at)
        SELECT $1,account_id,google_subject_hash,expected_legacy_ciphertext_hash,proof_method,proof_reference_hash,verified_by,status,expires_at FROM classroom_desk_account_recovery_requests WHERE id=$2`, ["synthetic-ambiguous-request", request.requestId]);
      await expect(store.resolveGoogleIdentityBinding({ ...identity, now: new Date() })).rejects.toThrow("legacy_recovery_ambiguous");
    } finally { sqlite.close(); }
  });

  it("rolls back profile, request, mapping, grant, and code if OAuth persistence is interrupted", async () => {
    const { sqlite, db, newKey, user, original, store } = await setup();
    try {
      const request = await begin(store, user.id);
      const binding = await store.resolveGoogleIdentityBinding({ ...identity, now: new Date() });
      const auth = new PostgresPublicAuthStore(transactionDatabase(db), newKey, "classroom_desk_auth_records");
      await auth.migrate();
      sqlite.exec("CREATE TRIGGER synthetic_interrupt_recovery BEFORE INSERT ON classroom_desk_auth_records WHEN NEW.kind='code' BEGIN SELECT RAISE(ABORT,'synthetic_interruption'); END;");
      await expect(auth.putGrantAndCode(
        { userId: binding.mcpUserId, refreshToken: "synthetic-fresh-google-refresh", scopes: ["openid"], createdAt: Date.now(), updatedAt: Date.now(), googleSubject: identity.googleSubject },
        { code: "synthetic-interrupted-code", clientId: "synthetic-client", userId: binding.mcpUserId, redirectUri: "https://chatgpt.com/connector/oauth/callback", challenge: "synthetic-pkce", scopes: ["mcp:tools"], expiresAt: Date.now() + 30_000 },
        binding,
      )).rejects.toThrow();
      expect((await db.query("SELECT profile_ciphertext,profile_recovery_status FROM classroom_desk_users WHERE id=$1", [user.id])).rows).toEqual([{ profile_ciphertext: original, profile_recovery_status: "recovery_pending" }]);
      expect((await db.query("SELECT status FROM classroom_desk_account_recovery_requests WHERE id=$1", [request.requestId])).rows).toEqual([{ status: "pending" }]);
      expect((await db.query("SELECT count(*) AS count FROM classroom_desk_account_recovery_claims")).rows).toEqual([{ count: 0 }]);
      expect((await db.query("SELECT count(*) AS count FROM classroom_desk_oauth_accounts WHERE website_user_id=$1", [user.id])).rows).toEqual([{ count: 0 }]);
      expect(await auth.getGrant(binding.mcpUserId)).toBeUndefined();
      expect(await auth.getCode("synthetic-interrupted-code")).toBeUndefined();
    } finally { sqlite.close(); }
  });
});
