import { isTrialOrderCreatedByCutoff, planPricePaise, TRIAL_PRICE_PAISE } from "./campaign.js";
import { paymentIsFullyRefunded, paymentRefundStateIsConsistent } from "./razorpay-client.js";

export type BillingEvent =
  | { kind: "trial_captured"; userId: string; paymentId: string; orderId?: string; amountPaise: number; paidAt: Date }
  | { kind: "subscription_paid"; userId: string; subscriptionId: string; paymentId: string; plan: "student" | "teacher"; amountPaise: number; paidThrough: Date }
  | { kind: "subscription_cancelled"; userId: string; subscriptionId: string; cancelledAt: Date }
  | { kind: "subscription_failed"; userId: string; subscriptionId: string }
  | { kind: "payment_refunded"; userId: string; paymentId: string }
  | { kind: "payment_partially_refunded"; userId: string; paymentId: string; amountPaise: number; amountRefundedPaise: number; orderId?: string; subscriptionId?: string };

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
    if (!amount || !paymentId || payment.currency !== "INR" || payment.status !== "captured" || !paymentRefundStateIsConsistent(payment) || paymentIsFullyRefunded(payment)) return null;
    const kind = string(paymentNotes?.kind) ?? string(orderNotes?.kind);
    if (order && (payment.order_id !== order.id || order.amount !== amount || order.currency !== "INR")) return null;
    if ([paymentNotes, orderNotes].some(notes => string(notes?.product) && notes?.product !== "classroom_desk_trial")) return null;
    const paidAt = providerEventTime(body.created_at ?? payment.created_at, now);
    const orderId = string(payment.order_id);
    return kind === "trial" && amount === TRIAL_PRICE_PAISE && paidAt && orderId && order && order.id === orderId
      && isTrialOrderCreatedByCutoff(order.created_at)
      ? { kind: "trial_captured", userId, paymentId, orderId, amountPaise: amount, paidAt } : null;
  }
  if (body.event === "subscription.charged" && subscription && payment) {
    const subscriptionId = string(subscription.id); const paymentId = string(payment.id); const plan = string(subscriptionNotes?.plan); const amount = number(payment.amount);
    if (!subscriptionId || !paymentId || (plan !== "student" && plan !== "teacher") || !amount || amount !== planPricePaise(plan)) return null;
    const cycleEnd = number(subscription.current_end);
    if(!cycleEnd || payment.currency!=="INR" || payment.status!=="captured" || !paymentRefundStateIsConsistent(payment) || paymentIsFullyRefunded(payment))return null;
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
    const paymentId = string(payment.id); const amount = number(payment.amount); const amountRefunded = number(payment.amount_refunded);
    if (!paymentId || !amount || payment.currency !== "INR" || !paymentRefundStateIsConsistent(payment)) return null;
    let refundAmount: number | undefined;
    if(body.event==='refund.processed'){
      const refund=record(record(record(body.payload)?.refund)?.entity);
      refundAmount = number(refund?.amount);
      if(refund?.status!=='processed'||refund.payment_id!==payment.id||refund.currency!=='INR'||!refundAmount||refundAmount>amount)return null;
    }
    if (payment.refund_status === "partial" && amountRefunded !== undefined && amountRefunded > 0 && amountRefunded < amount) {
      // A refund is linked only through an existing server-side payment,
      // order, or subscription association. Provider notes alone are not an
      // ownership proof for a partial-refund state change.
      if (payment.status !== "captured" || !knownPaymentUserId || (refundAmount !== undefined && refundAmount > amountRefunded)) return null;
      const orderId = string(payment.order_id); const subscriptionId = string(payment.subscription_id);
      if (orderId && !/^order_[A-Za-z0-9_]+$/.test(orderId)) return null;
      if (subscriptionId && !/^sub_[A-Za-z0-9_]+$/.test(subscriptionId)) return null;
      return { kind: "payment_partially_refunded", userId: knownPaymentUserId, paymentId, amountPaise: amount, amountRefundedPaise: amountRefunded, orderId, subscriptionId };
    }
    // Full refunds alone are terminal and revoke a paid term. Partial refunds
    // are tracked separately without shortening the provider-confirmed term.
    if(!paymentIsFullyRefunded(payment) || payment.currency!=="INR")return null;
    if (amountRefunded !== undefined && amountRefunded !== amount) return null;
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
