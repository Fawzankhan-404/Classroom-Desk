import { createHmac, timingSafeEqual } from "node:crypto";

export function verifyRazorpaySignature(payload: string, signature: string, secret: string): boolean {
  if (!signature || !secret) return false;
  const expected = createHmac("sha256", secret).update(payload, "utf8").digest("hex");
  const provided = Buffer.from(signature, "utf8");
  const wanted = Buffer.from(expected, "utf8");
  return provided.length === wanted.length && timingSafeEqual(provided, wanted);
}

export function verifyCheckoutSignature(orderId: string, paymentId: string, signature: string, secret: string): boolean {
  return verifyRazorpaySignature(`${orderId}|${paymentId}`, signature, secret);
}

export function verifySubscriptionSignature(subscriptionId: string, paymentId: string, signature: string, secret: string): boolean {
  return verifyRazorpaySignature(`${paymentId}|${subscriptionId}`, signature, secret);
}

export interface WebhookDecision { eventId: string; accepted: boolean; reason: "new" | "duplicate" | "invalid"; }

export function acceptWebhook(eventId: string, seen: ReadonlySet<string>, signatureValid: boolean): WebhookDecision {
  if (!signatureValid) return { eventId, accepted: false, reason: "invalid" };
  if (seen.has(eventId)) return { eventId, accepted: false, reason: "duplicate" };
  return { eventId, accepted: true, reason: "new" };
}
