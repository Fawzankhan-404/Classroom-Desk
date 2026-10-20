import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import type express from "express";
import type { SqlConnection, SqlDatabase } from "../public/postgres.js";
import { SaaSMigration } from "./schema.js";
import { SaaSStore } from "./store.js";
import { registerWebsiteRoutes } from "./website-routes.js";
import { parseRazorpayEvent } from "./billing-events.js";
import { reconcileRecentPayments } from "./reconciliation.js";
import { invoicePaidThrough, RazorpayClient, trialOrderReceipt, type RazorpayPayment, type RazorpaySubscription } from "./razorpay-client.js";
import { verifyCheckoutSignature, verifySubscriptionSignature } from "./razorpay.js";
import { renderSubscription } from "./account-portal.js";

const secret = "synthetic-billing-secret";
const now = new Date();
const planIds = { student: "plan_student", teacher: "plan_teacher" };
const sign = (value: string) => createHmac("sha256", secret).update(value).digest("hex");

describe("billing provider boundaries (all fetches mocked)", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

  it("keeps order and subscription signature protocols distinct", () => {
    expect(verifyCheckoutSignature("order_test", "pay_test", sign("order_test|pay_test"), secret)).toBe(true);
    expect(verifySubscriptionSignature("sub_test", "pay_test", sign("pay_test|sub_test"), secret)).toBe(true);
    expect(verifySubscriptionSignature("sub_test", "pay_test", sign("sub_test|pay_test"), secret)).toBe(false);
    expect(verifyCheckoutSignature("order_test", "pay_test", "invalid", secret)).toBe(false);
  });

  it("does not offer a second trial while the first trial is active", () => {
    const view = { user: { id:"00000000-0000-0000-0000-000000000001", googleSubject:"s", email:"reviewer@example.invalid", displayName:"Reviewer", role:"student", status:"active", createdAt:now, lastLoginAt:now }, entitlement:{allowed:true,reason:"active_trial",plan:"student",expiresAt:new Date("2026-10-18T06:09:57.000Z")}, history:{trialStatus:"active",trialExpiresAt:new Date("2026-10-18T06:09:57.000Z"),subscriptions:[],referralsMade:0}, payments:[], linked:false, deletionRequested:false } as never;
    const page = renderSubscription(view, true);
    expect(page).toContain("Trial active");
    expect(page).not.toContain('data-checkout="trial"');
  });

  it("hides plan and trial offers when billing is disabled and keeps them in enabled environments", () => {
    const view = { user: { id:"00000000-0000-0000-0000-000000000001", googleSubject:"s", email:"reviewer@example.invalid", displayName:"Reviewer", role:"student", status:"active", createdAt:now, lastLoginAt:now }, entitlement:{allowed:false,reason:"expired",plan:null,expiresAt:null}, history:{trialStatus:"eligible",trialExpiresAt:null,subscriptions:[],referralsMade:0}, payments:[], linked:false, deletionRequested:false } as never;
    const stagingPage = renderSubscription(view, false);
    expect(stagingPage).toContain("Checkout is unavailable right now");
    expect(stagingPage).not.toContain("Plan information");
    expect(stagingPage).not.toContain("₹99/month");
    expect(stagingPage).not.toContain("₹199/month");
    expect(stagingPage).not.toContain("₹9 once for 168 hours");
    expect(stagingPage).not.toContain("data-checkout=");
    const productionPage = renderSubscription(view, true, true);
    expect(productionPage).toContain("Plan information");
    expect(productionPage).toContain("₹99/month");
    expect(productionPage).toContain("₹199/month");
    expect(productionPage).toContain("₹9 once for 168 hours");
  });

  it("bounds long UUID receipts before the provider POST and does not retry", async () => {
    const fetch = vi.fn(async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      expect(body.receipt.length).toBeLessThanOrEqual(40);
      expect(body.notes).toMatchObject({ user_id: "owner", kind: "trial" });
      return Response.json({ id: "order_test", amount: 900, currency: "INR", status: "created" });
    });
    vi.stubGlobal("fetch", fetch);
    await new RazorpayClient("synthetic-key", secret).createTrialOrder(`trial_${"a".repeat(36)}_1791633600000`, "owner");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(trialOrderReceipt("one")).not.toBe(trialOrderReceipt("two"));
  });

  it("rejects a payment response belonging to a different requested ID", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ id: "pay_other", amount: 900, currency: "INR", status: "captured" })));
    await expect(new RazorpayClient("synthetic-key", secret).getPayment("pay_requested")).rejects.toThrow("billing_payment_mismatch");
  });

  it("rejects a same-ID subscription cancellation response that confirms no cancellation", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ id: "sub_requested", plan_id: "plan_student", status: "active", has_scheduled_changes: false })));
    await expect(new RazorpayClient("synthetic-key", secret).cancelSubscription("sub_requested", true)).rejects.toThrow("billing_cancellation_unconfirmed");
  });

  it("accepts a cycle-end cancellation only when Razorpay confirms a scheduled change", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ id: "sub_requested", plan_id: "plan_student", status: "active", has_scheduled_changes: true })));
    await expect(new RazorpayClient("synthetic-key", secret).cancelSubscription("sub_requested", true)).resolves.toMatchObject({
      id: "sub_requested", has_scheduled_changes: true,
    });
  });

  it("bounds fetch and response-body stalls, including implementations ignoring abort", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const fetch = vi.fn((_url: unknown, init: RequestInit) => { signal = init.signal as AbortSignal; return new Promise<Response>(() => {}); });
    vi.stubGlobal("fetch", fetch);
    const result = expect(new RazorpayClient("synthetic-key", secret, "https://provider.invalid/v1", 20).getPayment("pay_test")).rejects.toThrow("billing_provider_timeout");
    await vi.advanceTimersByTimeAsync(21);
    await result;
    expect(signal?.aborted).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    fetch.mockImplementation(() => Promise.resolve({ ok: true, json: () => new Promise(() => {}) } as Response));
    const body = expect(new RazorpayClient("synthetic-key", secret, "https://provider.invalid/v1", 20).getPayment("pay_test")).rejects.toThrow("billing_provider_timeout");
    await vi.advanceTimersByTimeAsync(21);
    await body;
  });

  it("bounds and validates provider pagination", async () => {
    const fetch = vi.fn(async (url: string) => {
      expect(url).toContain("count=5&skip=5");
      return Response.json({ count: 6, items: Array.from({length:6}, () => ({id:"pay_test"})) });
    });
    vi.stubGlobal("fetch", fetch);
    await expect(new RazorpayClient("synthetic-key", secret).getOrderPayments("order_test", 5, 5)).rejects.toThrow("billing_page_mismatch");
  });

  it("uses immutable signed/provider timestamps and rejects missing or future trial times", () => {
    const created = Math.floor(now.getTime()/1000) - 2*86400;
    const payment = { id:"pay_test",order_id:"order_test",amount:900,currency:"INR",status:"captured",created_at:created,notes:{user_id:"owner",kind:"trial"} };
    const body = {event:"payment.captured",payload:{payment:{entity:payment}}};
    expect(parseRazorpayEvent(body, now)).toMatchObject({orderId:"order_test",paidAt:new Date(created*1000)});
    expect(parseRazorpayEvent({...body,created_at:created+60},now)).toMatchObject({paidAt:new Date((created+60)*1000)});
    expect(parseRazorpayEvent({...body,payload:{payment:{entity:{...payment,created_at:undefined}}}},now)).toBeNull();
    expect(parseRazorpayEvent({...body,created_at:now.getTime()/1000+61},now)).toBeNull();
  });

  it("rejects conflicting subscription users, plans, payment linkage and refunded captures", () => {
    const payment = {id:"pay_test",subscription_id:"sub_test",amount:9900,currency:"INR",status:"captured",notes:{user_id:"owner"}};
    const subscription = {id:"sub_test",plan_id:planIds.student,current_end:1794225600,notes:{user_id:"owner",plan:"student"}};
    const event = (p=payment,s=subscription) => ({event:"subscription.charged",payload:{payment:{entity:p},subscription:{entity:s}}});
    expect(parseRazorpayEvent(event(),now,"owner",planIds)).toMatchObject({kind:"subscription_paid"});
    expect(parseRazorpayEvent(event({...payment,notes:{user_id:"other"}}),now,"owner",planIds)).toBeNull();
    expect(parseRazorpayEvent(event(payment,{...subscription,plan_id:planIds.teacher}),now,"owner",planIds)).toBeNull();
    expect(parseRazorpayEvent(event({...payment,subscription_id:"sub_other"}),now,"owner",planIds)).toBeNull();
    expect(parseRazorpayEvent(event({...payment,refund_status:"full"} as typeof payment),now,"owner",planIds)).toBeNull();
  });
});

describe("billing ownership and fair recovery with isolated PostgreSQL", () => {
  const pg = new PGlite();
  let db: SqlDatabase;
  let store: SaaSStore;
  beforeAll(async () => {
    await pg.exec(SaaSMigration);
    const query: SqlConnection["query"] = async (sql,values=[]) => ({rows:(await pg.query(sql,values)).rows as never});
    db = {query,transaction:work=>pg.transaction(tx=>work({query:async(sql,values=[])=>({rows:(await tx.query(sql,values)).rows as never})}))};
    store = new SaaSStore(db);
  },30000);
  beforeEach(async () => { await pg.exec("TRUNCATE classroom_desk_users,classroom_desk_webhook_events CASCADE"); });
  afterAll(async () => { await pg.close(); });

  const user = (name:string) => store.upsertGoogleIdentity({googleSubject:`billing-${name}`,email:`${name}@example.invalid`,displayName:name,now});
  const captured = (id:string,extra:Partial<RazorpayPayment>={}) => ({id,amount:900,currency:"INR",status:"captured",created_at:Math.floor(Date.now()/1000)-3600,...extra});
  const order = (owner:string,status="paid") => ({id:"order_owned",amount:900,currency:"INR",status,notes:{user_id:owner,kind:"trial",product:"classroom_desk_trial"}});
  const subscription = (owner:string):RazorpaySubscription => ({id:"sub_owned",plan_id:planIds.student,status:"active",current_start:Math.floor(Date.now()/1000)-3600,current_end:Math.floor(Date.now()/1000)+30*86400,notes:{user_id:owner,plan:"student"}});

  async function harness(ownerId:string,provider:Partial<RazorpayClient>) {
    const handlers = new Map<string, (req:express.Request,res:express.Response)=>Promise<unknown>>();
    const app = {use:()=>{},get:()=>{},post:(path:string,...fns:unknown[])=>handlers.set(path,fns.at(-1) as never)} as unknown as express.Express;
    registerWebsiteRoutes(app,{store,secureCookies:false,billingEnabled:true,teacherFeaturesEnabled:true,razorpayKeyId:"synthetic-key",razorpayKeySecret:secret,razorpayPlanIds:planIds,razorpay:provider as RazorpayClient});
    const session = await store.sessions.create(ownerId);
    return async (path:string,body:Record<string,unknown>={}) => {
      let status = 200; let data:unknown;
      const req = {body,get:(name:string)=>name==="cookie"?`cd_session=${session.token}`:undefined} as express.Request;
      const res = {status:(code:number)=>{status=code;return res;},json:(value:unknown)=>{data=value;return res;}} as unknown as express.Response;
      await handlers.get(path)!(req,res);
      return {status,data};
    };
  }
  const trialBody = () => ({razorpay_order_id:"order_owned",razorpay_payment_id:"pay_owned",razorpay_signature:sign("order_owned|pay_owned")});
  const subBody = () => ({razorpay_subscription_id:"sub_owned",razorpay_payment_id:"pay_owned",razorpay_signature:sign("pay_owned|sub_owned")});

  it("persists the pending order before returning checkout data with a bounded receipt", async () => {
    const owner = await user("order-owner");
    const createTrialOrder = vi.fn(async (receipt:string) => {expect(receipt.length).toBeLessThanOrEqual(40);return order(owner.id,"created");});
    const send = await harness(owner.id,{createTrialOrder});
    expect((await send("/api/billing/trial/order")).status).toBe(201);
    const rows = await pg.query("SELECT user_id,provider_order_id,provider_payment_id,status FROM classroom_desk_payments");
    expect(rows.rows).toEqual([{user_id:owner.id,provider_order_id:"order_owned",provider_payment_id:null,status:"pending"}]);
  });

  it("keeps trial eligibility reserved after an ambiguous provider failure", async () => {
    const owner = await user("trial-provider-ambiguous");
    const createTrialOrder = vi.fn(async () => { throw new Error("synthetic provider timeout after request send"); });
    const send = await harness(owner.id, { createTrialOrder });

    expect(await send("/api/billing/trial/order")).toEqual({ status: 503, data: { error: "trial_creation_requires_reconciliation" } });
    expect((await pg.query("SELECT status FROM classroom_desk_trials WHERE user_id=$1", [owner.id])).rows).toEqual([{ status: "pending" }]);
    expect(await store.pendingTrialOrder(owner.id)).toEqual({ kind: "reconciliation_required" });
    expect(await send("/api/billing/trial/order")).toEqual({ status: 409, data: { error: "trial_not_eligible" } });
    expect(createTrialOrder).toHaveBeenCalledTimes(1);
  });

  it("does not release a trial when the provider created an order but local persistence failed", async () => {
    const owner = await user("trial-persistence-ambiguous");
    const createTrialOrder = vi.fn(async () => order(owner.id, "created"));
    const send = await harness(owner.id, { createTrialOrder });
    const persistence = vi.spyOn(store, "recordPendingTrialOrder").mockRejectedValueOnce(new Error("synthetic storage outage"));
    try {
      expect(await send("/api/billing/trial/order")).toEqual({ status: 503, data: { error: "trial_creation_requires_reconciliation" } });
      expect((await pg.query("SELECT status FROM classroom_desk_trials WHERE user_id=$1", [owner.id])).rows).toEqual([{ status: "pending" }]);
      expect(await send("/api/billing/trial/resume")).toEqual({ status: 409, data: { error: "trial_creation_requires_reconciliation" } });
      expect(await send("/api/billing/trial/order")).toEqual({ status: 409, data: { error: "trial_not_eligible" } });
      expect(createTrialOrder).toHaveBeenCalledTimes(1);
    } finally { persistence.mockRestore(); }
  });

  it("serializes concurrent subscription creation and resumes the stored pending provider subscription", async () => {
    const owner = await user("subscription-create-race");
    let startProvider!: () => void; let releaseProvider!: () => void;
    const providerStarted = new Promise<void>(resolve => { startProvider = resolve; });
    const providerWait = new Promise<void>(resolve => { releaseProvider = resolve; });
    const created = { id: "sub_create_once", plan_id: planIds.student, status: "created", notes: { user_id: owner.id, plan: "student" } };
    const createSubscription = vi.fn(async (_planId: string, _totalCount: number, notes: Record<string, string>) => {
      expect(notes).toMatchObject({ user_id: owner.id, plan: "student" });
      startProvider(); await providerWait; return created;
    });
    const send = await harness(owner.id, { createSubscription });
    const firstRequest = send("/api/billing/subscription", { plan: "student" });
    await providerStarted;
    expect(await send("/api/billing/subscription", { plan: "student" })).toEqual({ status: 409, data: { error: "creation_in_progress" } });
    expect(createSubscription).toHaveBeenCalledTimes(1);
    releaseProvider();
    expect(await firstRequest).toEqual({ status: 201, data: { subscriptionId: "sub_create_once", plan: "student", keyId: "synthetic-key" } });
    expect(await send("/api/billing/subscription", { plan: "student" })).toEqual({ status: 200, data: { subscriptionId: "sub_create_once", plan: "student", keyId: "synthetic-key", resumed: true } });
    expect(createSubscription).toHaveBeenCalledTimes(1);
    expect((await pg.query("SELECT count(*) AS count FROM classroom_desk_subscriptions WHERE user_id=$1", [owner.id])).rows).toEqual([{ count: 1 }]);
  });

  it("fails closed after an ambiguous provider or persistence failure and never starts a duplicate subscription", async () => {
    const owner = await user("subscription-create-unknown");
    const createSubscription = vi.fn(async () => ({ id: "sub_untracked", plan_id: planIds.student, status: "created", notes: { user_id: owner.id, plan: "student" } }));
    const send = await harness(owner.id, { createSubscription });
    const persistence = vi.spyOn(store, "completeSubscriptionCreation").mockRejectedValueOnce(new Error("synthetic persistence outage"));
    try {
      expect(await send("/api/billing/subscription", { plan: "student" })).toEqual({ status: 503, data: { error: "subscription_creation_requires_reconciliation" } });
      expect((await pg.query("SELECT state FROM classroom_desk_subscription_creation_reservations WHERE user_id=$1", [owner.id])).rows).toEqual([{ state: "unknown" }]);
      expect(await send("/api/billing/subscription", { plan: "student" })).toEqual({ status: 409, data: { error: "creation_requires_reconciliation" } });
      expect(createSubscription).toHaveBeenCalledTimes(1);
    } finally { persistence.mockRestore(); }
  });

  it("records provider timeouts as unresolved creation attempts without retrying", async () => {
    const owner = await user("subscription-create-timeout");
    const createSubscription = vi.fn(async () => { throw new Error("synthetic provider timeout"); });
    const send = await harness(owner.id, { createSubscription });
    expect(await send("/api/billing/subscription", { plan: "teacher" })).toEqual({ status: 503, data: { error: "subscription_creation_requires_reconciliation" } });
    expect((await pg.query("SELECT state,plan FROM classroom_desk_subscription_creation_reservations WHERE user_id=$1", [owner.id])).rows).toEqual([{ state: "unknown", plan: "teacher" }]);
    expect(await send("/api/billing/subscription", { plan: "teacher" })).toEqual({ status: 409, data: { error: "creation_requires_reconciliation" } });
    expect(createSubscription).toHaveBeenCalledTimes(1);
  });

  it("moves a stale subscription reservation to reconciliation without retrying the provider", async () => {
    const owner = await user("subscription-create-stale");
    const reservation = await store.reserveSubscriptionCreation(owner.id, "student");
    expect(reservation.kind).toBe("reserved");
    if (reservation.kind !== "reserved") throw new Error("reservation was not created");
    await pg.query("UPDATE classroom_desk_subscription_creation_reservations SET updated_at=$1 WHERE user_id=$2", [new Date(Date.now() - 31 * 60 * 1000), owner.id]);
    const createSubscription = vi.fn();
    const send = await harness(owner.id, { createSubscription });
    expect(await send("/api/billing/subscription", { plan: "student" })).toEqual({ status: 409, data: { error: "creation_requires_reconciliation" } });
    expect((await pg.query("SELECT state FROM classroom_desk_subscription_creation_reservations WHERE user_id=$1", [owner.id])).rows).toEqual([{ state: "unknown" }]);
    expect(createSubscription).not.toHaveBeenCalled();
  });

  it("resumes an owned open order and expires a provider-closed attempt without granting access", async () => {
    const owner = await user("resume-owner");
    await store.beginTrialPurchase(owner.id, now);
    await store.recordPendingTrialOrder(owner.id,"order_owned",900,"INR");
    const send = await harness(owner.id,{getOrder:async()=>order(owner.id,"created"),getOrderPayments:async()=>({count:0,items:[]})});
    expect(await send("/api/billing/trial/resume")).toMatchObject({status:200,data:{orderId:"order_owned",resumed:true}});
    const closed = await harness(owner.id,{getOrder:async()=>order(owner.id,"closed"),getOrderPayments:async()=>({count:0,items:[]})});
    expect(await closed("/api/billing/trial/resume")).toMatchObject({status:409,data:{error:"trial_attempt_expired"}});
    expect(await store.beginTrialPurchase(owner.id, new Date(now.getTime() + 31 * 60 * 1000))).toBe(true);
    expect((await store.entitlement(owner.id)).allowed).toBe(false);
  });

  it("does not create a second trial order from an old but still open reservation", async () => {
    const owner = await user("trial-open-stale");
    const createTrialOrder = vi.fn(async () => order(owner.id, "created"));
    const send = await harness(owner.id, { createTrialOrder });
    expect((await send("/api/billing/trial/order")).status).toBe(201);
    await pg.query("UPDATE classroom_desk_trials SET pending_at=$1 WHERE user_id=$2", [new Date(Date.now() - 31 * 60 * 1000), owner.id]);
    expect(await send("/api/billing/trial/order")).toEqual({ status: 409, data: { error: "trial_not_eligible" } });
    expect(createTrialOrder).toHaveBeenCalledTimes(1);
    const resume = await harness(owner.id, { getOrder: async () => order(owner.id, "created"), getOrderPayments: async () => ({ count: 0, items: [] }) });
    expect(await resume("/api/billing/trial/resume")).toMatchObject({ status: 200, data: { orderId: "order_owned", resumed: true } });
  });

  it("blocks another session and unknown orders before any provider reads", async () => {
    const a=await user("a"),b=await user("b");
    await store.recordPendingTrialOrder(a.id,"order_owned",900,"INR");
    const getPayment=vi.fn(),getOrder=vi.fn();
    const send=await harness(b.id,{getPayment,getOrder});
    expect((await send("/api/billing/verify",trialBody())).status).toBe(403);
    expect(getPayment).not.toHaveBeenCalled();expect(getOrder).not.toHaveBeenCalled();
    const sendOwner = await harness(a.id,{getPayment,getOrder});
    expect(await sendOwner("/api/billing/verify",{...trialBody(),razorpay_order_id:"order_unknown",razorpay_signature:sign("order_unknown|pay_owned")})).toMatchObject({status:403});
  });

  it("activates a trial when an authorized capture has no optional order association",async()=>{
    const owner=await user("trial-without-order");
    const event={kind:"trial_captured" as const,userId:owner.id,paymentId:"pay_without_order",amountPaise:900,paidAt:now};
    expect(await store.processBillingEvent(event)).toBe(true);
    expect((await pg.query<{status:string;provider_order_id:string|null}>("SELECT status,provider_order_id FROM classroom_desk_payments WHERE provider_payment_id=$1",[event.paymentId])).rows[0]).toEqual({status:"captured",provider_order_id:null});
    expect((await store.entitlement(owner.id,now)).allowed).toBe(true);
  });

  it("merges the pending order on valid checkout and does not extend access on replay", async () => {
    const owner=await user("verified");
    await store.recordPendingTrialOrder(owner.id,"order_owned",900,"INR");
    const payment=captured("pay_owned",{order_id:"order_owned"});
    const send=await harness(owner.id,{getPayment:async()=>payment,getOrder:async()=>order(owner.id)});
    expect((await send("/api/billing/verify",trialBody())).status).toBe(200);
    const before=await pg.query<{starts_at:string;expires_at:string}>("SELECT starts_at,expires_at FROM classroom_desk_trials WHERE user_id=$1",[owner.id]);
    expect(new Date(before.rows[0]!.starts_at as string).getTime()).toBe(payment.created_at!*1000);
    expect((await send("/api/billing/verify",trialBody())).status).toBe(200);
    expect((await pg.query("SELECT * FROM classroom_desk_payments")).rows).toHaveLength(1);
    expect((await pg.query("SELECT starts_at,expires_at FROM classroom_desk_trials WHERE user_id=$1",[owner.id])).rows).toEqual(before.rows);
  });

  it.each([
    {id:"pay_other"},{amount:899},{currency:"USD"},{status:"authorized"},
    {refund_status:"full"},{amount_refunded:1},{order_id:"order_other"},{notes:{user_id:"other"}},
  ])("rejects mismatched provider payment %j without activation", async extra => {
    const owner=await user("bad-payment");
    await store.recordPendingTrialOrder(owner.id,"order_owned",900,"INR");
    const send=await harness(owner.id,{getPayment:async()=>captured("pay_owned",{order_id:"order_owned",...extra}),getOrder:async()=>order(owner.id)});
    expect((await send("/api/billing/verify",trialBody())).status).not.toBe(200);
    expect((await store.entitlement(owner.id)).allowed).toBe(false);
    expect((await pg.query("SELECT status FROM classroom_desk_payments")).rows[0]).toEqual({status:"pending"});
  });

  it("accepts subscription signatures only with stored ownership and configured plan", async () => {
    const owner=await user("sub-owner");
    await store.recordPendingSubscription(owner.id,"student","sub_owned");
    const send=await harness(owner.id,{getPayment:async()=>captured("pay_owned",{amount:9900,subscription_id:"sub_owned"}),getSubscription:async()=>subscription(owner.id)});
    expect((await send("/api/billing/verify",{...subBody(),razorpay_signature:sign("sub_owned|pay_owned")})).status).toBe(400);
    expect((await send("/api/billing/verify",subBody())).status).toBe(200);
    expect((await store.entitlement(owner.id)).plan).toBe("student");
  });

  it("binds subscription payments through invoices when the payment omits subscription_id", async () => {
    const owner=await user("invoice-owner");
    await store.recordPendingSubscription(owner.id,"student","sub_owned");
    const getInvoice=vi.fn(async()=>({id:"inv_owned",subscription_id:"sub_owned",payment_id:"pay_owned",amount:9900,currency:"INR",status:"paid"}));
    const send=await harness(owner.id,{getPayment:async()=>captured("pay_owned",{amount:9900,invoice_id:"inv_owned"}),getSubscription:async()=>subscription(owner.id),getInvoice});
    expect((await send("/api/billing/verify",subBody())).status).toBe(200);
    expect(getInvoice).toHaveBeenCalledWith("inv_owned");
  });

  it.each(["historical", "future"])("rejects a %s subscription payment despite a valid signature", async age => {
    const owner=await user("cycle-owner");
    await store.recordPendingSubscription(owner.id,"student","sub_owned");
    const sub=subscription(owner.id);
    const created_at=age==="historical"?sub.current_start!-86400:Math.floor(Date.now()/1000)+120;
    const send=await harness(owner.id,{getPayment:async()=>captured("pay_owned",{amount:9900,subscription_id:"sub_owned",created_at}),getSubscription:async()=>sub});
    expect((await send("/api/billing/verify",subBody())).status).toBe(400);
    expect((await store.entitlement(owner.id)).allowed).toBe(false);
  });

  it.each(["ownership","plan","payment-link","invoice-link"])("rejects subscription %s mismatches", async mismatch => {
    const owner=await user("sub-bad"),other=await user("sub-other");
    await store.recordPendingSubscription(mismatch==="ownership"?other.id:owner.id,"student","sub_owned");
    const getPayment=vi.fn(async()=>captured("pay_owned",{amount:9900,subscription_id:mismatch==="payment-link"?"sub_other":mismatch==="invoice-link"?undefined:"sub_owned",invoice_id:"inv_owned"}));
    const send=await harness(owner.id,{getPayment,getSubscription:async()=>({...subscription(owner.id),plan_id:mismatch==="plan"?planIds.teacher:planIds.student}),getInvoice:async()=>({id:"inv_owned",subscription_id:"sub_other",payment_id:"pay_owned",amount:9900,currency:"INR",status:"paid"})});
    expect((await send("/api/billing/verify",subBody())).status).not.toBe(200);
    expect((await store.entitlement(owner.id)).allowed).toBe(false);
    if(mismatch==="ownership")expect(getPayment).not.toHaveBeenCalled();
  });

  it("advances across more than 200 stale payments despite failures and timestamp ties", async () => {
    const owner=await user("queue");
    await pg.query(`INSERT INTO classroom_desk_payments (user_id,kind,amount_paise,currency,provider_payment_id,status,created_at) SELECT $1,'trial',900,'INR','pay_queue_'||n,'captured',$2::timestamptz FROM generate_series(1,251) n`,[owner.id,"2026-10-01T00:00:00.123456Z"]);
    const seen=new Set<string>();let calls=0;
    const getPayment=async(id:string)=>{seen.add(id);calls++;if(Number(id.split("_").at(-1))<=150)throw new Error("synthetic_provider_failure");return captured(id);};
    for(let run=0;run<3;run++){
      const before=calls;await reconcileRecentPayments(db,store,{getPayment} as RazorpayClient,now);
      expect(calls-before).toBeLessThanOrEqual(100);
    }
    expect(seen.size).toBe(251);
    const before=calls;await reconcileRecentPayments(db,store,{getPayment} as RazorpayClient,now);
    expect(calls).toBeGreaterThan(before);
  });

  it("recovers a pending order from a later provider page with the original trial start", async () => {
    const owner=await user("pending-order");
    await store.recordPendingTrialOrder(owner.id,"order_owned",900,"INR");
    await pg.query("UPDATE classroom_desk_payments SET created_at=$1",[new Date(now.getTime()-86400000)]);
    const payments=Array.from({length:7},(_,i)=>captured(`pay_attempt_${i}`,{order_id:"order_owned",status:i===6?"captured":"failed",created_at:Math.floor(now.getTime()/1000)-7200}));
    const skips:number[]=[];
    const provider={getOrder:async()=>order(owner.id),getOrderPayments:async(_id:string,count:number,skip:number)=>{skips.push(skip);const items=payments.slice(skip,skip+count);return{items,count:items.length};},getPayment:async(id:string)=>payments.find(p=>p.id===id)!} as unknown as RazorpayClient;
    expect((await reconcileRecentPayments(db,store,provider,now)).recovered).toBe(0);
    expect((await reconcileRecentPayments(db,store,provider,now)).recovered).toBe(1);
    expect(skips).toEqual([0,5]);
    const trial=(await pg.query<{starts_at:string;expires_at:string}>("SELECT starts_at,expires_at FROM classroom_desk_trials WHERE user_id=$1",[owner.id])).rows[0]!;
    expect(new Date(trial.starts_at as string).getTime()).toBe(payments[6]!.created_at!*1000);
    expect(new Date(trial.expires_at as string).getTime()-new Date(trial.starts_at as string).getTime()).toBe(168*3600000);
    expect((await pg.query("SELECT * FROM classroom_desk_payments WHERE user_id=$1",[owner.id])).rows).toHaveLength(1);
  });

  it("recovers a missed subscription charge from a later invoice page without using old invoices", async () => {
    const owner=await user("pending-sub");
    await store.recordPendingSubscription(owner.id,"student","sub_owned");
    await pg.query("UPDATE classroom_desk_subscriptions SET created_at=$1",[new Date(now.getTime()-86400000)]);
    const currentStart=Math.floor(now.getTime()/1000)-3600;
    const sub={...subscription(owner.id),current_start:currentStart,current_end:Math.floor(now.getTime()/1000)+29*86400};
    const invoices=Array.from({length:6},(_,i)=>({id:`inv_${i}`,subscription_id:"sub_owned",payment_id:`pay_invoice_${i}`,amount:9900,currency:"INR",status:"paid"}));
    const skips:number[]=[];
    const provider={getSubscription:async()=>sub,getSubscriptionInvoices:async(_id:string,count:number,skip:number)=>{skips.push(skip);const items=invoices.slice(skip,skip+count);return{items,count:items.length};},getPayment:async(id:string)=>{const i=Number(id.split("_").at(-1));return captured(id,{amount:9900,invoice_id:`inv_${i}`,created_at:i===5?currentStart+60:currentStart-86400});}} as unknown as RazorpayClient;
    expect((await reconcileRecentPayments(db,store,provider,now,planIds)).recovered).toBe(0);
    expect((await store.entitlement(owner.id)).allowed).toBe(false);
    expect((await reconcileRecentPayments(db,store,provider,now,planIds)).recovered).toBe(1);
    expect(skips).toEqual([0,5]);
    expect((await store.entitlement(owner.id,now)).plan).toBe("student");
  });

  it("recovers an older paid subscription invoice using only its own verified billing end", async () => {
    const owner=await user("historical-invoice");
    await store.recordPendingSubscription(owner.id,"student","sub_owned");
    await pg.query("UPDATE classroom_desk_subscriptions SET created_at=$1",[new Date(now.getTime()-86400000)]);
    const currentStart=Math.floor(now.getTime()/1000)-3600;
    const currentEnd=Math.floor(now.getTime()/1000)+29*86400;
    const oldEnd=currentStart-30*86400;
    const sub={...subscription(owner.id),current_start:currentStart,current_end:currentEnd};
    const invoice={id:"inv_old",subscription_id:"sub_owned",payment_id:"pay_old_invoice",amount:9900,currency:"INR",status:"paid",billing_start:oldEnd-30*86400,billing_end:oldEnd};
    const payment=captured("pay_old_invoice",{amount:9900,invoice_id:invoice.id,created_at:oldEnd-60});
    const provider={getSubscription:async()=>sub,getSubscriptionInvoices:async()=>({items:[invoice],count:1}),getPayment:async()=>payment} as unknown as RazorpayClient;

    expect(await reconcileRecentPayments(db,store,provider,now,planIds)).toMatchObject({recovered:1,failed:0});
    expect((await pg.query("SELECT paid_through FROM classroom_desk_subscriptions WHERE provider_subscription_id='sub_owned'")).rows[0]?.paid_through).toEqual(new Date(oldEnd*1000));
    expect((await store.entitlement(owner.id,now)).allowed).toBe(false);
  });

  it("rejects malformed and future-out-of-cycle subscription invoice periods", () => {
    const sub={...subscription("owner"),current_end:1_900_000_000};
    const invoice={id:"inv_period",subscription_id:"sub_owned",payment_id:"pay_period",amount:9900,currency:"INR",status:"paid"};
    expect(invoicePaidThrough({...invoice,billing_start:1_800_000_000,billing_end:1_850_000_000},sub)).toEqual(new Date(1_850_000_000_000));
    expect(invoicePaidThrough({...invoice,billing_start:1_850_000_000,billing_end:1_800_000_000},sub)).toBeUndefined();
    expect(invoicePaidThrough({...invoice,billing_start:1_800_000_000,billing_end:1_950_000_000},sub)).toBeUndefined();
    expect(invoicePaidThrough({...invoice,billing_start:null,billing_end:1_850_000_000},sub)).toBeUndefined();
  });

  async function pendingRefund(ownerId:string, extra:Partial<RazorpayPayment>={}) {
    await store.recordPendingTrialOrder(ownerId,"order_owned",900,"INR");
    await pg.query("UPDATE classroom_desk_payments SET created_at=$1 WHERE provider_order_id='order_owned'",[new Date(now.getTime()-86400000)]);
    const payment=captured("pay_owned",{order_id:"order_owned",status:"refunded",refund_status:"full",amount_refunded:900,created_at:Math.floor(now.getTime()/1000)-7200,...extra});
    const getOrder=vi.fn(async()=>order(ownerId));
    // Discovery metadata is not authoritative: the direct payment GET must be checked.
    const getOrderPayments=vi.fn(async()=>({items:[{id:"pay_owned",created_at:Math.floor(now.getTime()/1000)}],count:1}));
    const getPayment=vi.fn(async()=>payment);
    return {payment,getOrder,getOrderPayments,getPayment,provider:{getOrder,getOrderPayments,getPayment} as unknown as RazorpayClient};
  }

  it("recovers a fully refunded pending order through a tombstone before terminal ledger repair, never access", async () => {
    const owner=await user("pending-refund");
    const fixture=await pendingRefund(owner.id);
    const process=store.processBillingEvent.bind(store);
    const events:string[]=[];
    const spy=vi.spyOn(store,"processBillingEvent").mockImplementation(async event=>{
      events.push(event.kind);
      const result=await process(event);
      expect((await store.entitlement(owner.id,now)).allowed).toBe(false);
      return result;
    });
    try {
      expect(await reconcileRecentPayments(db,store,fixture.provider,now)).toEqual({checked:1,refunded:1,partiallyRefunded:0,failed:0,recovered:0});
      expect(events).toEqual(["payment_refunded","trial_captured"]);
      expect(fixture.getPayment).toHaveBeenCalledWith("pay_owned");
      expect((await pg.query("SELECT user_id,provider_order_id,provider_payment_id,status FROM classroom_desk_payments")).rows)
        .toEqual([{user_id:owner.id,provider_order_id:"order_owned",provider_payment_id:"pay_owned",status:"refunded"}]);
      const trial=(await pg.query<{paid_at:string;starts_at:string;expires_at:string;status:string}>("SELECT paid_at,starts_at,expires_at,status FROM classroom_desk_trials WHERE user_id=$1",[owner.id])).rows[0]!;
      expect(trial.status).toBe("refunded");
      expect(new Date(trial.paid_at as string).getTime()).toBe(fixture.payment.created_at!*1000);
      expect(new Date(trial.starts_at as string).getTime()).toBe(fixture.payment.created_at!*1000);
      expect(await reconcileRecentPayments(db,store,fixture.provider,now)).toEqual({checked:1,refunded:0,partiallyRefunded:0,failed:0,recovered:0});
      expect(fixture.getOrderPayments).toHaveBeenCalledTimes(1);
      expect((await pg.query("SELECT paid_at,starts_at,expires_at,status FROM classroom_desk_trials WHERE user_id=$1",[owner.id])).rows[0]).toEqual(trial);
      expect((await pg.query("SELECT payload_hash,status FROM classroom_desk_webhook_events WHERE event_id=$1",["internal:refund-tombstone:pay_owned"])).rows)
        .toEqual([{payload_hash:owner.id,status:"terminal"}]);
      expect(await process({kind:"trial_captured",userId:owner.id,paymentId:"pay_owned",orderId:"order_owned",amountPaise:900,paidAt:new Date(fixture.payment.created_at!*1000)})).toBe(false);
      expect((await store.entitlement(owner.id,now)).allowed).toBe(false);
    } finally { spy.mockRestore(); }
  });

  it.each([
    {id:"pay_other"},{order_id:"order_other"},{amount:899},{currency:"USD"},{subscription_id:"sub_other"},
    {amount_refunded:899},{notes:{user_id:"other"}},{notes:{kind:"subscription"}},{notes:{product:"other"}},
    {created_at:undefined},{created_at:NaN},{created_at:Infinity},{created_at:Number.MAX_SAFE_INTEGER},
    {created_at:0},{created_at:-1},{created_at:1.5},{created_at:Math.floor(now.getTime()/1000)+61},
  ] as Partial<RazorpayPayment>[])("rejects an unverified pending-order refund %j before tombstone or ledger mutation", async extra=>{
    const owner=await user("invalid-pending-refund");
    const fixture=await pendingRefund(owner.id,extra);
    expect((await reconcileRecentPayments(db,store,fixture.provider,now)).failed).toBe(1);
    expect((await pg.query("SELECT provider_payment_id,status FROM classroom_desk_payments")).rows)
      .toEqual([{provider_payment_id:null,status:"pending"}]);
    expect((await pg.query("SELECT 1 FROM classroom_desk_webhook_events WHERE event_type='internal.refund.tombstone'")).rows).toHaveLength(0);
    expect((await store.entitlement(owner.id,now)).allowed).toBe(false);
  });

  it("rejects pending-order refund ownership conflicting with an existing payment ledger", async()=>{
    const owner=await user("refund-order-owner"),other=await user("refund-payment-owner");
    const fixture=await pendingRefund(owner.id);
    await pg.query("INSERT INTO classroom_desk_payments (user_id,kind,amount_paise,currency,provider_payment_id,status,created_at) VALUES ($1,'trial',900,'INR','pay_owned','refunded',$2)",[other.id,new Date(now.getTime()-4*86400000)]);
    expect((await reconcileRecentPayments(db,store,fixture.provider,now)).failed).toBe(1);
    expect((await pg.query("SELECT provider_payment_id,status FROM classroom_desk_payments WHERE user_id=$1",[owner.id])).rows)
      .toEqual([{provider_payment_id:null,status:"pending"}]);
    expect((await pg.query("SELECT 1 FROM classroom_desk_webhook_events WHERE event_type='internal.refund.tombstone'")).rows).toHaveLength(0);
    expect(await store.paymentOwner("pay_owned")).toBe(other.id);
  });

  it("recovers a captured partial refund without treating it as fully refunded", async()=>{
    const owner=await user("partial-pending-refund");
    const fixture=await pendingRefund(owner.id,{status:"captured",refund_status:"partial",amount_refunded:100});
    expect(await reconcileRecentPayments(db,store,fixture.provider,now)).toEqual({checked:1,refunded:0,partiallyRefunded:1,failed:0,recovered:1});
    expect((await pg.query<{status:string;amount_refunded_paise:number}>("SELECT status,amount_refunded_paise FROM classroom_desk_payments WHERE provider_payment_id='pay_owned'")).rows[0]).toEqual({status:"partially_refunded",amount_refunded_paise:100});
    expect((await store.entitlement(owner.id,now)).allowed).toBe(true);
    fixture.payment.status="failed";fixture.payment.refund_status=undefined;fixture.payment.amount_refunded=undefined;
    expect(await reconcileRecentPayments(db,store,fixture.provider,now)).toEqual({checked:1,refunded:0,partiallyRefunded:0,failed:0,recovered:0});
    expect((await pg.query("SELECT provider_payment_id,status FROM classroom_desk_payments")).rows).toEqual([{provider_payment_id:"pay_owned",status:"partially_refunded"}]);
    expect((await store.entitlement(owner.id,now)).allowed).toBe(true);
  });

  it("tracks cumulative subscription refunds without revoking the verified paid term",async()=>{
    const owner=await user("partial-subscription-refund");
    const paidThrough=new Date(now.getTime()+30*86400000);
    const payment={kind:"subscription_paid" as const,userId:owner.id,subscriptionId:"sub_partial_refund",paymentId:"pay_partial_refund",plan:"student" as const,amountPaise:9900,paidThrough};
    expect(await store.processBillingEvent(payment)).toBe(true);
    const partial={kind:"payment_partially_refunded" as const,userId:owner.id,subscriptionId:payment.subscriptionId,paymentId:payment.paymentId,amountPaise:9900,amountRefundedPaise:1200};
    expect(await store.processBillingEvent(partial)).toBe(true);
    expect(await store.processBillingEvent(partial)).toBe(false);
    expect(await store.processBillingEvent({...partial,amountRefundedPaise:800})).toBe(false);
    expect(await store.processBillingEvent({...partial,amountRefundedPaise:2500})).toBe(true);
    expect((await pg.query<{status:string;amount_refunded_paise:number}>("SELECT status,amount_refunded_paise FROM classroom_desk_payments WHERE provider_payment_id=$1",[payment.paymentId])).rows[0]).toEqual({status:"partially_refunded",amount_refunded_paise:2500});
    expect((await pg.query<{status:string;paid_through:Date}>("SELECT status,paid_through FROM classroom_desk_subscriptions WHERE provider_subscription_id=$1",[payment.subscriptionId])).rows[0]).toEqual({status:"active",paid_through:paidThrough});
    expect((await store.entitlement(owner.id,now)).allowed).toBe(true);
    const referrer=await user("partial-refund-referrer");
    const code=await store.referrals.ensureCode(referrer.id);
    await expect(store.referrals.attribute(code,owner.id)).rejects.toThrow("referral_requires_new_customer");
    expect(await store.processBillingEvent({kind:"payment_refunded",userId:owner.id,paymentId:payment.paymentId})).toBe(true);
    expect((await pg.query<{status:string;amount_refunded_paise:number}>("SELECT status,amount_refunded_paise FROM classroom_desk_payments WHERE provider_payment_id=$1",[payment.paymentId])).rows[0]).toEqual({status:"refunded",amount_refunded_paise:9900});
    expect((await store.entitlement(owner.id,now)).allowed).toBe(false);
  });

  it.each(["cancelled","halted","completed","expired"])("recovers verified %s subscription state while preserving only the stored paid-through",async status=>{
    const owner=await user(`terminal-${status}`);
    await store.recordPendingSubscription(owner.id,"student","sub_owned");
    const paidThrough=new Date(now.getTime()+3*86400000);
    await pg.query("UPDATE classroom_desk_subscriptions SET status='active',paid_through=$1,created_at=$2",[paidThrough,new Date(now.getTime()-86400000)]);
    const getSubscription=vi.fn(async()=>({...subscription(owner.id),status,current_end:Math.floor(now.getTime()/1000)+365*86400}));
    const getSubscriptionInvoices=vi.fn(),getPayment=vi.fn();
    const provider={getSubscription,getSubscriptionInvoices,getPayment} as unknown as RazorpayClient;
    expect((await reconcileRecentPayments(db,store,provider,now,planIds)).failed).toBe(0);
    const rows=(await pg.query<{status:string;paid_through:string|null;cancelled_at:string|null}>("SELECT status,paid_through,cancelled_at FROM classroom_desk_subscriptions")).rows;
    expect(rows).toHaveLength(1);expect(rows[0]!.status).toBe("cancelled");
    expect(new Date(rows[0]!.paid_through as string).getTime()).toBe(paidThrough.getTime());
    expect(new Date(rows[0]!.cancelled_at as string).getTime()).toBe(now.getTime());
    expect((await store.entitlement(owner.id,now)).allowed).toBe(true);
    expect((await store.entitlement(owner.id,new Date(paidThrough.getTime()+1))).allowed).toBe(false);
    await reconcileRecentPayments(db,store,provider,new Date(now.getTime()+60000),planIds);
    expect((await pg.query("SELECT status,paid_through,cancelled_at FROM classroom_desk_subscriptions")).rows).toEqual(rows);
    expect(getSubscription).toHaveBeenCalledTimes(1);
    expect(getSubscriptionInvoices).not.toHaveBeenCalled();expect(getPayment).not.toHaveBeenCalled();
    expect((await pg.query("SELECT * FROM classroom_desk_payments")).rows).toHaveLength(0);
  });

  it.each(["cancelled","halted","completed","expired"])("records %s for an unpaid pending subscription without manufacturing a paid cycle",async status=>{
    const owner=await user(`unpaid-${status}`);
    await store.recordPendingSubscription(owner.id,"student","sub_owned");
    await pg.query("UPDATE classroom_desk_subscriptions SET created_at=$1",[new Date(now.getTime()-86400000)]);
    const getSubscriptionInvoices=vi.fn(),getPayment=vi.fn();
    await reconcileRecentPayments(db,store,{getSubscription:async()=>({...subscription(owner.id),status}),getSubscriptionInvoices,getPayment} as unknown as RazorpayClient,now,planIds);
    expect((await pg.query("SELECT status,paid_through FROM classroom_desk_subscriptions")).rows).toEqual([{status:"cancelled",paid_through:null}]);
    expect((await store.entitlement(owner.id,now)).allowed).toBe(false);
    expect(getSubscriptionInvoices).not.toHaveBeenCalled();expect(getPayment).not.toHaveBeenCalled();
    expect((await pg.query("SELECT * FROM classroom_desk_payments")).rows).toHaveLength(0);
  });

  it.each([false,true])("maps verified pending retry state to failure without revoking an unexpired paid term (paid=%s)",async paid=>{
    const owner=await user("pending-provider-sub");
    await store.recordPendingSubscription(owner.id,"student","sub_owned");
    const paidThrough=paid?new Date(Math.max(now.getTime()+3*86400000,Date.now()+3*86400000)):null;
    await pg.query("UPDATE classroom_desk_subscriptions SET status=$1,paid_through=$2,created_at=$3",[paid?"active":"pending",paidThrough,new Date(now.getTime()-86400000)]);
    const getSubscriptionInvoices=vi.fn(),getPayment=vi.fn();
    const provider={getSubscription:async()=>({...subscription(owner.id),status:"pending"}),getSubscriptionInvoices,getPayment} as unknown as RazorpayClient;
    await reconcileRecentPayments(db,store,provider,now,planIds);
    const row=(await pg.query<{status:string;paid_through:string|null}>("SELECT status,paid_through FROM classroom_desk_subscriptions")).rows[0]!;
    expect(row.status).toBe(paid?"active":"past_due");
    expect(row.paid_through?new Date(row.paid_through as string).getTime():null).toBe(paidThrough?.getTime()??null);
    expect((await store.entitlement(owner.id,now)).allowed).toBe(paid);
    expect(getSubscriptionInvoices).not.toHaveBeenCalled();expect(getPayment).not.toHaveBeenCalled();
    expect((await pg.query("SELECT * FROM classroom_desk_payments")).rows).toHaveLength(0);
  });

  it.each(["created","authenticated","unknown"])("does not classify provider %s onboarding state as a failed or paid subscription",async status=>{
    const owner=await user("unpaid-onboarding");
    await store.recordPendingSubscription(owner.id,"student","sub_owned");
    await pg.query("UPDATE classroom_desk_subscriptions SET created_at=$1",[new Date(now.getTime()-86400000)]);
    await reconcileRecentPayments(db,store,{getSubscription:async()=>({...subscription(owner.id),status})} as unknown as RazorpayClient,now,planIds);
    expect((await pg.query("SELECT status,paid_through FROM classroom_desk_subscriptions")).rows).toEqual([{status:"pending",paid_through:null}]);
    expect((await store.entitlement(owner.id,now)).allowed).toBe(false);
  });

  it.each(["id","owner","plan","configured-plan"])("rejects a terminal subscription with a mismatched %s before changing local state",async mismatch=>{
    const owner=await user("invalid-terminal-sub");
    await store.recordPendingSubscription(owner.id,"student","sub_owned");
    await pg.query("UPDATE classroom_desk_subscriptions SET created_at=$1",[new Date(now.getTime()-86400000)]);
    const sub={...subscription(owner.id),status:"cancelled"};
    if(mismatch==="id")sub.id="sub_other";
    if(mismatch==="owner")sub.notes={...sub.notes,user_id:"other"};
    if(mismatch==="plan")sub.notes={...sub.notes,plan:"teacher"};
    if(mismatch==="configured-plan")sub.plan_id=planIds.teacher;
    expect((await reconcileRecentPayments(db,store,{getSubscription:async()=>sub} as unknown as RazorpayClient,now,planIds)).failed).toBe(1);
    expect((await pg.query("SELECT status,paid_through,cancelled_at FROM classroom_desk_subscriptions")).rows).toEqual([{status:"pending",paid_through:null,cancelled_at:null}]);
  });

  it("rejects mismatched refund IDs and amounts while allowing valid refunds", async () => {
    const owner=await user("refund-check");
    await store.activateTrial(owner.id,"pay_refund",new Date(now.getTime()-3600000),900);
    const invalid={getPayment:async()=>captured("pay_other",{status:"refunded",refund_status:"full"})} as unknown as RazorpayClient;
    expect((await reconcileRecentPayments(db,store,invalid,new Date())).failed).toBe(1);
    expect((await store.entitlement(owner.id)).allowed).toBe(true);
    const wrongAmount={getPayment:async()=>captured("pay_refund",{amount:800,status:"refunded",refund_status:"full"})} as unknown as RazorpayClient;
    expect((await reconcileRecentPayments(db,store,wrongAmount,new Date())).failed).toBe(1);
    const valid={getPayment:async()=>captured("pay_refund",{status:"refunded",refund_status:"full",amount_refunded:900})} as unknown as RazorpayClient;
    expect((await reconcileRecentPayments(db,store,valid,new Date())).refunded).toBe(1);
    expect((await store.entitlement(owner.id)).allowed).toBe(false);
  });
});
