import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { SaaSMigration } from "./schema.js";
import { SaaSStore } from "./store.js";
import type { SqlDatabase, SqlConnection } from "../public/postgres.js";
import express from "express";
import { createServer } from "node:http";
import { registerWebsiteRoutes } from "./website-routes.js";
import { resolveEntitlement } from "./entitlements.js";
import {registerInternalLink} from "./internal-link.js";
import {registerAdminRoutes} from "./admin-routes.js";
import { reconcileRecentPayments } from "./reconciliation.js";
import { renderSubscription } from "./account-portal.js";
import { safeWebsiteReturnPath } from "./website-routes.js";

describe("Account portal with isolated PostgreSQL persistence", () => {
  const pg=new PGlite();
  let store:SaaSStore;
  beforeAll(async()=>{
    await pg.exec(SaaSMigration);
    const query:SqlConnection["query"] = async (sql,values=[]) => ({rows:(await pg.query(sql,values)).rows as never});
    const db:SqlDatabase={query,transaction:async work=>pg.transaction(async tx=>work({query:async(sql,values=[])=>({rows:(await tx.query(sql,values)).rows as never})}))};
    store=new SaaSStore(db,{referralRewardsEnabled:true});
  },30000);
  afterAll(async()=>pg.close());
  const identity=(n:string)=>({googleSubject:`synthetic-${n}`,email:`${n}@example.invalid`,displayName:`Example ${n}`,now:new Date()});
  it("persists account identity and confines payment history to its owner",async()=>{
    const a=await store.upsertGoogleIdentity(identity("owner")),b=await store.upsertGoogleIdentity(identity("other"));
    await store.activateTrial(a.id,"pay_synthetic_trial",new Date(),900);
    const overview=await store.accountOverview(a);
    expect(overview.payments).toHaveLength(1);
    expect((await store.accountOverview(b)).payments).toHaveLength(0);
    expect(overview.entitlement.reason).toBe("active_trial");
    expect(await store.activateTrial(a.id,"pay_synthetic_trial",new Date(),900)).toBe(false);
    await store.processBillingEvent({kind:"payment_refunded",userId:a.id,paymentId:"pay_synthetic_trial"});
    expect((await store.entitlement(a.id)).allowed).toBe(false);
  });
  it("applies an expired subscription past-due transition only once in PostgreSQL",async()=>{
    const user=await store.upsertGoogleIdentity(identity("past-due"));
    const paidThrough=new Date(Date.now()-60_000);
    const payment={kind:"subscription_paid" as const,userId:user.id,subscriptionId:"sub_synthetic_past_due",paymentId:"pay_synthetic_past_due",plan:"student" as const,amountPaise:9900,paidThrough};
    expect(await store.processBillingEvent(payment)).toBe(true);
    const failure={kind:"subscription_failed" as const,userId:user.id,subscriptionId:payment.subscriptionId};
    expect(await store.processBillingEvent(failure)).toBe(true);
    expect(await store.processBillingEvent(failure)).toBe(false);
    expect((await pg.query<{status:string}>("SELECT status FROM classroom_desk_subscriptions WHERE provider_subscription_id=$1",[payment.subscriptionId])).rows[0]?.status).toBe("past_due");
  });
  it("qualifies two paid referrals once and reverses a refunded reward",async()=>{
    const referrer=await store.upsertGoogleIdentity(identity("referrer")),a=await store.upsertGoogleIdentity(identity("ref-a")),b=await store.upsertGoogleIdentity(identity("ref-b"));
    const code=await store.referrals.ensureCode(referrer.id);
    await expect(store.referrals.attribute(code,referrer.id)).rejects.toThrow("invalid_referral");
    await store.referrals.attribute(code,a.id);await store.referrals.attribute(code,b.id);
    await expect(store.referrals.attribute(code,a.id)).rejects.toThrow("referral_already_attributed");
    const paidThrough=new Date(Date.now()+30*86400000);
    const event={kind:"subscription_paid" as const,userId:a.id,subscriptionId:"sub_synthetic_a",paymentId:"pay_synthetic_a",plan:"student" as const,amountPaise:9900,paidThrough};
    expect(await store.processBillingEvent(event)).toBe(true);
    expect(await store.processBillingEvent(event)).toBe(false);
    await store.processBillingEvent({...event,userId:b.id,subscriptionId:"sub_synthetic_b",paymentId:"pay_synthetic_b"});
    expect(await store.referrals.summary(referrer.id)).toMatchObject({qualified:2,rewards:1});
    const renewal={...event,paymentId:"pay_synthetic_a_renewal",paidThrough:new Date(paidThrough.getTime()+30*86400000)};
    expect(await store.processBillingEvent(renewal)).toBe(true);
    expect(await store.processBillingEvent({kind:"payment_refunded",userId:a.id,paymentId:renewal.paymentId})).toBe(true);
    expect(await store.referrals.summary(referrer.id)).toMatchObject({qualified:2,rewards:1});
    await store.processBillingEvent({kind:"payment_refunded",userId:a.id,paymentId:event.paymentId});
    expect((await store.referrals.summary(referrer.id)).qualified).toBe(1);
    const grant=await pg.query<{revoked_at:Date}>("SELECT revoked_at FROM classroom_desk_entitlement_grants WHERE user_id=$1",[referrer.id]);
    expect(grant.rows[0].revoked_at).toBeTruthy();
  });
  it("attributes a referral only to the authenticated session account and rejects self, duplicate, and expired requests", async () => {
    const referrer = await store.upsertGoogleIdentity(identity("http-referrer"));
    const referred = await store.upsertGoogleIdentity(identity("http-referred"));
    const code = await store.referrals.ensureCode(referrer.id);
    const session = await store.sessions.create(referred.id);
    const app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: false }));
    registerWebsiteRoutes(app, { store, secureCookies: false, referralRewardsEnabled: true });
    const server = createServer(app);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const headers = { cookie: `cd_session=${session.token}`, origin, "content-type": "application/json" };
    try {
      expect((await fetch(`${origin}/api/referrals`)).status).toBe(401);
      expect((await fetch(`${origin}/api/referrals/attribute`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ code }) })).status).toBe(401);
      const response = await fetch(`${origin}/api/referrals/attribute`, { method: "POST", headers, body: JSON.stringify({ code, userId: referrer.id }) });
      expect(response.status).toBe(201);
      const saved = await pg.query<{ referrer_user_id: string; referred_user_id: string }>(`SELECT referrer_user_id,referred_user_id FROM classroom_desk_referrals WHERE referred_user_id=$1`, [referred.id]);
      expect(saved.rows[0]).toEqual({ referrer_user_id: referrer.id, referred_user_id: referred.id });

      const duplicate = await fetch(`${origin}/api/referrals/attribute`, { method: "POST", headers, body: JSON.stringify({ code }) });
      expect(duplicate.status).toBe(409);
      const selfSession = await store.sessions.create(referrer.id);
      const self = await fetch(`${origin}/api/referrals/attribute`, { method: "POST", headers: { ...headers, cookie: `cd_session=${selfSession.token}` }, body: JSON.stringify({ code }) });
      expect(self.status).toBe(409);
      const expired = await store.sessions.create(await store.upsertGoogleIdentity(identity("http-expired-referral")).then(user => user.id), new Date(Date.now() - 31 * 86400000));
      const expiredResponse = await fetch(`${origin}/api/referrals/attribute`, { method: "POST", headers: { ...headers, cookie: `cd_session=${expired.token}` }, body: JSON.stringify({ code }) });
      expect(expiredResponse.status).toBe(401);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
  it("protects portal routes, validates deletion confirmation, and revokes a real SQL session through both logout routes",async()=>{
    const user=await store.upsertGoogleIdentity(identity("http"));
    const app=express();app.use(express.urlencoded({extended:false}));registerWebsiteRoutes(app,{store,secureCookies:false,billingEnabled:false,referralRewardsEnabled:false});
    const server=createServer(app);await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));
    const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
    try {
      for (const route of ["/logout","/session/end"]) {
        const {token}=await store.sessions.create(user.id);
        const headers={cookie:`cd_session=${token}`,origin};
        for (const path of ["/app","/app/subscription","/app/referrals","/app/connection"]) {
          const response=await fetch(origin+path,{headers,redirect:"manual"});
          expect(response.status).toBe(200);expect(response.headers.get("cache-control")).toBe("no-store");
          const content=await response.text();expect(content).toContain(user.email);expect(content).not.toContain('href="/app/courses"');
          if (path === "/app/referrals") expect(content).toContain("Unavailable while rewards are paused");
        }
        const referralCode = await pg.query("SELECT code FROM classroom_desk_referral_codes WHERE user_id=$1", [user.id]);
        expect(referralCode.rows).toHaveLength(0);
        expect((await fetch(origin+route,{method:"POST",headers:{...headers,origin:"https://attacker.invalid"},redirect:"manual"})).status).toBe(403);
        expect(await store.sessions.find(token)).not.toBeNull();
        expect((await fetch(origin+"/api/account/deletion-request",{method:"POST",headers,redirect:"manual"})).status).toBe(400);
        const response=await fetch(origin+route,{method:"POST",headers,redirect:"manual"});
        expect(response.status).toBe(303);expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
        expect(await store.sessions.find(token)).toBeNull();
        for(const path of ["/app","/app/connection","/app/subscription","/app/referrals"])expect((await fetch(origin+path,{headers,redirect:"manual"})).status).toBe(303);
      }
      const expired=await store.sessions.create(user.id,new Date(Date.now()-31*86400000));
      expect(await store.sessions.find(expired.token)).toBeNull();
    } finally {await new Promise<void>(r=>server.close(()=>r()));}
  });
  it("does not activate future grants",()=>{
    expect(resolveEntitlement({now:new Date("2026-10-10"),user:{status:"active"},grants:[{id:"g",userId:"u",plan:"student",source:"manual",startsAt:new Date("2026-11-01"),expiresAt:new Date("2026-12-01"),revokedAt:null}]}).allowed).toBe(false);
  });
  it("allows only safe Pricing return paths with a single referral code", () => {
    expect(safeWebsiteReturnPath("/pricing?ref=CD-a1b2c3d4e5#refer-and-earn")).toBe("/pricing?ref=CD-A1B2C3D4E5#refer-and-earn");
    expect(safeWebsiteReturnPath("/pricing?ref=CD-A1B2C3D4E5&next=https://attacker.invalid")).toBe("/app");
    expect(safeWebsiteReturnPath("//attacker.invalid/pricing")).toBe("/app");
  });
  it("atomically processes webhook delivery and rejects duplicates or changed payloads",async()=>{
    const user=await store.upsertGoogleIdentity(identity("webhook"));
    const event={kind:"trial_captured" as const,userId:user.id,paymentId:"pay_synthetic_atomic",amountPaise:900,paidAt:new Date()};
    expect(await store.processWebhook("evt_synthetic_atomic","payment.captured","hash-one",event)).toBe(true);
    expect(await store.processWebhook("evt_synthetic_atomic","payment.captured","hash-one",event)).toBe(false);
    await expect(store.processWebhook("evt_synthetic_atomic","payment.captured","hash-two",event)).rejects.toThrow("webhook_payload_conflict");
    expect((await store.accountOverview(user)).payments).toHaveLength(1);
    const invalid={...event,userId:"00000000-0000-0000-0000-000000000000",paymentId:"pay_synthetic_retry"};
    await expect(store.processWebhook("evt_synthetic_retry","payment.captured","hash-three",invalid)).rejects.toThrow();
    expect((await pg.query("SELECT * FROM classroom_desk_webhook_events WHERE event_id='evt_synthetic_retry'")).rows).toHaveLength(0);
    expect(await store.processWebhook("evt_synthetic_retry","payment.captured","hash-three",{...invalid,userId:user.id})).toBe(true);
  });
  it("reconciles a pre-recorded captured trial payment without extending or reassigning it",async()=>{
    const user=await store.upsertGoogleIdentity(identity("reconcile"));
    const paidAt=new Date("2026-10-10T06:05:18.436Z");
    await store.db.query(`INSERT INTO classroom_desk_payments (user_id,kind,amount_paise,currency,provider_payment_id,status) VALUES ($1,'trial',900,'INR',$2,'captured')`,[user.id,"pay_pre_recorded"]);
    expect(await store.activateTrial(user.id,"pay_pre_recorded",paidAt,900)).toBe(true);
    const first=(await pg.query<{starts_at:Date;expires_at:Date;status:string;payment_id:string}>(`SELECT starts_at,expires_at,status,payment_id FROM classroom_desk_trials WHERE user_id=$1`,[user.id])).rows[0];
    expect(first.status).toBe("active"); expect(first.payment_id).toBe("pay_pre_recorded");
    expect(new Date(first.expires_at).getTime()-new Date(first.starts_at).getTime()).toBe(168*60*60*1000);
    expect(await store.activateTrial(user.id,"pay_pre_recorded",new Date("2026-10-11T06:05:18.436Z"),900)).toBe(false);
    const second=(await pg.query<{starts_at:Date;expires_at:Date}>(`SELECT starts_at,expires_at FROM classroom_desk_trials WHERE user_id=$1`,[user.id])).rows[0];
    expect(new Date(second.starts_at).toISOString()).toBe(new Date(first.starts_at).toISOString()); expect(new Date(second.expires_at).toISOString()).toBe(new Date(first.expires_at).toISOString());
    const other=await store.upsertGoogleIdentity(identity("reconcile-other"));
    await expect(store.activateTrial(other.id,"pay_pre_recorded",paidAt,900)).rejects.toThrow("trial_payment_owner_mismatch");
  });
  it("recovers a provider-confirmed refund when the webhook was missed",async()=>{
    const user=await store.upsertGoogleIdentity(identity("missed-refund"));
    // Prior tests share the PGlite database; keep their synthetic payments out
    // of this provider fixture so every reconciled row has a matching response.
    await store.db.query(`UPDATE classroom_desk_payments SET status='refunded',created_at=$1 WHERE provider_payment_id IS NOT NULL AND provider_payment_id<>'pay_missed_refund'`,[new Date("2026-10-01T06:00:00.000Z")]);
    await store.activateTrial(user.id,"pay_missed_refund",new Date("2026-10-10T06:00:00.000Z"),900);
    await store.db.query(`UPDATE classroom_desk_payments SET created_at=$2 WHERE provider_payment_id=$1`,["pay_missed_refund",new Date("2026-10-01T06:00:00.000Z")]);
    const result=await reconcileRecentPayments(store.db,store,{getPayment:async()=>({id:"pay_missed_refund",amount:900,currency:"INR",status:"refunded",refund_status:"full"})} as never,new Date("2026-10-10T07:00:00.000Z"));
    expect(result.refunded).toBe(1); expect(result.failed).toBe(0); expect(result.checked).toBeGreaterThanOrEqual(1);
    expect((await store.entitlement(user.id)).allowed).toBe(false);
    expect((await store.db.query<{status:string}>("SELECT status FROM classroom_desk_trials WHERE user_id=$1",[user.id])).rows[0].status).toBe("refunded");
    const repeat=await reconcileRecentPayments(store.db,store,{getPayment:async()=>({id:"pay_missed_refund",amount:900,currency:"INR",status:"refunded",refund_status:"full"})} as never,new Date("2026-10-10T08:00:00.000Z"));
    expect(repeat.refunded).toBe(0);
  });
  it("authenticates the pairing bridge, consumes codes once and blocks cross-account reassignment",async()=>{
    const user=await store.upsertGoogleIdentity(identity("pair"));
    const other=await store.upsertGoogleIdentity(identity("pair-other"));
    const app=express();app.use(express.json());registerInternalLink(app,store,"synthetic-internal-secret-32-characters");registerAdminRoutes(app,store);
    const server=createServer(app);await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
    try{
      const link=await store.linking.start(user.id),subject="22222222-2222-4222-8222-222222222222";
      const payload=JSON.stringify({code:link.code,subject});
      const send=(token:string)=>fetch(origin+'/internal/account/link',{method:'POST',headers:{'content-type':'application/json','x-classroom-internal-token':token},body:payload});
      expect((await send("spoof")).status).toBe(404);
      expect(await(await send("synthetic-internal-secret-32-characters")).json()).toEqual({linked:true});
      expect(await(await send("synthetic-internal-secret-32-characters")).json()).toEqual({linked:false});
      expect(await store.getLinkedMcpUserId(user.id)).toBe(subject);
      const otherLink=await store.linking.start(other.id);expect(await store.linking.consume(otherLink.code,subject)).toBe(false);
      const session=await store.sessions.create(user.id);
      expect((await fetch(origin+'/admin',{headers:{cookie:`cd_session=${session.token}`}})).status).toBe(403);
    }finally{await new Promise<void>(r=>server.close(()=>r()));}
  });
  it("keeps billing administration behind the stored active admin role, not identity text",async()=>{
    const student=await store.upsertGoogleIdentity({...identity("billing-admin-looking-student"),email:"billing-admin@example.invalid"});
    const session=await store.sessions.create(student.id);
    const app=express();app.use(express.json());registerAdminRoutes(app,store);
    const server=createServer(app);await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));
    const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
    const headers={cookie:`cd_session=${session.token}`,origin};
    try{
      for(const path of ["/admin","/admin/billing","/admin/referrals",`/admin/users/${student.id}`]){
        expect((await fetch(origin+path,{headers})).status).toBe(403);
      }
      expect((await fetch(origin+"/admin/access-grants",{
        method:"POST",headers:{...headers,"content-type":"application/json"},
        body:JSON.stringify({targetUserId:student.id,plan:"student",durationDays:30,reason:"synthetic authorization test"}),
      })).status).toBe(403);
      expect((await store.getUser(student.id))?.role).toBe("STUDENT");
      expect((await store.db.query(`SELECT count(*) AS count FROM classroom_desk_admin_audit WHERE actor_user_id=$1`,[student.id])).rows).toEqual([{count:0}]);
    }finally{await new Promise<void>(r=>server.close(()=>r()));}
  });

  it("limits support admins from audit and referral records while retaining operational billing access", async () => {
    const support = await store.upsertGoogleIdentity(identity("support-read-boundary"));
    await store.db.query(`UPDATE classroom_desk_users SET role='SUPPORT_ADMIN' WHERE id=$1`, [support.id]);
    const session = await store.sessions.create(support.id);
    const app = express(); app.use(express.json()); registerAdminRoutes(app, store);
    const server = createServer(app); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const headers = { cookie: `cd_session=${session.token}`, origin };
    try {
      for (const path of ["/admin/audit", "/admin/referrals"]) {
        const response = await fetch(origin + path, { headers });
        expect(response.status).toBe(403);
        expect(await response.text()).toContain("Super administrator access required");
      }
      expect((await fetch(origin + "/admin", { headers })).status).toBe(200);
      expect((await fetch(origin + "/admin/billing", { headers })).status).toBe(200);
      expect((await fetch(origin + "/admin/billing/reconciliation", { headers })).status).toBe(200);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });

  it("shows actor, target, and state changes on the protected admin audit page",async()=>{
    const actor=await store.upsertGoogleIdentity(identity("audit-actor"));
    const target=await store.upsertGoogleIdentity(identity("audit-target"));
    await store.db.query(`UPDATE classroom_desk_users SET role='SUPER_ADMIN' WHERE id=$1`,[actor.id]);
    await store.adminSetStatus(actor.id,target.id,"suspended","<script>synthetic audit reason</script>");
    const actorSession=await store.sessions.create(actor.id),studentSession=await store.sessions.create(target.id);
    const app=express();registerAdminRoutes(app,store);
    const server=createServer(app);await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));
    const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
    try{
      expect((await fetch(origin+"/admin/audit")).status).toBe(403);
      expect((await fetch(origin+"/admin/audit",{headers:{cookie:`cd_session=${studentSession.token}`,origin}})).status).toBe(403);
      const response=await fetch(origin+"/admin/audit",{headers:{cookie:`cd_session=${actorSession.token}`,origin}});
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const body=await response.text();
      expect(body).toContain(actor.id);
      expect(body).toContain(target.id);
      expect(body).toContain("suspend_user");
      expect(body).toContain("active");
      expect(body).toContain("suspended");
      expect(body).toContain("&lt;script&gt;synthetic audit reason&lt;/script&gt;");
      expect(body).not.toContain("<script>synthetic audit reason</script>");
    }finally{await new Promise<void>(r=>server.close(()=>r()));}
  });

  it("exposes unresolved subscription attempts only in an escaped, read-only admin queue",async()=>{
    const student=await store.upsertGoogleIdentity(identity("reservation-queue-student"));
    const admin=await store.upsertGoogleIdentity(identity("reservation-queue-admin"));
    await store.db.query(`UPDATE classroom_desk_users SET role='SUPER_ADMIN' WHERE id=$1`,[admin.id]);
    const requestId="11111111-2222-4333-8444-555555555555";
    await store.db.query(`INSERT INTO classroom_desk_subscription_creation_reservations (user_id,request_id,plan,state) VALUES ($1,$2,'student','unknown')`,[student.id,requestId]);
    const studentSession=await store.sessions.create(student.id),adminSession=await store.sessions.create(admin.id);
    const app=express();app.use(express.json());registerAdminRoutes(app,store);
    const server=createServer(app);await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));
    const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
    try{
      expect((await fetch(origin+"/admin/billing/reconciliation")).status).toBe(403);
      expect((await fetch(origin+"/admin/billing/reconciliation",{headers:{cookie:`cd_session=${studentSession.token}`,origin}})).status).toBe(403);
      const response=await fetch(origin+"/admin/billing/reconciliation",{headers:{cookie:`cd_session=${adminSession.token}`,origin}});
      expect(response.status).toBe(200);
      const body=await response.text();
      expect(body).toContain("Read-only queue");
      expect(body).toContain(requestId);
      expect(body).not.toContain("<form");
      expect(body).toContain(student.id);
    }finally{await new Promise<void>(r=>server.close(()=>r()));}
  });

  it("shows and confirms owner-only end-of-cycle subscription cancellation",async()=>{
    const user=await store.upsertGoogleIdentity(identity("cancel-owner"));
    await store.recordPendingSubscription(user.id,"student","sub_synthetic_cancel");
    await store.db.query(`UPDATE classroom_desk_subscriptions SET status='active' WHERE provider_subscription_id=$1`,["sub_synthetic_cancel"]);
    const overview=await store.accountOverview(user);
    const html=renderSubscription(overview,true);
    expect(html).toContain('action="/api/billing/subscription/cancel"');
    expect(html).toContain('name="subscriptionId" value="sub_synthetic_cancel"');
    expect(html).toContain('name="confirm" value="yes" required');
    expect(renderSubscription(overview,false)).not.toContain('action="/api/billing/subscription/cancel"');

    const cancelSubscription=vi.fn(async(id:string)=>({id,status:"cancelled"}));
    const app=express();app.use(express.json());app.use(express.urlencoded({extended:false}));
    registerWebsiteRoutes(app,{store,secureCookies:false,billingEnabled:true,razorpay:{cancelSubscription} as never});
    const server=createServer(app);await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));
    const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
    const session=await store.sessions.create(user.id);
    const post=(body:Record<string,string>)=>fetch(origin+"/api/billing/subscription/cancel",{method:"POST",headers:{cookie:`cd_session=${session.token}`,origin,"content-type":"application/json"},body:JSON.stringify({subscriptionId:"sub_synthetic_cancel",...body})});
    try{
      const missing=await post({});
      expect(missing.status).toBe(400);
      expect(await missing.json()).toEqual({error:"confirmation_required"});
      expect(cancelSubscription).not.toHaveBeenCalled();
      const confirmed=await post({confirm:"yes"});
      expect(confirmed.status).toBe(200);
      expect(await confirmed.json()).toMatchObject({cancelled:true,scheduledAtCycleEnd:true,accessContinuesUntilProviderPaidThrough:true});
      expect(cancelSubscription).toHaveBeenCalledWith("sub_synthetic_cancel",true);
    }finally{await new Promise<void>(r=>server.close(()=>r()));}
  });
});
