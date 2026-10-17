import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { SaaSMigration } from "./schema.js";
import { SaaSStore } from "./store.js";
import type { SqlDatabase, SqlConnection } from "../public/postgres.js";
import { PostgresPublicAuthStore } from "../public/postgres.js";
import { randomBytes } from "node:crypto";
import express from "express";
import { createServer } from "node:http";
import { registerWebsiteRoutes } from "./website-routes.js";
import { resolveEntitlement } from "./entitlements.js";
import {registerInternalLink} from "./internal-link.js";
import {registerAdminRoutes} from "./admin-routes.js";
import { reconcileRecentPayments } from "./reconciliation.js";
import { resolveMcpAccess } from "./mcp-access.js";

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
  it("persists unified account ownership, grant and code in one PostgreSQL transaction while retaining the legacy mapping",async()=>{
    const user=await store.upsertGoogleIdentity(identity("unified-postgres"));
    await store.db.query("INSERT INTO classroom_desk_connections (website_user_id,mcp_user_id) VALUES ($1,$2)",[user.id,"retained-pg-legacy-subject"]);
    const session=await store.sessions.create(user.id);
    const auth=new PostgresPublicAuthStore(store.db,randomBytes(32).toString("base64"));await auth.migrate();
    const client=await auth.registerClient({redirect_uris:["https://example.invalid/callback"]});
    const subject=`cd-account:${user.id}`;
    const flow={id:"pg-unified-flow",userId:subject,client,params:{redirectUri:client.redirect_uris[0]!,codeChallenge:"synthetic-pkce"},googleState:"synthetic-state",googleVerifier:"synthetic-verifier",expiresAt:Date.now()+60000,started:true,account:{userId:user.id,sessionId:session.session.id,googleSubject:user.googleSubject}};
    const code={code:"pg-unified-code",clientId:client.client_id,userId:subject,redirectUri:client.redirect_uris[0]!,challenge:"synthetic-pkce",scopes:["mcp:tools"],expiresAt:Date.now()+60000};
    const grant={userId:subject,googleSubject:user.googleSubject,refreshToken:"synthetic-pg-refresh",scopes:["synthetic"],createdAt:Date.now(),updatedAt:Date.now()};
    await auth.completeAccountAuthorization(flow,code,grant);
    await auth.completeAccountAuthorization(flow,code,grant);
    expect(await store.getUnifiedMcpUserId(user.id)).toBe(subject);
    expect(await store.getLegacyMcpUserId(user.id)).toBe("retained-pg-legacy-subject");
    expect(await auth.getGrant(subject)).toMatchObject({refreshToken:"synthetic-pg-refresh"});
    expect(await auth.getCode(code.code)).toMatchObject({userId:subject});
  });
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
  it("grants free product access to linked active accounts while retaining account restrictions", async () => {
    const user = await store.upsertGoogleIdentity(identity("free-access"));
    const mcpId = "synthetic-free-mcp";
    await store.db.query("INSERT INTO classroom_desk_connections (website_user_id,mcp_user_id) VALUES ($1,$2)", [user.id, mcpId]);
    expect(await resolveMcpAccess(store, mcpId)).toMatchObject({ allowed: true, reason: "free_access" });
    await store.db.query("UPDATE classroom_desk_users SET status='suspended' WHERE id=$1", [user.id]);
    expect(await resolveMcpAccess(store, mcpId)).toMatchObject({ allowed: false, reason: "suspended" });
    await store.db.query("UPDATE classroom_desk_users SET status='deleted' WHERE id=$1", [user.id]);
    expect(await resolveMcpAccess(store, mcpId)).toMatchObject({ allowed: false, reason: "deleted" });
  });
  it("retires all new checkout routes and gives /start a safe signed-in destination", async () => {
    const user = await store.upsertGoogleIdentity(identity("free-checkout-retired"));
    const app = express(); app.use(express.json()); app.use(express.urlencoded({ extended: false }));
    registerWebsiteRoutes(app, { store, secureCookies: false, billingEnabled: true, billingAllowlistUuids: new Set([user.id]) });
    const server = createServer(app); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      for (const path of ["/api/billing/trial/order", "/api/billing/trial/resume", "/api/billing/subscription", "/api/billing/verify"]) {
        const response = await fetch(origin + path, { method: "POST", headers: { "content-type": "application/json", origin }, body: "{}", redirect: "manual" });
        expect(response.status).toBe(410);
        expect(await response.json()).toMatchObject({ error: "billing_retired" });
      }
      const anonymousStart = await fetch(origin + "/start", { redirect: "manual" });
      expect(anonymousStart.status).toBe(303);
      expect(anonymousStart.headers.get("location")).toBe("/login?next=%2Fapp%2Fexperience");
      const session = await store.sessions.create(user.id);
      const signedInStart = await fetch(origin + "/start", { headers: { cookie: `cd_session=${session.token}` }, redirect: "manual" });
      expect(signedInStart.status).toBe(303);
      expect(signedInStart.headers.get("location")).toBe("/app/experience");
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
  it("keeps synthetic encrypted and opaque profile fields unchanged when retaining a legacy mapping", async () => {
    await pg.exec("ALTER TABLE classroom_desk_users ADD COLUMN IF NOT EXISTS profile_ciphertext text; ALTER TABLE classroom_desk_users ADD COLUMN IF NOT EXISTS google_subject_hash text; ALTER TABLE classroom_desk_users ADD COLUMN IF NOT EXISTS email_hash text; ALTER TABLE classroom_desk_users ADD COLUMN IF NOT EXISTS display_name_hash text;");
    const user = await store.upsertGoogleIdentity(identity("synthetic-opaque-pairing"));
    const markers = { subject: `enc:${"a".repeat(64)}`, email: `enc:${"b".repeat(64)}`, display: `enc:${"c".repeat(64)}`, ciphertext: "v1.synthetic-fixture-not-production-data", subjectHash: "a".repeat(64), emailHash: "b".repeat(64), displayHash: "c".repeat(64) };
    await pg.query("UPDATE classroom_desk_users SET google_subject=$2,email=$3,display_name=$4,profile_ciphertext=$5,google_subject_hash=$6,email_hash=$7,display_name_hash=$8 WHERE id=$1", [user.id, markers.subject, markers.email, markers.display, markers.ciphertext, markers.subjectHash, markers.emailHash, markers.displayHash]);
    await store.db.query("INSERT INTO classroom_desk_connections (website_user_id,mcp_user_id) VALUES ($1,$2)", [user.id,"synthetic-mcp-identity"]);
    const row = (await pg.query("SELECT google_subject,email,display_name,profile_ciphertext,google_subject_hash,email_hash,display_name_hash FROM classroom_desk_users WHERE id=$1", [user.id])).rows[0];
    expect(row).toEqual({ google_subject: markers.subject, email: markers.email, display_name: markers.display, profile_ciphertext: markers.ciphertext, google_subject_hash: markers.subjectHash, email_hash: markers.emailHash, display_name_hash: markers.displayHash });
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
    await store.processBillingEvent({kind:"payment_refunded",userId:a.id,paymentId:event.paymentId});
    expect((await store.referrals.summary(referrer.id)).qualified).toBe(1);
    const grant=await pg.query<{revoked_at:Date}>("SELECT revoked_at FROM classroom_desk_entitlement_grants WHERE user_id=$1",[referrer.id]);
    expect(grant.rows[0].revoked_at).toBeTruthy();
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
        for (const path of ["/app","/app/subscription","/app/connection"]) {
          const response=await fetch(origin+path,{headers,redirect:"manual"});
          expect(response.status).toBe(200);expect(response.headers.get("cache-control")).toBe("no-store");
          const content=await response.text();expect(content).toContain(user.email);expect(content).not.toContain('href="/app/courses"');
          if(path==="/app/connection"){
            expect(content).toContain("Connect in ChatGPT");
            expect(content).toContain("Use another Google account");
            expect(/pairing|link_website_account/.test(content)).toBe(false);
            expect(content).toContain("cannot inspect ChatGPT");
          }
        }
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
  it("selects and switches dashboards without changing Google authorization or exposing real teacher data",async()=>{
    const student=await store.upsertGoogleIdentity(identity("dashboard-student"));
    const other=await store.upsertGoogleIdentity(identity("dashboard-other"));
    const app=express();app.use(express.urlencoded({extended:false,limit:"4kb"}));app.use(express.json({limit:"64kb"}));
    let realConnectionChecks=0;
    registerWebsiteRoutes(app,{store,secureCookies:false,billingEnabled:false,referralRewardsEnabled:false,loadConnectionStatus:async()=>{realConnectionChecks++;return "authorized";},loadClassroomDashboard:async()=>({courses:1,coursesAvailable:3,coursesTruncated:true,assignmentsShown:1,upcomingAssignments:1,missingAssignments:0,sync:"connected",records:{courses:[{id:"course-1",name:"Java <Basics>",section:"Morning"}],assignments:[{courseName:"Java Basics",title:"Practice <script>",dueAt:"2026-10-20T00:00:00.000Z",submissionState:"ASSIGNED",late:false,missing:false,assignmentUrl:"https://classroom.google.com/c/course-1/a/work-1/details",instructions:"Read chapter 4."}],announcements:[{courseName:"Java Basics",text:"Quiz Friday"}],courseMaterials:[{courseName:"Java Basics",title:"Course notes",description:"Unit 2"}]}})});
    const server=createServer(app);await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));
    const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
    const studentSession=await store.sessions.create(student.id),otherSession=await store.sessions.create(other.id);
    const studentHeaders={cookie:`cd_session=${studentSession.token}`,origin};
    try{
      const first=await fetch(origin+"/app",{headers:studentHeaders,redirect:"manual"});
      expect(first.status).toBe(200);const selector=await first.text();
      expect(selector).toContain("Choose experience");expect(selector).toContain("Choose how you want to use Classroom Desk");expect(selector).toContain("Student is the default");expect(selector).toContain("Continue as Student (default)");expect(selector).toContain("Teacher");
      expect(selector).toContain("does not change your Google Classroom permissions");
      expect((await fetch(origin+"/app/teacher",{headers:studentHeaders,redirect:"manual"})).status).toBe(303);
      const forbiddenSwitch=await fetch(origin+"/api/dashboard/preference",{method:"POST",headers:{...studentHeaders,origin:"https://attacker.invalid","content-type":"application/x-www-form-urlencoded"},body:"dashboard=teacher",redirect:"manual"});
      expect(forbiddenSwitch.status).toBe(403);
      const selected=await fetch(origin+"/api/dashboard/preference",{method:"POST",headers:{...studentHeaders,"content-type":"application/x-www-form-urlencoded"},body:"dashboard=teacher",redirect:"manual"});
       expect(selected.status).toBe(303);expect(selected.headers.get("location")).toBe("/app/teacher");
       expect(selected.headers.get("set-cookie")).toBeNull();
       const teacherHeaders=studentHeaders;
      const dashboard=await fetch(origin+"/app",{headers:teacherHeaders,redirect:"manual"});expect(dashboard.status).toBe(303);expect(dashboard.headers.get("location")).toBe("/app/teacher");
      const page=await fetch(origin+"/app/teacher",{headers:teacherHeaders});expect(page.status).toBe(200);const html=await page.text();
      expect(html).toContain("Synthetic demonstration");expect(html).toContain("Gradebook writeback is disabled");expect(html).toContain("verified teacher membership");
      expect(html).toContain("/app/assets/teacher.js");expect(html).toContain('href="/app/teacher" aria-current="page">Teacher demo');expect(html).toContain("@media(max-width:760px)");expect(realConnectionChecks).toBe(0);
      const teacherScript=await fetch(origin+"/app/assets/teacher.js").then(response=>response.text());expect(()=>new Function(teacherScript)).not.toThrow();
      const anonymous=await fetch(origin+"/api/teacher-demo/packet");expect(anonymous.status).toBe(401);
      const packetResponse=await fetch(origin+"/api/teacher-demo/packet",{headers:teacherHeaders});expect(packetResponse.status).toBe(200);
      expect(packetResponse.headers.get("cache-control")).toBe("no-store");const packet=await packetResponse.json() as {syntheticOnly:boolean;realClassroomAccess:boolean;gradebookWriteback:boolean;submissions:unknown[]};
      expect(packet).toMatchObject({syntheticOnly:true,realClassroomAccess:false,gradebookWriteback:false});expect(packet.submissions).toHaveLength(6);
      const invalidMark=await fetch(origin+"/api/teacher-demo/mark",{method:"POST",headers:{...teacherHeaders,"content-type":"application/json"},body:JSON.stringify({submissionId:"syn-01",criterionPoints:{claim:2,evidence:2,reasoning:2,counterclaim:2},selectedChoiceIds:["reasoning","counterclaim"],optionalCriteriaIds:[],evidence:[{criterionId:"claim",quote:"invented statement"}]})});
      expect(invalidMark.status).toBe(422);expect(await invalidMark.json()).toMatchObject({error:"EVIDENCE_NOT_IN_RESPONSE"});
      const validMark={submissionId:"syn-01",criterionPoints:{claim:2,evidence:2,reasoning:2,counterclaim:2},selectedChoiceIds:["reasoning","counterclaim"],optionalCriteriaIds:[],evidence:[{criterionId:"claim",quote:"The school should add shade trees beside the west court."},{criterionId:"evidence",quote:"The grounds report says the court reached 38°C at noon"},{criterionId:"reasoning",quote:"This six-degree difference supports adding trees where students gather."},{criterionId:"counterclaim",quote:"A tree plan also needs regular watering"}]};
      const saved=await fetch(origin+"/api/teacher-demo/mark",{method:"POST",headers:{...teacherHeaders,"content-type":"application/json"},body:JSON.stringify(validMark)});expect(saved.status).toBe(200);
      const savedBody=await saved.json() as {score:number;report:{gradebookWriteback:boolean}};expect(savedBody.score).toBe(8);expect(savedBody.report.gradebookWriteback).toBe(false);
      const approved=await fetch(origin+"/api/teacher-demo/approve",{method:"POST",headers:{...teacherHeaders,"content-type":"application/json"},body:JSON.stringify(validMark)});expect(approved.status).toBe(200);expect(await approved.json()).toMatchObject({status:"APPROVED_LOCAL_DEMO_ONLY",gradebookWriteback:false});
      for(const [submissionId,flag] of [["syn-05","MISSING_WORK"],["syn-06","UNREADABLE_RESPONSE"]] as const){
        const missingMark={submissionId,criterionPoints:{},selectedChoiceIds:[],optionalCriteriaIds:[],evidence:[]};
        const review=await fetch(origin+"/api/teacher-demo/mark",{method:"POST",headers:{...teacherHeaders,"content-type":"application/json"},body:JSON.stringify(missingMark)});
        expect(review.status).toBe(200);expect(await review.json()).toMatchObject({score:null,flags:[flag,"TEACHER_REVIEW_REQUIRED"]});
        const blocked=await fetch(origin+"/api/teacher-demo/approve",{method:"POST",headers:{...teacherHeaders,"content-type":"application/json"},body:JSON.stringify(missingMark)});expect(blocked.status).toBe(422);
      }
      const crossOrigin=await fetch(origin+"/api/teacher-demo/approve",{method:"POST",headers:{...teacherHeaders,origin:"https://attacker.invalid","content-type":"application/json"},body:JSON.stringify({submissionId:"syn-01"})});expect(crossOrigin.status).toBe(403);
      expect(realConnectionChecks).toBe(0);
       const otherPage=await fetch(origin+"/app",{headers:{cookie:`cd_session=${otherSession.token}`},redirect:"manual"});expect(otherPage.status).toBe(200);expect(await otherPage.text()).toContain("Choose experience");
       const otherApi=await fetch(origin+"/api/teacher-demo/packet",{headers:{cookie:`cd_session=${otherSession.token}`}});expect(otherApi.status).toBe(403);
      const switchStudent=await fetch(origin+"/api/dashboard/preference",{method:"POST",headers:{...teacherHeaders,"content-type":"application/x-www-form-urlencoded"},body:"dashboard=student",redirect:"manual"});expect(switchStudent.status).toBe(303);
       const studentDashboard=await fetch(origin+"/app",{headers:studentHeaders});expect(studentDashboard.status).toBe(200);const studentHtml=await studentDashboard.text();expect(studentHtml).toContain("My Classroom");expect(studentHtml).toContain("Java &lt;Basics&gt;");expect(studentHtml).toContain("Practice &lt;script&gt;");expect(studentHtml).not.toContain("<script>");expect(studentHtml).toContain("https://classroom.google.com/c/course-1/a/work-1/details");expect(studentHtml).toContain("Quiz Friday");expect(studentHtml).toContain("Course notes");expect(studentHtml).toContain("Showing 1 of 3 accessible courses");expect(studentHtml).toContain("Upcoming assignments");expect(studentHtml).toContain("Assignments shown");expect(studentHtml).not.toContain("undefined");
      expect((await store.getUser(student.id))?.role).toBe("STUDENT");expect(realConnectionChecks).toBe(0);
    }finally{await new Promise<void>(r=>server.close(()=>r()));}
  });
  it("stores dashboard preferences server-side for the authenticated account",async()=>{
    const user=await store.upsertGoogleIdentity(identity("secure-dashboard"));
    const app=express();app.use(express.urlencoded({extended:false,limit:"4kb"}));
    registerWebsiteRoutes(app,{store,secureCookies:true,billingEnabled:false,referralRewardsEnabled:false});
    const server=createServer(app);await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));
    const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`,session=await store.sessions.create(user.id);
    try{
      const response=await fetch(origin+"/api/dashboard/preference",{method:"POST",headers:{cookie:`cd_session=${session.token}`,origin,"content-type":"application/x-www-form-urlencoded"},body:"dashboard=teacher",redirect:"manual"});
      expect(response.status).toBe(303);expect(response.headers.get("location")).toBe("/app/teacher");expect(response.headers.get("set-cookie")).toBeNull();
      expect(await store.dashboardPreference(user.id)).toBe("teacher");
    }finally{await new Promise<void>(r=>server.close(()=>r()));}
  });
  it("requires an explicit, same-session teacher OAuth flow before exposing live teacher reads",async()=>{
    const user=await store.upsertGoogleIdentity(identity("teacher-consent"));
    await store.setDashboardPreference(user.id,"teacher");
    await store.db.query("INSERT INTO classroom_desk_connections (website_user_id,mcp_user_id) VALUES ($1,$2)",[user.id,"teacher-consent-mcp"]);
    const session=await store.sessions.create(user.id);
    const auth=new PostgresPublicAuthStore(store.db,randomBytes(32).toString("base64"));await auth.migrate();
    const complete=vi.fn(async()=>{}),begin=vi.fn(async(_mcp:string,state:string)=>`https://accounts.google.com/auth?state=${state}`);
    const app=express();app.use(express.urlencoded({extended:false,limit:"4kb"}));
    registerWebsiteRoutes(app,{store,secureCookies:false,oauth:{clientId:"synthetic-client",clientSecret:"synthetic-secret",callbackUrl:"http://127.0.0.1/unused",origin:"http://127.0.0.1"},oauthStateStore:auth,teacherAuthorization:{begin,complete},teacherData:{courses:async()=>{throw new Error("teacher_authorization_required")},coursework:async()=>[],students:async()=>[],submissions:async()=>[]}});
    const server=createServer(app);await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));
    const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
    try{
      const headers={cookie:`cd_session=${session.token}`,origin};
      const start=await fetch(origin+"/api/teacher/authorize",{method:"POST",headers,redirect:"manual"});
      expect(start.status).toBe(303);expect(begin).toHaveBeenCalledOnce();
      const location=new URL(start.headers.get("location")!);const state=location.searchParams.get("state")!;
      expect(state).toMatch(/^[A-Za-z0-9_-]{32}$/);
      const stateCookie=start.headers.get("set-cookie")!.split(";")[0]!;
      const callback=await fetch(`${origin}/auth/google/callback?state=${state}&code=synthetic-code`,{headers:{cookie:`cd_session=${session.token}; ${stateCookie}`},redirect:"manual"});
      expect(callback.status).toBe(303);expect(callback.headers.get("location")).toBe("/app/teacher?authorization=complete");
      expect(complete).toHaveBeenCalledWith("teacher-consent-mcp",state,"synthetic-code",expect.stringMatching(/^[A-Za-z0-9_-]{40,64}$/));
      const replay=await fetch(`${origin}/auth/google/callback?state=${state}&code=synthetic-code`,{headers:{cookie:`cd_session=${session.token}; ${stateCookie}`},redirect:"manual"});
      expect(replay.status).toBe(400);expect(complete).toHaveBeenCalledOnce();
      const live=await fetch(origin+"/api/teacher/live/courses",{headers:{cookie:`cd_session=${session.token}`}});
      expect(live.status).toBe(403);expect(await live.json()).toMatchObject({error:"teacher_authorization_required",authorizationUrl:"/app/teacher"});
      const anonymous=await fetch(origin+"/api/teacher/live/courses");expect(anonymous.status).toBe(401);
    }finally{await new Promise<void>(r=>server.close(()=>r()));}
  });
  it("does not grant billing administration to a Student through the customer billing allowlist", async () => {
    const user = await store.upsertGoogleIdentity(identity("allowlisted-admin-boundary"));
    const session = await store.sessions.create(user.id);
    const app = express();
    app.use(express.urlencoded({ extended: false }));
    registerWebsiteRoutes(app, { store, secureCookies: false, billingEnabled: true, billingAllowlistUserIds: new Set([user.id]) });
    registerAdminRoutes(app, store);
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address() as { port: number };
      const response = await fetch(`http://127.0.0.1:${address.port}/admin/billing`, { headers: { cookie: `cd_session=${session.token}` } });
      expect((await store.getUser(user.id))?.role).toBe("STUDENT");
      expect(response.status).toBe(403);
      expect(await response.text()).toContain("Administrator access required.");
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
  it("does not activate future grants",()=>{
    expect(resolveEntitlement({now:new Date("2026-10-10"),user:{status:"active"},grants:[{id:"g",userId:"u",plan:"student",source:"manual",startsAt:new Date("2026-11-01"),expiresAt:new Date("2026-12-01"),revokedAt:null}]}).allowed).toBe(false);
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
  it("reports onboarding status safely when Google and entitlement checks fail",async()=>{
    const user=await store.upsertGoogleIdentity(identity("onboarding-status"));
    await store.db.query("INSERT INTO classroom_desk_connections (website_user_id,mcp_user_id) VALUES ($1,$2)",[user.id,"55555555-5555-4555-8555-555555555555"]);
    const app=express();app.use(express.urlencoded({extended:false}));
    registerWebsiteRoutes(app,{store,secureCookies:false,billingEnabled:false,referralRewardsEnabled:false,loadConnectionStatus:async()=>{throw new Error("synthetic-provider-error");},loadMcpStatus:async()=>{throw new Error("synthetic-policy-error");}});
    const session=await store.sessions.create(user.id);const server=createServer(app);await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
    try{
      const response=await fetch(origin+"/app/connection",{headers:{cookie:`cd_session=${session.token}`}});const content=await response.text();
      expect(response.status).toBe(200);expect(content).toContain("STATUS_UNAVAILABLE");expect(content).toContain("unavailable");expect(content).toContain("Connect in ChatGPT");expect(content).not.toContain("synthetic-provider-error");expect(content).not.toContain("synthetic-policy-error");
    }finally{await new Promise<void>(r=>server.close(()=>r()));}
  });
  it("shows only server-verified linked grant and entitlement states on onboarding",async()=>{
    const user=await store.upsertGoogleIdentity(identity("onboarding-authorized"));
    await store.db.query("INSERT INTO classroom_desk_connections (website_user_id,mcp_user_id) VALUES ($1,$2)",[user.id,"66666666-6666-4666-8666-666666666666"]);
    await store.activateTrial(user.id,"pay_synthetic_onboarding",new Date(),900);
    const app=express();app.use(express.urlencoded({extended:false}));
    registerWebsiteRoutes(app,{store,secureCookies:false,billingEnabled:false,referralRewardsEnabled:false,loadConnectionStatus:async()=>"authorized",loadMcpStatus:async()=>({state:"TRIAL_ACTIVE",message:"Server verified active trial.",plan:"active_trial",expiresAt:new Date(Date.now()+86400000).toISOString(),linked:true})});
    const session=await store.sessions.create(user.id);const server=createServer(app);await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
    try{
      const response=await fetch(origin+"/app/connection",{headers:{cookie:`cd_session=${session.token}`}});const content=await response.text();
      expect(response.status).toBe(200);expect(content).toContain("Connected account recorded");expect(content).toContain("authorized");expect(content).toContain("TRIAL_ACTIVE");expect(content).toContain("Use another Google account");expect(/pairing|link_website_account/.test(content)).toBe(false);
    }finally{await new Promise<void>(r=>server.close(()=>r()));}
  });
});
