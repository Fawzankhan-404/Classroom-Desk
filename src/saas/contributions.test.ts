import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import type express from "express";
import { PGlite } from "@electric-sql/pglite";
import type { SqlConnection, SqlDatabase } from "../public/postgres.js";
import { SaaSMigration } from "./schema.js";
import { loadTestContributionOptions, registerContributionRoutes, type ContributionOptions } from "./contributions.js";

const keySecret = "synthetic-contribution-key-secret";
const webhookSecret = "synthetic-contribution-webhook-secret";
const sign = (value: string, secret: string) => createHmac("sha256", secret).update(value).digest("hex");
const bodyKey = () => "a".repeat(32);

describe("isolated voluntary contribution flow", () => {
  const pg = new PGlite();
  let db: SqlDatabase;
  let handlers: Map<string, express.RequestHandler[]>;
  let provider: {
    createContributionOrder: ReturnType<typeof vi.fn>;
    getOrder: ReturnType<typeof vi.fn>;
    getPayment: ReturnType<typeof vi.fn>;
  };
  let options: ContributionOptions;

  beforeAll(async () => {
    await pg.exec(SaaSMigration);
    const query: SqlConnection["query"] = async (sql, values = []) => ({ rows: (await pg.query(sql, values)).rows as never });
    const transaction: SqlDatabase["transaction"] = work => pg.transaction(tx => work({ query: async (sql, values = []) => ({ rows: (await tx.query(sql, values)).rows as never }) }));
    const batch: NonNullable<SqlDatabase["batch"]> = queries => pg.transaction(async tx => Promise.all(queries.map(async ({ sql, values = [] }) => ({ rows: (await tx.query(sql, values)).rows as never }))));
    db = { query, transaction, batch };
  }, 30_000);
  afterAll(async () => { await pg.close(); });

  beforeAll(async () => {
    provider = {
      createContributionOrder: vi.fn(async (contributionId: string, amount: number) => ({
        id: "order_contribution1", amount, currency: "INR", status: "created",
        notes: { kind: "contribution", product: "classroom_desk_voluntary_contribution", contribution_id: contributionId },
      })),
      getOrder: vi.fn(async () => ({
        id: "order_contribution1", amount: 9900, amount_paid: 9900, amount_due: 0, currency: "INR", status: "paid",
        notes: { kind: "contribution", product: "classroom_desk_voluntary_contribution", contribution_id: contributionId },
      })),
      getPayment: vi.fn(async () => ({
        id: "pay_contribution1", order_id: "order_contribution1", amount: 9900, currency: "INR", status: "captured",
      })),
    };
    options = { enabled: true, mode: "test", provider: provider as never, keyId: "rzp_test_synthetic", keySecret, webhookSecret, maxAmountPaise: 499_000, rateLimit: { limit: vi.fn(async () => ({ success: true })) } };
  });

  let contributionId = "";
  beforeEach(async () => {
    await pg.exec("TRUNCATE classroom_desk_contribution_webhook_events,classroom_desk_contributions");
    options.rateLimit = { limit: vi.fn(async () => ({ success: true })) };
    provider.createContributionOrder.mockClear();
    provider.getOrder.mockClear();
    provider.getPayment.mockClear();
    provider.createContributionOrder.mockImplementation(async (id: string, amount: number) => {
      contributionId = id;
      return { id: "order_contribution1", amount, currency: "INR", status: "created", notes: { kind: "contribution", product: "classroom_desk_voluntary_contribution", contribution_id: id } };
    });
    provider.getOrder.mockImplementation(async () => ({ id: "order_contribution1", amount: 9900, amount_paid: 9900, amount_due: 0, currency: "INR", status: "paid", notes: { kind: "contribution", product: "classroom_desk_voluntary_contribution", contribution_id: contributionId } }));
    provider.getPayment.mockResolvedValue({ id: "pay_contribution1", order_id: "order_contribution1", amount: 9900, currency: "INR", status: "captured" });
    handlers = new Map();
    const app = { post: (path: string, ...middlewares: express.RequestHandler[]) => { handlers.set(path, middlewares); } } as unknown as express.Express;
    registerContributionRoutes(app, { db, options });
  });

  async function send(path: string, body: unknown, headers: Record<string, string> = {}, rawBody?: Buffer) {
    let status = 200;
    let data: unknown;
    let completed!: () => void;
    let failed!: (error: unknown) => void;
    const responseDone = new Promise<void>((resolve, reject) => { completed = resolve; failed = reject; });
    const req = { body, rawBody, ip: "192.0.2.10", get: (name: string) => headers[name.toLowerCase()] } as unknown as express.Request;
    const res = { status: (code: number) => { status = code; return res; }, json: (value: unknown) => { data = value; completed(); return res; } } as unknown as express.Response;
    const chain = handlers.get(path);
    if (!chain) throw new Error(`No handler registered for ${path}`);
    const invoke = (index: number): Promise<void> => new Promise((resolve, reject) => {
      const handler = chain[index];
      if (!handler) return resolve();
      let passed = false;
      const next = () => { passed = true; void invoke(index + 1).then(resolve, reject); };
      Promise.resolve(handler(req, res, next)).then(() => { if (!passed) resolve(); }, reject);
    });
    void invoke(0).catch(failed);
    await Promise.race([responseDone, new Promise<void>((_resolve, reject) => setTimeout(() => reject(new Error(`Handler timed out for ${path}`)), 3000))]);
    return { status, data };
  }

  it("validates minimum, configured maximum, and integer paise before creating an order", async () => {
    const invalid = await send("/api/contributions/order", { amountPaise: 999, requestKey: bodyKey() });
    const over = await send("/api/contributions/order", { amountPaise: 499_001, requestKey: bodyKey() });
    const fractional = await send("/api/contributions/order", { amountPaise: 9990.5, requestKey: bodyKey() });
    expect([invalid.status, over.status, fractional.status]).toEqual([400, 400, 400]);
    expect(provider.createContributionOrder).not.toHaveBeenCalled();
  });

  it("applies the dedicated Cloudflare contribution rate limit and fails closed if it is unavailable", async () => {
    const limit = vi.fn(async () => ({ success: false }));
    options.rateLimit = { limit };
    const blocked = await send("/api/contributions/order", { amountPaise: 9900, requestKey: bodyKey() });
    expect(blocked).toEqual({ status: 429, data: { error: "contribution_rate_limited" } });
    expect(provider.createContributionOrder).not.toHaveBeenCalled();
    options.rateLimit = { limit: vi.fn(async () => { throw new Error("rate limiter unavailable"); }) };
    const unavailable = await send("/api/contributions/order", { amountPaise: 9900, requestKey: "b".repeat(32) });
    expect(unavailable).toEqual({ status: 503, data: { error: "contribution_rate_limit_unavailable" } });
    expect(provider.createContributionOrder).not.toHaveBeenCalled();
  });

  it("creates one server-validated order and reuses it for the same idempotency key", async () => {
    const request = { amountPaise: 9900, requestKey: bodyKey() };
    const first = await send("/api/contributions/order", request);
    const retry = await send("/api/contributions/order", request);
    expect(first).toMatchObject({ status: 201, data: { orderId: "order_contribution1", amountPaise: 9900, currency: "INR", keyId: "rzp_test_synthetic" } });
    expect(retry).toMatchObject({ status: 200, data: { orderId: "order_contribution1", resumed: true } });
    expect(provider.createContributionOrder).toHaveBeenCalledTimes(1);
    const row = await db.query<{ status: string }>("SELECT status FROM classroom_desk_contributions");
    expect(row.rows[0]?.status).toBe("pending");
    expect((await db.query("SELECT id FROM classroom_desk_payments")).rows).toHaveLength(0);
  });

  it("rejects idempotency-key reuse with another amount", async () => {
    await send("/api/contributions/order", { amountPaise: 9900, requestKey: bodyKey() });
    const conflict = await send("/api/contributions/order", { amountPaise: 19900, requestKey: bodyKey() });
    expect(conflict).toEqual({ status: 409, data: { error: "contribution_request_conflict" } });
    expect(provider.createContributionOrder).toHaveBeenCalledTimes(1);
  });

  it("marks ambiguous provider creation as reconciliation-required and never creates a duplicate", async () => {
    provider.createContributionOrder.mockRejectedValueOnce(new Error("provider timeout"));
    const request = { amountPaise: 9900, requestKey: bodyKey() };
    expect(await send("/api/contributions/order", request)).toEqual({ status: 503, data: { error: "contribution_order_requires_reconciliation" } });
    expect(await send("/api/contributions/order", request)).toEqual({ status: 409, data: { error: "contribution_reconciliation_required" } });
    expect(provider.createContributionOrder).toHaveBeenCalledTimes(1);
  });

  it("requires a valid checkout signature and authoritative captured payment/order before success", async () => {
    await send("/api/contributions/order", { amountPaise: 9900, requestKey: bodyKey() });
    const body = { razorpay_order_id: "order_contribution1", razorpay_payment_id: "pay_contribution1", razorpay_signature: sign("order_contribution1|pay_contribution1", keySecret) };
    expect(await send("/api/contributions/verify", { ...body, razorpay_signature: "bad" })).toEqual({ status: 400, data: { error: "invalid_contribution_signature" } });
    expect(provider.getPayment).not.toHaveBeenCalled();
    provider.getPayment.mockResolvedValueOnce({ id: "pay_contribution1", order_id: "order_contribution1", amount: 19900, currency: "INR", status: "captured" });
    expect(await send("/api/contributions/verify", body)).toEqual({ status: 409, data: { error: "contribution_payment_not_confirmed" } });
    expect((await db.query<{ status: string }>("SELECT status FROM classroom_desk_contributions")).rows[0]?.status).toBe("pending");
    expect(await send("/api/contributions/verify", body)).toEqual({ status: 200, data: { verified: true, contribution: true } });
    expect((await db.query<{ status: string }>("SELECT status FROM classroom_desk_contributions")).rows[0]?.status).toBe("paid");
    expect((await db.query("SELECT id FROM classroom_desk_payments")).rows).toHaveLength(0);
  });

  it("verifies signed capture webhooks idempotently with an isolated secret and event ledger", async () => {
    await send("/api/contributions/order", { amountPaise: 9900, requestKey: bodyKey() });
    const text = JSON.stringify({ event: "payment.captured", payload: { payment: { entity: { id: "pay_contribution1", order_id: "order_contribution1" } } } });
    const raw = Buffer.from(text);
    const headers = { "x-razorpay-signature": sign(text, webhookSecret), "x-razorpay-event-id": "evt_contribution1" };
    expect(await send("/webhooks/razorpay/contributions", JSON.parse(text), headers, raw)).toEqual({ status: 200, data: { received: true, duplicate: false } });
    expect(await send("/webhooks/razorpay/contributions", JSON.parse(text), headers, raw)).toEqual({ status: 200, data: { received: true, duplicate: true } });
    expect((await db.query("SELECT event_id FROM classroom_desk_contribution_webhook_events")).rows).toHaveLength(1);
    expect((await db.query<{ status: string }>("SELECT status FROM classroom_desk_contributions")).rows[0]?.status).toBe("paid");
  });

  it("does not register payment routes when the test contribution gate is absent", async () => {
    const app = { post: vi.fn() } as unknown as express.Express;
    registerContributionRoutes(app, { db });
    expect(app.post).not.toHaveBeenCalled();
  });

  it("never enables contributions for live mode, subscription keys, or missing max-amount configuration", () => {
    const common = { SAAS_CONTRIBUTIONS_TEST_ENABLED: "true", RAZORPAY_CONTRIBUTION_KEY_ID: "rzp_test_abc123", RAZORPAY_CONTRIBUTION_KEY_SECRET: keySecret, RAZORPAY_CONTRIBUTION_WEBHOOK_SECRET: webhookSecret, RAZORPAY_CONTRIBUTION_MAX_AMOUNT_PAISE: "499000" };
    const rateLimit = { limit: vi.fn(async () => ({ success: true })) };
    expect(loadTestContributionOptions({ ...common, RAZORPAY_CONTRIBUTION_MODE: "live" }, rateLimit)).toBeUndefined();
    expect(loadTestContributionOptions({ ...common, RAZORPAY_CONTRIBUTION_MODE: "test", RAZORPAY_CONTRIBUTION_KEY_ID: "rzp_live_abc123" }, rateLimit)).toBeUndefined();
    expect(loadTestContributionOptions({ ...common, RAZORPAY_CONTRIBUTION_MODE: "test", RAZORPAY_CONTRIBUTION_MAX_AMOUNT_PAISE: "" }, rateLimit)).toBeUndefined();
    expect(loadTestContributionOptions({ ...common, RAZORPAY_CONTRIBUTION_MODE: "test" }, undefined)).toBeUndefined();
    expect(loadTestContributionOptions({ ...common, RAZORPAY_CONTRIBUTION_MODE: "test" }, rateLimit)).toMatchObject({ enabled: true, mode: "test", keyId: "rzp_test_abc123", maxAmountPaise: 499000 });
  });
});
