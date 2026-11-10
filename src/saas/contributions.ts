import { createHash, randomUUID } from "node:crypto";
import { ipKeyGenerator } from "express-rate-limit";
import type express from "express";
import type { SqlConnection, SqlDatabase } from "../public/postgres.js";
import type { RazorpayOrder, RazorpayPayment } from "./razorpay-client.js";
import { paymentIsFullyRefunded, RazorpayClient, validProviderPayment } from "./razorpay-client.js";
import { verifyCheckoutSignature, verifyRazorpaySignature } from "./razorpay.js";
import type { RateLimitBinding } from "./rate-limit.js";

export const CONTRIBUTION_MIN_AMOUNT_PAISE = 1_000;
export const CONTRIBUTION_PRESET_AMOUNTS_RUPEES = [49, 99, 199, 499] as const;
const REQUEST_KEY = /^[0-9a-f]{32}$/i;
const PROVIDER_ORDER_ID = /^order_[A-Za-z0-9_]{1,120}$/;
const PROVIDER_PAYMENT_ID = /^pay_[A-Za-z0-9_]{1,120}$/;

export type ContributionProvider = Pick<RazorpayClient, "createContributionOrder" | "getOrder" | "getPayment">;

export type ContributionOptions = {
  enabled: true;
  mode: "test";
  provider: ContributionProvider;
  keyId: string;
  keySecret: string;
  webhookSecret: string;
  maxAmountPaise: number;
  rateLimit: RateLimitBinding;
};

export function loadTestContributionOptions(env: Record<string, unknown>, rateLimit: RateLimitBinding | undefined): ContributionOptions | undefined {
  const value = (key: string) => typeof env[key] === "string" ? (env[key] as string).trim() : "";
  const mode = value("RAZORPAY_CONTRIBUTION_MODE").toLowerCase();
  const keyId = value("RAZORPAY_CONTRIBUTION_KEY_ID");
  const keySecret = value("RAZORPAY_CONTRIBUTION_KEY_SECRET");
  const webhookSecret = value("RAZORPAY_CONTRIBUTION_WEBHOOK_SECRET");
  const maxText = value("RAZORPAY_CONTRIBUTION_MAX_AMOUNT_PAISE");
  const maxAmountPaise = /^\d{4,10}$/.test(maxText) ? Number(maxText) : NaN;
  if (value("SAAS_CONTRIBUTIONS_TEST_ENABLED").toLowerCase() !== "true" || mode !== "test"
    || !/^rzp_test_[A-Za-z0-9]+$/.test(keyId) || keySecret.length < 16 || webhookSecret.length < 16
    || !Number.isSafeInteger(maxAmountPaise) || maxAmountPaise < 49_900 || !rateLimit) return undefined;
  return { enabled: true, mode: "test", keyId, keySecret, webhookSecret, maxAmountPaise, provider: new RazorpayClient(keyId, keySecret), rateLimit };
}

type ContributionRow = {
  id: string;
  request_key_hash: string;
  amount_paise: number;
  currency: string;
  status: string;
  provider_order_id: string | null;
  provider_payment_id: string | null;
  created_at: Date | string;
};

type ContributionPayment = RazorpayPayment & { order_id: string; status: string };

function requestKeyHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function jsonError(res: express.Response, status: number, error: string) {
  return res.status(status).json({ error });
}

function validateAmount(amount: unknown, maxAmountPaise: number): number | undefined {
  if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount < CONTRIBUTION_MIN_AMOUNT_PAISE || amount > maxAmountPaise) return undefined;
  return amount;
}

function validContributionOrder(order: RazorpayOrder, input: { id: string; amountPaise: number }): boolean {
  return Boolean(order && PROVIDER_ORDER_ID.test(order.id) && order.amount === input.amountPaise
    && order.currency === "INR" && order.status === "created"
    && order.notes?.kind === "contribution" && order.notes.product === "classroom_desk_voluntary_contribution"
    && order.notes.contribution_id === input.id);
}

function validContributionPayment(payment: RazorpayPayment, order: RazorpayOrder, expected: ContributionRow): payment is ContributionPayment {
  return validProviderPayment(payment, payment.id) && PROVIDER_PAYMENT_ID.test(payment.id)
    && payment.status === "captured" && !paymentIsFullyRefunded(payment)
    && payment.order_id === expected.provider_order_id && !payment.subscription_id
    && payment.amount === Number(expected.amount_paise) && payment.currency === "INR"
    && order.id === expected.provider_order_id && order.amount === Number(expected.amount_paise)
    && order.currency === "INR" && order.status === "paid"
    && order.amount_paid === Number(expected.amount_paise) && order.amount_due === 0
    && order.notes?.kind === "contribution" && order.notes.product === "classroom_desk_voluntary_contribution"
    && order.notes.contribution_id === expected.id;
}

async function getContribution(db: SqlDatabase, orderId: string): Promise<ContributionRow | undefined> {
  const result = await db.query<ContributionRow>(
    `SELECT id,request_key_hash,amount_paise,currency,status,provider_order_id,provider_payment_id,created_at
       FROM classroom_desk_contributions WHERE provider_order_id=$1`, [orderId]);
  return result.rows.length === 1 ? result.rows[0] : undefined;
}

async function persistVerifiedPayment(db: SqlDatabase, row: ContributionRow, payment: ContributionPayment, event?: { id: string; hash: string }): Promise<{ updated: boolean; eventInserted?: boolean }> {
  const update = {
    sql: `UPDATE classroom_desk_contributions SET status='paid',provider_payment_id=$2,paid_at=COALESCE(paid_at,now()),updated_at=now()
      WHERE id=$1 AND provider_order_id=$3 AND currency='INR' AND amount_paise=$4
        AND status IN ('pending','paid') AND (provider_payment_id IS NULL OR provider_payment_id=$2)
        ${event ? "AND EXISTS (SELECT 1 FROM classroom_desk_contribution_webhook_events WHERE event_id=$5 AND payload_hash=$6)" : ""}
      RETURNING id`,
    values: event ? [row.id, payment.id, row.provider_order_id, Number(row.amount_paise), event.id, event.hash]
      : [row.id, payment.id, row.provider_order_id, Number(row.amount_paise)],
  };
  if (!event) return { updated: (await db.query(update.sql, update.values)).rows.length === 1 };
  const insert = {
    sql: `INSERT INTO classroom_desk_contribution_webhook_events(event_id,payload_hash) VALUES($1,$2) ON CONFLICT(event_id) DO NOTHING RETURNING event_id`,
    values: [event.id, event.hash],
  };
  const results = db.batch
    ? await db.batch([insert, update])
    : await db.transaction(async (tx: SqlConnection) => [await tx.query(insert.sql, insert.values), await tx.query(update.sql, update.values)]);
  const stored = await db.query<{ payload_hash: string }>(`SELECT payload_hash FROM classroom_desk_contribution_webhook_events WHERE event_id=$1`, [event.id]);
  if (stored.rows[0]?.payload_hash !== event.hash) throw new Error("contribution_webhook_event_conflict");
  return { updated: results[1]?.rows.length === 1, eventInserted: results[0]?.rows.length === 1 };
}

export function registerContributionRoutes(app: express.Express, input: {
  db: SqlDatabase;
  options?: ContributionOptions;
}): void {
  const options = input.options;
  if (!options || !options.enabled || options.mode !== "test" || options.keyId.startsWith("rzp_live_")) return;

  const orderLimit: express.RequestHandler = (req, res, next) => {
    const clientIp = req.get("cf-connecting-ip") ?? req.ip ?? "";
    let key: string;
    try { key = ipKeyGenerator(clientIp, 56); }
    catch { return jsonError(res, 503, "contribution_rate_limit_unavailable"); }
    void options.rateLimit.limit({ key }).then(result => {
      if (!result.success) return jsonError(res, 429, "contribution_rate_limited");
      next();
    }).catch(() => jsonError(res, 503, "contribution_rate_limit_unavailable"));
  };

  app.post("/api/contributions/order", orderLimit, async (req, res) => {
    const amountPaise = validateAmount(req.body?.amountPaise, options.maxAmountPaise);
    const key = typeof req.body?.requestKey === "string" ? req.body.requestKey : "";
    if (!amountPaise || !REQUEST_KEY.test(key)) return jsonError(res, 400, "invalid_contribution_request");
    const hash = requestKeyHash(key);
    const id = `con_${randomUUID()}`;
    try {
      const reservation = await input.db.query<ContributionRow>(
        `INSERT INTO classroom_desk_contributions(id,request_key_hash,amount_paise,currency,status)
         VALUES($1,$2,$3,'INR','creating') ON CONFLICT(request_key_hash) DO NOTHING
         RETURNING id,request_key_hash,amount_paise,currency,status,provider_order_id,provider_payment_id,created_at`,
        [id, hash, amountPaise]);
      const row = reservation.rows[0] ?? (await input.db.query<ContributionRow>(
        `SELECT id,request_key_hash,amount_paise,currency,status,provider_order_id,provider_payment_id,created_at
         FROM classroom_desk_contributions WHERE request_key_hash=$1`, [hash])).rows[0];
      if (!row) return jsonError(res, 503, "contribution_unavailable");
      if (Number(row.amount_paise) !== amountPaise) return jsonError(res, 409, "contribution_request_conflict");
      if (row.status === "paid") return res.status(200).json({ verified: true, paid: true });
      if (row.status === "pending" && row.provider_order_id) {
        return res.status(200).json({ orderId: row.provider_order_id, amountPaise, currency: "INR", keyId: options.keyId, resumed: true });
      }
      if (row.status === "creating" && reservation.rows.length === 0) {
        const ageMs = Date.now() - new Date(row.created_at).getTime();
        if (Number.isFinite(ageMs) && ageMs < 2 * 60_000) return jsonError(res, 409, "contribution_order_processing");
        await input.db.query(`UPDATE classroom_desk_contributions SET status='reconciliation_required',updated_at=now() WHERE id=$1 AND status='creating'`, [row.id]);
        return jsonError(res, 409, "contribution_reconciliation_required");
      }
      if (row.status !== "creating") return jsonError(res, 409, "contribution_reconciliation_required");

      let providerOrder: RazorpayOrder;
      try {
        providerOrder = await options.provider.createContributionOrder(row.id, amountPaise);
        if (!validContributionOrder(providerOrder, { id: row.id, amountPaise })) throw new Error("contribution_order_mismatch");
      } catch {
        await input.db.query(`UPDATE classroom_desk_contributions SET status='reconciliation_required',updated_at=now() WHERE id=$1 AND status='creating'`, [row.id]).catch(() => undefined);
        return jsonError(res, 503, "contribution_order_requires_reconciliation");
      }
      const saved = await input.db.query<{ id: string }>(
        `UPDATE classroom_desk_contributions SET status='pending',provider_order_id=$2,updated_at=now()
         WHERE id=$1 AND status='creating' RETURNING id`, [row.id, providerOrder.id]);
      if (saved.rows.length !== 1) return jsonError(res, 503, "contribution_order_requires_reconciliation");
      return res.status(201).json({ orderId: providerOrder.id, amountPaise, currency: "INR", keyId: options.keyId });
    } catch {
      return jsonError(res, 503, "contribution_unavailable");
    }
  });

  app.post("/api/contributions/verify", async (req, res) => {
    const orderId = typeof req.body?.razorpay_order_id === "string" ? req.body.razorpay_order_id : "";
    const paymentId = typeof req.body?.razorpay_payment_id === "string" ? req.body.razorpay_payment_id : "";
    const signature = typeof req.body?.razorpay_signature === "string" ? req.body.razorpay_signature : "";
    if (!PROVIDER_ORDER_ID.test(orderId) || !PROVIDER_PAYMENT_ID.test(paymentId)
      || !verifyCheckoutSignature(orderId, paymentId, signature, options.keySecret)) return jsonError(res, 400, "invalid_contribution_signature");
    try {
      const row = await getContribution(input.db, orderId);
      if (!row || !["pending", "paid"].includes(row.status) || (row.provider_payment_id && row.provider_payment_id !== paymentId)) return jsonError(res, 404, "contribution_order_not_found");
      const [payment, order] = await Promise.all([options.provider.getPayment(paymentId), options.provider.getOrder(orderId)]);
      if (!validContributionPayment(payment, order, row)) return jsonError(res, 409, "contribution_payment_not_confirmed");
      if (!(await persistVerifiedPayment(input.db, row, payment)).updated) return jsonError(res, 409, "contribution_payment_not_confirmed");
      return res.json({ verified: true, contribution: true });
    } catch {
      return jsonError(res, 502, "contribution_verification_unavailable");
    }
  });

  app.post("/webhooks/razorpay/contributions", async (req, res) => {
    const raw = (req as express.Request & { rawBody?: Buffer }).rawBody;
    const signature = req.get("x-razorpay-signature") ?? "";
    const eventId = req.get("x-razorpay-event-id") ?? "";
    if (!raw || !/^[A-Za-z0-9_]{1,128}$/.test(eventId)
      || !verifyRazorpaySignature(raw.toString("utf8"), signature, options.webhookSecret)) return jsonError(res, 401, "invalid_webhook");
    const body = req.body as { event?: unknown; payload?: { payment?: { entity?: { id?: unknown; order_id?: unknown } } } } | undefined;
    if (body?.event !== "payment.captured") return res.status(200).json({ received: true, ignored: true });
    const paymentId = body.payload?.payment?.entity?.id;
    const orderId = body.payload?.payment?.entity?.order_id;
    if (typeof paymentId !== "string" || !PROVIDER_PAYMENT_ID.test(paymentId) || typeof orderId !== "string" || !PROVIDER_ORDER_ID.test(orderId)) return jsonError(res, 400, "invalid_webhook_payload");
    try {
      const row = await getContribution(input.db, orderId);
      if (!row || !["pending", "paid"].includes(row.status)) return res.status(200).json({ received: true, ignored: true });
      const [payment, order] = await Promise.all([options.provider.getPayment(paymentId), options.provider.getOrder(orderId)]);
      if (!validContributionPayment(payment, order, row)) return jsonError(res, 409, "contribution_payment_not_confirmed");
      const hash = createHash("sha256").update(raw).digest("hex");
      const persisted = await persistVerifiedPayment(input.db, row, payment, { id: eventId, hash });
      if (!persisted.updated) return jsonError(res, 409, "contribution_payment_not_confirmed");
      return res.status(200).json({ received: true, duplicate: !persisted.eventInserted });
    } catch (error) {
      if (error instanceof Error && error.message === "contribution_webhook_event_conflict") return jsonError(res, 409, "webhook_event_conflict");
      return jsonError(res, 500, "webhook_processing_failed");
    }
  });
}
