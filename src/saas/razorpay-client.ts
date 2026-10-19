import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { planPricePaise, TRIAL_PRICE_PAISE } from "./campaign.js";
import type { Plan } from "./types.js";

export interface RazorpayOrder { id: string; amount: number; currency: string; status: string; receipt?: string; notes?: Record<string, string>; }
export interface RazorpaySubscription { id: string; plan_id: string; status: string; charge_at?: number; current_start?: number; current_end?: number; notes?: Record<string, string>; }
export interface RazorpayPayment { id: string; order_id?: string | null; subscription_id?: string | null; invoice_id?: string | null; amount: number; currency: string; status: string; refund_status?: string | null; amount_refunded?: number; created_at?: number; notes?: Record<string, string>; }
export interface RazorpayInvoice { id: string; subscription_id: string; payment_id: string; order_id?: string | null; amount: number; currency: string; status: string; billing_start?: number | null; billing_end?: number | null; }
export interface RazorpayCollection<T> { items: T[]; count: number; }

export const PROVIDER_REQUEST_TIMEOUT_MS = 10_000;

/** Includes body decoding, and also bounds fetch implementations that ignore abort. */
export async function withProviderTimeout<T>(run: (signal: AbortSignal) => Promise<T>, timeoutMs = PROVIDER_REQUEST_TIMEOUT_MS): Promise<T> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30_000) throw new Error("invalid_provider_timeout");
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => run(controller.signal)),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error("billing_provider_timeout")); }, timeoutMs);
      }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

export function trialOrderReceipt(value: string): string {
  return `trial_${createHash("sha256").update(value).digest("hex").slice(0, 32)}`;
}

export function validProviderPayment(payment: RazorpayPayment, expectedId: string): boolean {
  return Boolean(payment && payment.id === expectedId && Number.isSafeInteger(payment.amount) && payment.amount > 0
    && typeof payment.currency === "string" && /^[A-Z]{3}$/.test(payment.currency)
    && ["created", "authorized", "captured", "refunded", "failed"].includes(payment.status)
    && paymentRefundStateIsConsistent(payment));
}

export function paymentHasRefund(payment: { amount_refunded?: unknown; refund_status?: unknown }): boolean {
  return (payment.amount_refunded !== undefined && payment.amount_refunded !== 0) || Boolean(payment.refund_status && payment.refund_status !== "none");
}

/** True only when provider fields establish that the entire payment was refunded. */
export function paymentIsFullyRefunded(payment: { amount?: unknown; amount_refunded?: unknown; refund_status?: unknown; status?: unknown }): boolean {
  if (payment.status === "refunded" || payment.refund_status === "full") return true;
  return typeof payment.amount === "number" && Number.isSafeInteger(payment.amount) && payment.amount > 0
    && typeof payment.amount_refunded === "number" && Number.isSafeInteger(payment.amount_refunded)
    && payment.amount_refunded >= payment.amount;
}

/** Reject contradictory refund fields before they can affect checkout or reconciliation. */
export function paymentRefundStateIsConsistent(payment: { amount?: unknown; amount_refunded?: unknown; refund_status?: unknown; status?: unknown }): boolean {
  if (typeof payment.amount !== "number" || !Number.isSafeInteger(payment.amount) || payment.amount <= 0) return false;
  const refunded = payment.amount_refunded;
  if (refunded !== undefined && (typeof refunded !== "number" || !Number.isSafeInteger(refunded) || refunded < 0 || refunded > payment.amount)) return false;
  if (payment.refund_status === "partial") return payment.status === "captured" && typeof refunded === "number" && refunded > 0 && refunded < payment.amount;
  if (payment.refund_status === "full") return refunded === undefined || refunded === payment.amount;
  if (payment.refund_status === undefined || payment.refund_status === null || payment.refund_status === "none") {
    return payment.status !== "refunded" && (refunded === undefined || refunded === 0);
  }
  return false;
}

/** Do not attach a fresh provider cycle end to a historical payment. */
export function paymentMatchesSubscriptionCycle(payment: RazorpayPayment, subscription: RazorpaySubscription, now = new Date()): boolean {
  const start = subscription.current_start; const end = subscription.current_end; const created = payment.created_at;
  return typeof start === "number" && Number.isSafeInteger(start) && start > 0
    && typeof end === "number" && Number.isSafeInteger(end) && start < end && Number.isFinite(new Date(end * 1000).getTime())
    && typeof created === "number" && Number.isSafeInteger(created) && created > 0
    && created >= start - 60 && created < end && created * 1000 <= now.getTime() + 60_000;
}

/** Use the provider invoice's own paid billing period; never lend a newer cycle end to an older invoice. */
export function invoicePaidThrough(invoice: RazorpayInvoice, subscription: RazorpaySubscription): Date | undefined {
  const start = invoice.billing_start; const end = invoice.billing_end; const currentEnd = subscription.current_end;
  if (typeof start !== "number" || !Number.isSafeInteger(start) || start <= 0
    || typeof end !== "number" || !Number.isSafeInteger(end) || start >= end
    || typeof currentEnd !== "number" || !Number.isSafeInteger(currentEnd) || currentEnd <= 0
    || end > currentEnd + 60) return undefined;
  const paidThrough = new Date(end * 1000);
  return Number.isFinite(paidThrough.getTime()) ? paidThrough : undefined;
}

/** Server-only Razorpay REST adapter. It never accepts or stores card data. */
export class RazorpayClient {
  constructor(private readonly keyId: string, private readonly keySecret: string, private readonly baseUrl = "https://api.razorpay.com/v1", private readonly timeoutMs = PROVIDER_REQUEST_TIMEOUT_MS) {}

  async createTrialOrder(receipt: string, userId: string): Promise<RazorpayOrder> {
    const order = await this.post<RazorpayOrder>("/orders", { amount: TRIAL_PRICE_PAISE, currency: "INR", receipt: receipt.length > 0 && receipt.length <= 40 ? receipt : trialOrderReceipt(receipt), notes: { product: "classroom_desk_trial", user_id: userId, kind: "trial" } });
    if (!order || !/^order_[A-Za-z0-9_]+$/.test(order.id) || order.amount !== TRIAL_PRICE_PAISE || order.currency !== "INR" || order.status !== "created") throw new Error("billing_order_mismatch");
    return order;
  }

  async createSubscription(planId: string, totalCount: number, notes: Record<string, string>): Promise<RazorpaySubscription> {
    const subscription = await this.post<RazorpaySubscription>("/subscriptions", { plan_id: planId, total_count: totalCount, customer_notify: 1, notes });
    if (!subscription || !/^sub_[A-Za-z0-9_]+$/.test(subscription.id) || subscription.plan_id !== planId) throw new Error("billing_subscription_mismatch");
    return subscription;
  }

  async cancelSubscription(subscriptionId: string, cancelAtCycleEnd = true): Promise<RazorpaySubscription> {
    const subscription = await this.post<RazorpaySubscription>(`/subscriptions/${encodeURIComponent(subscriptionId)}/cancel`, { cancel_at_cycle_end: cancelAtCycleEnd ? 1 : 0 });
    if (!subscription || subscription.id !== subscriptionId) throw new Error("billing_subscription_mismatch");
    return subscription;
  }
  async getPayment(paymentId: string): Promise<RazorpayPayment> {
    const payment = await this.get<RazorpayPayment>(`/payments/${encodeURIComponent(paymentId)}`);
    if (!validProviderPayment(payment, paymentId)) throw new Error("billing_payment_mismatch");
    return payment;
  }
  async getOrder(orderId: string): Promise<RazorpayOrder> {
    const order = await this.get<RazorpayOrder>(`/orders/${encodeURIComponent(orderId)}`);
    if (!order || order.id !== orderId) throw new Error("billing_order_mismatch");
    return order;
  }
  async getSubscription(subscriptionId: string): Promise<RazorpaySubscription> {
    const subscription = await this.get<RazorpaySubscription>(`/subscriptions/${encodeURIComponent(subscriptionId)}`);
    if (!subscription || subscription.id !== subscriptionId) throw new Error("billing_subscription_mismatch");
    return subscription;
  }
  async getInvoice(invoiceId: string): Promise<RazorpayInvoice> {
    const invoice = await this.get<RazorpayInvoice>(`/invoices/${encodeURIComponent(invoiceId)}`);
    if (!invoice || invoice.id !== invoiceId) throw new Error("billing_invoice_mismatch");
    return invoice;
  }
  async getOrderPayments(orderId: string, count = 5, skip = 0): Promise<RazorpayCollection<RazorpayPayment>> {
    return this.getPage<RazorpayPayment>(`/orders/${encodeURIComponent(orderId)}/payments`, count, skip);
  }
  async getSubscriptionInvoices(subscriptionId: string, count = 5, skip = 0): Promise<RazorpayCollection<RazorpayInvoice>> {
    return this.getPage<RazorpayInvoice>(`/invoices?subscription_id=${encodeURIComponent(subscriptionId)}`, count, skip);
  }

  static monthlyPrice(plan: Plan): number { return planPricePaise(plan); }

  private async getPage<T>(path: string, count: number, skip: number): Promise<RazorpayCollection<T>> {
    if (!Number.isSafeInteger(count) || count < 1 || count > 100 || !Number.isSafeInteger(skip) || skip < 0) throw new Error("invalid_provider_page");
    const page = await this.get<RazorpayCollection<T>>(`${path}${path.includes("?") ? "&" : "?"}count=${count}&skip=${skip}`);
    if (!page || !Array.isArray(page.items) || page.items.length > count || !Number.isSafeInteger(page.count) || page.count !== page.items.length) throw new Error("billing_page_mismatch");
    return page;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    if (!this.keyId || !this.keySecret) throw new Error("Razorpay is not configured.");
    return withProviderTimeout(async signal => {
      const response = await fetch(`${this.baseUrl}${path}`, { method: "POST", signal, headers: { Authorization: `Basic ${Buffer.from(`${this.keyId}:${this.keySecret}`).toString("base64")}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!response.ok) throw new Error(`Razorpay request failed with status ${response.status}.`);
      return await response.json() as T;
    }, this.timeoutMs);
  }
  private async get<T>(path: string): Promise<T> {
    if (!this.keyId || !this.keySecret) throw new Error("Razorpay is not configured.");
    return withProviderTimeout(async signal => {
      const response = await fetch(`${this.baseUrl}${path}`, { signal, headers: { Authorization: `Basic ${Buffer.from(`${this.keyId}:${this.keySecret}`).toString("base64")}` } });
      if (!response.ok) throw new Error(`Razorpay request failed with status ${response.status}.`);
      return await response.json() as T;
    }, this.timeoutMs);
  }
}
