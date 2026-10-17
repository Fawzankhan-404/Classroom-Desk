import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import express from "express";
import { SaaSMigration } from "./schema.js";
import { SaaSStore } from "./store.js";
import { registerWebsiteRoutes } from "./website-routes.js";
import type { SqlDatabase, SqlConnection } from "../public/postgres.js";

describe("billing terminal-state and referral security with isolated SQL",()=>{
  const pg=new PGlite();let store:SaaSStore;
  beforeAll(async()=>{
    await pg.exec(SaaSMigration);
    const db:SqlDatabase={query:async(sql,values=[])=>({rows:(await pg.query(sql,values)).rows as never}),transaction:async run=>pg.transaction(async tx=>run({query:async(sql,values=[])=>({rows:(await tx.query(sql,values)).rows as never})}))};
    store=new SaaSStore(db,{referralRewardsEnabled:true});
  },30000);
  afterAll(()=>pg.close());
  const user=(name:string)=>store.upsertGoogleIdentity({googleSubject:`isolated-${name}`,email:`${name}@example.invalid`,displayName:"Synthetic fixture",now:new Date()});
  it("fills a pending server-owned order atomically and never resurrects a refunded trial",async()=>{
    const a=await user("trial"),b=await user("trial-other");const paidAt=new Date("2026-10-10T12:00:00Z");
    await store.recordPendingTrialOrder(a.id,"order_owned",900,"INR");
    await expect(store.activateTrial(b.id,"pay_owned",paidAt,900,"order_owned")).rejects.toThrow("trial_order_owner_mismatch");
    expect(await store.activateTrial(a.id,"pay_owned",paidAt,900,"order_owned")).toBe(true);
    const rows=await pg.query<{status:string}>("SELECT status FROM classroom_desk_payments WHERE provider_order_id='order_owned'");expect(rows.rows).toHaveLength(1);
    expect(await store.activateTrial(a.id,"pay_owned",new Date(paidAt.getTime()+60000),900,"order_owned")).toBe(false);
    expect((await store.entitlement(a.id,new Date(paidAt.getTime()+168*3600000-1))).allowed).toBe(true);
    expect((await store.entitlement(a.id,new Date(paidAt.getTime()+168*3600000))).allowed).toBe(false);
    await store.processBillingEvent({kind:"payment_refunded",userId:a.id,paymentId:"pay_owned"});
    expect(await store.activateTrial(a.id,"pay_owned",new Date(),900,"order_owned")).toBe(false);
    expect((await pg.query<{status:string}>("SELECT status FROM classroom_desk_payments WHERE provider_payment_id='pay_owned'")).rows[0].status).toBe("refunded");
  });
  it("keeps cancellation paid-through, rejects refunded replay and prevents renewed-customer referral attribution",async()=>{
    const a=await user("subscriber"),ref=await user("referrer");
    const term=new Date(Date.now()+30*86400000);
    const event={kind:"subscription_paid" as const,userId:a.id,paymentId:"pay_first",subscriptionId:"sub_first",plan:"student" as const,amountPaise:9900,paidThrough:term};
    await store.processBillingEvent(event);
    const code=await store.referrals.ensureCode(ref.id);
    await expect(store.referrals.attribute(code,a.id)).rejects.toThrow("referral_requires_new_customer");
    await store.processBillingEvent({kind:"subscription_cancelled",userId:a.id,subscriptionId:"sub_first",cancelledAt:new Date()});
    expect((await store.entitlement(a.id)).allowed).toBe(true);
    expect((await store.entitlement(a.id,term)).allowed).toBe(false);
    await store.processBillingEvent({...event,paymentId:"pay_delayed"});
    expect((await pg.query<{status:string}>("SELECT status FROM classroom_desk_subscriptions WHERE provider_subscription_id='sub_first'")).rows[0].status).toBe("cancelled");
    await store.processBillingEvent({kind:"payment_refunded",userId:a.id,paymentId:"pay_first"});
    expect(await store.processBillingEvent({...event,paymentId:"pay_after_refund"})).toBe(false);
    expect((await store.entitlement(a.id)).allowed).toBe(false);
  });
  it("awards exactly 30 days for two separate first paid referrals and revokes once on refund",async()=>{
    const ref=await user("two-ref"),a=await user("two-a"),b=await user("two-b");const code=await store.referrals.ensureCode(ref.id);
    await store.referrals.attribute(code,a.id);await store.referrals.attribute(code,b.id);
    const event={kind:"subscription_paid" as const,userId:a.id,paymentId:"pay_ref_a",subscriptionId:"sub_ref_a",plan:"student" as const,amountPaise:9900,paidThrough:new Date(Date.now()+30*86400000)};
    await store.processBillingEvent(event);await store.processBillingEvent({...event,userId:b.id,paymentId:"pay_ref_b",subscriptionId:"sub_ref_b"});
    const grant=(await pg.query<{starts_at:Date;expires_at:Date;revoked_at:Date|null}>("SELECT starts_at,expires_at,revoked_at FROM classroom_desk_entitlement_grants WHERE user_id=$1",[ref.id])).rows[0];
    expect(new Date(grant.expires_at).getTime()-new Date(grant.starts_at).getTime()).toBe(30*86400000);
    await store.processBillingEvent(event);expect((await store.referrals.summary(ref.id)).extraDays).toBe(30);
    await store.processBillingEvent({kind:"payment_refunded",userId:a.id,paymentId:"pay_ref_a"});expect((await store.referrals.summary(ref.id)).extraDays).toBe(0);
  });

  it("persists a missing-payment refund and fills its pending trial order as refunded",async()=>{
    const a=await user("early-trial");const pay="pay_early_trial",order="order_early_trial";
    await store.recordPendingTrialOrder(a.id,order,900,"INR");
    expect(await store.paymentOwner(pay,order)).toBe(a.id);
    const refund={kind:"payment_refunded" as const,userId:a.id,paymentId:pay};
    expect(await store.processWebhook("evt_early_trial_refund","payment.refunded","synthetic-refund",refund)).toBe(true);
    expect(await store.processWebhook("evt_early_trial_refund","payment.refunded","synthetic-refund",refund)).toBe(false);
    expect(await store.processBillingEvent(refund)).toBe(false);
    expect(await store.paymentOwner(pay)).toBe(a.id);
    expect(await store.activateTrial(a.id,pay,new Date(),900,order)).toBe(false);
    await store.recordPendingTrialOrder(a.id,order,900,"INR");
    const marker=(await pg.query<{event_type:string;status:string;payload_hash:string}>("SELECT event_type,status,payload_hash FROM classroom_desk_webhook_events WHERE event_id=$1",[`internal:refund-tombstone:${pay}`])).rows;
    expect(marker).toEqual([{event_type:"internal.refund.tombstone",status:"terminal",payload_hash:a.id}]);
    expect((await pg.query("SELECT provider_payment_id,status FROM classroom_desk_payments WHERE provider_order_id=$1",[order])).rows).toEqual([{provider_payment_id:pay,status:"refunded"}]);
    expect((await pg.query("SELECT status,payment_id FROM classroom_desk_trials WHERE user_id=$1",[a.id])).rows).toEqual([{status:"refunded",payment_id:pay}]);
    expect((await store.entitlement(a.id)).allowed).toBe(false);
  });

  it("records a tombstoned subscription charge as refunded without paid-through or referral credit",async()=>{
    const a=await user("early-sub"),ref=await user("early-sub-referrer");
    await store.referrals.attribute(await store.referrals.ensureCode(ref.id),a.id);
    const event={kind:"subscription_paid" as const,userId:a.id,paymentId:"pay_early_sub",subscriptionId:"sub_early_sub",plan:"student" as const,amountPaise:9900,paidThrough:new Date(Date.now()+30*86400000)};
    await store.recordPendingSubscription(a.id,"student",event.subscriptionId);
    expect(await store.paymentOwner(event.paymentId,undefined,event.subscriptionId)).toBe(a.id);
    expect(await store.processBillingEvent({kind:"payment_refunded",userId:a.id,paymentId:event.paymentId})).toBe(true);
    expect(await store.processBillingEvent(event)).toBe(false);
    expect(await store.processBillingEvent(event)).toBe(false);
    expect((await pg.query("SELECT status,paid_through FROM classroom_desk_subscriptions WHERE provider_subscription_id=$1",[event.subscriptionId])).rows).toEqual([{status:"refunded",paid_through:null}]);
    expect((await pg.query("SELECT status FROM classroom_desk_payments WHERE provider_payment_id=$1",[event.paymentId])).rows).toEqual([{status:"refunded"}]);
    expect((await store.entitlement(a.id)).allowed).toBe(false);
    expect((await store.referrals.summary(ref.id)).qualified).toBe(0);
  });

  it("remembers refunds with no ledger or pending association across store instances",async()=>{
    const a=await user("no-association");
    expect(await store.processBillingEvent({kind:"payment_refunded",userId:a.id,paymentId:"pay_no_association"})).toBe(true);
    const fresh=new SaaSStore(store.db);
    expect(await fresh.paymentOwner("pay_no_association")).toBe(a.id);
    expect(await fresh.activateTrial(a.id,"pay_no_association",new Date(),900)).toBe(false);
    expect((await fresh.entitlement(a.id)).allowed).toBe(false);
    expect((await pg.query("SELECT status FROM classroom_desk_payments WHERE provider_payment_id='pay_no_association'")).rows).toEqual([{status:"refunded"}]);
  });

  it("rejects cross-owner refund, trial, subscription and resolver attempts against an immutable tombstone",async()=>{
    const a=await user("marker-owner"),b=await user("marker-other"),pay="pay_cross_marker";
    await store.processBillingEvent({kind:"payment_refunded",userId:a.id,paymentId:pay});
    await expect(store.processBillingEvent({kind:"payment_refunded",userId:b.id,paymentId:pay})).rejects.toThrow("refund_tombstone_owner_mismatch");
    await expect(store.activateTrial(b.id,pay,new Date(),900)).rejects.toThrow("refund_tombstone_owner_mismatch");
    await store.recordPendingSubscription(b.id,"student","sub_marker_other");
    await expect(store.processBillingEvent({kind:"subscription_paid",userId:b.id,paymentId:pay,subscriptionId:"sub_marker_other",plan:"student",amountPaise:9900,paidThrough:new Date(Date.now()+86400000)})).rejects.toThrow("refund_tombstone_owner_mismatch");
    await store.recordPendingTrialOrder(b.id,"order_marker_other",900,"INR");
    await expect(store.paymentOwner(pay,"order_marker_other")).rejects.toThrow("payment_owner_conflict");
    await expect(store.paymentOwner(pay,undefined,"sub_marker_other")).rejects.toThrow("payment_owner_conflict");
    expect(await store.paymentOwner(pay)).toBe(a.id);
    expect((await pg.query("SELECT 1 FROM classroom_desk_payments WHERE provider_payment_id=$1",[pay])).rows).toHaveLength(0);
    expect((await store.entitlement(b.id)).allowed).toBe(false);
  });

  it("rejects a wrong-owner refund of an existing payment without poisoning its tombstone",async()=>{
    const a=await user("ledger-owner"),b=await user("ledger-other"),pay="pay_ledger_owner";
    await store.activateTrial(a.id,pay,new Date(),900);
    await expect(store.processBillingEvent({kind:"payment_refunded",userId:b.id,paymentId:pay})).rejects.toThrow("refund_payment_owner_mismatch");
    expect((await pg.query("SELECT 1 FROM classroom_desk_webhook_events WHERE event_id=$1",[`internal:refund-tombstone:${pay}`])).rows).toHaveLength(0);
    expect((await store.entitlement(a.id)).allowed).toBe(true);
  });

  it("rejects malformed IDs, conflicting associations and public internal-event collisions",async()=>{
    const a=await user("invalid-owner"),b=await user("invalid-other");
    for(const pay of ["","pay_","sub_wrong","pay_bad/path",`pay_${"a".repeat(129)}`])await expect(store.paymentOwner(pay)).rejects.toThrow("invalid_billing_provider_id");
    await expect(store.paymentOwner("pay_valid","")).rejects.toThrow("invalid_billing_provider_id");
    await expect(store.paymentOwner("pay_valid",undefined,"order_wrong")).rejects.toThrow("invalid_billing_provider_id");
    await store.recordPendingTrialOrder(a.id,"order_resolve_a",900,"INR");
    await store.recordPendingSubscription(b.id,"student","sub_resolve_b");
    await expect(store.paymentOwner("pay_valid","order_resolve_a","sub_resolve_b")).rejects.toThrow("payment_owner_conflict");
    await expect(store.processBillingEvent({kind:"payment_refunded",userId:"not-a-uuid",paymentId:"pay_invalid_owner"})).rejects.toThrow("invalid_billing_owner");
    await expect(store.processBillingEvent({kind:"payment_refunded",userId:"00000000-0000-0000-0000-000000000000",paymentId:"pay_unknown_owner"})).rejects.toThrow("refund_owner_missing");
    const reserved="internal:refund-tombstone:pay_valid";
    await expect(store.recordWebhook(reserved,"payment.refunded","untrusted")).rejects.toThrow("reserved_webhook_event_id");
    await expect(store.processWebhook(reserved,"payment.refunded","untrusted",null)).rejects.toThrow("reserved_webhook_event_id");
    await expect(store.markWebhook(reserved,"processed")).rejects.toThrow("reserved_webhook_event_id");
    expect((await pg.query("SELECT 1 FROM classroom_desk_webhook_events WHERE event_id IN ($1,$2)",["internal:refund-tombstone:pay_invalid_owner","internal:refund-tombstone:pay_unknown_owner"])).rows).toHaveLength(0);
  });

  it.each(["refund-first","capture-first"])("makes concurrent trial refund/capture calls terminal (%s)",async order=>{
    const a=await user(`race-trial-${order}`),pay=`pay_race_trial_${order.replaceAll("-","_")}`,providerOrder=`order_race_${order.replaceAll("-","_")}`;
    await store.recordPendingTrialOrder(a.id,providerOrder,900,"INR");
    const refund=()=>store.processWebhook(`evt_refund_${pay}`,"payment.refunded","refund",{kind:"payment_refunded",userId:a.id,paymentId:pay});
    const capture=()=>store.processWebhook(`evt_capture_${pay}`,"payment.captured","capture",{kind:"trial_captured",userId:a.id,paymentId:pay,orderId:providerOrder,amountPaise:900,paidAt:new Date()});
    await Promise.all(order==="refund-first"?[refund(),capture()]:[capture(),refund()]);
    expect((await pg.query("SELECT status FROM classroom_desk_payments WHERE provider_payment_id=$1",[pay])).rows).toEqual([{status:"refunded"}]);
    expect((await pg.query("SELECT status FROM classroom_desk_trials WHERE user_id=$1",[a.id])).rows).toEqual([{status:"refunded"}]);
    expect((await store.entitlement(a.id)).allowed).toBe(false);
  });

  it.each(["refund-first","capture-first"])("makes concurrent subscription refund/charge calls terminal (%s)",async order=>{
    const a=await user(`race-sub-${order}`),pay=`pay_race_sub_${order.replaceAll("-","_")}`,sub=`sub_race_${order.replaceAll("-","_")}`;
    await store.recordPendingSubscription(a.id,"student",sub);
    const refund=()=>store.processBillingEvent({kind:"payment_refunded",userId:a.id,paymentId:pay});
    const capture=()=>store.processBillingEvent({kind:"subscription_paid",userId:a.id,paymentId:pay,subscriptionId:sub,plan:"student",amountPaise:9900,paidThrough:new Date(Date.now()+30*86400000)});
    await Promise.all(order==="refund-first"?[refund(),capture()]:[capture(),refund()]);
    expect((await pg.query("SELECT status FROM classroom_desk_payments WHERE provider_payment_id=$1",[pay])).rows).toEqual([{status:"refunded"}]);
    expect((await pg.query("SELECT status FROM classroom_desk_subscriptions WHERE provider_subscription_id=$1",[sub])).rows).toEqual([{status:"refunded"}]);
    expect((await store.entitlement(a.id)).allowed).toBe(false);
  });

  it("locks the payment before webhook, account, order or subscription rows",async()=>{
    const a=await user("lock-order"),calls:Array<{sql:string;values:unknown[]}>=[];
    const db:SqlDatabase={query:store.db.query.bind(store.db),transaction:work=>store.db.transaction(tx=>work({query:async(sql,values=[])=>{calls.push({sql,values});return tx.query(sql,values);}}))};
    const tracked=new SaaSStore(db);
    const event={kind:"payment_refunded" as const,userId:a.id,paymentId:"pay_lock_order"};
    const operations=[
      {paymentId:event.paymentId,run:()=>tracked.processBillingEvent(event)},
      {paymentId:event.paymentId,run:()=>tracked.activateTrial(a.id,event.paymentId,new Date(),900)},
      {paymentId:"pay_lock_order_sub",run:()=>tracked.processBillingEvent({kind:"subscription_paid",userId:a.id,paymentId:"pay_lock_order_sub",subscriptionId:"sub_lock_order",plan:"student",amountPaise:9900,paidThrough:new Date(Date.now()+86400000)})},
      {paymentId:event.paymentId,run:()=>tracked.processWebhook("evt_lock_order","payment.refunded","hash",event)},
    ];
    for(const operation of operations){calls.length=0;await operation.run();expect(calls[0]?.sql).toContain("pg_advisory_xact_lock");expect(calls[0]?.values).toEqual([`billing-payment:${operation.paymentId}`]);}
  });
});

describe("website login browser binding",()=>{
  it("requires the initiating browser nonce before consuming Google OAuth state",async()=>{
    const pending=new Map<string,unknown>();const take=vi.fn(async(_kind:string,key:string)=>{const value=pending.get(key);pending.delete(key);return value;});
    const app=express();registerWebsiteRoutes(app,{store:{} as SaaSStore,secureCookies:false,oauth:{clientId:"fixture",clientSecret:"fixture",origin:"http://127.0.0.1",callbackUrl:"http://127.0.0.1/auth/google/callback"},oauthStateStore:{putEphemeral:async(_kind,key,value)=>{pending.set(key,value);},takeEphemeral:take as never}});
    const server=app.listen(0,"127.0.0.1");await new Promise<void>(r=>server.once("listening",r));const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
    try {
      const login=await fetch(origin+"/login",{redirect:"manual"});const state=new URL(login.headers.get("location")!).searchParams.get("state")!;
      expect(login.headers.get("set-cookie")).toContain("HttpOnly; SameSite=Lax");
      for(const cookie of ["","cd_login_state=wrong"]){expect((await fetch(origin+`/auth/google/callback?state=${state}&code=fixture`,{headers:{cookie},redirect:"manual"})).status).toBe(400);}
      expect(take).not.toHaveBeenCalled();expect(pending.has(state)).toBe(true);
      // A missing code verifies browser binding and consumes state without contacting Google.
      const response=await fetch(origin+`/auth/google/callback?state=${state}`,{headers:{cookie:`cd_login_state=${state}`},redirect:"manual"});
      expect(response.status).toBe(400);expect(take).toHaveBeenCalledOnce();expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    } finally {await new Promise<void>(r=>server.close(()=>r()));}
  });
});
