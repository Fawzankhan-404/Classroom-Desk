import type express from "express";
import { timingSafeEqual } from "node:crypto";
import { readSessionCookie, sessionCookie, clearSessionCookie } from "./sessions.js";
import { buildWebsiteGoogleUrl, completeWebsiteGoogleLogin, createLoginState, type WebsiteOAuthConfig } from "./website-auth.js";
import type { SaaSStore } from "./store.js";
import type { RazorpayClient } from "./razorpay-client.js";
import { requireSameOrigin } from "./csrf.js";
import { accountScript, renderProfile, renderSubscription, renderConnection } from "./account-portal.js";
import type {ConnectionStatus} from "./connection-status.js";
import { z } from "zod";
import { createReport, rubric, submissions, type TeacherMark } from "../hackathon/domain.js";
import { approveSyntheticDemoMark, createSyntheticDemoState, saveSyntheticDemoMark, syntheticDemoReport } from "../hackathon/demo-state.js";
import { renderExperienceSelector, renderTeacherDashboard, type DashboardPreference, type StudentDashboardData } from "./account-portal.js";
import { teacherDashboardScript } from "./teacher-dashboard-script.js";

export interface WebsiteOAuthStateStore { putEphemeral(kind: string, key: string, value: unknown, owner: string, expiresAt: number): Promise<void>; takeEphemeral<T>(kind: string, key: string): Promise<T | undefined>; }
export interface WebsiteRouteOptions { store: SaaSStore; oauth?: WebsiteOAuthConfig; oauthStateStore?: WebsiteOAuthStateStore; secureCookies: boolean; razorpay?: RazorpayClient; razorpayKeyId?: string; razorpayKeySecret?: string; razorpayPlanIds?: { student?: string; teacher?: string }; billingEnabled?: boolean; billingAllowlistUuids?: ReadonlySet<string>; teacherFeaturesEnabled?: boolean; referralRewardsEnabled?: boolean; loadConnectionStatus?: (websiteUserId:string)=>Promise<ConnectionStatus>; loadMcpStatus?: (websiteUserId:string)=>Promise<{ state: string; message: string; plan: string | null; expiresAt: string | null; linked: boolean }>; loadClassroomDashboard?: (websiteUserId: string) => Promise<StudentDashboardData>; }

const WEBSITE_LOGIN_STATE_KIND = "website_login";
const WEBSITE_LOGIN_STATE_OWNER = "website-login";
const WEBSITE_LOGIN_STATE_TTL_MS = 10 * 60 * 1000;
const dashboardMarkSchema = z.object({
  submissionId: z.string().min(1).max(40),
  criterionPoints: z.record(z.string().min(1).max(40), z.number().int().min(0).max(100)),
  selectedChoiceIds: z.array(z.string().min(1).max(40)).max(3),
  optionalCriteriaIds: z.array(z.string().min(1).max(40)).max(2),
  evidence: z.array(z.object({ criterionId: z.string().min(1).max(40), quote: z.string().min(1).max(1000) }).strict()).max(8),
}).strict();

const loginCookie = (secure: boolean, state = "") => `${secure ? "__Host-" : ""}cd_login_state=${state}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${state ? 600 : 0}${secure ? "; Secure" : ""}`;
function browserStartedLogin(header: string | undefined, state: string, secure: boolean): boolean {
  const prefix = `${secure ? "__Host-" : ""}cd_login_state=`;
  const value = header?.split(";").map(item => item.trim()).find(item => item.startsWith(prefix))?.slice(prefix.length) ?? "";
  return /^[A-Za-z0-9_-]{32}$/.test(state) && value.length === state.length && timingSafeEqual(Buffer.from(value),Buffer.from(state));
}

export function safeWebsiteReturnPath(value: unknown): string {
  if (typeof value !== "string" || !/^\/app(?:\/|$)/.test(value) || /[\\\r\n]/.test(value)) return "/app";
  const url=new URL(value,"https://return.invalid");
  if(url.origin!=="https://return.invalid"||!/^\/app(?:\/|$)/.test(url.pathname))return "/app";
  return url.pathname+url.search;
}

export function registerWebsiteRoutes(app: express.Express, options: WebsiteRouteOptions): void {
  const pending = new Map<string, ReturnType<typeof createLoginState>>();
  app.use("/api", requireSameOrigin);
  app.get("/start", async (req, res) => {
    const token = readSessionCookie(req.get("cookie"));
    const session = token ? await options.store.sessions.find(token) : null;
    return res.redirect(303, session ? "/app/experience" : "/login?next=%2Fapp%2Fexperience");
  });
  app.get("/login", async (req, res) => {
    if (!options.oauth) return res.status(503).type("html").send(message("Website sign-in is not configured yet.", "Set WEBSITE_GOOGLE_OAUTH_CLIENT_ID and WEBSITE_GOOGLE_OAUTH_CLIENT_SECRET, then restart the Worker."));
    const login = createLoginState();
    if (!options.oauthStateStore) pending.set(login.state, login);
    for (const [key, value] of pending) if (Date.now() - value.createdAt > 10 * 60 * 1000) pending.delete(key);
    const returnTo = safeWebsiteReturnPath(req.query.next);
    if (options.oauthStateStore) {
      try {
        await options.oauthStateStore.putEphemeral(WEBSITE_LOGIN_STATE_KIND, login.state, { verifier: login.verifier, returnTo }, WEBSITE_LOGIN_STATE_OWNER, login.createdAt + WEBSITE_LOGIN_STATE_TTL_MS);
      } catch { pending.delete(login.state); return res.status(503).type("html").send(message("Sign-in is temporarily unavailable.", "Your account was not changed. Please try again shortly.")); }
    }
    res.setHeader("Set-Cookie",loginCookie(options.secureCookies,login.state));
    return res.redirect(302, buildWebsiteGoogleUrl(options.oauth, login));
  });
  app.get("/auth/google/callback", async (req, res) => {
    const state = typeof req.query.state === "string" ? req.query.state : "";
    const code = typeof req.query.code === "string" ? req.query.code : "";
    if (!browserStartedLogin(req.get("cookie"),state,options.secureCookies)) return res.status(400).type("html").send(message("Sign-in could not be completed.","Start sign-in again in this browser. Your account was not changed."));
    res.setHeader("Set-Cookie",loginCookie(options.secureCookies));
    let stored: { verifier: string; returnTo: string } | undefined;
    try { stored = options.oauthStateStore ? await options.oauthStateStore.takeEphemeral<{ verifier: string; returnTo: string }>(WEBSITE_LOGIN_STATE_KIND, state) : undefined; }
    catch { return res.status(400).type("html").send(message("Sign-in could not be completed.", "Return to Classroom Desk and start again.")); }
    const local = options.oauthStateStore ? undefined : pending.get(state); pending.delete(state);
    const login = stored ? { verifier: stored.verifier, returnTo: safeWebsiteReturnPath(stored.returnTo) } : local ? { verifier: local.verifier, returnTo: "/app" } : undefined;
    if (!login || !code || !options.oauth) return res.status(400).type("html").send(message("Sign-in could not be completed.", "Return to Classroom Desk and start again."));
    try {
      const user = await completeWebsiteGoogleLogin(options.oauth, options.store, code, login.verifier);
      const session = await options.store.sessions.create(user.id);
      res.setHeader("Set-Cookie", [sessionCookie(session.token, options.secureCookies),loginCookie(options.secureCookies)]);
      res.setHeader("Cache-Control", "no-store");
      return res.redirect(303, login.returnTo);
    } catch { return res.status(400).type("html").send(message("Google sign-in could not be verified.", "No Classroom or billing access was changed. Try again.")); }
  });
  const endSession = async (req: express.Request, res: express.Response) => { const token = readSessionCookie(req.get("cookie")); if (token) await options.store.sessions.revoke(token); res.setHeader("Set-Cookie", clearSessionCookie); return res.redirect(303, "/"); };
  // Both backward-compatible paths are POST-only with identical origin checks.
  app.post("/logout", requireSameOrigin, endSession);
  app.post("/session/end", requireSameOrigin, endSession);
  // New charges and subscription enrollment are permanently disabled. Historical webhooks remain active below.
  const billingClosed = (_req: express.Request, res: express.Response) => res.status(410).json({ error: "billing_retired", message: "Classroom Desk is free. New payments and subscriptions are unavailable." });
  app.post("/api/billing/trial/order", billingClosed);
  app.post("/api/billing/trial/resume", billingClosed);
  app.post("/api/billing/subscription", billingClosed);
  app.post("/api/billing/verify", billingClosed);
  app.post("/api/billing/subscription/cancel", requireSameOrigin, async (req, res) => {
    const session = await currentSession(req.get("cookie"), options.store);
    if (!session) return res.status(401).json({ error: "login_required" });
    const subscriptionId = typeof req.body?.subscriptionId === "string" ? req.body.subscriptionId : "";
    if (!options.razorpay || !subscriptionId || !(await options.store.ownsSubscription(session.userId, subscriptionId))) return res.status(400).json({ error: "invalid_subscription" });
    try { const subscription = await options.razorpay.cancelSubscription(subscriptionId, true); return res.json({ cancelled: true, subscriptionId: subscription.id, accessContinuesUntilProviderPaidThrough: true }); }
    catch { return res.status(502).json({ error: "billing_provider_unavailable" }); }
  });
  app.get("/api/referrals", (_req, res) => res.status(410).json({ error: "referrals_retired" }));
  app.post("/api/account/deletion-request", async (req, res) => {
    const session = await currentSession(req.get("cookie"), options.store);
    if (!session) return res.status(401).json({ error: "login_required" });
    if (req.body?.confirm !== "yes") return res.status(400).json({ error: "deletion_confirmation_required" });
    const reason = typeof req.body?.reason === "string" ? req.body.reason.slice(0, 1000) : undefined;
    try { return res.status(201).json({ requestId: await options.store.requestAccountDeletion(session.userId, reason), status: "requested", detail: "Your account remains active until this request is reviewed. Google authorization and billing are not changed automatically." }); }
    catch { return res.status(503).json({ error: "deletion_request_unavailable" }); }
  });
  app.post("/api/referrals/attribute", (_req, res) => res.status(410).json({ error: "referrals_retired" }));
  app.post("/api/dashboard/preference", async (req, res) => {
    const session = await currentSession(req.get("cookie"), options.store);
    if (!session) return res.status(401).json({ error: "login_required" });
    const preference = req.body?.dashboard;
    if (preference !== "student" && preference !== "teacher") return res.status(400).json({ error: "invalid_dashboard_preference" });
    try { await options.store.setDashboardPreference(session.userId, preference); }
    catch { return res.status(503).json({ error: "dashboard_preference_unavailable" }); }
    res.setHeader("Cache-Control", "no-store");
    return res.redirect(303, preference === "teacher" ? "/app/teacher" : "/app");
  });
  app.get("/api/teacher-demo/packet", async (req, res) => {
    const session = await currentSession(req.get("cookie"), options.store);
    if (!session) return res.status(401).json({ error: "login_required" });
    if (await options.store.dashboardPreference(session.userId) !== "teacher") return res.status(403).json({ error: "teacher_demo_not_selected" });
    res.setHeader("Cache-Control", "no-store");
    return res.json({ syntheticOnly: true, rubric, submissions, report: createReport(), realClassroomAccess: false, gradebookWriteback: false });
  });
  app.post("/api/teacher-demo/mark", async (req, res) => {
    const session = await currentSession(req.get("cookie"), options.store);
    if (!session) return res.status(401).json({ error: "login_required" });
    if (await options.store.dashboardPreference(session.userId) !== "teacher") return res.status(403).json({ error: "teacher_demo_not_selected" });
    const parsed = dashboardMarkSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "invalid_assessment_request" });
    try {
      const state = createSyntheticDemoState();
      const stored = saveSyntheticDemoMark(state, parsed.data as TeacherMark);
      res.setHeader("Cache-Control", "no-store");
      return res.json({ ...stored, status: "DRAFT", report: syntheticDemoReport(state), syntheticOnly: true, gradebookWriteback: false });
    } catch (error) { return res.status(422).json({ error: error instanceof Error ? error.message : "invalid_assessment" }); }
  });
  app.post("/api/teacher-demo/approve", async (req, res) => {
    const session = await currentSession(req.get("cookie"), options.store);
    if (!session) return res.status(401).json({ error: "login_required" });
    if (await options.store.dashboardPreference(session.userId) !== "teacher") return res.status(403).json({ error: "teacher_demo_not_selected" });
    const parsed = dashboardMarkSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "invalid_assessment_request" });
    try {
      const state = createSyntheticDemoState();
      saveSyntheticDemoMark(state, parsed.data as TeacherMark);
      const stored = approveSyntheticDemoMark(state, parsed.data.submissionId);
      res.setHeader("Cache-Control", "no-store");
      return res.json({ status: "APPROVED_LOCAL_DEMO_ONLY", submissionId: parsed.data.submissionId, report: syntheticDemoReport(state), syntheticOnly: true, gradebookWriteback: false, approved: stored.approved });
    } catch (error) { return res.status(422).json({ error: error instanceof Error ? error.message : "review_required" }); }
  });
  app.get("/app/assets/account.js", (_req, res) => res.type("js").send(accountScript));
  app.get("/app/assets/teacher.js", (_req, res) => res.type("js").send(teacherDashboardScript));
  app.use("/app", async (req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Security-Policy", "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
    const token = readSessionCookie(req.get("cookie"));
    const session = token ? await options.store.sessions.find(token) : null;
    if (!session) return res.redirect(303, `/login?next=${encodeURIComponent(safeWebsiteReturnPath(req.originalUrl))}`);
    const user = await options.store.getUser(session.userId);
    if (!user || user.status !== "active") return res.status(403).type("html").send(message("Account unavailable", "Contact support to review your account status."));
    res.locals.accountUser = user;
    next();
  });
  app.get("/app", async (_req, res) => {
    const user = res.locals.accountUser as import("./types.js").SaaSUser;
    const preference = await options.store.dashboardPreference(user.id);
    if (!preference) return res.type("html").send(renderExperienceSelector(user, null));
    if (preference === "teacher") return res.redirect(303, "/app/teacher");
    const overview=await options.store.accountOverview(res.locals.accountUser);
    const connectionStatus=overview.linked?(options.loadConnectionStatus?await options.loadConnectionStatus(overview.user.id).catch(()=>'unavailable' as const):'unavailable'):'not_linked';
    const mcpStatus=overview.linked?(options.loadMcpStatus?await options.loadMcpStatus(overview.user.id).catch(()=>({state:"STATUS_UNAVAILABLE",message:"Access status could not be checked right now.",plan:null,expiresAt:null,linked:true})):{state:"STATUS_UNAVAILABLE",message:"Access status could not be checked right now.",plan:null,expiresAt:null,linked:true}):undefined;
    const dashboard=options.loadClassroomDashboard?await options.loadClassroomDashboard(overview.user.id).catch(()=>({courses:null,assignmentsShown:null,upcomingAssignments:null,missingAssignments:null,sync:"api_error" as const})):undefined;
    return res.type("html").send(renderProfile({...overview,connectionStatus,mcpStatus,dashboard}));
  });
  app.get("/app/experience", async (_req, res) => {
    const user = res.locals.accountUser as import("./types.js").SaaSUser;
    return res.type("html").send(renderExperienceSelector(user, await options.store.dashboardPreference(user.id)));
  });
  app.get("/app/teacher", async (_req, res) => {
    const user = res.locals.accountUser as import("./types.js").SaaSUser;
    if (await options.store.dashboardPreference(user.id) !== "teacher") return res.redirect(303, "/app/experience");
    return res.type("html").send(renderTeacherDashboard(user));
  });
  app.get("/app/subscription", async (_req, res) => res.type("html").send(renderSubscription(await options.store.accountOverview(res.locals.accountUser), false)));
  app.get("/app/referrals", (_req, res) => res.redirect(303, "/app"));
  app.get("/app/connection", async (_req, res) => {
    const overview=await options.store.accountOverview(res.locals.accountUser);
    const google=overview.linked?(options.loadConnectionStatus?await options.loadConnectionStatus(overview.user.id).catch(()=>'unavailable' as const):'unavailable'):'not_linked';
    const mcpStatus=overview.linked?(options.loadMcpStatus?await options.loadMcpStatus(overview.user.id).catch(()=>({state:"STATUS_UNAVAILABLE",message:"Access status could not be checked right now.",plan:null,expiresAt:null,linked:true})):{state:"STATUS_UNAVAILABLE",message:"Access status could not be checked right now.",plan:null,expiresAt:null,linked:true}):undefined;
    return res.type("html").send(renderConnection(overview.user,{websiteSignedIn:true,linked:overview.linked,google,entitlement:"free",activePlan:"free",expiresAt:null,trialStatus:"not_applicable",mcpState:mcpStatus?.state??"Authorization required"}));
  });
  for (const [path, target] of [["/app/courses", "/app/connection"], ["/app/assignments", "/app/connection"], ["/app/deadlines", "/app/connection"], ["/app/activity", "/app/connection"], ["/app/billing", "/app"], ["/app/settings", "/app"]] as const) {
    app.get(path, async (req, res) => {
      return res.redirect(303, target);
    });
  }
}

async function currentSession(cookie: string | undefined, store: SaaSStore) {
  const token = readSessionCookie(cookie);
  const session = token ? await store.sessions.find(token) : null;
  if (!session) return null;
  const user = await store.getUser(session.userId);
  return user?.status === "active" ? session : null;
}

function message(title: string, detail: string): string { return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · Classroom Desk</title><body style="font:16px system-ui;max-width:640px;margin:12vh auto;padding:24px;color:#202923"><p style="color:#207a55;font-weight:700">Classroom Desk</p><h1>${title}</h1><p>${detail}</p><a href="/">Return home</a></body></html>`; }
