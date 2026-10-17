import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { D1SqlDatabase } from "../public/d1-database.js";
import { PostgresPublicAuthStore } from "../public/postgres.js";
import { ReferralService } from "./referral-service.js";
import { SaaSStore } from "./store.js";
import { reconcileRecentPayments } from "./reconciliation.js";

function sqliteD1() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(new URL("../../migrations/0001_classroom_desk.sql", import.meta.url), "utf8"));
  sqlite.exec(readFileSync(new URL("../../migrations/0002_d1_link_claims.sql", import.meta.url), "utf8"));
  sqlite.exec(readFileSync(new URL("../../migrations/0003_d1_admin_operation_markers.sql", import.meta.url), "utf8"));
  sqlite.exec(readFileSync(new URL("../../migrations/0004_d1_unique_trial_orders.sql", import.meta.url), "utf8"));
  sqlite.exec(readFileSync(new URL("../../migrations/0005_d1_billing_operation_markers.sql", import.meta.url), "utf8"));
  sqlite.exec(readFileSync(new URL("../../migrations/0006_d1_reconciliation_claims.sql", import.meta.url), "utf8"));
  sqlite.exec(readFileSync(new URL("../../migrations/0007_saas_profile_privacy.sql", import.meta.url), "utf8"));
  sqlite.exec(readFileSync(new URL("../../migrations/0008_unified_oauth_accounts.sql", import.meta.url), "utf8"));
  sqlite.exec(readFileSync(new URL("../../migrations/0009_dashboard_preference.sql", import.meta.url), "utf8"));
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

describe("D1 migration and account-link atomicity", () => {
  it("persists the dashboard choice per account in D1", async () => {
    const { sqlite, database } = sqliteD1();
    try {
      const store = new SaaSStore(database);
      const user = await store.upsertGoogleIdentity({ googleSubject: "synthetic-dashboard-choice", email: "dashboard@example.invalid", displayName: "Synthetic Dashboard", now: new Date() });
      expect(await store.dashboardPreference(user.id)).toBeNull();
      await store.setDashboardPreference(user.id, "teacher");
      expect(await store.dashboardPreference(user.id)).toBe("teacher");
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
});
