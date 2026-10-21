import { DatabaseSync } from "node:sqlite";
import { createServer as createHttpServer } from "node:http";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { D1SqlDatabase, type D1BatchQuery } from "../public/d1-database.js";
import type { QueryResultRow } from "pg";
import type { SqlConnection, SqlDatabase } from "../public/postgres.js";
import { AccountLinkService } from "./linking.js";
import { PostgresPublicAuthStore } from "../public/postgres.js";
import { ReferralService } from "./referral-service.js";
import { SaaSStore } from "./store.js";
import { reconcileRecentPayments } from "./reconciliation.js";
import { OAuth2Client } from "googleapis-common";
import { PublicOAuthProvider, MCP_SCOPE, MCP_OFFLINE_SCOPE } from "../public/oauth.js";
import { PUBLIC_CLASSROOM_SCOPES } from "../scopes.js";
import { createPublicApp } from "../public/http.js";
import { resolveMcpAccess } from "./mcp-access.js";
import { SaaSProfileCipher } from "./privacy.js";

function sqliteD1(options: {
  includePublicOAuthMigrations?: boolean;
  includeExperienceMigration?: boolean;
  includeSubscriptionCreationMigration?: boolean;
  includeRefundTotalsMigration?: boolean;
  includeLegacyAccountRecoveryMigration?: boolean;
} = {}) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(new URL("../../migrations/0001_classroom_desk.sql", import.meta.url), "utf8"));
  sqlite.exec(readFileSync(new URL("../../migrations/0002_d1_link_claims.sql", import.meta.url), "utf8"));
  sqlite.exec(readFileSync(new URL("../../migrations/0003_d1_admin_operation_markers.sql", import.meta.url), "utf8"));
  sqlite.exec(readFileSync(new URL("../../migrations/0004_d1_unique_trial_orders.sql", import.meta.url), "utf8"));
  sqlite.exec(readFileSync(new URL("../../migrations/0005_d1_billing_operation_markers.sql", import.meta.url), "utf8"));
  sqlite.exec(readFileSync(new URL("../../migrations/0006_d1_reconciliation_claims.sql", import.meta.url), "utf8"));
  sqlite.exec(readFileSync(new URL("../../migrations/0007_saas_profile_privacy.sql", import.meta.url), "utf8"));
  if (options.includePublicOAuthMigrations !== false) {
    sqlite.exec(readFileSync(new URL("../../migrations/0008_unified_oauth_accounts.sql", import.meta.url), "utf8"));
    sqlite.exec(readFileSync(new URL("../../migrations/0009_dashboard_preference.sql", import.meta.url), "utf8"));
  }
  if (options.includeExperienceMigration !== false) sqlite.exec(readFileSync(new URL("../../migrations/0010_user_experience_preferences.sql", import.meta.url), "utf8"));
  if (options.includeSubscriptionCreationMigration !== false) sqlite.exec(readFileSync(new URL("../../migrations/0011_subscription_creation_reservations.sql", import.meta.url), "utf8"));
  if (options.includeRefundTotalsMigration !== false) sqlite.exec(readFileSync(new URL("../../migrations/0012_payment_refund_totals.sql", import.meta.url), "utf8"));
  if (options.includeLegacyAccountRecoveryMigration !== false) sqlite.exec(readFileSync(new URL("../../migrations/0013_legacy_account_recovery.sql", import.meta.url), "utf8"));
  const statement = (sql: string, values: unknown[] = []) => ({
    all: async <T>() => {
      const query = sqlite.prepare(sql);
      const rows = query.columns().length ? query.all(...values) : (query.run(...values), []);
      return { success: true, results: rows as T[] };
    },
  });
  let batchTail = Promise.resolve();
  const binding = {
    prepare: (sql: string) => ({ bind: (...values: unknown[]) => statement(sql, values) }),
    batch: <T>(statements: ReturnType<typeof statement>[]) => {
      const current = batchTail.then(async () => {
        sqlite.exec("BEGIN");
        try {
          const results = [];
          for (const item of statements) results.push(await item.all<T>());
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
  return { sqlite, database: new D1SqlDatabase(binding) };
}

function withBeforeD1Batch(database: D1SqlDatabase, beforeBatch: () => Promise<void>): SqlDatabase {
  return {
    query: <T extends QueryResultRow = Record<string, unknown>>(sql: string, values?: unknown[]) => database.query<T>(sql, values),
    transaction: <T>(run: (tx: SqlConnection) => Promise<T>) => database.transaction(run),
    batch: async <T extends QueryResultRow = Record<string, unknown>>(queries: D1BatchQuery[]) => {
      await beforeBatch();
      return database.batch<T>(queries);
    },
  };
}

async function adminD1Fixture(actorRole: "SUPER_ADMIN" | "SUPPORT_ADMIN" = "SUPER_ADMIN") {
  const { sqlite, database } = sqliteD1();
  const addUser = async (subject: string, role = "STUDENT") => (await database.query<{ id: string }>(
    `INSERT INTO classroom_desk_users (google_subject,email,display_name,role) VALUES ($1,$2,$3,$4) RETURNING id`,
    [subject, `${subject}@example.invalid`, subject, role],
  )).rows[0]!.id;
  const actorId = await addUser("admin-race-actor", actorRole);
  const targetId = await addUser("admin-race-target");
  return { sqlite, database, actorId, targetId, store: new SaaSStore(database) };
}

afterEach(() => vi.restoreAllMocks());

describe("D1 migration and account-link atomicity", () => {
  it("reserves subscription creation once, persists the provider ID atomically, and resumes the same pending subscription", async () => {
    const { sqlite, database } = sqliteD1();
    const userId = "00000000-0000-4000-8000-000000000097";
    const store = new SaaSStore(database);
    try {
      await database.query(`INSERT INTO classroom_desk_users (id,google_subject,email,display_name) VALUES ($1,$2,$3,$4)`, [userId, "synthetic-subscription-reservation", "reservation@example.invalid", "Synthetic Reservation"]);
      const reservations = await Promise.all([store.reserveSubscriptionCreation(userId, "student"), store.reserveSubscriptionCreation(userId, "student")]);
      expect(reservations.filter(item => item.kind === "reserved")).toHaveLength(1);
      expect(reservations.filter(item => item.kind === "blocked" && item.reason === "creation_in_progress")).toHaveLength(1);
      const created = reservations.find(item => item.kind === "reserved");
      if (!created || created.kind !== "reserved") throw new Error("reservation_missing");
      await store.completeSubscriptionCreation(userId, "student", created.requestId, "sub_d1_reservation");
      expect((await database.query(`SELECT plan,status,provider_subscription_id FROM classroom_desk_subscriptions WHERE user_id=$1`, [userId])).rows).toEqual([{ plan: "student", status: "pending", provider_subscription_id: "sub_d1_reservation" }]);
      expect((await database.query(`SELECT count(*) AS count FROM classroom_desk_subscription_creation_reservations WHERE user_id=$1`, [userId])).rows).toEqual([{ count: 0 }]);
      await expect(store.reserveSubscriptionCreation(userId, "student")).resolves.toEqual({ kind: "resume", subscriptionId: "sub_d1_reservation" });
      await database.query(`UPDATE classroom_desk_subscriptions SET status='cancelled' WHERE provider_subscription_id=$1`, ["sub_d1_reservation"]);
      const next = await store.reserveSubscriptionCreation(userId, "teacher");
      expect(next.kind).toBe("reserved");
      if (next.kind === "reserved") {
        await store.markSubscriptionCreationUnknown(userId, next.requestId);
        await expect(store.adminSubscriptionCreationReservations()).resolves.toMatchObject([{ userId, requestId: next.requestId, plan: "teacher", state: "unknown" }]);
      }
      await expect(store.reserveSubscriptionCreation(userId, "teacher")).resolves.toEqual({ kind: "blocked", reason: "creation_requires_reconciliation" });
    } finally { sqlite.close(); }
  });

  it("preserves the public 0008-0009 history and adds dashboard storage without changing account or billing rows", async () => {
    const { sqlite, database } = sqliteD1({ includePublicOAuthMigrations: false, includeExperienceMigration: false, includeSubscriptionCreationMigration: false, includeRefundTotalsMigration: false });
    const userId = "00000000-0000-4000-8000-000000000007";
    const now = "2026-10-18T00:00:00.000Z";
    try {
      expect(sqlite.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='classroom_desk_user_preferences'`).get()).toBeUndefined();
      await database.query(`INSERT INTO classroom_desk_users (id,google_subject,email,display_name) VALUES ($1,$2,$3,$4)`, [userId, "synthetic-migration-subject", "migration@example.invalid", "Synthetic Migration User"]);
      await database.query(`INSERT INTO classroom_desk_trials (user_id,payment_id,paid_at,starts_at,expires_at,status) VALUES ($1,$2,$3,$4,$5,'active')`, [userId, "synthetic-trial-payment", now, now, "2026-10-25T00:00:00.000Z"]);
      await database.query(`INSERT INTO classroom_desk_subscriptions (id,user_id,plan,status,paid_through,provider_subscription_id,created_at) VALUES ($1,$2,'student','active',$3,$4,$5)`, ["00000000-0000-4000-8000-000000000008", userId, "2026-11-18T00:00:00.000Z", "synthetic-subscription", now]);
      await database.query(`INSERT INTO classroom_desk_payments (id,user_id,kind,plan,amount_paise,provider_payment_id,provider_subscription_id,status,created_at) VALUES ($1,$2,'subscription','student',9900,$3,$4,'captured',$5)`, ["00000000-0000-4000-8000-000000000009", userId, "synthetic-payment", "synthetic-subscription", now]);
      await database.query(`INSERT INTO classroom_desk_connections (website_user_id,mcp_user_id,connected_at) VALUES ($1,$2,$3)`, [userId, "synthetic-mcp-identity", now]);

      const readExistingRows = async () => Promise.all([
        database.query(`SELECT id,google_subject,email,display_name,role,status FROM classroom_desk_users WHERE id=$1`, [userId]),
        database.query(`SELECT user_id,payment_id,paid_at,starts_at,expires_at,status FROM classroom_desk_trials WHERE user_id=$1`, [userId]),
        database.query(`SELECT id,user_id,plan,status,paid_through,provider_subscription_id FROM classroom_desk_subscriptions WHERE user_id=$1`, [userId]),
        database.query(`SELECT id,user_id,kind,plan,amount_paise,provider_payment_id,provider_subscription_id,status FROM classroom_desk_payments WHERE user_id=$1`, [userId]),
        database.query(`SELECT website_user_id,mcp_user_id,connected_at FROM classroom_desk_connections WHERE website_user_id=$1`, [userId]),
      ]);
      const before = await readExistingRows();
      sqlite.exec(readFileSync(new URL("../../migrations/0008_unified_oauth_accounts.sql", import.meta.url), "utf8"));
      sqlite.exec(readFileSync(new URL("../../migrations/0009_dashboard_preference.sql", import.meta.url), "utf8"));
      await database.query(`UPDATE classroom_desk_users SET dashboard_preference='teacher' WHERE id=$1`, [userId]);
      const migration = readFileSync(new URL("../../migrations/0010_user_experience_preferences.sql", import.meta.url), "utf8");
      sqlite.exec(migration);
      expect(await readExistingRows()).toEqual(before);

      const store = new SaaSStore(database);
      expect(await store.getDashboardExperience(userId)).toBe("teacher");
      await store.setDashboardExperience(userId, "student");
      expect(await store.getDashboardExperience(userId)).toBe("student");
      sqlite.exec(migration);
      expect((await readExistingRows())).toEqual(before);
      expect(await store.getDashboardExperience(userId)).toBe("student");
    } finally { sqlite.close(); }
  });

  it("adds migration 0011 after the public 0008-0010 schema without changing existing billing rows and is rerunnable", async () => {
    const { sqlite, database } = sqliteD1({ includeSubscriptionCreationMigration: false });
    const userId = "00000000-0000-4000-8000-000000000098";
    try {
      await database.query(`INSERT INTO classroom_desk_users (id,google_subject,email,display_name) VALUES ($1,$2,$3,$4)`, [userId, "synthetic-migration-0009", "migration-0009@example.invalid", "Synthetic Migration 0009"]);
      await database.query(`INSERT INTO classroom_desk_subscriptions (id,user_id,plan,status,provider_subscription_id) VALUES ($1,$2,'student','active',$3)`, ["00000000-0000-4000-8000-000000000099", userId, "sub_migration_0009"]);
      await database.query(`INSERT INTO classroom_desk_payments (id,user_id,kind,plan,amount_paise,provider_payment_id,provider_subscription_id,status) VALUES ($1,$2,'subscription','student',9900,$3,$4,'captured')`, ["00000000-0000-4000-8000-000000000100", userId, "pay_migration_0009", "sub_migration_0009"]);
      expect(sqlite.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='classroom_desk_subscription_creation_reservations'`).get()).toBeUndefined();
      const before = await database.query(`SELECT user_id,plan,status,provider_subscription_id FROM classroom_desk_subscriptions WHERE user_id=$1`, [userId]);
      const beforePayments = await database.query(`SELECT user_id,kind,amount_paise,provider_payment_id,status FROM classroom_desk_payments WHERE user_id=$1`, [userId]);
      const migration = readFileSync(new URL("../../migrations/0011_subscription_creation_reservations.sql", import.meta.url), "utf8");
      sqlite.exec(migration); sqlite.exec(migration);
      expect(sqlite.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='classroom_desk_subscription_creation_reservations'`).get()).toBeDefined();
      expect(await database.query(`SELECT user_id,plan,status,provider_subscription_id FROM classroom_desk_subscriptions WHERE user_id=$1`, [userId])).toEqual(before);
      expect(await database.query(`SELECT user_id,kind,amount_paise,provider_payment_id,status FROM classroom_desk_payments WHERE user_id=$1`, [userId])).toEqual(beforePayments);
      expect((await database.query(`SELECT count(*) AS count FROM classroom_desk_subscription_creation_reservations`)).rows).toEqual([{ count: 0 }]);
    } finally { sqlite.close(); }
  });

  it("backfills known full refunds when adding migration 0012 and leaves captured payments at zero", async () => {
    const { sqlite, database } = sqliteD1({ includeExperienceMigration: false, includeRefundTotalsMigration: false });
    const userId = "00000000-0000-4000-8000-000000000110";
    try {
      await database.query(`INSERT INTO classroom_desk_users (id,google_subject,email,display_name) VALUES ($1,$2,$3,$4)`, [userId, "synthetic-refund-migration", "refund-migration@example.invalid", "Synthetic Refund Migration"]);
      await database.query(`INSERT INTO classroom_desk_payments (id,user_id,kind,plan,amount_paise,provider_payment_id,status) VALUES ($1,$2,'subscription','student',9900,$3,'refunded')`, ["00000000-0000-4000-8000-000000000111", userId, "pay_synthetic_full_refund"]);
      await database.query(`INSERT INTO classroom_desk_payments (id,user_id,kind,plan,amount_paise,provider_payment_id,status) VALUES ($1,$2,'subscription','student',9900,$3,'captured')`, ["00000000-0000-4000-8000-000000000112", userId, "pay_synthetic_captured"]);

      sqlite.exec(readFileSync(new URL("../../migrations/0012_payment_refund_totals.sql", import.meta.url), "utf8"));

      expect((await database.query<{ status: string; amount_refunded_paise: number }>(`SELECT status,amount_refunded_paise FROM classroom_desk_payments WHERE user_id=$1 ORDER BY status`, [userId])).rows).toEqual([
        { status: "captured", amount_refunded_paise: 0 },
        { status: "refunded", amount_refunded_paise: 9900 },
      ]);
    } finally { sqlite.close(); }
  });

  it("stores an account-scoped dashboard preference without changing Google or platform roles", async () => {
    const { sqlite, database } = sqliteD1();
    const store = new SaaSStore(database);
    const user = await store.upsertGoogleIdentity({ googleSubject: "stable-subject-1", email: "student@example.test", displayName: "Student", now: new Date() });
    expect(await store.getDashboardExperience(user.id)).toBeNull();
    expect(await store.getClassroomMcpUserId(user.id)).toBe(user.id);
    await store.setDashboardExperience(user.id, "teacher");
    expect(await store.getDashboardExperience(user.id)).toBe("teacher");
    const roleAfterTeacherSelection = await store.getUser(user.id);
    expect(roleAfterTeacherSelection?.role).toBe("STUDENT");
    await store.setDashboardExperience(user.id, "student");
    expect(await store.getDashboardExperience(user.id)).toBe("student");
    sqlite.exec(readFileSync(new URL("../../migrations/0010_user_experience_preferences.sql", import.meta.url), "utf8"));
    expect(await store.getDashboardExperience(user.id)).toBe("student");
  });

  it("persists dynamic OAuth clients in D1 and validates authorization before starting Google consent", async () => {
    const { sqlite, database } = sqliteD1();
    const key = randomBytes(32).toString("base64");
    const authStore = new PostgresPublicAuthStore(database, key, "classroom_desk_auth_records");
    await authStore.migrate();
    const config = {
      origin: new URL("http://127.0.0.1"), mcpResource: new URL("http://127.0.0.1/mcp"),
      googleCallbackUrl: "http://127.0.0.1/oauth/google/callback", googleClientId: "synthetic-google-client",
      googleClientSecret: "synthetic-google-secret", port: 0, production: false,
    };
    const provider = new PublicOAuthProvider(authStore, config);
    const app = createPublicApp(config, authStore, provider, () => authStore.ready()).app;
    const server = createHttpServer(app);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number };
    const origin = `http://127.0.0.1:${address.port}`;
    const redirectUri = "https://chatgpt.com/connector/oauth/synthetic-d1-callback";
    try {
      const registered = await fetch(`${origin}/register`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "Synthetic ChatGPT D1 registration test", redirect_uris: [redirectUri],
          grant_types: ["authorization_code", "refresh_token"], response_types: ["code"],
          token_endpoint_auth_method: "none", scope: "mcp:tools offline_access",
        }),
      });
      expect(registered.status).toBe(201);
      const client = await registered.json() as { client_id: string };
      expect(client.client_id).toMatch(/^[0-9a-f-]{36}$/i);
      expect(await authStore.getClient(client.client_id)).toMatchObject({ client_id: client.client_id, redirect_uris: [redirectUri] });

      const authorize = async (overrides: Record<string, string> = {}) => {
        const params = new URLSearchParams({
          response_type: "code", client_id: client.client_id, redirect_uri: redirectUri,
          code_challenge: "synthetic-s256-challenge", code_challenge_method: "S256",
          state: "synthetic-oauth-state", resource: config.mcpResource.href, scope: `${MCP_SCOPE} ${MCP_OFFLINE_SCOPE}`,
          ...overrides,
        });
        return fetch(`${origin}/authorize?${params}`, { redirect: "manual" });
      };

      const accepted = await authorize();
      expect(accepted.status).toBe(302);
      expect(new URL(accepted.headers.get("location")!).pathname).toBe("/connect/google");

      const unknownClient = await authorize({ client_id: "unregistered-synthetic-client" });
      expect(unknownClient.status).toBe(400);
      expect(await unknownClient.json()).toMatchObject({ error: "invalid_client" });

      const wrongRedirect = await authorize({ redirect_uri: "https://chatgpt.com/connector/oauth/not-registered" });
      expect(wrongRedirect.status).toBe(400);
      expect(await wrongRedirect.json()).toMatchObject({ error: "invalid_request" });

      const weakPkce = await authorize({ code_challenge_method: "plain" });
      expect(weakPkce.status).toBe(302);
      expect(new URL(weakPkce.headers.get("location")!).searchParams.get("error")).toBe("invalid_request");

      const wrongResource = await authorize({ resource: "https://other.example/mcp" });
      expect(wrongResource.status).toBe(302);
      expect(new URL(wrongResource.headers.get("location")!).pathname).toBe(redirectUri.replace("https://chatgpt.com", ""));
      expect(new URL(wrongResource.headers.get("location")!).searchParams.get("error")).toBe("server_error");
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      sqlite.close();
    }
  });

  it("backfills five synthetic legacy profiles idempotently and keeps plaintext out of database reads", async () => {
    const { sqlite, database } = sqliteD1();
    const key = randomBytes(32).toString("base64");
    const store = new SaaSStore(database, { profileEncryptionKeyBase64: key, requireProfileEncryption: true });
    const fixture = Array.from({ length: 5 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      googleSubject: `synthetic-legacy-subject-${index + 1}`,
      email: `legacy-${index + 1}@example.invalid`,
      displayName: `Synthetic Legacy ${index + 1}`,
    }));
    try {
      for (const row of fixture) await database.query(`INSERT INTO classroom_desk_users (id,google_subject,email,display_name) VALUES ($1,$2,$3,$4)`, [row.id,row.googleSubject,row.email,row.displayName]);
      const beforeTrials = await database.query<{ count: number }>(`SELECT count(*) AS count FROM classroom_desk_trials`);
      const beforePayments = await database.query<{ count: number }>(`SELECT count(*) AS count FROM classroom_desk_payments`);

      expect(await store.backfillLegacyProfiles()).toBe(5);
      const encrypted = await database.query<{ id: string; google_subject: string; email: string; display_name: string; profile_ciphertext: string; google_subject_hash: string; email_hash: string; display_name_hash: string }>(
        `SELECT id,google_subject,email,display_name,profile_ciphertext,google_subject_hash,email_hash,display_name_hash FROM classroom_desk_users ORDER BY id`);
      expect(encrypted.rows).toHaveLength(5);
      for (const row of encrypted.rows) {
        expect(row.google_subject).toMatch(/^enc:[a-f0-9]{64}$/);
        expect(row.email).toMatch(/^enc:[a-f0-9]{64}$/);
        expect(row.display_name).toMatch(/^enc:[a-f0-9]{64}$/);
        expect(row.profile_ciphertext).toMatch(/^v1\./);
        expect(row.google_subject_hash).toMatch(/^[a-f0-9]{64}$/);
        expect(row.email_hash).toMatch(/^[a-f0-9]{64}$/);
        expect(row.display_name_hash).toMatch(/^[a-f0-9]{64}$/);
      }
      expect(JSON.stringify(encrypted.rows)).not.toContain("example.invalid");
      expect(JSON.stringify(encrypted.rows)).not.toContain("Synthetic Legacy");
      for (const row of fixture) expect(await store.getUser(row.id)).toMatchObject({ id: row.id, googleSubject: row.googleSubject, email: row.email, displayName: row.displayName });

      const ciphertextBeforeRetry = encrypted.rows.map(row => row.profile_ciphertext);
      expect(await store.backfillLegacyProfiles()).toBe(0);
      const ciphertextAfterRetry = await database.query<{ profile_ciphertext: string }>(`SELECT profile_ciphertext FROM classroom_desk_users ORDER BY id`);
      expect(ciphertextAfterRetry.rows.map(row => row.profile_ciphertext)).toEqual(ciphertextBeforeRetry);
      expect((await database.query(`SELECT count(*) AS count FROM classroom_desk_trials`)).rows).toEqual(beforeTrials.rows);
      expect((await database.query(`SELECT count(*) AS count FROM classroom_desk_payments`)).rows).toEqual(beforePayments.rows);
    } finally { sqlite.close(); }
  });

  it("repairs only the verified Google subject among five legacy plaintext profiles", async () => {
    const { sqlite, database } = sqliteD1();
    const key = randomBytes(32).toString("base64");
    const store = new SaaSStore(database, { profileEncryptionKeyBase64: key, requireProfileEncryption: true });
    const fixture = Array.from({ length: 5 }, (_, index) => ({
      id: "00000000-0000-4000-8000-" + String(index + 1).padStart(12, "0"),
      googleSubject: "synthetic-legacy-subject-" + (index + 1),
      email: "legacy-" + (index + 1) + "@example.invalid",
      displayName: "Synthetic Legacy " + (index + 1),
    }));
    try {
      for (const row of fixture) {
        await database.query("INSERT INTO classroom_desk_users (id,google_subject,email,display_name,role,status) VALUES ($1,$2,$3,$4,'STUDENT','active')",
          [row.id, row.googleSubject, row.email, row.displayName]);
      }
      const ids = fixture.map(row => row.id);
      const before = await database.query<{
        id: string; google_subject: string; email: string; display_name: string;
        profile_ciphertext: string | null; google_subject_hash: string | null;
        email_hash: string | null; display_name_hash: string | null;
      }>("SELECT id,google_subject,email,display_name,profile_ciphertext,google_subject_hash,email_hash,display_name_hash FROM classroom_desk_users WHERE id IN ($1,$2,$3,$4,$5) ORDER BY id", ids);

      const target = fixture[2]!;
      const binding = await store.resolveGoogleIdentityBinding({
        googleSubject: target.googleSubject,
        email: target.email,
        displayName: target.displayName,
        now: new Date("2026-10-20T00:00:00.000Z"),
      });
      expect(binding).toEqual({ accountId: target.id, mcpUserId: target.id });

      const after = await database.query<{
        id: string; google_subject: string; email: string; display_name: string;
        profile_ciphertext: string | null; google_subject_hash: string | null;
        email_hash: string | null; display_name_hash: string | null;
      }>("SELECT id,google_subject,email,display_name,profile_ciphertext,google_subject_hash,email_hash,display_name_hash FROM classroom_desk_users WHERE id IN ($1,$2,$3,$4,$5) ORDER BY id", ids);
      expect(after.rows).toHaveLength(5);
      expect(after.rows.filter(row => row.profile_ciphertext !== null)).toHaveLength(1);
      const migrated = after.rows.find(row => row.id === target.id)!;
      expect(migrated.google_subject).toMatch(/^enc:/);
      expect(migrated.email).toMatch(/^enc:/);
      expect(migrated.display_name).toMatch(/^enc:/);
      expect(migrated.profile_ciphertext).toMatch(/^v1\./);
      expect(await store.getUser(target.id)).toMatchObject({ id: target.id, ...target });
      for (const row of before.rows) {
        if (row.id !== target.id) expect(after.rows.find(candidate => candidate.id === row.id)).toEqual(row);
      }
      expect((await database.query("SELECT count(*) AS count FROM classroom_desk_users")).rows).toEqual([{ count: 5 }]);
    } finally { sqlite.close(); }
  });

  it("fails closed on a partially marked legacy profile without changing it", async () => {
    const { sqlite, database } = sqliteD1();
    const store = new SaaSStore(database, { profileEncryptionKeyBase64: randomBytes(32).toString("base64"), requireProfileEncryption: true });
    try {
      await database.query(`INSERT INTO classroom_desk_users (id,google_subject,email,display_name) VALUES ($1,$2,$3,$4)`, [
        "00000000-0000-4000-8000-000000000099", "enc:partial-marker", "legacy@example.invalid", "Synthetic Partial",
      ]);
      await expect(store.backfillLegacyProfiles()).rejects.toThrow("legacy_profile_record_unreadable");
      expect((await database.query<{ profile_ciphertext: string | null; google_subject: string; email: string; display_name: string }>(
        `SELECT profile_ciphertext,google_subject,email,display_name FROM classroom_desk_users WHERE id=$1`, ["00000000-0000-4000-8000-000000000099"]
      )).rows[0]).toEqual({ profile_ciphertext: null, google_subject: "enc:partial-marker", email: "legacy@example.invalid", display_name: "Synthetic Partial" });
    } finally { sqlite.close(); }
  });

  it("does not expose legacy plaintext profiles through strict account or admin reads", async () => {
    const { sqlite, database } = sqliteD1();
    const key = randomBytes(32).toString("base64");
    const strictStore = new SaaSStore(database, { profileEncryptionKeyBase64: key, requireProfileEncryption: true });
    const legacyStore = new SaaSStore(database);
    const firstId = "00000000-0000-4000-8000-000000000111";
    const secondId = "00000000-0000-4000-8000-000000000112";
    const firstEmail = "synthetic-legacy-one@example.invalid";
    const secondEmail = "synthetic-legacy-two@example.invalid";
    try {
      await database.query(`INSERT INTO classroom_desk_users (id,google_subject,email,display_name) VALUES ($1,$2,$3,$4)`, [
        firstId, "synthetic-legacy-subject-one", firstEmail, "Synthetic Legacy One",
      ]);
      await database.query(`INSERT INTO classroom_desk_users (id,google_subject,email,display_name) VALUES ($1,$2,$3,$4)`, [
        secondId, "synthetic-legacy-subject-two", secondEmail, "Synthetic Legacy Two",
      ]);
      await database.query(`INSERT INTO classroom_desk_payments (user_id,kind,plan,amount_paise,status) VALUES ($1,'subscription','student',9900,'paid')`, [firstId]);
      await database.query(`INSERT INTO classroom_desk_referrals (referrer_user_id,referred_user_id,code) VALUES ($1,$2,'SYNTHETIC-CODE')`, [firstId, secondId]);

      await expect(strictStore.getUser(firstId)).rejects.toThrow("stored_profile_unavailable");
      await expect(legacyStore.getUser(firstId)).resolves.toMatchObject({ email: firstEmail, displayName: "Synthetic Legacy One" });

      const adminUsers = await strictStore.listUsers();
      const adminPayments = await strictStore.adminPayments();
      const adminReferrals = await strictStore.adminReferrals();
      const serialized = JSON.stringify({ adminUsers, adminPayments, adminReferrals });
      expect(serialized).not.toContain(firstEmail);
      expect(serialized).not.toContain(secondEmail);
      expect(serialized).not.toContain("synthetic-legacy-subject");
      expect(serialized).not.toContain("Synthetic Legacy One");
      expect(serialized).not.toContain("Synthetic Legacy Two");
      expect(adminUsers.find((user) => user.id === firstId)).toMatchObject({ email: "Profile unavailable", displayName: "Profile unavailable", googleSubject: "" });
      expect(adminPayments.find((payment) => payment.userId === firstId)?.email).toBe("Profile unavailable");
      expect(adminReferrals[0]).toMatchObject({ referrerEmail: "Profile unavailable", referredEmail: "Profile unavailable" });
    } finally { sqlite.close(); }
  });

  it("can scope staging backfill to synthetic subjects and preserve all other legacy rows", async () => {
    const { sqlite, database } = sqliteD1();
    const store = new SaaSStore(database, { profileEncryptionKeyBase64: randomBytes(32).toString("base64"), requireProfileEncryption: true });
    try {
      await database.query(`INSERT INTO classroom_desk_users (id,google_subject,email,display_name) VALUES ($1,$2,$3,$4)`, [
        "00000000-0000-4000-8000-000000000101", "real-stage-subject-redacted", "stage@example.invalid", "Preserved Existing Stage Row",
      ]);
      await database.query(`INSERT INTO classroom_desk_users (id,google_subject,email,display_name) VALUES ($1,$2,$3,$4)`, [
        "00000000-0000-4000-8000-000000000102", "synthetic-legacy-case-1", "synthetic@example.invalid", "Synthetic Legacy Case",
      ]);
      expect(await store.backfillLegacyProfiles(10, "synthetic-legacy-case-")).toBe(1);
      const rows = await database.query<{ google_subject: string; profile_ciphertext: string | null }>(`SELECT google_subject,profile_ciphertext FROM classroom_desk_users ORDER BY id`);
      expect(rows.rows[0]).toMatchObject({ google_subject: "real-stage-subject-redacted", profile_ciphertext: null });
      expect(rows.rows[1]).toMatchObject({ google_subject: expect.stringMatching(/^enc:/), profile_ciphertext: expect.stringMatching(/^v1\./) });
      expect(await store.backfillLegacyProfiles(10, "synthetic-legacy-case-")).toBe(0);
      await expect(store.backfillLegacyProfiles(10, "synthetic%_")).rejects.toThrow("profile_backfill_prefix_invalid");
    } finally { sqlite.close(); }
  });

  it("requires a configured encryption key before legacy-profile backfill", async () => {
    const { sqlite, database } = sqliteD1();
    const store = new SaaSStore(database);
    try { await expect(store.backfillLegacyProfiles()).rejects.toThrow("profile_encryption_configuration_unavailable"); }
    finally { sqlite.close(); }
  });

  it("keeps different Google subjects isolated even when verified emails match", async () => {
    const { sqlite, database } = sqliteD1();
    const key = randomBytes(32).toString("base64");
    const store = new SaaSStore(database, { profileEncryptionKeyBase64: key, requireProfileEncryption: true });
    const cipher = new SaaSProfileCipher(key);
    try {
      const first = await store.upsertGoogleIdentity({ googleSubject: "synthetic-subject-one", email: "same@example.invalid", displayName: "Account One", now: new Date() });
      const second = await store.upsertGoogleIdentity({ googleSubject: "synthetic-subject-two", email: "same@example.invalid", displayName: "Account Two", now: new Date() });
      const returning = await store.upsertGoogleIdentity({ googleSubject: "synthetic-subject-one", email: "renamed@example.invalid", displayName: "Account One Updated", now: new Date() });
      expect(first.id).not.toBe(second.id);
      expect(returning.id).toBe(first.id);
      expect((await database.query(`SELECT count(*) AS count FROM classroom_desk_users WHERE google_subject_hash IN ($1,$2)`, [cipher.digest("synthetic-subject-one"), cipher.digest("synthetic-subject-two")])).rows).toEqual([{ count: 2 }]);
    } finally { sqlite.close(); }
  });

  it("fails closed when the profile encryption key cannot validate an existing encrypted row", async () => {
    const { sqlite, database } = sqliteD1();
    try {
      const correct = randomBytes(32).toString("base64");
      const incorrect = randomBytes(32).toString("base64");
      const originalStore = new SaaSStore(database, { profileEncryptionKeyBase64: correct, requireProfileEncryption: true });
      await originalStore.upsertGoogleIdentity({ googleSubject: "synthetic-encrypted-subject", email: "encrypted@example.invalid", displayName: "Encrypted Fixture", now: new Date() });
      const rowCount = await database.query<{ count: number }>(`SELECT count(*) AS count FROM classroom_desk_users`);
      const wrongKeyStore = new SaaSStore(database, { profileEncryptionKeyBase64: incorrect, requireProfileEncryption: true });
      await expect(wrongKeyStore.upsertGoogleIdentity({ googleSubject: "another-synthetic-subject", email: "other@example.invalid", displayName: "Other Fixture", now: new Date() })).rejects.toThrow("stored_profile_unavailable");
      expect((await database.query(`SELECT count(*) AS count FROM classroom_desk_users`)).rows).toEqual(rowCount.rows);
    } finally { sqlite.close(); }
  });

  it("rejects verified-subject sign-in when a legacy row has a conflicting subject hash", async () => {
    const { sqlite, database } = sqliteD1();
    const key = randomBytes(32).toString("base64");
    const store = new SaaSStore(database, { profileEncryptionKeyBase64: key, requireProfileEncryption: true });
    const cipher = new SaaSProfileCipher(key);
    const userId = "00000000-0000-4000-8000-000000000154";
    try {
      await database.query(`INSERT INTO classroom_desk_users (id,google_subject,email,display_name,role,status)
        VALUES ($1,'synthetic-legacy-subject','legacy-conflict@example.invalid','Synthetic Conflict','STUDENT','active')`, [userId]);
      await database.query(`UPDATE classroom_desk_users SET google_subject_hash=$2 WHERE id=$1`, [userId, cipher.digest("different-synthetic-subject")]);
      const before = await database.query(`SELECT id,google_subject,email,display_name,profile_ciphertext,google_subject_hash,email_hash,display_name_hash,role,status FROM classroom_desk_users WHERE id=$1`, [userId]);

      await expect(store.upsertGoogleIdentity({
        googleSubject: "synthetic-legacy-subject",
        email: "legacy-conflict@example.invalid",
        displayName: "Synthetic Conflict",
        now: new Date("2026-10-18T00:00:00.000Z"),
      })).rejects.toThrow("google_subject_account_conflict");

      expect((await database.query(`SELECT id,google_subject,email,display_name,profile_ciphertext,google_subject_hash,email_hash,display_name_hash,role,status FROM classroom_desk_users WHERE id=$1`, [userId])).rows).toEqual(before.rows);
      expect((await database.query(`SELECT count(*) AS count FROM classroom_desk_users`)).rows).toEqual([{ count: 1 }]);
      expect((await database.query(`SELECT count(*) AS count FROM classroom_desk_trials WHERE user_id=$1`, [userId])).rows).toEqual([{ count: 0 }]);
    } finally { sqlite.close(); }
  });

  it("repairs a legacy plaintext profile on verified-subject sign-in without replacing account or billing links", async () => {
    const { sqlite, database } = sqliteD1();
    const key = randomBytes(32).toString("base64");
    const store = new SaaSStore(database, { profileEncryptionKeyBase64: key, requireProfileEncryption: true });
    const cipher = new SaaSProfileCipher(key);
    const userId = "00000000-0000-4000-8000-000000000155";
    const identity = {
      googleSubject: "synthetic-legacy-google-subject",
      email: "legacy-recovery@example.invalid",
      displayName: "Synthetic Legacy Recovery",
    };
    try {
      await database.query(`INSERT INTO classroom_desk_users (id,google_subject,email,display_name,role,status)
        VALUES ($1,$2,$3,$4,'STUDENT','active')`, [userId, identity.googleSubject, identity.email, identity.displayName]);
      await database.query(`INSERT INTO classroom_desk_trials (user_id,status,starts_at,expires_at)
        VALUES ($1,'active',$2,$3)`, [userId, "2026-10-01T00:00:00.000Z", "2026-11-01T00:00:00.000Z"]);
      await database.query(`INSERT INTO classroom_desk_subscriptions (user_id,plan,status,paid_through,provider_subscription_id)
        VALUES ($1,'student','active',$2,'sub_synthetic_legacy_preserved')`, [userId, "2026-11-01T00:00:00.000Z"]);
      await database.query(`INSERT INTO classroom_desk_payments (user_id,kind,plan,amount_paise,provider_payment_id,status)
        VALUES ($1,'subscription','student',9900,'pay_synthetic_legacy_preserved','paid')`, [userId]);
      await database.query(`INSERT INTO classroom_desk_connections (website_user_id,mcp_user_id,connected_at)
        VALUES ($1,'legacy-mcp-subject-preserved','2026-10-01T00:00:00.000Z')`, [userId]);

      const billingBefore = {
        trial: (await database.query(`SELECT user_id,status,starts_at,expires_at FROM classroom_desk_trials WHERE user_id=$1`, [userId])).rows,
        subscriptions: (await database.query(`SELECT user_id,plan,status,paid_through,provider_subscription_id FROM classroom_desk_subscriptions WHERE user_id=$1`, [userId])).rows,
        payments: (await database.query(`SELECT user_id,kind,plan,amount_paise,provider_payment_id,status FROM classroom_desk_payments WHERE user_id=$1`, [userId])).rows,
      };

      const binding = await store.resolveGoogleIdentityBinding({ ...identity, now: new Date("2026-10-18T00:00:00.000Z") });
      expect(binding).toEqual({ accountId: userId, mcpUserId: "legacy-mcp-subject-preserved" });
      expect(await store.getUser(userId)).toMatchObject({ id: userId, ...identity, role: "STUDENT", status: "active" });

      const stored = await database.query<{
        id: string; google_subject: string; email: string; display_name: string; profile_ciphertext: string;
        google_subject_hash: string; email_hash: string; display_name_hash: string; role: string; status: string;
      }>(`SELECT id,google_subject,email,display_name,profile_ciphertext,google_subject_hash,email_hash,display_name_hash,role,status
         FROM classroom_desk_users WHERE id=$1`, [userId]);
      expect(stored.rows[0]).toMatchObject({
        id: userId,
        google_subject: expect.stringMatching(/^enc:/),
        email: expect.stringMatching(/^enc:/),
        display_name: expect.stringMatching(/^enc:/),
        profile_ciphertext: expect.stringMatching(/^v1\./),
        google_subject_hash: cipher.digest(identity.googleSubject),
        email_hash: cipher.digest(identity.email.toLowerCase()),
        display_name_hash: cipher.digest(identity.displayName),
        role: "STUDENT",
        status: "active",
      });
      expect(JSON.stringify(stored.rows)).not.toContain(identity.googleSubject);
      expect(JSON.stringify(stored.rows)).not.toContain(identity.email);
      expect(JSON.stringify(stored.rows)).not.toContain(identity.displayName);
      expect((await database.query(`SELECT id FROM classroom_desk_users WHERE google_subject_hash=$1`, [cipher.digest(identity.googleSubject)])).rows).toEqual([{ id: userId }]);
      expect((await database.query(`SELECT website_user_id,mcp_user_id,connected_at FROM classroom_desk_connections WHERE website_user_id=$1`, [userId])).rows).toEqual([
        { website_user_id: userId, mcp_user_id: "legacy-mcp-subject-preserved", connected_at: "2026-10-01T00:00:00.000Z" },
      ]);
      expect({
        trial: (await database.query(`SELECT user_id,status,starts_at,expires_at FROM classroom_desk_trials WHERE user_id=$1`, [userId])).rows,
        subscriptions: (await database.query(`SELECT user_id,plan,status,paid_through,provider_subscription_id FROM classroom_desk_subscriptions WHERE user_id=$1`, [userId])).rows,
        payments: (await database.query(`SELECT user_id,kind,plan,amount_paise,provider_payment_id,status FROM classroom_desk_payments WHERE user_id=$1`, [userId])).rows,
      }).toEqual(billingBefore);
    } finally { sqlite.close(); }
  });

  it("binds a verified OAuth subject to an encrypted D1 account and serves MCP status and courses without a pairing row", async () => {
    const { sqlite, database } = sqliteD1();
    const port = 0;
    const origin = "http://127.0.0.1";
    const key = randomBytes(32).toString("base64");
    const userStore = new SaaSStore(database, { profileEncryptionKeyBase64: key, requireProfileEncryption: true });
    const expectedIdentity = { googleSubject: "synthetic-google-subject-2026", email: "reviewer@example.invalid", displayName: "Synthetic Reviewer" };
    try {
      const user = await userStore.upsertGoogleIdentity({ ...expectedIdentity, now: new Date() });
      await database.query(`UPDATE classroom_desk_trials SET status='active',starts_at=$2,expires_at=$3 WHERE user_id=$1`, [user.id, new Date(Date.now() - 60_000), new Date(Date.now() + 60_000)]);
      const privateRow = await database.query<{ google_subject: string; email: string; display_name: string; profile_ciphertext: string; google_subject_hash: string }>(`SELECT google_subject,email,display_name,profile_ciphertext,google_subject_hash FROM classroom_desk_users WHERE id=$1`, [user.id]);
      expect(privateRow.rows[0]).toMatchObject({ google_subject: expect.stringMatching(/^enc:/), email: expect.stringMatching(/^enc:/), display_name: expect.stringMatching(/^enc:/), profile_ciphertext: expect.stringMatching(/^v1\./), google_subject_hash: expect.stringMatching(/^[a-f0-9]{64}$/) });
      expect(JSON.stringify(privateRow.rows)).not.toContain(expectedIdentity.email);

      const authStore = new PostgresPublicAuthStore(database, key, "classroom_desk_auth_records");
      await authStore.migrate();
      const identityScopes = [...PUBLIC_CLASSROOM_SCOPES, "https://www.googleapis.com/auth/drive.file", "openid", "email"];
      const scopeValidator = (scopes: string[]) => scopes.length === identityScopes.length && identityScopes.every(scope => scopes.includes(scope));
      const provider = new PublicOAuthProvider(authStore, {
        origin: new URL(origin), mcpResource: new URL(`${origin}/mcp`), googleCallbackUrl: `${origin}/oauth/google/callback`,
        googleClientId: "synthetic-google-client", googleClientSecret: "synthetic-google-secret", googleScopes: identityScopes,
        googleGrantValidator: scopeValidator, googleStoredGrantValidator: scopeValidator,
        googleIdentityResolver: identity => userStore.resolveGoogleIdentityBinding({ ...identity, now: new Date() }),
      });
      const flow = {
        id: "synthetic-d1-flow", userId: "temporary-mcp-subject", client: { client_id: "synthetic-mcp-client", redirect_uris: [`${origin}/callback`] } as never,
        params: { state: "synthetic-client-state", scopes: [MCP_SCOPE, MCP_OFFLINE_SCOPE], codeChallenge: "synthetic-challenge", redirectUri: `${origin}/callback` },
        googleState: "synthetic-google-state", googleVerifier: "synthetic-verifier", googleNonce: "synthetic-nonce", expiresAt: Date.now() + 60_000, started: false,
      };
      await authStore.putFlow(flow);
      const googleUrl = new URL(await provider.beginGoogle(flow.id));
      expect(googleUrl.searchParams.get("nonce")).toBe(flow.googleNonce);
      const getGoogleToken = vi.spyOn(OAuth2Client.prototype, "getToken").mockResolvedValue({ tokens: { access_token: "synthetic-access", refresh_token: "synthetic-refresh", id_token: "synthetic-id-token", scope: identityScopes.join(" ") } } as never);
      const verifyGoogleToken = vi.spyOn(OAuth2Client.prototype, "verifyIdToken").mockResolvedValue({ getPayload: () => ({ iss: "https://accounts.google.com", aud: "synthetic-google-client", exp: Math.floor(Date.now() / 1000) + 300, iat: Math.floor(Date.now() / 1000), nonce: flow.googleNonce, sub: expectedIdentity.googleSubject, email: expectedIdentity.email, email_verified: true, name: expectedIdentity.displayName }) } as never);
      const callback = new URL(await provider.completeGoogle(flow.googleState, "synthetic-google-code", undefined));
      const code = callback.searchParams.get("code")!;
      const tokens = await provider.exchangeAuthorizationCode({ client_id: "synthetic-mcp-client" } as never, code, undefined, flow.params.redirectUri, new URL(`${origin}/mcp`));
      expect(await authStore.getGrant(user.id)).toMatchObject({ refreshToken: "synthetic-refresh" });
      expect(await provider.verifyAccessToken(tokens.access_token)).toMatchObject({ extra: { userId: user.id } });
      const reconnect = { ...flow, id: "synthetic-d1-reconnect", googleState: "synthetic-google-state-reconnect", googleNonce: "synthetic-nonce-reconnect", started: false };
      await authStore.putFlow(reconnect);
      const reconnectUrl = new URL(await provider.beginGoogle(reconnect.id));
      expect(reconnectUrl.searchParams.get("nonce")).toBe(reconnect.googleNonce);
      getGoogleToken.mockResolvedValueOnce({ tokens: { access_token: "synthetic-access-reconnect", id_token: "synthetic-id-token-reconnect", scope: identityScopes.join(" ") } } as never);
      verifyGoogleToken.mockResolvedValueOnce({ getPayload: () => ({ iss: "https://accounts.google.com", aud: "synthetic-google-client", exp: Math.floor(Date.now() / 1000) + 300, iat: Math.floor(Date.now() / 1000), nonce: reconnect.googleNonce, sub: expectedIdentity.googleSubject, email: expectedIdentity.email, email_verified: true, name: expectedIdentity.displayName }) } as never);
      const reconnectRedirect = new URL(await provider.completeGoogle(reconnect.googleState, "synthetic-google-code-reconnect", undefined));
      await provider.exchangeAuthorizationCode({ client_id: "synthetic-mcp-client" } as never, reconnectRedirect.searchParams.get("code")!, undefined, reconnect.params.redirectUri, new URL(`${origin}/mcp`));
      expect(await authStore.getGrant(user.id)).toMatchObject({ refreshToken: "synthetic-refresh" });
      expect(await resolveMcpAccess(userStore, user.id)).toMatchObject({ allowed: true, reason: "active_trial" });
      expect((await userStore.accountStatusForMcpUser(user.id, origin)).state).toBe("TRIAL_ACTIVE");
      expect((await database.query<{ website_user_id: string; mcp_user_id: string }>(`SELECT website_user_id,mcp_user_id FROM classroom_desk_connections WHERE website_user_id=$1`, [user.id])).rows).toEqual([{ website_user_id: user.id, mcp_user_id: user.id }]);

      const app = createPublicApp({ origin: new URL(origin), mcpResource: new URL(`${origin}/mcp`), googleCallbackUrl: `${origin}/oauth/google/callback`, googleClientId: "synthetic-google-client", googleClientSecret: "synthetic-google-secret", port, production: true, saasFlags: { enforceEntitlements: true } } as never,
        authStore, provider, undefined,
        () => ({ classroom: { courses: { list: async () => ({ data: { courses: [{ id: "synthetic-course-1", name: "Synthetic D1 Course" }] } }) } } } as never),
        { entitlementCheck: subject => resolveMcpAccess(userStore, subject) }).app;
      const server = createHttpServer(app);
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
      const address = server.address() as { port: number };
      const testOrigin = `http://127.0.0.1:${address.port}`;
      const headers = { authorization: `Bearer ${tokens.access_token}`, "content-type": "application/json", accept: "application/json, text/event-stream" };
      try {
        const initialize = await fetch(`${testOrigin}/mcp`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "d1-oauth-test", version: "1" } } }) });
        expect(initialize.status).toBe(200);
        const status = await fetch(`${testOrigin}/mcp`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "classroom_desk_status", arguments: {} } }) });
        expect(await status.text()).toContain('"allowed":true');
        const courses = await fetch(`${testOrigin}/mcp`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_courses", arguments: {} } }) });
        expect(courses.status).toBe(200);
        expect(await courses.text()).toContain("Synthetic D1 Course");
      } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
    } finally { sqlite.close(); }
  });

  it("reuses a legacy MCP connection mapping and rejects a conflicting account binding without writing grants or codes", async () => {
    const { sqlite, database } = sqliteD1();
    const key = randomBytes(32).toString("base64");
    const users = new SaaSStore(database, { profileEncryptionKeyBase64: key, requireProfileEncryption: true });
    const authStore = new PostgresPublicAuthStore(database, key, "classroom_desk_auth_records");
    try {
      const user = await users.upsertGoogleIdentity({ googleSubject: "legacy-google-subject", email: "legacy@example.invalid", displayName: "Legacy", now: new Date() });
      await database.query(`INSERT INTO classroom_desk_connections (website_user_id,mcp_user_id,connected_at) VALUES ($1,$2,$3)`, [user.id, "legacy-mcp-subject", new Date()]);
      const entitlementNow = new Date("2026-10-20T00:00:00.000Z");
      await database.query(`INSERT INTO classroom_desk_entitlement_grants (user_id,plan,source,starts_at,expires_at) VALUES ($1,'teacher','manual',$2,$3)`, [user.id, new Date("2026-10-19T00:00:00.000Z"), new Date("2026-11-20T00:00:00.000Z")]);
      expect(await users.resolveGoogleIdentityBinding({ googleSubject: "legacy-google-subject", email: "legacy@example.invalid", displayName: "Legacy", now: new Date() })).toEqual({ accountId: user.id, mcpUserId: "legacy-mcp-subject" });
      expect(await users.entitlementForMcpUser("legacy-mcp-subject", entitlementNow)).toMatchObject({ allowed: true, reason: "active_grant", plan: "teacher" });
      expect(await users.entitlement("legacy-mcp-subject", entitlementNow)).toMatchObject({ allowed: false, reason: "none", plan: null });

      await authStore.migrate();
      await expect(authStore.putGrantAndCode(
        { userId: "replacement-mcp-subject", refreshToken: "synthetic-refresh", scopes: ["openid"], createdAt: Date.now(), updatedAt: Date.now() },
        { code: "synthetic-conflicting-code", clientId: "synthetic-client", userId: "replacement-mcp-subject", redirectUri: "https://example.invalid/callback", challenge: "synthetic-challenge", scopes: ["mcp"], expiresAt: Date.now() + 30_000 },
        { accountId: user.id, mcpUserId: "replacement-mcp-subject" },
      )).rejects.toThrow("oauth_account_binding_conflict");

      expect((await database.query<{ mcp_user_id: string }>(`SELECT mcp_user_id FROM classroom_desk_connections WHERE website_user_id=$1`, [user.id])).rows).toEqual([{ mcp_user_id: "legacy-mcp-subject" }]);
      expect(await authStore.getGrant("replacement-mcp-subject")).toBeUndefined();
      expect(await authStore.getCode("synthetic-conflicting-code")).toBeUndefined();
    } finally { sqlite.close(); }
  });

  it("prefers the existing unified OAuth mapping while preserving a distinct legacy pairing mapping", async () => {
    const { sqlite, database } = sqliteD1();
    const key = randomBytes(32).toString("base64");
    const users = new SaaSStore(database, { profileEncryptionKeyBase64: key, requireProfileEncryption: true });
    const authStore = new PostgresPublicAuthStore(database, key, "classroom_desk_auth_records");
    try {
      const user = await users.upsertGoogleIdentity({ googleSubject: "synthetic-dual-map-google", email: "dual-map@example.invalid", displayName: "Synthetic Dual Map", now: new Date() });
      const unifiedId = `cd-account:${user.id}`;
      await database.query(`INSERT INTO classroom_desk_connections (website_user_id,mcp_user_id,connected_at) VALUES ($1,$2,$3)`, [user.id, "legacy-opaque-subject", new Date()]);
      await database.query(`INSERT INTO classroom_desk_oauth_accounts (website_user_id,mcp_user_id,connected_at) VALUES ($1,$2,$3)`, [user.id, unifiedId, new Date()]);
      expect(await users.resolveGoogleIdentityBinding({ googleSubject: user.googleSubject, email: user.email, displayName: user.displayName, now: new Date() })).toEqual({ accountId: user.id, mcpUserId: unifiedId });
      expect(await users.getLinkedMcpUserId(user.id)).toBe(unifiedId);
      expect(await users.getLegacyMcpUserId(user.id)).toBe("legacy-opaque-subject");

      await authStore.migrate();
      await authStore.putGrantAndCode(
        { userId: unifiedId, refreshToken: "synthetic-refresh", scopes: ["openid", "email"], createdAt: Date.now(), updatedAt: Date.now(), googleSubject: "synthetic-dual-map-google" },
        { code: "synthetic-dual-map-code", clientId: "synthetic-client", userId: unifiedId, redirectUri: "https://chatgpt.com/connector/oauth/callback", challenge: "synthetic-pkce-challenge", scopes: ["mcp:tools"], expiresAt: Date.now() + 30_000 },
        { accountId: user.id, mcpUserId: unifiedId },
      );

      expect(await authStore.getGrant(unifiedId)).toMatchObject({ userId: unifiedId, refreshToken: "synthetic-refresh", googleSubject: "synthetic-dual-map-google" });
      expect(await authStore.getCode("synthetic-dual-map-code")).toMatchObject({ userId: unifiedId });
      expect((await database.query<{ mcp_user_id: string }>(`SELECT mcp_user_id FROM classroom_desk_connections WHERE website_user_id=$1`, [user.id])).rows).toEqual([{ mcp_user_id: "legacy-opaque-subject" }]);
      expect((await database.query<{ mcp_user_id: string }>(`SELECT mcp_user_id FROM classroom_desk_oauth_accounts WHERE website_user_id=$1`, [user.id])).rows).toEqual([{ mcp_user_id: unifiedId }]);
      expect(await users.accountStatusForMcpUser(unifiedId, "https://classroom.jarvis404.com")).not.toMatchObject({ state: "ACCOUNT_SETUP_REQUIRED" });
    } finally { sqlite.close(); }
  });

  it("supports OAuth account binding on the 0001-0007 schema without the optional unified mapping table", async () => {
    const { sqlite, database } = sqliteD1({ includePublicOAuthMigrations: false });
    const key = randomBytes(32).toString("base64");
    const users = new SaaSStore(database, { profileEncryptionKeyBase64: key, requireProfileEncryption: true });
    const authStore = new PostgresPublicAuthStore(database, key, "classroom_desk_auth_records");
    try {
      const user = await users.upsertGoogleIdentity({ googleSubject: "synthetic-legacy-schema", email: "legacy-schema@example.invalid", displayName: "Synthetic Legacy Schema", now: new Date() });
      const binding = await users.resolveGoogleIdentityBinding({ googleSubject: user.googleSubject, email: user.email, displayName: user.displayName, now: new Date() });
      expect(binding).toEqual({ accountId: user.id, mcpUserId: user.id });
      await authStore.migrate();
      await authStore.putGrantAndCode(
        { userId: binding.mcpUserId, refreshToken: "synthetic-legacy-refresh", scopes: ["openid"], createdAt: Date.now(), updatedAt: Date.now(), googleSubject: "synthetic-legacy-schema" },
        { code: "synthetic-legacy-schema-code", clientId: "synthetic-client", userId: binding.mcpUserId, redirectUri: "https://chatgpt.com/connector/oauth/callback", challenge: "synthetic-pkce-challenge", scopes: ["mcp:tools"], expiresAt: Date.now() + 30_000 },
        binding,
      );
      expect((await database.query<{ mcp_user_id: string }>(`SELECT mcp_user_id FROM classroom_desk_connections WHERE website_user_id=$1`, [user.id])).rows).toEqual([{ mcp_user_id: user.id }]);
      expect(await authStore.getGrant(user.id)).toMatchObject({ refreshToken: "synthetic-legacy-refresh", googleSubject: "synthetic-legacy-schema" });
      expect(await users.accountStatusForMcpUser(user.id, "https://classroom.jarvis404.com")).not.toMatchObject({ state: "ACCOUNT_SETUP_REQUIRED" });
    } finally { sqlite.close(); }
  });
  it("creates a user, consumes one pairing code once, and rejects cross-account reassignment", async () => {
    const { sqlite, database } = sqliteD1();
    try {
      const first = await database.query<{ id: string }>(`INSERT INTO classroom_desk_users (google_subject,email,display_name) VALUES ($1,$2,$3) RETURNING id`, ["synthetic-one", "one@example.invalid", "One"]);
      const second = await database.query<{ id: string }>(`INSERT INTO classroom_desk_users (google_subject,email,display_name) VALUES ($1,$2,$3) RETURNING id`, ["synthetic-two", "two@example.invalid", "Two"]);
      const service = new AccountLinkService(database);
      const code = await service.start(first.rows[0]!.id, new Date("2026-10-14T00:00:00.000Z"));
      expect(await service.consume(code.code, "same-mcp-user", new Date("2026-10-14T00:01:00.000Z"))).toBe(true);
      expect(await service.consume(code.code, "same-mcp-user", new Date("2026-10-14T00:02:00.000Z"))).toBe(false);
      const secondCode = await service.start(second.rows[0]!.id, new Date("2026-10-14T00:00:00.000Z"));
      expect(await service.consume(secondCode.code, "same-mcp-user", new Date("2026-10-14T00:01:00.000Z"))).toBe(false);
      expect((await database.query<{ website_user_id: string }>(`SELECT website_user_id FROM classroom_desk_connections WHERE mcp_user_id=$1`, ["same-mcp-user"])).rows).toEqual([{ website_user_id: first.rows[0]!.id }]);
    } finally { sqlite.close(); }
  });

  it("allows exactly one concurrent consumer for the same pairing code", async () => {
    const { sqlite, database } = sqliteD1();
    try {
      const user = await database.query<{ id: string }>(`INSERT INTO classroom_desk_users (google_subject,email,display_name) VALUES ($1,$2,$3) RETURNING id`, ["synthetic-race", "race@example.invalid", "Race"]);
      const service = new AccountLinkService(database);
      const code = await service.start(user.rows[0]!.id, new Date("2026-10-14T00:00:00.000Z"));
      const outcomes = await Promise.all([
        service.consume(code.code, "race-mcp-user", new Date("2026-10-14T00:01:00.000Z")),
        service.consume(code.code, "race-mcp-user", new Date("2026-10-14T00:01:00.001Z")),
      ]);
      expect(outcomes.filter(Boolean)).toHaveLength(1);
      expect((await database.query(`SELECT website_user_id FROM classroom_desk_connections WHERE mcp_user_id=$1`, ["race-mcp-user"])).rows).toHaveLength(1);
    } finally { sqlite.close(); }
  });

  it("stores encrypted OAuth tokens and rotates a refresh token once with D1 batches", async () => {
    const { sqlite, database } = sqliteD1();
    try {
      const key = randomBytes(32).toString("base64");
      const store = new PostgresPublicAuthStore(database, key, "classroom_desk_auth_records");
      await store.migrate();
      const now = Date.now();
      await store.putTokenPair(
        { token: "d1-access-old", clientId: "client-a", userId: "user-a", scopes: ["mcp:tools"], expiresAt: now + 60_000 },
        { token: "d1-refresh-old", clientId: "client-a", userId: "user-a", scopes: ["mcp:tools"], expiresAt: now + 600_000 },
      );
      const rotations = await Promise.all([
        store.rotateTokenPair("d1-refresh-old", "client-a", { token: "d1-access-a", clientId: "client-a", userId: "user-a", scopes: ["mcp:tools"], expiresAt: now + 90_000 }, { token: "d1-refresh-a", clientId: "client-a", userId: "user-a", scopes: ["mcp:tools"], expiresAt: now + 900_000 }),
        store.rotateTokenPair("d1-refresh-old", "client-a", { token: "d1-access-b", clientId: "client-a", userId: "user-a", scopes: ["mcp:tools"], expiresAt: now + 90_000 }, { token: "d1-refresh-b", clientId: "client-a", userId: "user-a", scopes: ["mcp:tools"], expiresAt: now + 900_000 }),
      ]);
      expect(rotations.filter(Boolean)).toHaveLength(1);
      expect(await store.getRefresh("d1-refresh-old")).toBeUndefined();
      const winner = rotations[0] ? "a" : "b";
      expect((await store.getRefresh(`d1-refresh-${winner}`))?.userId).toBe("user-a");
      expect(await store.rotateTokenPair("d1-refresh-old", "client-a", { token: "d1-access-replay", clientId: "client-a", userId: "user-a", scopes: ["mcp:tools"], expiresAt: now + 90_000 }, { token: "d1-refresh-replay", clientId: "client-a", userId: "user-a", scopes: ["mcp:tools"], expiresAt: now + 900_000 })).toBe(false);
      const stored = await database.query<{ payload: string }>(`SELECT payload FROM classroom_desk_auth_records`);
      expect(JSON.stringify(stored.rows)).not.toContain("d1-refresh-");
      expect(JSON.stringify(stored.rows)).not.toContain("d1-access-");
    } finally { sqlite.close(); }
  });

  it("attributes referrals atomically and enforces new-customer eligibility", async () => {
    const { sqlite, database } = sqliteD1();
    try {
      const makeUser = async (subject: string) => (await database.query<{ id: string }>(`INSERT INTO classroom_desk_users (google_subject,email,display_name) VALUES ($1,$2,$3) RETURNING id`, [subject, `${subject}@example.invalid`, subject])).rows[0]!.id;
      const referrerId = await makeUser("referrer");
      const referredId = await makeUser("referred");
      const paidId = await makeUser("paid-customer");
      const referrals = new ReferralService(database);
      const code = await referrals.ensureCode(referrerId);
      const concurrent = await Promise.allSettled([referrals.attribute(code, referredId), referrals.attribute(code, referredId)]);
      expect(concurrent.filter(result => result.status === "fulfilled")).toHaveLength(1);
      expect(concurrent.filter(result => result.status === "rejected" && (result.reason as Error).message === "referral_already_attributed")).toHaveLength(1);
      await expect(referrals.attribute(code, referrerId)).rejects.toThrow("invalid_referral");
      await database.query(`INSERT INTO classroom_desk_payments (user_id,kind,plan,amount_paise,status) VALUES ($1,'subscription','student',9900,'refunded')`, [paidId]);
      await expect(referrals.attribute(code, paidId)).rejects.toThrow("referral_requires_new_customer");
      await expect(referrals.attribute("CD-UNKNOWN", await makeUser("unknown-referral"))).rejects.toThrow("invalid_referral");
    } finally { sqlite.close(); }
  });

  it("keeps D1 admin access, role, status, and audit writes in atomic batches", async () => {
    const { sqlite, database } = sqliteD1();
    try {
      const addUser = async (subject: string, role = "STUDENT") => (await database.query<{ id: string }>(`INSERT INTO classroom_desk_users (google_subject,email,display_name,role) VALUES ($1,$2,$3,$4) RETURNING id`, [subject, `${subject}@example.invalid`, subject, role])).rows[0]!.id;
      const actorId = await addUser("admin", "SUPER_ADMIN");
      const targetId = await addUser("target");
      const store = new SaaSStore(database);
      const grantId = await store.adminGrantAccess(actorId, targetId, "teacher", 60_000, "synthetic test", new Date("2026-10-14T00:00:00.000Z"));
      expect((await database.query(`SELECT id,source,plan FROM classroom_desk_entitlement_grants WHERE id=$1`, [grantId])).rows).toEqual([{ id: grantId, source: "manual", plan: "teacher" }]);
      await store.adminChangeRole(actorId, targetId, "TEACHER", "synthetic role change", new Date("2026-10-14T00:01:00.000Z"));
      await store.adminSetStatus(actorId, targetId, "suspended", "synthetic suspension", new Date("2026-10-14T00:02:00.000Z"));
      await store.adminExtendAccess(actorId, grantId, 60_000, "synthetic extension", new Date("2026-10-14T00:03:00.000Z"));
      await store.adminRevokeAccess(actorId, grantId, "synthetic revocation", new Date("2026-10-14T00:04:00.000Z"));
      expect((await store.getUser(targetId))?.role).toBe("TEACHER");
      expect((await store.getUser(targetId))?.status).toBe("suspended");
      const grant = await database.query<{ revoked_at: string | null; expires_at: string }>(`SELECT revoked_at,expires_at FROM classroom_desk_entitlement_grants WHERE id=$1`, [grantId]);
      expect(grant.rows[0]?.revoked_at).toBe("2026-10-14T00:04:00.000Z");
      expect(grant.rows[0]?.expires_at).toBe("2026-10-14T00:04:00.000Z");
      const audit = await database.query<{ action: string }>(`SELECT action FROM classroom_desk_admin_audit WHERE target_user_id=$1`, [targetId]);
      expect(audit.rows.map(row => row.action).sort()).toEqual(["change_role", "extend_access", "grant_access", "revoke_access", "suspend_user"]);
    } finally { sqlite.close(); }
  });

  it("prevents D1 demotion of the last active super admin without writing an audit row", async () => {
    const { sqlite, database, actorId } = await adminD1Fixture();
    try {
      const store = new SaaSStore(database);
      await expect(store.adminChangeRole(actorId, actorId, "STUDENT", "synthetic last-admin demotion"))
        .rejects.toThrow("last_super_admin_required");
      expect((await store.getUser(actorId))?.role).toBe("SUPER_ADMIN");
      expect((await database.query(`SELECT count(*) AS count FROM classroom_desk_admin_audit WHERE target_user_id=$1`, [actorId])).rows)
        .toEqual([{ count: 0 }]);
    } finally { sqlite.close(); }
  });

  it("allows D1 self-demotion when another active super admin remains", async () => {
    const { sqlite, database, actorId } = await adminD1Fixture();
    try {
      const otherId = (await database.query<{ id: string }>(`INSERT INTO classroom_desk_users (google_subject,email,display_name,role) VALUES ($1,$2,$3,'SUPER_ADMIN') RETURNING id`, ["second-super-admin", "second@example.invalid", "Second admin"])).rows[0]!.id;
      const store = new SaaSStore(database);
      await store.adminChangeRole(actorId, actorId, "STUDENT", "synthetic two-admin demotion");
      expect((await store.getUser(actorId))?.role).toBe("STUDENT");
      expect((await store.getUser(otherId))?.role).toBe("SUPER_ADMIN");
      expect((await database.query(`SELECT action FROM classroom_desk_admin_audit WHERE target_user_id=$1`, [actorId])).rows)
        .toEqual([{ action: "change_role" }]);
    } finally { sqlite.close(); }
  });

  it("rechecks active admin status when a grant actor is suspended after precheck", async () => {
    const { sqlite, database, actorId, targetId } = await adminD1Fixture();
    try {
      const interleaved = withBeforeD1Batch(database, async () => {
        await database.query(`UPDATE classroom_desk_users SET status='suspended' WHERE id=$1`, [actorId]);
      });
      await expect(new SaaSStore(interleaved).adminGrantAccess(actorId, targetId, "student", 60_000, "synthetic race"))
        .rejects.toThrow("admin_permission_required");
      expect((await database.query(`SELECT count(*) AS count FROM classroom_desk_entitlement_grants WHERE user_id=$1`, [targetId])).rows).toEqual([{ count: 0 }]);
      expect((await database.query(`SELECT count(*) AS count FROM classroom_desk_admin_audit WHERE actor_user_id=$1`, [actorId])).rows).toEqual([{ count: 0 }]);
    } finally { sqlite.close(); }
  });

  it("rechecks active support-admin status before extending a grant", async () => {
    const { sqlite, database, actorId, targetId, store } = await adminD1Fixture("SUPPORT_ADMIN");
    try {
      const at = new Date("2026-10-14T00:00:00.000Z");
      const grantId = await store.adminGrantAccess(actorId, targetId, "student", 60_000, "synthetic setup", at);
      const interleaved = withBeforeD1Batch(database, async () => {
        await database.query(`UPDATE classroom_desk_users SET status='suspended' WHERE id=$1`, [actorId]);
      });
      await expect(new SaaSStore(interleaved).adminExtendAccess(actorId, grantId, 60_000, "synthetic race", new Date(at.getTime() + 60_000)))
        .rejects.toThrow("admin_permission_required");
      expect((await database.query<{ expires_at: string }>(`SELECT expires_at FROM classroom_desk_entitlement_grants WHERE id=$1`, [grantId])).rows[0]?.expires_at)
        .toBe("2026-10-14T00:01:00.000Z");
      expect((await database.query<{ action: string }>(`SELECT action FROM classroom_desk_admin_audit WHERE actor_user_id=$1`, [actorId])).rows.map(row => row.action))
        .toEqual(["grant_access"]);
    } finally { sqlite.close(); }
  });

  it("rechecks active super-admin status before revoking a grant", async () => {
    const { sqlite, database, actorId, targetId, store } = await adminD1Fixture();
    try {
      const grantId = await store.adminGrantAccess(actorId, targetId, "student", 60_000, "synthetic setup");
      const interleaved = withBeforeD1Batch(database, async () => {
        await database.query(`UPDATE classroom_desk_users SET status='suspended' WHERE id=$1`, [actorId]);
      });
      await expect(new SaaSStore(interleaved).adminRevokeAccess(actorId, grantId, "synthetic race"))
        .rejects.toThrow("admin_permission_required");
      expect((await database.query<{ revoked_at: string | null }>(`SELECT revoked_at FROM classroom_desk_entitlement_grants WHERE id=$1`, [grantId])).rows[0]?.revoked_at).toBeNull();
      expect((await database.query<{ action: string }>(`SELECT action FROM classroom_desk_admin_audit WHERE actor_user_id=$1`, [actorId])).rows.map(row => row.action))
        .toEqual(["grant_access"]);
    } finally { sqlite.close(); }
  });

  it("rechecks super-admin role before changing another account role", async () => {
    const { sqlite, database, actorId, targetId } = await adminD1Fixture();
    try {
      const interleaved = withBeforeD1Batch(database, async () => {
        await database.query(`UPDATE classroom_desk_users SET role='SUPPORT_ADMIN' WHERE id=$1`, [actorId]);
      });
      await expect(new SaaSStore(interleaved).adminChangeRole(actorId, targetId, "TEACHER", "synthetic race"))
        .rejects.toThrow("admin_permission_required");
      expect((await new SaaSStore(database).getUser(targetId))?.role).toBe("STUDENT");
      expect((await database.query(`SELECT count(*) AS count FROM classroom_desk_admin_audit WHERE actor_user_id=$1`, [actorId])).rows).toEqual([{ count: 0 }]);
    } finally { sqlite.close(); }
  });

  it("does not revoke a grant after its expiry changes between read and batch", async () => {
    const { sqlite, database, actorId, targetId, store } = await adminD1Fixture();
    try {
      const at = new Date("2026-10-14T00:00:00.000Z");
      const grantId = await store.adminGrantAccess(actorId, targetId, "student", 60_000, "synthetic setup", at);
      const extendedExpiry = new Date(at.getTime() + 120_000);
      const interleaved = withBeforeD1Batch(database, async () => {
        await database.query(`UPDATE classroom_desk_entitlement_grants SET expires_at=$2 WHERE id=$1`, [grantId, extendedExpiry]);
      });

      await expect(new SaaSStore(interleaved).adminRevokeAccess(actorId, grantId, "synthetic race", new Date(at.getTime() + 30_000)))
        .rejects.toThrow("grant_changed_concurrently");
      const grant = await database.query<{ expires_at: string; revoked_at: string | null }>(`SELECT expires_at,revoked_at FROM classroom_desk_entitlement_grants WHERE id=$1`, [grantId]);
      expect(grant.rows[0]?.expires_at).toBe(extendedExpiry.toISOString());
      expect(grant.rows[0]?.revoked_at).toBeNull();
      expect((await database.query<{ action: string }>(`SELECT action FROM classroom_desk_admin_audit WHERE target_user_id=$1`, [targetId])).rows.map(row => row.action))
        .toEqual(["grant_access"]);
    } finally { sqlite.close(); }
  });

  it("does not audit a status update that lost its compare-and-set race", async () => {
    const { sqlite, database, actorId, targetId } = await adminD1Fixture();
    try {
      const interleaved = withBeforeD1Batch(database, async () => {
        await database.query(`UPDATE classroom_desk_users SET status='suspended' WHERE id=$1`, [targetId]);
      });

      await expect(new SaaSStore(interleaved).adminSetStatus(actorId, targetId, "suspended", "synthetic race", new Date("2026-10-14T00:01:00.000Z")))
        .rejects.toThrow("target_changed_concurrently");
      expect((await new SaaSStore(database).getUser(targetId))?.status).toBe("suspended");
      expect((await database.query(`SELECT count(*) AS count FROM classroom_desk_admin_audit WHERE target_user_id=$1`, [targetId])).rows)
        .toEqual([{ count: 0 }]);
    } finally { sqlite.close(); }
  });

  it("rechecks active admin status before changing account status", async () => {
    const { sqlite, database, actorId, targetId } = await adminD1Fixture();
    try {
      const interleaved = withBeforeD1Batch(database, async () => {
        await database.query(`UPDATE classroom_desk_users SET status='suspended' WHERE id=$1`, [actorId]);
      });
      await expect(new SaaSStore(interleaved).adminSetStatus(actorId, targetId, "suspended", "synthetic race"))
        .rejects.toThrow("admin_permission_required");
      expect((await new SaaSStore(database).getUser(targetId))?.status).toBe("active");
      expect((await database.query(`SELECT count(*) AS count FROM classroom_desk_admin_audit WHERE actor_user_id=$1`, [actorId])).rows).toEqual([{ count: 0 }]);
    } finally { sqlite.close(); }
  });

  it("rejects self-suspension by the only active super admin", async () => {
    const { sqlite, database, actorId, store } = await adminD1Fixture();
    try {
      await expect(store.adminSetStatus(actorId, actorId, "suspended", "synthetic self-suspension", new Date("2026-10-14T00:02:00.000Z")))
        .rejects.toThrow("cannot_suspend_self");
      expect((await store.getUser(actorId))?.status).toBe("active");
      expect((await database.query(`SELECT count(*) AS count FROM classroom_desk_users WHERE role='SUPER_ADMIN' AND status='active'`)).rows)
        .toEqual([{ count: 1 }]);
      expect((await database.query(`SELECT count(*) AS count FROM classroom_desk_admin_audit WHERE actor_user_id=$1`, [actorId])).rows)
        .toEqual([{ count: 0 }]);
    } finally { sqlite.close(); }
  });

  it("keeps an active super admin when two admins concurrently suspend each other", async () => {
    const { sqlite, database, actorId, targetId } = await adminD1Fixture();
    try {
      await database.query(`UPDATE classroom_desk_users SET role='SUPER_ADMIN' WHERE id=$1`, [targetId]);
      const store = new SaaSStore(database);
      const attempts = await Promise.allSettled([
        store.adminSetStatus(actorId, targetId, "suspended", "synthetic reciprocal suspension"),
        store.adminSetStatus(targetId, actorId, "suspended", "synthetic reciprocal suspension"),
      ]);
      expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
      expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
      const remaining = await database.query<{ count: number }>(`SELECT count(*) AS count FROM classroom_desk_users WHERE role='SUPER_ADMIN' AND status='active'`);
      expect(Number(remaining.rows[0]?.count)).toBe(1);
      const audit = await database.query<{ count: number }>(`SELECT count(*) AS count FROM classroom_desk_admin_audit WHERE target_user_id IN ($1,$2)`, [actorId, targetId]);
      expect(Number(audit.rows[0]?.count)).toBe(1);
    } finally { sqlite.close(); }
  });

  it("prevents support admins from suspending or restoring administrator accounts", async () => {
    const { sqlite, database } = sqliteD1();
    try {
      const addUser = async (subject: string, role: string, status = "active") => (await database.query<{ id: string }>(
        `INSERT INTO classroom_desk_users (google_subject,email,display_name,role,status) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [subject, `${subject}@example.invalid`, subject, role, status],
      )).rows[0]!.id;
      const supportId = await addUser("support-admin", "SUPPORT_ADMIN");
      const superId = await addUser("super-admin", "SUPER_ADMIN");
      const otherSupportId = await addUser("other-support-admin", "SUPPORT_ADMIN", "suspended");
      const studentId = await addUser("ordinary-user", "STUDENT");
      const store = new SaaSStore(database);
      const at = new Date("2026-10-14T00:00:00.000Z");

      await expect(store.adminSetStatus(supportId, superId, "suspended", "synthetic test", at)).rejects.toThrow("admin_target_forbidden");
      await expect(store.adminSetStatus(supportId, otherSupportId, "active", "synthetic test", at)).rejects.toThrow("admin_target_forbidden");
      expect((await store.getUser(superId))?.status).toBe("active");
      expect((await store.getUser(otherSupportId))?.status).toBe("suspended");
      expect((await database.query(`SELECT count(*) AS count FROM classroom_desk_admin_audit WHERE actor_user_id=$1`, [supportId])).rows).toEqual([{ count: 0 }]);

      await store.adminSetStatus(supportId, studentId, "suspended", "synthetic test", at);
      expect((await store.getUser(studentId))?.status).toBe("suspended");
      expect((await database.query<{ action: string }>(`SELECT action FROM classroom_desk_admin_audit WHERE actor_user_id=$1`, [supportId])).rows).toEqual([{ action: "suspend_user" }]);
    } finally { sqlite.close(); }
  });

  it("records each Razorpay trial order once and expires only its owner's pending trial", async () => {
    const { sqlite, database } = sqliteD1();
    try {
      const user = await database.query<{ id: string }>(`INSERT INTO classroom_desk_users (google_subject,email,display_name) VALUES ($1,$2,$3) RETURNING id`, ["trial-owner", "trial@example.invalid", "Trial"]);
      const other = await database.query<{ id: string }>(`INSERT INTO classroom_desk_users (google_subject,email,display_name) VALUES ($1,$2,$3) RETURNING id`, ["other-owner", "other@example.invalid", "Other"]);
      const store = new SaaSStore(database);
      const orderId = "order_d1synthetic";
      await store.recordPendingTrialOrder(user.rows[0]!.id, orderId, 900, "INR");
      await store.recordPendingTrialOrder(user.rows[0]!.id, orderId, 900, "INR");
      await expect(store.recordPendingTrialOrder(other.rows[0]!.id, orderId, 900, "INR")).rejects.toThrow("trial_order_owner_mismatch");
      await database.query(`INSERT INTO classroom_desk_trials (user_id,status,pending_at) VALUES ($1,'pending',$2)`, [user.rows[0]!.id, new Date("2026-10-14T00:00:00.000Z")]);
      expect(await store.expirePendingTrialOrder(user.rows[0]!.id, orderId)).toBe(true);
      expect(await store.expirePendingTrialOrder(user.rows[0]!.id, orderId)).toBe(false);
      expect((await database.query<{ status: string }>(`SELECT status FROM classroom_desk_trials WHERE user_id=$1`, [user.rows[0]!.id])).rows[0]?.status).toBe("eligible");
      expect((await database.query(`SELECT count(*) AS count FROM classroom_desk_payments WHERE provider_order_id=$1`, [orderId])).rows).toEqual([{ count: 1 }]);
    } finally { sqlite.close(); }
  });

  it("activates one trial atomically and honors a refund tombstone that arrived first", async () => {
    const { sqlite, database } = sqliteD1();
    try {
      const makeUser = async (subject: string) => {
        const user = await database.query<{ id: string }>(`INSERT INTO classroom_desk_users (google_subject,email,display_name) VALUES ($1,$2,$3) RETURNING id`, [subject, `${subject}@example.invalid`, subject]);
        await database.query(`INSERT INTO classroom_desk_trials (user_id,status) VALUES ($1,'eligible')`, [user.rows[0]!.id]);
        return user.rows[0]!.id;
      };
      const ownerId = await makeUser("trial-capture");
      const refundedOwnerId = await makeUser("refund-first");
      const store = new SaaSStore(database);
      const paidAt = new Date("2026-10-14T00:00:00.000Z");
      expect(await store.activateTrial(ownerId, "pay_d1capture", paidAt, 900)).toBe(true);
      expect(await store.activateTrial(ownerId, "pay_d1capture", paidAt, 900)).toBe(false);
      expect((await database.query<{ status: string }>(`SELECT status FROM classroom_desk_trials WHERE user_id=$1`, [ownerId])).rows[0]?.status).toBe("active");
      await database.query(`INSERT INTO classroom_desk_webhook_events (event_id,event_type,payload_hash,status) VALUES ($1,'internal.refund.tombstone',$2,'terminal')`, [`internal:refund-tombstone:pay_d1refundfirst`, refundedOwnerId.toLowerCase()]);
      expect(await store.activateTrial(refundedOwnerId, "pay_d1refundfirst", paidAt, 900)).toBe(false);
      expect((await database.query<{ status: string }>(`SELECT status FROM classroom_desk_trials WHERE user_id=$1`, [refundedOwnerId])).rows[0]?.status).toBe("refunded");
      expect((await database.query<{ status: string }>(`SELECT status FROM classroom_desk_payments WHERE provider_payment_id=$1`, ["pay_d1refundfirst"])).rows[0]?.status).toBe("refunded");
      const raceOwnerId = await makeUser("trial-race");
      const races = await Promise.all([
        store.activateTrial(raceOwnerId, "pay_d1racea", paidAt, 900),
        store.activateTrial(raceOwnerId, "pay_d1raceb", paidAt, 900),
      ]);
      expect(races.filter(Boolean)).toHaveLength(1);
      const raceTrial = await database.query<{ status: string; payment_id: string; starts_at: string; expires_at: string }>(`SELECT status,payment_id,starts_at,expires_at FROM classroom_desk_trials WHERE user_id=$1`, [raceOwnerId]);
      expect(raceTrial.rows[0]?.status).toBe("active");
      expect(["pay_d1racea", "pay_d1raceb"]).toContain(raceTrial.rows[0]?.payment_id);
      expect(Date.parse(raceTrial.rows[0]!.expires_at) - Date.parse(raceTrial.rows[0]!.starts_at)).toBe(168 * 60 * 60 * 1000);
    } finally { sqlite.close(); }
  });

  it("processes D1 refund events once and reverses a captured trial", async () => {
    const { sqlite, database } = sqliteD1();
    try {
      const user = await database.query<{ id: string }>(`INSERT INTO classroom_desk_users (google_subject,email,display_name) VALUES ($1,$2,$3) RETURNING id`, ["refund-after-capture", "refund@example.invalid", "Refund"]);
      await database.query(`INSERT INTO classroom_desk_trials (user_id,status) VALUES ($1,'eligible')`, [user.rows[0]!.id]);
      const store = new SaaSStore(database);
      const paidAt = new Date("2026-10-14T00:00:00.000Z");
      expect(await store.activateTrial(user.rows[0]!.id, "pay_d1refund", paidAt, 900)).toBe(true);
      const event = { kind: "payment_refunded" as const, userId: user.rows[0]!.id, paymentId: "pay_d1refund" };
      expect(await store.processBillingEvent(event)).toBe(true);
      expect(await store.processBillingEvent(event)).toBe(false);
      expect((await database.query<{ status: string }>(`SELECT status FROM classroom_desk_payments WHERE provider_payment_id=$1`, [event.paymentId])).rows[0]?.status).toBe("refunded");
      expect((await database.query<{ status: string }>(`SELECT status FROM classroom_desk_trials WHERE user_id=$1`, [event.userId])).rows[0]?.status).toBe("refunded");
    } finally { sqlite.close(); }
  });

  it("tracks cumulative D1 partial refunds and blocks repeat-customer referral attribution",async()=>{
    const {sqlite,database}=sqliteD1();
    try {
      const makeUser=async(subject:string)=>(await database.query<{id:string}>(`INSERT INTO classroom_desk_users (google_subject,email,display_name) VALUES ($1,$2,$3) RETURNING id`,[subject,`${subject}@example.invalid`,subject])).rows[0]!.id;
      const customer=await makeUser("d1-partial-refund-customer"),referrer=await makeUser("d1-partial-refund-referrer"),other=await makeUser("d1-partial-refund-other");
      const store=new SaaSStore(database);
      const paidThrough=new Date(Date.now()+30*86400000);
      const paid={kind:"subscription_paid" as const,userId:customer,subscriptionId:"sub_d1partial",paymentId:"pay_d1partial",plan:"student" as const,amountPaise:9900,paidThrough};
      expect(await store.processBillingEvent(paid)).toBe(true);
      const partial={kind:"payment_partially_refunded" as const,userId:customer,subscriptionId:paid.subscriptionId,paymentId:paid.paymentId,amountPaise:9900,amountRefundedPaise:1200};
      expect(await store.processBillingEvent(partial)).toBe(true);
      expect(await store.processBillingEvent(partial)).toBe(false);
      expect(await store.processBillingEvent({...partial,amountRefundedPaise:2500})).toBe(true);
      expect(await store.processBillingEvent({...partial,amountRefundedPaise:2000})).toBe(false);
      expect((await database.query<{status:string;amount_refunded_paise:number}>(`SELECT status,amount_refunded_paise FROM classroom_desk_payments WHERE provider_payment_id=$1`,[paid.paymentId])).rows[0]).toEqual({status:"partially_refunded",amount_refunded_paise:2500});
      expect((await database.query<{status:string;paid_through:string}>(`SELECT status,paid_through FROM classroom_desk_subscriptions WHERE provider_subscription_id=$1`,[paid.subscriptionId])).rows[0]).toEqual({status:"active",paid_through:paidThrough.toISOString()});
      expect((await store.entitlement(customer)).allowed).toBe(true);
      const referralCode=await store.referrals.ensureCode(referrer);
      await expect(store.referrals.attribute(referralCode,customer)).rejects.toThrow("referral_requires_new_customer");
      expect(await store.referrals.attribute(referralCode,other)).toBeTruthy();
      expect(await store.processBillingEvent({kind:"payment_refunded",userId:customer,paymentId:paid.paymentId})).toBe(true);
      expect((await database.query<{status:string;amount_refunded_paise:number}>(`SELECT status,amount_refunded_paise FROM classroom_desk_payments WHERE provider_payment_id=$1`,[paid.paymentId])).rows[0]).toEqual({status:"refunded",amount_refunded_paise:9900});
      expect((await store.entitlement(customer)).allowed).toBe(false);
    } finally { sqlite.close(); }
  });

  it("records subscription cycles once and grants referral rewards on the second qualifying customer", async () => {
    const { sqlite, database } = sqliteD1();
    try {
      const makeUser = async (subject: string) => (await database.query<{ id: string }>(`INSERT INTO classroom_desk_users (google_subject,email,display_name) VALUES ($1,$2,$3) RETURNING id`, [subject, `${subject}@example.invalid`, subject])).rows[0]!.id;
      const referrerId = await makeUser("subscription-referrer");
      const referredOne = await makeUser("subscription-referred-one");
      const referredTwo = await makeUser("subscription-referred-two");
      const store = new SaaSStore(database, { referralRewardsEnabled: true });
      const code = await store.referrals.ensureCode(referrerId);
      await store.referrals.attribute(code, referredOne);
      await store.referrals.attribute(code, referredTwo);
      const paidThrough = new Date("2026-11-14T00:00:00.000Z");
      const eventOne = { kind: "subscription_paid" as const, userId: referredOne, subscriptionId: "sub_d1cyclea", paymentId: "pay_d1cyclea", plan: "student" as const, amountPaise: 9900, paidThrough };
      const eventTwo = { kind: "subscription_paid" as const, userId: referredTwo, subscriptionId: "sub_d1cycleb", paymentId: "pay_d1cycleb", plan: "student" as const, amountPaise: 9900, paidThrough };
      expect(await store.processBillingEvent(eventOne)).toBe(true);
      expect(await store.processBillingEvent(eventOne)).toBe(false);
      expect(await store.processBillingEvent(eventTwo)).toBe(true);
      expect((await database.query<{ status: string; paid_through: string }>(`SELECT status,paid_through FROM classroom_desk_subscriptions WHERE provider_subscription_id=$1`, [eventOne.subscriptionId])).rows[0]).toEqual({ status: "active", paid_through: paidThrough.toISOString() });
      expect((await database.query<{ status: string }>(`SELECT status FROM classroom_desk_payments WHERE provider_payment_id=$1`, [eventOne.paymentId])).rows[0]?.status).toBe("paid");
      const reward = await database.query<{ count: number; source: string; plan: string }>(`SELECT r.referral_count count,g.source,g.plan FROM classroom_desk_referral_rewards r JOIN classroom_desk_entitlement_grants g ON g.id=r.grant_id WHERE r.user_id=$1`, [referrerId]);
      expect(reward.rows).toEqual([{ count: 2, source: "referral", plan: "student" }]);
      const renewal = { ...eventOne, paymentId: "pay_d1cyclea_renewal", paidThrough: new Date("2026-12-14T00:00:00.000Z") };
      expect(await store.processBillingEvent(renewal)).toBe(true);
      expect(await store.processBillingEvent({ kind: "payment_refunded", userId: referredOne, paymentId: renewal.paymentId })).toBe(true);
      expect(await store.referrals.summary(referrerId)).toMatchObject({ qualified: 2, rewards: 1 });
      expect((await database.query<{ revoked_at: string | null }>(`SELECT g.revoked_at FROM classroom_desk_referral_rewards r JOIN classroom_desk_entitlement_grants g ON g.id=r.grant_id WHERE r.user_id=$1`, [referrerId])).rows[0]?.revoked_at).toBeNull();
      expect(await store.processBillingEvent({ kind: "payment_refunded", userId: referredOne, paymentId: eventOne.paymentId })).toBe(true);
      expect(await store.referrals.summary(referrerId)).toMatchObject({ qualified: 1, rewards: 1 });
      expect((await database.query<{ revoked_at: string | null }>(`SELECT g.revoked_at FROM classroom_desk_referral_rewards r JOIN classroom_desk_entitlement_grants g ON g.id=r.grant_id WHERE r.user_id=$1`, [referrerId])).rows[0]?.revoked_at).not.toBeNull();
    } finally { sqlite.close(); }
  });

  it("keeps cancellation, past-due, and subscription-refund state transitions isolated per D1 account", async () => {
    const { sqlite, database } = sqliteD1();
    try {
      const makeUser = async (subject: string) => (await database.query<{ id: string }>(`INSERT INTO classroom_desk_users (google_subject,email,display_name) VALUES ($1,$2,$3) RETURNING id`, [subject, `${subject}@example.invalid`, subject])).rows[0]!.id;
      const cancelledUser = await makeUser("d1-cancelled-user");
      const failedUser = await makeUser("d1-failed-user");
      const refundedUser = await makeUser("d1-refunded-user");
      const store = new SaaSStore(database);
      const now = new Date();
      const cancelledPaidThrough = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
      const cancelledPayment = { kind: "subscription_paid" as const, userId: cancelledUser, subscriptionId: "sub_d1cancelled", paymentId: "pay_d1cancelled", plan: "student" as const, amountPaise: 9900, paidThrough: cancelledPaidThrough };
      expect(await store.processBillingEvent(cancelledPayment)).toBe(true);
      expect(await store.processBillingEvent({ kind: "subscription_cancelled", userId: cancelledUser, subscriptionId: cancelledPayment.subscriptionId, cancelledAt: now })).toBe(true);
      expect((await database.query<{ status: string }>(`SELECT status FROM classroom_desk_subscriptions WHERE provider_subscription_id=$1`, [cancelledPayment.subscriptionId])).rows[0]?.status).toBe("cancelled");
      expect((await store.entitlement(cancelledUser)).allowed).toBe(true);

      const failedPayment = { kind: "subscription_paid" as const, userId: failedUser, subscriptionId: "sub_d1pastdue", paymentId: "pay_d1pastdue", plan: "student" as const, amountPaise: 9900, paidThrough: new Date(now.getTime() - 60_000) };
      expect(await store.processBillingEvent(failedPayment)).toBe(true);
      expect(await store.processBillingEvent({ kind: "subscription_failed", userId: failedUser, subscriptionId: failedPayment.subscriptionId })).toBe(true);
      expect((await database.query<{ status: string }>(`SELECT status FROM classroom_desk_subscriptions WHERE provider_subscription_id=$1`, [failedPayment.subscriptionId])).rows[0]?.status).toBe("past_due");
      expect((await store.entitlement(failedUser)).allowed).toBe(false);
      expect(await store.processBillingEvent({ kind: "subscription_failed", userId: failedUser, subscriptionId: failedPayment.subscriptionId })).toBe(false);

      const refundedPayment = { kind: "subscription_paid" as const, userId: refundedUser, subscriptionId: "sub_d1refunded", paymentId: "pay_d1refunded", plan: "student" as const, amountPaise: 9900, paidThrough: cancelledPaidThrough };
      expect(await store.processBillingEvent(refundedPayment)).toBe(true);
      expect(await store.processBillingEvent({ kind: "payment_refunded", userId: refundedUser, paymentId: refundedPayment.paymentId })).toBe(true);
      expect((await database.query<{ status: string }>(`SELECT status FROM classroom_desk_subscriptions WHERE provider_subscription_id=$1`, [refundedPayment.subscriptionId])).rows[0]?.status).toBe("refunded");
      expect((await store.entitlement(refundedUser)).allowed).toBe(false);
      expect(await store.processBillingEvent({ kind: "payment_refunded", userId: refundedUser, paymentId: refundedPayment.paymentId })).toBe(false);
    } finally { sqlite.close(); }
  });

  it("retries D1 webhooks idempotently and rejects changed payloads", async () => {
    const { sqlite, database } = sqliteD1();
    try {
      const user = await database.query<{ id: string }>(`INSERT INTO classroom_desk_users (google_subject,email,display_name) VALUES ($1,$2,$3) RETURNING id`, ["webhook-owner", "webhook@example.invalid", "Webhook"]);
      await database.query(`INSERT INTO classroom_desk_trials (user_id,status) VALUES ($1,'eligible')`, [user.rows[0]!.id]);
      const store = new SaaSStore(database);
      const event = { kind: "trial_captured" as const, userId: user.rows[0]!.id, paymentId: "pay_d1webhook", amountPaise: 900, paidAt: new Date("2026-10-14T00:00:00.000Z") };
      expect(await store.processWebhook("evt_d1webhook", "payment.captured", "payload-hash-one", event)).toBe(true);
      expect(await store.processWebhook("evt_d1webhook", "payment.captured", "payload-hash-one", event)).toBe(false);
      await expect(store.processWebhook("evt_d1webhook", "payment.captured", "payload-hash-two", event)).rejects.toThrow("webhook_payload_conflict");
      expect((await database.query<{ status: string }>(`SELECT status FROM classroom_desk_webhook_events WHERE event_id=$1`, ["evt_d1webhook"])).rows[0]?.status).toBe("processed");
      expect((await database.query(`SELECT provider_payment_id FROM classroom_desk_payments WHERE user_id=$1`, [user.rows[0]!.id])).rows).toEqual([{ provider_payment_id: "pay_d1webhook" }]);
    } finally { sqlite.close(); }
  });

  it("claims D1 reconciliation pages with a compare-and-swap cursor", async () => {
    const { sqlite, database } = sqliteD1();
    try {
      const user = await database.query<{ id: string }>(`INSERT INTO classroom_desk_users (google_subject,email,display_name) VALUES ($1,$2,$3) RETURNING id`, ["reconcile-owner", "reconcile@example.invalid", "Reconcile"]);
      await database.query(`INSERT INTO classroom_desk_payments (user_id,kind,amount_paise,currency,provider_payment_id,status) VALUES ($1,'trial',900,'INR',$2,'captured')`, [user.rows[0]!.id, "pay_d1reconcile"]);
      await database.query(`INSERT INTO classroom_desk_payments (user_id,kind,amount_paise,currency,provider_order_id,status) VALUES ($1,'trial',900,'INR',$2,'pending')`, [user.rows[0]!.id, "order_d1reconcile"]);
      const store = new SaaSStore(database);
      const provider = {
        getPayment: async (id: string) => ({ id, amount: 900, currency: "INR", status: "captured" }),
        getOrder: async (id: string) => ({ id, amount: 900, currency: "INR", status: "created", notes: { user_id: user.rows[0]!.id, kind: "trial", product: "classroom_desk_trial" } }),
        getOrderPayments: async () => ({ items: [], count: 0 }),
      } as never;
      // Keep SQLite's created_at defaults safely inside the reconciliation boundary.
      const now = new Date(Date.now() + 60_000);
      const first = await reconcileRecentPayments(database, store, provider, now);
      const second = await reconcileRecentPayments(database, store, provider, now);
      expect(first).toMatchObject({ checked: 1, failed: 0, refunded: 0 });
      expect(second).toMatchObject({ checked: 1, failed: 0, refunded: 0 });
      const cursors = await database.query<{ count: number }>(`SELECT count(*) AS count FROM classroom_desk_webhook_events WHERE event_type='internal.reconciliation.cursor'`);
      expect(cursors.rows[0]?.count).toBeGreaterThanOrEqual(3);
      expect((await database.query<{ payload_hash: string }>(`SELECT payload_hash FROM classroom_desk_webhook_events WHERE event_id=$1`, [`internal:billing-reconciliation:order-payments:order_d1reconcile`])).rows[0]?.payload_hash).toBe('{"skip":0}');
    } finally { sqlite.close(); }
  });

  it("recovers a historical subscription invoice in D1 using its own billing period", async () => {
    const { sqlite, database } = sqliteD1();
    try {
      const user = await database.query<{ id: string }>(`INSERT INTO classroom_desk_users (google_subject,email,display_name) VALUES ($1,$2,$3) RETURNING id`, ["historical-invoice-owner", "historical-invoice@example.invalid", "Synthetic Invoice Owner"]);
      const userId = user.rows[0]!.id;
      const subscriptionId = "sub_d1historical";
      await database.query(`INSERT INTO classroom_desk_subscriptions (user_id,plan,status,provider_subscription_id,created_at) VALUES ($1,'student','active',$2,$3)`, [userId, subscriptionId, new Date(Date.now() - 86400000)]);
      const now = new Date(Date.now() + 60_000);
      const currentStart = Math.floor(now.getTime() / 1000) - 3600;
      const currentEnd = Math.floor(now.getTime() / 1000) + 29 * 86400;
      const invoiceEnd = currentStart - 30 * 86400;
      const invoice = { id: "inv_d1historical", subscription_id: subscriptionId, payment_id: "pay_d1historical", amount: 9900, currency: "INR", status: "paid", billing_start: invoiceEnd - 30 * 86400, billing_end: invoiceEnd };
      const provider = {
        getSubscription: async () => ({ id: subscriptionId, plan_id: "plan_student", status: "active", current_start: currentStart, current_end: currentEnd, notes: { user_id: userId, plan: "student" } }),
        getSubscriptionInvoices: async () => ({ items: [invoice], count: 1 }),
        getPayment: async () => ({ id: invoice.payment_id, invoice_id: invoice.id, amount: invoice.amount, currency: invoice.currency, status: "captured", created_at: invoiceEnd - 60 }),
      } as never;

      const result = await reconcileRecentPayments(database, new SaaSStore(database), provider, now, { student: "plan_student", teacher: "plan_teacher" });
      expect(result).toMatchObject({ recovered: 1, failed: 0 });
      expect((await database.query(`SELECT paid_through FROM classroom_desk_subscriptions WHERE provider_subscription_id=$1`, [subscriptionId])).rows[0]?.paid_through).toEqual(new Date(invoiceEnd * 1000).toISOString());
      expect((await database.query(`SELECT provider_payment_id,status FROM classroom_desk_payments WHERE provider_subscription_id=$1`, [subscriptionId])).rows).toEqual([{ provider_payment_id: invoice.payment_id, status: "paid" }]);
    } finally { sqlite.close(); }
  });
});
