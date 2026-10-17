import { randomUUID } from "node:crypto";
import type { SqlDatabase } from "../public/postgres.js";
import type { RazorpayClient, RazorpayCollection } from "./razorpay-client.js";
import { paymentHasRefund, paymentMatchesSubscriptionCycle, validProviderPayment, withProviderTimeout } from "./razorpay-client.js";
import { SaaSStore } from "./store.js";
import { parseRazorpayEvent } from "./billing-events.js";
import { planPricePaise, TRIAL_PRICE_PAISE } from "./campaign.js";

interface ReconciliationRow extends Record<string, unknown> {
  id: string; created_at: Date | string; cursor_created_at: string; user_id: string; amount_paise: number; currency: string;
  provider_payment_id: string | null; provider_order_id: string | null; provider_subscription_id: string | null; plan: "student" | "teacher" | null;
}
interface Cursor { createdAt: string; id: string; }
const BATCH_SIZE = 100;
const CONCURRENCY = 5;
const RECOVERY_BATCH_SIZE = 5;
const PROVIDER_PAGE_SIZE = 5;
const MAX_PROVIDER_CHECKS = 300;

/** Claim the next page before doing I/O, so failures cannot pin the next run. */
async function claimPayments(db: SqlDatabase, since: Date, category: "recent" | "stale" | "orders" | "subscriptions", now: Date): Promise<ReconciliationRow[]> {
  if (db.batch) return claimPaymentsD1(db, since, category, now);
  return db.transaction(async tx => {
    const key = `internal:billing-reconciliation:${category}`;
    await tx.query(`INSERT INTO classroom_desk_webhook_events (event_id,event_type,payload_hash,status) VALUES ($1,'internal.reconciliation.cursor','{}','cursor') ON CONFLICT (event_id) DO NOTHING`, [key]);
    const state = await tx.query<{ payload_hash: string; status: string }>(`SELECT payload_hash,status FROM classroom_desk_webhook_events WHERE event_id=$1 FOR UPDATE`, [key]);
    if (state.rows[0]?.status !== "cursor") throw new Error("reconciliation_cursor_conflict");
    const saved: unknown = JSON.parse(state.rows[0].payload_hash);
    const candidate = saved as Partial<Cursor> | null;
    const cursor = candidate && typeof candidate.createdAt === "string" && Number.isFinite(Date.parse(candidate.createdAt))
      && typeof candidate.id === "string" && /^[0-9a-f-]{36}$/i.test(candidate.id) ? candidate as Cursor : undefined;
    const limit = category === "recent" || category === "stale" ? BATCH_SIZE : RECOVERY_BATCH_SIZE;
    const predicate = category === "recent" ? "provider_payment_id IS NOT NULL AND created_at >= $1"
      : category === "stale" ? "provider_payment_id IS NOT NULL AND created_at < $1 AND status IN ('pending','authorized','captured','paid')"
        : category === "orders" ? "provider_order_id IS NOT NULL AND provider_payment_id IS NULL AND kind='trial' AND status='pending' AND created_at <= $1"
          : "provider_subscription_id IS NOT NULL AND status IN ('pending','active','past_due') AND created_at <= $1";
    const source = category === "subscriptions"
      ? "SELECT id,created_at,created_at::text cursor_created_at,user_id,0 amount_paise,'INR' currency,NULL::text provider_payment_id,NULL::text provider_order_id,provider_subscription_id,plan FROM classroom_desk_subscriptions"
      : "SELECT id,created_at,created_at::text cursor_created_at,user_id,amount_paise,currency,provider_payment_id,provider_order_id,provider_subscription_id,plan FROM classroom_desk_payments";
    const select = `${source} WHERE ${predicate}`;
    const boundary = category === "orders" || category === "subscriptions" ? now : since;
    const page = await tx.query<ReconciliationRow>(`${select}${cursor ? " AND (created_at,id)>($2::timestamptz,$3::uuid)" : ""} ORDER BY created_at ASC,id ASC LIMIT ${limit}`, cursor ? [boundary, cursor.createdAt, cursor.id] : [boundary]);
    const rows = [...page.rows];
    if (cursor && rows.length < limit) {
      const wrap = await tx.query<ReconciliationRow>(`${select} AND (created_at,id)<=($2::timestamptz,$3::uuid) ORDER BY created_at ASC,id ASC LIMIT ${limit - rows.length}`, [boundary, cursor.createdAt, cursor.id]);
      rows.push(...wrap.rows);
    }
    const last = rows.at(-1);
    if (last) await tx.query(`UPDATE classroom_desk_webhook_events SET payload_hash=$2,processed_at=$3 WHERE event_id=$1`, [key, JSON.stringify({ createdAt: last.cursor_created_at, id: last.id }), now]);
    return rows;
  });
}

async function claimPaymentsD1(db: SqlDatabase, since: Date, category: "recent" | "stale" | "orders" | "subscriptions", now: Date): Promise<ReconciliationRow[]> {
  const key = `internal:billing-reconciliation:${category}`;
  await db.query(`INSERT INTO classroom_desk_webhook_events (event_id,event_type,payload_hash,status) VALUES ($1,'internal.reconciliation.cursor','{}','cursor') ON CONFLICT (event_id) DO NOTHING`, [key]);
  const limit = category === "recent" || category === "stale" ? BATCH_SIZE : RECOVERY_BATCH_SIZE;
  const predicate = category === "recent" ? "provider_payment_id IS NOT NULL AND created_at >= $1"
    : category === "stale" ? "provider_payment_id IS NOT NULL AND created_at < $1 AND status IN ('pending','authorized','captured','paid')"
      : category === "orders" ? "provider_order_id IS NOT NULL AND provider_payment_id IS NULL AND kind='trial' AND status='pending' AND created_at <= $1"
        : "provider_subscription_id IS NOT NULL AND status IN ('pending','active','past_due') AND created_at <= $1";
  const source = category === "subscriptions"
    ? "SELECT id,created_at,created_at::text cursor_created_at,user_id,0 amount_paise,'INR' currency,NULL::text provider_payment_id,NULL::text provider_order_id,provider_subscription_id,plan FROM classroom_desk_subscriptions"
    : "SELECT id,created_at,created_at::text cursor_created_at,user_id,amount_paise,currency,provider_payment_id,provider_order_id,provider_subscription_id,plan FROM classroom_desk_payments";
  const select = `${source} WHERE ${predicate}`;
  const boundary = category === "orders" || category === "subscriptions" ? now : since;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const state = await db.query<{ payload_hash: string; status: string; claim_id: string | null }>(`SELECT payload_hash,status,claim_id FROM classroom_desk_webhook_events WHERE event_id=$1`, [key]);
    const saved = state.rows[0];
    if (saved?.status !== "cursor") throw new Error("reconciliation_cursor_conflict");
    let cursor: Cursor | undefined;
    try {
      const value = JSON.parse(saved.payload_hash) as Partial<Cursor> | null;
      if (value && typeof value.createdAt === "string" && Number.isFinite(Date.parse(value.createdAt)) && typeof value.id === "string" && /^[0-9a-f-]{36}$/i.test(value.id)) cursor = value as Cursor;
    } catch { /* Invalid cursor payload starts from the first page. */ }
    const page = await db.query<ReconciliationRow>(`${select}${cursor ? " AND (created_at,id)>($2::timestamptz,$3::uuid)" : ""} ORDER BY created_at ASC,id ASC LIMIT ${limit}`, cursor ? [boundary, cursor.createdAt, cursor.id] : [boundary]);
    const rows = [...page.rows];
    if (cursor && rows.length < limit) {
      const wrap = await db.query<ReconciliationRow>(`${select} AND (created_at,id)<=($2::timestamptz,$3::uuid) ORDER BY created_at ASC,id ASC LIMIT ${limit - rows.length}`, [boundary, cursor.createdAt, cursor.id]);
      rows.push(...wrap.rows);
    }
    const last = rows.at(-1);
    if (!last) return [];
    const next = JSON.stringify({ createdAt: last.cursor_created_at, id: last.id });
    const claimId = randomUUID();
    const moved = await db.query(`UPDATE classroom_desk_webhook_events SET payload_hash=$2,processed_at=$3,claim_id=$4 WHERE event_id=$1 AND status='cursor' AND payload_hash=$5 AND claim_id IS $6 RETURNING event_id`, [key, next, now, claimId, saved.payload_hash, saved.claim_id]);
    if (moved.rows.length === 1) return rows;
  }
  throw new Error("reconciliation_cursor_contention");
}

async function reserveProviderPage(db: SqlDatabase, key: string, now: Date): Promise<{ skip: number; finish: (size: number) => Promise<void> }> {
  if (db.batch) return reserveProviderPageD1(db, key, now);
  const skip = await db.transaction(async tx => {
    await tx.query(`INSERT INTO classroom_desk_webhook_events (event_id,event_type,payload_hash,status) VALUES ($1,'internal.reconciliation.cursor','{"skip":0}','cursor') ON CONFLICT (event_id) DO NOTHING`, [key]);
    const state = await tx.query<{payload_hash:string;status:string}>(`SELECT payload_hash,status FROM classroom_desk_webhook_events WHERE event_id=$1 FOR UPDATE`, [key]);
    if (state.rows[0]?.status !== "cursor") throw new Error("reconciliation_cursor_conflict");
    const saved = JSON.parse(state.rows[0].payload_hash) as {skip?:unknown} | null;
    const offset = typeof saved?.skip === "number" && Number.isSafeInteger(saved.skip) && saved.skip >= 0 && saved.skip < Number.MAX_SAFE_INTEGER - PROVIDER_PAGE_SIZE ? saved.skip : 0;
    await tx.query(`UPDATE classroom_desk_webhook_events SET payload_hash=$2,processed_at=$3 WHERE event_id=$1`, [key,JSON.stringify({skip:offset+PROVIDER_PAGE_SIZE}),now]);
    return offset;
  });
  return { skip, finish: async size => {
    if (size < PROVIDER_PAGE_SIZE) await db.query(`UPDATE classroom_desk_webhook_events SET payload_hash='{"skip":0}' WHERE event_id=$1 AND status='cursor' AND payload_hash=$2`, [key,JSON.stringify({skip:skip+PROVIDER_PAGE_SIZE})]);
  } };
}

async function reserveProviderPageD1(db: SqlDatabase, key: string, now: Date): Promise<{ skip: number; finish: (size: number) => Promise<void> }> {
  await db.query(`INSERT INTO classroom_desk_webhook_events (event_id,event_type,payload_hash,status) VALUES ($1,'internal.reconciliation.cursor','{"skip":0}','cursor') ON CONFLICT (event_id) DO NOTHING`, [key]);
  let skip = 0; let claimId = ""; let payload = "";
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const state = await db.query<{ payload_hash: string; status: string; claim_id: string | null }>(`SELECT payload_hash,status,claim_id FROM classroom_desk_webhook_events WHERE event_id=$1`, [key]);
    const saved = state.rows[0];
    if (saved?.status !== "cursor") throw new Error("reconciliation_cursor_conflict");
    let offset = 0;
    try {
      const value = JSON.parse(saved.payload_hash) as { skip?: unknown } | null;
      if (typeof value?.skip === "number" && Number.isSafeInteger(value.skip) && value.skip >= 0 && value.skip < Number.MAX_SAFE_INTEGER - PROVIDER_PAGE_SIZE) offset = value.skip;
    } catch { /* Invalid cursor payload restarts paging. */ }
    const next = JSON.stringify({ skip: offset + PROVIDER_PAGE_SIZE });
    const operationId = randomUUID();
    const moved = await db.query(`UPDATE classroom_desk_webhook_events SET payload_hash=$2,processed_at=$3,claim_id=$4 WHERE event_id=$1 AND status='cursor' AND payload_hash=$5 AND claim_id IS $6 RETURNING event_id`, [key, next, now, operationId, saved.payload_hash, saved.claim_id]);
    if (moved.rows.length === 1) { skip = offset; claimId = operationId; payload = next; break; }
  }
  if (!claimId) throw new Error("reconciliation_cursor_contention");
  return { skip, finish: async size => {
    if (size < PROVIDER_PAGE_SIZE) await db.query(`UPDATE classroom_desk_webhook_events SET payload_hash='{"skip":0}',claim_id=$4 WHERE event_id=$1 AND status='cursor' AND payload_hash=$2 AND claim_id=$3`, [key, payload, claimId, randomUUID()]);
  } };
}

function validPage<T>(page: RazorpayCollection<T>): boolean {
  return Boolean(page && Array.isArray(page.items) && page.items.length <= PROVIDER_PAGE_SIZE && page.count === page.items.length);
}

function providerPaidAt(createdAt: unknown, now: Date): Date {
  if (typeof createdAt !== "number" || !Number.isSafeInteger(createdAt) || createdAt <= 0) throw new Error("reconciliation_payment_time_mismatch");
  const paidAt = new Date(createdAt * 1000);
  if (!Number.isFinite(paidAt.getTime()) || paidAt.getTime() > now.getTime() + 60_000) throw new Error("reconciliation_payment_time_mismatch");
  return paidAt;
}

export async function reconcileRecentPayments(db: SqlDatabase, store: SaaSStore, razorpay: RazorpayClient, now = new Date(), planIds?: { student?: string; teacher?: string }): Promise<{ checked: number; refunded: number; failed: number; recovered: number }> {
  const since = new Date(now.getTime() - 48 * 60 * 60 * 1000);
  const recent = await claimPayments(db, since, "recent", now);
  const stale = await claimPayments(db, since, "stale", now);
  const rows = [...new Map([...recent, ...stale].map(row => [row.provider_payment_id, row])).values()];
  let checked = 0; let refunded = 0; let failed = 0; let recovered = 0; let requests = 0;
  const provider = <T>(run: () => Promise<T>) => {
    if (++requests > MAX_PROVIDER_CHECKS) throw new Error("reconciliation_budget_exhausted");
    return withProviderTimeout(run);
  };
  const each = async (items: ReconciliationRow[], run: (row: ReconciliationRow) => Promise<void>) => {
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
      for (;;) {
        const row = items[next++];
        if (!row) return;
        try { await run(row); } catch { failed += 1; }
      }
    }));
  };
  await each(rows, async row => {
        if (!row.provider_payment_id) throw new Error("reconciliation_payment_missing");
        const payment = await provider(() => razorpay.getPayment(row.provider_payment_id!));
        checked += 1;
        if (!validProviderPayment(payment, row.provider_payment_id) || payment.currency !== "INR" || payment.currency !== row.currency
          || payment.amount !== Number(row.amount_paise)
          || (row.provider_order_id && payment.order_id !== row.provider_order_id)
          || (row.provider_subscription_id && payment.subscription_id && payment.subscription_id !== row.provider_subscription_id)) throw new Error("reconciliation_payment_mismatch");
        if (payment.status === "refunded" && payment.refund_status === "full") {
          if (payment.amount_refunded !== undefined && payment.amount_refunded !== payment.amount) throw new Error("reconciliation_refund_mismatch");
          const owner = await store.paymentOwner(payment.id);
          if (owner !== row.user_id) throw new Error("reconciliation_owner_mismatch");
          if (await store.processBillingEvent({ kind: "payment_refunded", userId: row.user_id, paymentId: payment.id })) refunded += 1;
        }
  });
  const orders = await claimPayments(db, since, "orders", now);
  await each(orders, async row => {
    const orderId = row.provider_order_id!;
    const order = await provider(() => razorpay.getOrder(orderId));
    if (order.id !== orderId || order.amount !== TRIAL_PRICE_PAISE || order.currency !== "INR" || Number(row.amount_paise) !== order.amount || row.currency !== order.currency
      || order.notes?.user_id !== row.user_id || order.notes.kind !== "trial" || order.notes.product !== "classroom_desk_trial") throw new Error("reconciliation_order_mismatch");
    const pageState = await reserveProviderPage(db, `internal:billing-reconciliation:order-payments:${orderId}`, now);
    const page = await provider(() => razorpay.getOrderPayments(orderId, PROVIDER_PAGE_SIZE, pageState.skip));
    if (!validPage(page)) throw new Error("reconciliation_page_mismatch");
    for (const candidate of page.items) {
      try {
      if (!candidate || !/^pay_[A-Za-z0-9_]+$/.test(candidate.id)) throw new Error("reconciliation_payment_mismatch");
      const payment = await provider(() => razorpay.getPayment(candidate.id));
      checked += 1;
      if (!validProviderPayment(payment, candidate.id) || payment.order_id !== orderId || payment.subscription_id || payment.amount !== order.amount || payment.currency !== order.currency
        || (payment.notes?.user_id !== undefined && payment.notes.user_id !== row.user_id)
        || (payment.notes?.kind !== undefined && payment.notes.kind !== "trial")
        || (payment.notes?.product !== undefined && payment.notes.product !== "classroom_desk_trial")) throw new Error("reconciliation_payment_mismatch");
      if (payment.status === "refunded" && payment.refund_status === "full") {
        if (payment.amount_refunded !== undefined && payment.amount_refunded !== payment.amount) throw new Error("reconciliation_refund_mismatch");
        const paidAt = providerPaidAt(payment.created_at, now);
        if (await store.paymentOwner(payment.id, orderId) !== row.user_id) throw new Error("reconciliation_owner_mismatch");
        // Refund-before-capture recovery: establish the terminal marker before
        // filling the pending ledger through the store's tombstone-aware path.
        if (await store.processBillingEvent({ kind: "payment_refunded", userId: row.user_id, paymentId: payment.id })) refunded += 1;
        await store.processBillingEvent({ kind: "trial_captured", userId: row.user_id, paymentId: payment.id, orderId, amountPaise: payment.amount, paidAt });
        continue;
      }
      if (payment.status !== "captured" || paymentHasRefund(payment)) continue;
      const event = parseRazorpayEvent({event:"payment.captured",payload:{payment:{entity:payment},order:{entity:order}}},now,row.user_id);
      if (!event) throw new Error("reconciliation_event_mismatch");
      if (await store.processBillingEvent(event)) recovered += 1;
      } catch { failed += 1; }
    }
    await pageState.finish(page.items.length);
  });
  if (planIds) {
    const subscriptions = await claimPayments(db, since, "subscriptions", now);
    await each(subscriptions, async row => {
      const subscriptionId = row.provider_subscription_id!;
      const subscription = await provider(() => razorpay.getSubscription(subscriptionId));
      if (subscription.id !== subscriptionId || !row.plan || !planIds[row.plan] || subscription.plan_id !== planIds[row.plan]
        || subscription.notes?.user_id !== row.user_id || subscription.notes.plan !== row.plan) throw new Error("reconciliation_subscription_mismatch");
      if (["cancelled", "halted", "completed", "expired"].includes(subscription.status)) {
        // Status-only recovery must not import an unverified provider cycle end.
        // The store preserves any previously verified paid-through entitlement.
        if (await store.processBillingEvent({ kind: "subscription_cancelled", userId: row.user_id, subscriptionId, cancelledAt: now })) recovered += 1;
        return;
      }
      if (subscription.status === "pending") {
        if (await store.processBillingEvent({ kind: "subscription_failed", userId: row.user_id, subscriptionId })) recovered += 1;
        return;
      }
      if (subscription.status !== "active") return;
      if (!Number.isSafeInteger(subscription.current_start) || !Number.isSafeInteger(subscription.current_end)
        || !subscription.current_start || !subscription.current_end || subscription.current_start >= subscription.current_end) throw new Error("reconciliation_cycle_mismatch");
      const pageState = await reserveProviderPage(db, `internal:billing-reconciliation:invoices:${subscriptionId}`, now);
      const page = await provider(() => razorpay.getSubscriptionInvoices(subscriptionId, PROVIDER_PAGE_SIZE, pageState.skip));
      if (!validPage(page)) throw new Error("reconciliation_page_mismatch");
      for (const invoice of page.items) {
        try {
        if (invoice.status !== "paid") continue;
        if (invoice.subscription_id !== subscriptionId || !/^pay_[A-Za-z0-9_]+$/.test(invoice.payment_id)
          || invoice.amount !== planPricePaise(row.plan) || invoice.currency !== "INR") throw new Error("reconciliation_invoice_mismatch");
        const payment = await provider(() => razorpay.getPayment(invoice.payment_id));
        checked += 1;
        if (!validProviderPayment(payment, invoice.payment_id) || payment.invoice_id !== invoice.id || payment.amount !== invoice.amount || payment.currency !== invoice.currency
          || (payment.subscription_id && payment.subscription_id !== subscriptionId) || (payment.order_id && payment.order_id !== invoice.order_id)) throw new Error("reconciliation_payment_mismatch");
        if (payment.status !== "captured" || paymentHasRefund(payment)) continue;
        // A fresh subscription snapshot must never lend its current_end to a
        // historical invoice from a different, possibly refunded billing term.
        if (!paymentMatchesSubscriptionCycle(payment, subscription, now)) continue;
        const event = parseRazorpayEvent({event:"subscription.charged",payload:{payment:{entity:payment},subscription:{entity:subscription}}},now,row.user_id,planIds);
        if (!event) throw new Error("reconciliation_event_mismatch");
        if (await store.processBillingEvent(event)) recovered += 1;
        } catch { failed += 1; }
      }
      await pageState.finish(page.items.length);
    });
  }
  return { checked, refunded, failed, recovered };
}
