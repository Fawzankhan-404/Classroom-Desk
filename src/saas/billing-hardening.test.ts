import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac, randomBytes } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import type express from "express";
import type { SqlConnection, SqlDatabase } from "../public/postgres.js";
import { SaaSMigration } from "./schema.js";
import { SaaSStore } from "./store.js";
import { registerWebsiteRoutes } from "./website-routes.js";
import { parseRazorpayEvent } from "./billing-events.js";
import { reconcileRecentPayments } from "./reconciliation.js";
import { RazorpayClient, trialOrderReceipt, type RazorpayPayment, type RazorpaySubscription } from "./razorpay-client.js";
import { verifyCheckoutSignature, verifySubscriptionSignature } from "./razorpay.js";
import { renderSubscription } from "./account-portal.js";

const secret = "synthetic-billing-secret";
const now = new Date("2026-10-10T12:00:00.000Z");
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
    expect(page).toContain("Classroom Desk is free");
    expect(page).not.toContain('data-checkout="trial"');
    expect(page).not.toContain("Razorpay");
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

  it("confirms scheduled cancellation only from Razorpay's scheduled-change response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ id: "sub_test", status: "active", has_scheduled_changes: true, change_scheduled_at: 1794225600 })));
    await expect(new RazorpayClient("synthetic-key", secret).cancelSubscription("sub_test", true)).resolves.toMatchObject({ has_scheduled_changes: true });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ id: "sub_test", status: "active", has_scheduled_changes: false })));
    await expect(new RazorpayClient("synthetic-key", secret).cancelSubscription("sub_test", true)).rejects.toThrow("billing_cancellation_unconfirmed");
  });

  it("confirms immediate cancellation only when Razorpay reports cancelled", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ id: "sub_test", status: "cancelled", has_scheduled_changes: false })));
    await expect(new RazorpayClient("synthetic-key", secret).cancelSubscription("sub_test", false)).resolves.toMatchObject({ status: "cancelled" });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ id: "sub_test", status: "active", has_scheduled_changes: true })));
    await expect(new RazorpayClient("synthetic-key", secret).cancelSubscription("sub_test", false)).rejects.toThrow("billing_cancellation_unconfirmed");
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
    await pg.exec("ALTER TABLE classroom_desk_users ADD COLUMN IF NOT EXISTS profile_ciphertext text; ALTER TABLE classroom_desk_users ADD COLUMN IF NOT EXISTS google_subject_hash text; ALTER TABLE classroom_desk_users ADD COLUMN IF NOT EXISTS email_hash text; ALTER TABLE classroom_desk_users ADD COLUMN IF NOT EXISTS display_name_hash text;");
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

  async function harness(ownerId:string,provider:Partial<RazorpayClient>,billingAllowlistUuids?: ReadonlySet<string>) {
    const handlers = new Map<string, (req:express.Request,res:express.Response)=>Promise<unknown>>();
    const app = {use:()=>{},get:()=>{},post:(path:string,...fns:unknown[])=>handlers.set(path,fns.at(-1) as never)} as unknown as express.Express;
    registerWebsiteRoutes(app,{store,secureCookies:false,billingEnabled:true,billingAllowlistUuids:billingAllowlistUuids ?? new Set([ownerId.toLowerCase()]),teacherFeaturesEnabled:true,razorpayKeyId:"synthetic-key",razorpayKeySecret:secret,razorpayPlanIds:planIds,razorpay:provider as RazorpayClient});
    const session = await store.sessions.create(ownerId);
    return async (path:string,body:Record<string,unknown>={}) => {
      let status = 200; let data:unknown;
      const req = {body,get:(name:string)=>name==="cookie"?`cd_session=${session.token}`:undefined} as express.Request;
      const res = {status:(code:number)=>{status=code;return res;},json:(value:unknown)=>{data=value;return res;}} as unknown as express.Response;
      await handlers.get(path)!(req,res);
      return {status,data};
    };
  }
  it("keeps all new billing mutations closed even for a previously allowlisted account", async () => {
    const owner = await user("formerly-allowlisted");
    const other = await user("not-allowlisted");
    const createTrialOrder = vi.fn();
    const createSubscription = vi.fn();
    const getOrder = vi.fn();
    const getPayment = vi.fn();
    const cancelSubscription = vi.fn();
    const allowlisted = await harness(owner.id, { createTrialOrder, createSubscription, getOrder, getPayment, cancelSubscription }, new Set([owner.id.toLowerCase()]));
    const ordinary = await harness(other.id, { createTrialOrder, createSubscription, getOrder, getPayment }, new Set());
    for (const path of ["/api/billing/trial/order", "/api/billing/trial/resume", "/api/billing/subscription", "/api/billing/verify"]) {
      expect(await allowlisted(path)).toMatchObject({ status: 410, data: { error: "billing_retired" } });
      expect(await ordinary(path)).toMatchObject({ status: 410, data: { error: "billing_retired" } });
    }
    expect(createTrialOrder).not.toHaveBeenCalled();
    expect(createSubscription).not.toHaveBeenCalled();
    expect(getOrder).not.toHaveBeenCalled();
    expect(getPayment).not.toHaveBeenCalled();
    expect(cancelSubscription).not.toHaveBeenCalled();
    expect(await store.getUser(owner.id)).not.toBeNull();
    expect(await store.getUser(other.id)).not.toBeNull();
  });

  it("preserves encrypted and opaque account fields when new checkout is rejected", async () => {
    const key = randomBytes(32).toString("base64");
    const privacyStore = new SaaSStore(db, { profileEncryptionKeyBase64: key, requireProfileEncryption: true });
    const originalStore = store;
    store = privacyStore;
    try {
      const owner = await user("synthetic-opaque-billing");
      const raw = (await pg.query<{ google_subject: string; email: string; display_name: string; profile_ciphertext: string; google_subject_hash: string; email_hash: string; display_name_hash: string }>("SELECT google_subject,email,display_name,profile_ciphertext,google_subject_hash,email_hash,display_name_hash FROM classroom_desk_users WHERE id=$1", [owner.id])).rows[0]!;
      const before = { ...raw };
      const send = await harness(owner.id, { createTrialOrder: vi.fn() }, new Set([owner.id.toLowerCase()]));
      expect((await send("/api/billing/trial/order")).status).toBe(410);
      const after = (await pg.query("SELECT google_subject,email,display_name,profile_ciphertext,google_subject_hash,email_hash,display_name_hash FROM classroom_desk_users WHERE id=$1", [owner.id])).rows[0];
      expect(after).toEqual(before);
      expect(await store.pendingTrialOrder(owner.id)).toBeNull();
    } finally { store = originalStore; }
  });

  it("keeps owner-authorized cancellation available for an existing subscription", async () => {
    const owner = await user("cancel-owner");
    const other = await user("cancel-other");
    await store.recordPendingSubscription(owner.id, "student", "sub_existing");
    const cancelSubscription = vi.fn(async (id: string, _atCycleEnd: boolean) => ({ id, status: "active", has_scheduled_changes: true, change_scheduled_at: Math.floor(Date.now() / 1000) + 1 } as RazorpaySubscription));
    const send = await harness(owner.id, { cancelSubscription });
    expect(await send("/api/billing/subscription/cancel", { subscriptionId: "sub_existing" })).toMatchObject({ status: 200, data: { cancelled: true, accessContinuesUntilProviderPaidThrough: true } });
    expect(cancelSubscription).toHaveBeenCalledWith("sub_existing", true);
    const otherSend = await harness(other.id, { cancelSubscription });
    expect(await otherSend("/api/billing/subscription/cancel", { subscriptionId: "sub_existing" })).toMatchObject({ status: 400, data: { error: "invalid_subscription" } });
    expect(cancelSubscription).toHaveBeenCalledTimes(1);
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
      expect(await reconcileRecentPayments(db,store,fixture.provider,now)).toEqual({checked:1,refunded:1,failed:0,recovered:0});
      expect(events).toEqual(["payment_refunded","trial_captured"]);
      expect(fixture.getPayment).toHaveBeenCalledWith("pay_owned");
      expect((await pg.query("SELECT user_id,provider_order_id,provider_payment_id,status FROM classroom_desk_payments")).rows)
        .toEqual([{user_id:owner.id,provider_order_id:"order_owned",provider_payment_id:"pay_owned",status:"refunded"}]);
      const trial=(await pg.query<{paid_at:string;starts_at:string;expires_at:string;status:string}>("SELECT paid_at,starts_at,expires_at,status FROM classroom_desk_trials WHERE user_id=$1",[owner.id])).rows[0]!;
      expect(trial.status).toBe("refunded");
      expect(new Date(trial.paid_at as string).getTime()).toBe(fixture.payment.created_at!*1000);
      expect(new Date(trial.starts_at as string).getTime()).toBe(fixture.payment.created_at!*1000);
      expect(await reconcileRecentPayments(db,store,fixture.provider,now)).toEqual({checked:1,refunded:0,failed:0,recovered:0});
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

  it("does not treat partial refunds or failed attempts as full-refund recovery", async()=>{
    const owner=await user("partial-pending-refund");
    const fixture=await pendingRefund(owner.id,{refund_status:"partial",amount_refunded:100});
    expect(await reconcileRecentPayments(db,store,fixture.provider,now)).toEqual({checked:1,refunded:0,failed:0,recovered:0});
    fixture.payment.status="failed";fixture.payment.refund_status=undefined;fixture.payment.amount_refunded=undefined;
    expect(await reconcileRecentPayments(db,store,fixture.provider,now)).toEqual({checked:1,refunded:0,failed:0,recovered:0});
    expect((await pg.query("SELECT provider_payment_id,status FROM classroom_desk_payments")).rows).toEqual([{provider_payment_id:null,status:"pending"}]);
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
