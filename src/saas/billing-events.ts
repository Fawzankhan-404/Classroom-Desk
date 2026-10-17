import { planPricePaise, TRIAL_PRICE_PAISE } from "./campaign.js";
import { paymentHasRefund } from "./razorpay-client.js";

export type BillingEvent =
  | { kind: "trial_captured"; userId: string; paymentId: string; orderId?: string; amountPaise: number; paidAt: Date }
  | { kind: "subscription_paid"; userId: string; subscriptionId: string; paymentId: string; plan: "student" | "teacher"; amountPaise: number; paidThrough: Date }
  | { kind: "subscription_cancelled"; userId: string; subscriptionId: string; cancelledAt: Date }
  | { kind: "subscription_failed"; userId: string; subscriptionId: string }
  | { kind: "payment_refunded"; userId: string; paymentId: string };

/** Strictly classifies only events carrying the application correlation note. */
export function parseRazorpayEvent(body: unknown, now = new Date(), knownPaymentUserId?:string, planIds?: { student?: string; teacher?: string }): BillingEvent | null {
  if (!isRecord(body) || typeof body.event !== "string") return null;
  const payment = record(record(record(body.payload)?.payment)?.entity);
  const subscription = record(record(record(body.payload)?.subscription)?.entity);
  const order = record(record(record(body.payload)?.order)?.entity);
  const paymentNotes = record(payment?.notes); const subscriptionNotes = record(subscription?.notes); const orderNotes = record(order?.notes);
  const userId = knownPaymentUserId ?? string(paymentNotes?.user_id) ?? string(subscriptionNotes?.user_id) ?? string(orderNotes?.user_id);
  if (!userId) return null;
  const isRefund = body.event === "payment.refunded" || body.event === "refund.processed";
  // Refund ownership comes from the immutable local payment ledger. Other
  // events must not combine conflicting provider/application correlations.
  if (!isRefund && [paymentNotes, subscriptionNotes, orderNotes].some(notes => string(notes?.user_id) && notes?.user_id !== userId)) return null;
  if (body.event === "payment.captured" && payment) {
    const amount = number(payment.amount); const paymentId = string(payment.id);
    if (!amount || !paymentId || payment.currency !== "INR" || payment.status !== "captured" || paymentHasRefund(payment)) return null;
    const kind = string(paymentNotes?.kind) ?? string(orderNotes?.kind);
    if (order && (payment.order_id !== order.id || order.amount !== amount || order.currency !== "INR")) return null;
    if ([paymentNotes, orderNotes].some(notes => string(notes?.product) && notes?.product !== "classroom_desk_trial")) return null;
    const paidAt = providerEventTime(body.created_at ?? payment.created_at, now);
    return kind === "trial" && amount === TRIAL_PRICE_PAISE && paidAt ? { kind: "trial_captured", userId, paymentId, orderId: string(payment.order_id), amountPaise: amount, paidAt } : null;
  }
  if (body.event === "subscription.charged" && subscription && payment) {
    const subscriptionId = string(subscription.id); const paymentId = string(payment.id); const plan = string(subscriptionNotes?.plan); const amount = number(payment.amount);
    if (!subscriptionId || !paymentId || (plan !== "student" && plan !== "teacher") || !amount || amount !== planPricePaise(plan)) return null;
    const cycleEnd = number(subscription.current_end);
    if(!cycleEnd || payment.currency!=="INR" || payment.status!=="captured" || paymentHasRefund(payment))return null;
    if (payment.subscription_id !== undefined && payment.subscription_id !== null && payment.subscription_id !== subscriptionId) return null;
    if (planIds && (!planIds[plan] || subscription.plan_id !== planIds[plan])) return null;
    const paidThrough = new Date(cycleEnd*1000);
    if(!Number.isFinite(paidThrough.getTime()))return null;
    return { kind: "subscription_paid", userId, subscriptionId, paymentId, plan, amountPaise: amount, paidThrough };
  }
  if ((body.event === "subscription.cancelled" || body.event === "subscription.halted") && subscription) {
    const subscriptionId = string(subscription.id); if (!subscriptionId) return null;
    return { kind: "subscription_cancelled", userId, subscriptionId, cancelledAt: now };
  }
  if (body.event === "subscription.pending" && subscription) {
    const subscriptionId = string(subscription.id); if (!subscriptionId) return null;
    return { kind: "subscription_failed", userId, subscriptionId };
  }
  if ((body.event === "payment.refunded" || body.event === "refund.processed") && payment) {
    if(body.event==='refund.processed'){
      const refund=record(record(record(body.payload)?.refund)?.entity);
      if(refund?.status!=='processed'||refund.payment_id!==payment.id)return null;
    }
    // A partial refund needs separate reconciliation; do not revoke an entire
    // paid term based on an unspecified or partial refund amount.
    if(payment.refund_status!=="full" || payment.currency!=="INR")return null;
    const paymentId = string(payment.id); if (!paymentId) return null;
    return { kind: "payment_refunded", userId, paymentId };
  }
  return null;
}

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const record = (value: unknown): Json | undefined => isRecord(value) ? value : undefined;
const string = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value : undefined;
const number = (value: unknown): number | undefined => typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;

function providerEventTime(value: unknown, now: Date): Date | undefined {
  const seconds = number(value);
  if (!seconds) return undefined;
  const date = new Date(seconds * 1000);
  return Number.isFinite(date.getTime()) && date.getTime() <= now.getTime() + 60_000 ? date : undefined;
}
