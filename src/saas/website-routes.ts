import type express from "express";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readSessionCookie, sessionCookie, clearSessionCookie } from "./sessions.js";
import { buildWebsiteGoogleUrl, completeWebsiteGoogleIdentity, completeWebsiteGoogleLogin, createLoginState, type VerifiedWebsiteGoogleIdentity, type WebsiteOAuthConfig } from "./website-auth.js";
import type { SaaSStore } from "./store.js";
import { paymentIsFullyRefunded, paymentMatchesSubscriptionCycle, trialOrderReceipt, validProviderPayment, withProviderTimeout, type RazorpayClient } from "./razorpay-client.js";
import { requireSameOrigin } from "./csrf.js";
import { accountScript, html, renderProfile, renderSubscription, renderReferrals, renderConnection } from "./account-portal.js";
import type {ConnectionStatus} from "./connection-status.js";
import { verifyCheckoutSignature, verifySubscriptionSignature } from "./razorpay.js";
import { parseRazorpayEvent } from "./billing-events.js";
import { isTrialOrderCreatedByCutoff, planPricePaise, TRIAL_PRICE_PAISE } from "./campaign.js";
import { renderExperienceSelector, renderStudentDashboard, renderTeacherCourse, renderTeacherDashboard, renderTeacherSubmissions, type StudentDashboardState, type TeacherDashboardState } from "./dashboard-pages.js";
import type { DashboardExperience, SaaSUser } from "./types.js";
import type { TeacherCourseworkDraftInput } from "../v2/teacher.js";
import { classifyGoogleReadFailure } from "../v2/workflow.js";

export interface WebsiteOAuthStateStore { putEphemeral(kind: string, key: string, value: unknown, owner: string, expiresAt: number): Promise<void>; takeEphemeral<T>(kind: string, key: string): Promise<T | undefined>; }
export interface WebsiteRouteOptions {
  store: SaaSStore; oauth?: WebsiteOAuthConfig; oauthStateStore?: WebsiteOAuthStateStore; secureCookies: boolean;
  razorpay?: RazorpayClient; razorpayKeyId?: string; razorpayKeySecret?: string; razorpayPlanIds?: { student?: string; teacher?: string };
  billingEnabled?: boolean; teacherFeaturesEnabled?: boolean; teacherDraftWritesEnabled?: boolean; referralRewardsEnabled?: boolean;
  loadConnectionStatus?: (websiteUserId: string) => Promise<ConnectionStatus>;
  loadClassroomDashboard?: (websiteUserId: string) => Promise<StudentDashboardState>;
  loadTeacherDashboard?: (websiteUserId: string, coursePageToken?: string) => Promise<TeacherDashboardState>;
  loadTeacherCourse?: (websiteUserId: string, courseId: string) => Promise<{
    course: { id: string; name: string | null; section: string | null };
    students: Array<{ userId: string | null; fullName: string | null }>;
    studentsMoreAvailable: boolean;
    studentsComplete?: boolean;
    coursework: Array<{ id: string | null; title: string | null; dueDate: unknown; maxPoints: number | null }>;
    courseworkMoreAvailable: boolean;
    drafts?: Array<{ id: string; title: string | null; description: string | null; dueDate: unknown; dueTime: unknown; maxPoints: number | null; state: "DRAFT" }>;
    draftsMoreAvailable?: boolean;
    courseworkDraftsEnabled?: boolean;
    writeAuthorizationAvailable?: boolean;
  }>;
  loadTeacherSubmissions?: (websiteUserId: string, courseId: string, courseWorkId: string) => Promise<{ courseId: string; courseWorkId: string; title: string | null; maxPoints: number | null; gradebookWritebackEnabled: false; submissions: Array<{ studentName: string | null; state: string; late: boolean; lateStatus?: "LATE" | "NOT_LATE" | "UNKNOWN"; assignedGrade: number | null; gradeStatus?: "GRADED" | "UNKNOWN"; updateTime: string | null }>; moreAvailable: boolean; submissionPagesComplete?: boolean; studentRosterMoreAvailable: boolean; studentRosterPagesComplete?: boolean }>;
  beginTeacherAuthorization?: (input: { mcpUserId: string; state: string; verifier: string; nonce: string }) => Promise<string>;
  completeTeacherAuthorization?: (input: { mcpUserId: string; expectedGoogleSubject: string; code: string; verifier: string; nonce: string }) => Promise<void>;
  beginTeacherWriteAuthorization?: (input: { mcpUserId: string; state: string; verifier: string; nonce: string }) => Promise<string>;
  completeTeacherWriteAuthorization?: (input: { mcpUserId: string; expectedGoogleSubject: string; code: string; verifier: string; nonce: string }) => Promise<void>;
  createTeacherCourseworkDraft?: (websiteUserId: string, courseId: string, input: TeacherCourseworkDraftInput) => Promise<unknown>;
  /** Test seam only; production leaves this unset and validates Google's signed OIDC token. */
  completeRecoveryGoogleIdentity?: (input: { code: string; verifier: string; nonce: string }) => Promise<VerifiedWebsiteGoogleIdentity>;
}

const WEBSITE_LOGIN_STATE_KIND = "website_login";
const WEBSITE_LOGIN_STATE_OWNER = "website-login";
const WEBSITE_LOGIN_STATE_TTL_MS = 10 * 60 * 1000;
const loginCookie = (secure: boolean, state = "") => `${secure ? "__Host-" : ""}cd_login_state=${state}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${state ? 600 : 0}${secure ? "; Secure" : ""}`;
const RECOVERY_LOGIN_STATE_KIND = "legacy_recovery_login";
const RECOVERY_LOGIN_STATE_OWNER = "legacy-recovery-login";
const RECOVERY_LOGIN_STATE_TTL_MS = 10 * 60 * 1000;
const RECOVERY_SESSION_COOKIE_TTL_SECONDS = 30 * 60;
const recoveryLoginCookie = (secure: boolean, state = "") => `${secure ? "__Host-" : ""}cd_recovery_login_state=${state}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${state ? 600 : 0}${secure ? "; Secure" : ""}`;
const recoverySessionCookie = (token: string, secure: boolean) => `${secure ? "__Host-" : ""}cd_recovery_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${RECOVERY_SESSION_COOKIE_TTL_SECONDS}${secure ? "; Secure" : ""}`;
const clearRecoverySessionCookie = (secure: boolean) => `${secure ? "__Host-" : ""}cd_recovery_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`;

function readRecoverySessionCookie(header: string | undefined, secure: boolean): string | null {
  const prefix = `${secure ? "__Host-" : ""}cd_recovery_session=`;
  const value = header?.split(";").map(item => item.trim()).find(item => item.startsWith(prefix))?.slice(prefix.length) ?? "";
  return /^[A-Za-z0-9_-]{40,}$/.test(value) ? value : null;
}

function browserStartedRecoveryLogin(header: string | undefined, state: string, secure: boolean): boolean {
  const prefix = `${secure ? "__Host-" : ""}cd_recovery_login_state=`;
  const value = header?.split(";").map(item => item.trim()).find(item => item.startsWith(prefix))?.slice(prefix.length) ?? "";
  return /^[A-Za-z0-9_-]{32}$/.test(state) && value.length === state.length && timingSafeEqual(Buffer.from(value), Buffer.from(state));
}

function recoveryHtmlEscape(value: string): string { return value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char); }
function renderLegacyRecoveryPage(input: { authenticated: boolean; requests: Array<{ id: string; status: string; expiresAt: Date; createdAt: Date }>; notice?: string }): string {
  const states = input.requests.map(item => `<li><code>${recoveryHtmlEscape(item.id)}</code> · ${recoveryHtmlEscape(item.status)} · expires ${recoveryHtmlEscape(item.expiresAt.toISOString())}</li>`).join("") || `<li>No recovery requests for this Google identity.</li>`;
  const form = input.authenticated ? `<section><h2>Submit a recovery request</h2><p>Enter the exact legacy account ID and a reference to a pre-existing, independently verifiable record. Do not use email matching, upload documents, or include passwords, tokens, or payment-card data. The owner reviews the evidence against the original account record. Approval does not change billing or account ownership until a fresh Google authorization completes.</p><form method="post" action="/account/recovery/request"><label>Legacy account ID<input name="accountId" required maxlength="36" pattern="[0-9a-fA-F-]{36}" autocomplete="off"></label><label>Evidence source<select name="evidenceType" required><option value="">Choose a source</option><option value="preexisting_support_record">Pre-existing support record</option><option value="billing_provider_record">Billing provider record</option><option value="account_specific_recovery_material">Account-specific recovery material</option><option value="other_independent_record">Other independent record</option></select></label><label>Reference ID<input name="evidenceReference" required minlength="8" maxlength="256" pattern="[A-Za-z0-9][A-Za-z0-9._:/#-]{7,255}" autocomplete="off"></label><button type="submit">Send for owner review</button></form><h2>Your requests</h2><ul>${states}</ul><form method="post" action="/account/recovery/logout"><button type="submit">End recovery session</button></form></section>` : `<section><h2>Verify the Google identity you want to reconnect</h2><p>This short-lived recovery-only sign-in does not create an account or grant Classroom access. Email equality alone cannot recover an account.</p><a class="button" href="/account/recovery/start">Continue with Google</a></section>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Legacy account recovery · Classroom Desk</title><style>body{margin:0;background:#f7f8f4;color:#202923;font:16px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}main{max-width:720px;margin:48px auto;padding:0 20px}section{background:#fff;border:1px solid #dce4dd;border-radius:12px;padding:24px;margin:22px 0}h1{letter-spacing:-.035em}label{display:grid;gap:6px;margin:14px 0;font-weight:650}input,select,button,.button{font:inherit;border:1px solid #cbd7cf;border-radius:8px;padding:10px 12px}button,.button{display:inline-block;background:#207a55;color:#fff;text-decoration:none;font-weight:700;cursor:pointer}small,p{color:#58665d}code{overflow-wrap:anywhere}</style></head><body><main><p>Classroom Desk / Account help</p><h1>Recover a legacy account</h1><p>Recovery keeps the original account ID and existing billing history. A fresh Google sign-in or matching email is not proof of ownership. An owner reviews independent evidence before approving a one-time, expiring Google reconnect.</p>${input.notice ? `<p role="status">${recoveryHtmlEscape(input.notice)}</p>` : ""}${form}<p><a href="/">Return to Classroom Desk</a></p></main></body></html>`;
}

function teacherReadFailure(error: unknown, resource: "course" | "submissions"):
  { status: 401 | 403 | 503; title: string; detail: string } {
  const value = error as { response?: { status?: unknown }; code?: unknown } | null;
  const code = typeof value?.code === "string" ? value.code : "";
  const state = classifyGoogleReadFailure(error);
  if (state === "reauthorization_required") {
    return { status: 401, title: "Reconnect Google Classroom", detail: "Your Google authorization expired or could not be refreshed. Reconnect from Account settings, then try again. No Classroom data was changed." };
  }
  if (state === "permission_denied" || ["teacher_account_binding_required", "account_access_required", "teacher_entitlement_required", "teacher_features_disabled"].includes(code)) {
    return { status: 403, title: "Teacher access not confirmed", detail: resource === "course" ? "Google did not confirm teacher access to that course. No roster data was shown." : "Google did not authorize reading those submissions. No grade or submission was changed." };
  }
  return { status: 503, title: "Teacher data temporarily unavailable", detail: "Classroom Desk could not verify this Google Classroom data. Try again later. No roster, grade, or submission was changed." };
}

function browserStartedLogin(header: string | undefined, state: string, secure: boolean): boolean {
  const prefix = `${secure ? "__Host-" : ""}cd_login_state=`;
  const value = header?.split(";").map(item => item.trim()).find(item => item.startsWith(prefix))?.slice(prefix.length) ?? "";
  return /^[A-Za-z0-9_-]{32}$/.test(state) && value.length === state.length && timingSafeEqual(Buffer.from(value),Buffer.from(state));
}

export function safeWebsiteReturnPath(value: unknown): string {
  if (typeof value !== "string" || /[\\\u0000-\u001f\u007f]/.test(value)) return "/app";
  let url: URL;
  try { url = new URL(value, "https://return.invalid"); } catch { return "/app"; }
  if (url.origin !== "https://return.invalid") return "/app";
  if (/^\/app(?:\/|$)/.test(url.pathname)) return url.pathname + url.search;
  if (url.pathname !== "/pricing") return "/app";
  if (url.hash && url.hash !== "#refer-and-earn") return "/app";
  const params = [...url.searchParams.entries()];
  if (params.length === 0) return `/pricing${url.hash}`;
  if (params.length !== 1 || params[0]?.[0] !== "ref" || !/^CD-[0-9A-F]{10}$/i.test(params[0]?.[1] ?? "")) return "/app";
  return `/pricing?ref=${encodeURIComponent(params[0]![1]!.toUpperCase())}${url.hash}`;
}

export function registerWebsiteRoutes(app: express.Express, options: WebsiteRouteOptions): void {
  const pending = new Map<string, ReturnType<typeof createLoginState> & { returnTo: string }>();
  app.use("/account/recovery", (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
    next();
  });
  app.use("/api", requireSameOrigin);
  const requireTeacherMutationAccount = async (req: express.Request, res: express.Response): Promise<string | undefined> => {
    if (options.teacherDraftWritesEnabled !== true) { res.status(503).type("html").send(message("Teacher draft creation is unavailable", "This feature is not available right now.")); return undefined; }
    const session = await currentSession(req.get("cookie"), options.store);
    if (!session) { res.status(401).type("html").send(message("Sign in required", "Sign in before changing coursework drafts.")); return undefined; }
    const user = await options.store.getUser(session.userId);
    const mcpUserId = await options.store.getClassroomMcpUserId(session.userId);
    if (!user || user.status !== "active" || !mcpUserId) { res.status(409).type("html").send(message("Reconnect Classroom Desk", "Connect the Google account used for this signed-in account, then try again.")); return undefined; }
    try {
      const entitlement = await options.store.entitlement(user.id);
      if (!entitlement.allowed || entitlement.plan !== "teacher") { res.status(403).type("html").send(message("Teacher access required", "An active Teacher plan is required before changing coursework drafts.")); return undefined; }
    } catch { res.status(503).type("html").send(message("Teacher access is unavailable", "Account access could not be verified. No Classroom changes were made.")); return undefined; }
    return user.id;
  };
  app.get("/account/recovery", async (req, res) => {
    const token = readRecoverySessionCookie(req.get("cookie"), options.secureCookies);
    if (!token) {
      res.setHeader("Cache-Control", "no-store");
      return res.type("html").send(renderLegacyRecoveryPage({ authenticated: false, requests: [], notice: req.query.submitted === "1" ? "Sign in again to check your recovery request." : undefined }));
    }
    try {
      const requests = await options.store.listOwnLegacyRecoveryIntakes(token);
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Referrer-Policy", "no-referrer");
      return res.type("html").send(renderLegacyRecoveryPage({ authenticated: true, requests,
        notice: req.query.submitted === "1" ? "Your request was submitted for owner review. You will need to complete a fresh Google authorization after approval." : undefined }));
    } catch {
      res.setHeader("Set-Cookie", clearRecoverySessionCookie(options.secureCookies));
      res.setHeader("Cache-Control", "no-store");
      return res.status(401).type("html").send(renderLegacyRecoveryPage({ authenticated: false, requests: [], notice: "Your recovery sign-in expired. Start again." }));
    }
  });
  app.get("/account/recovery/start", async (_req, res) => {
    if (!options.oauth || !options.oauthStateStore) return res.status(503).type("html").send(message("Recovery sign-in is unavailable.", "Try again later. No account or billing data was changed."));
    const login = createLoginState();
    try {
      await options.oauthStateStore.putEphemeral(RECOVERY_LOGIN_STATE_KIND, login.state,
        { verifier: login.verifier, nonce: login.nonce }, RECOVERY_LOGIN_STATE_OWNER, login.createdAt + RECOVERY_LOGIN_STATE_TTL_MS);
    } catch { return res.status(503).type("html").send(message("Recovery sign-in is temporarily unavailable.", "Try again later. No account or billing data was changed.")); }
    res.setHeader("Set-Cookie", recoveryLoginCookie(options.secureCookies, login.state));
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    return res.redirect(302, buildWebsiteGoogleUrl(options.oauth, login));
  });
  app.post("/account/recovery/request", requireSameOrigin, async (req, res) => {
    const token = readRecoverySessionCookie(req.get("cookie"), options.secureCookies);
    if (!token) return res.status(401).type("html").send(message("Recovery sign-in required.", "Verify the Google identity you want to reconnect, then try again."));
    try {
      await options.store.submitLegacyRecoveryIntake({
        sessionToken: token,
        accountId: typeof req.body?.accountId === "string" ? req.body.accountId.trim() : "",
        evidenceType: typeof req.body?.evidenceType === "string" ? req.body.evidenceType : "",
        evidenceReference: typeof req.body?.evidenceReference === "string" ? req.body.evidenceReference.trim() : "",
      });
      res.setHeader("Cache-Control", "no-store");
      return res.redirect(303, "/account/recovery?submitted=1");
    } catch {
      res.setHeader("Cache-Control", "no-store");
      return res.status(400).type("html").send(message("Recovery request could not be submitted.", "Check the account ID and evidence reference, or contact support. For privacy, the response does not confirm whether an account exists."));
    }
  });
  app.post("/account/recovery/logout", requireSameOrigin, async (req, res) => {
    const token = readRecoverySessionCookie(req.get("cookie"), options.secureCookies);
    if (token) await options.store.revokeLegacyRecoveryAccessSession(token);
    res.setHeader("Set-Cookie", clearRecoverySessionCookie(options.secureCookies));
    return res.redirect(303, "/account/recovery");
  });
  app.get("/login", async (req, res) => {
    if (!options.oauth) return res.status(503).type("html").send(message("Google sign-in is unavailable", "Try again later or contact support."));
    const login = createLoginState();
    const returnTo = safeWebsiteReturnPath(req.query.next);
    if (!options.oauthStateStore) pending.set(login.state, { ...login, returnTo });
    for (const [key, value] of pending) if (Date.now() - value.createdAt > 10 * 60 * 1000) pending.delete(key);
    if (options.oauthStateStore) {
      try {
        await options.oauthStateStore.putEphemeral(WEBSITE_LOGIN_STATE_KIND, login.state, { verifier: login.verifier, nonce: login.nonce, returnTo }, WEBSITE_LOGIN_STATE_OWNER, login.createdAt + WEBSITE_LOGIN_STATE_TTL_MS);
      } catch { pending.delete(login.state); return res.status(503).type("html").send(message("Sign-in is temporarily unavailable.", "Your account was not changed. Please try again shortly.")); }
    }
    res.setHeader("Set-Cookie",loginCookie(options.secureCookies,login.state));
    return res.redirect(302, buildWebsiteGoogleUrl(options.oauth, login));
  });
  app.get("/auth/google/callback", async (req, res) => {
    const state = typeof req.query.state === "string" ? req.query.state : "";
    const code = typeof req.query.code === "string" ? req.query.code : "";
    if (browserStartedRecoveryLogin(req.get("cookie"), state, options.secureCookies)) {
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader("Set-Cookie", recoveryLoginCookie(options.secureCookies));
      let recoveryFlow: { verifier: string; nonce: string } | undefined;
      try { recoveryFlow = options.oauthStateStore ? await options.oauthStateStore.takeEphemeral<{ verifier: string; nonce: string }>(RECOVERY_LOGIN_STATE_KIND, state) : undefined; }
      catch { return res.status(400).type("html").send(message("Recovery sign-in could not be completed.", "Return to account recovery and start again.")); }
      if (!recoveryFlow || !code || typeof req.query.error === "string" || !options.oauth) return res.status(400).type("html").send(message("Recovery sign-in could not be completed.", "Return to account recovery and start again."));
      try {
        const identity = options.completeRecoveryGoogleIdentity
          ? await options.completeRecoveryGoogleIdentity({ code, verifier: recoveryFlow.verifier, nonce: recoveryFlow.nonce })
          : await completeWebsiteGoogleIdentity(options.oauth, code, recoveryFlow.verifier, recoveryFlow.nonce);
        const session = await options.store.createLegacyRecoveryAccessSession(identity.googleSubject);
        res.setHeader("Set-Cookie", [recoveryLoginCookie(options.secureCookies), recoverySessionCookie(session.token, options.secureCookies)]);
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Referrer-Policy", "no-referrer");
        return res.redirect(303, "/account/recovery");
      } catch { return res.status(400).type("html").send(message("Recovery sign-in could not be verified.", "Use the Google account whose ownership you want to verify. No account or billing data was changed.")); }
    }
    if (!browserStartedLogin(req.get("cookie"),state,options.secureCookies)) return res.status(400).type("html").send(message("Sign-in could not be completed.","Start sign-in again in this browser. Your account was not changed."));
    res.setHeader("Set-Cookie",loginCookie(options.secureCookies));
    let teacherFlow: { mcpUserId: string; userId: string; verifier: string; nonce: string; authorizationType?: "read" | "write" } | undefined;
    try { teacherFlow = options.oauthStateStore ? await options.oauthStateStore.takeEphemeral<{ userId: string; mcpUserId: string; verifier: string; nonce: string }>("teacher_authorization", state) : undefined; }
    catch { return res.status(400).type("html").send(message("Teacher authorization could not be completed.", "Return to the Teacher dashboard and start a new authorization.")); }
    if (teacherFlow && teacherFlow.authorizationType !== "write") {
      const session = await currentSession(req.get("cookie"), options.store);
      if (!session || session.userId !== teacherFlow.userId) return res.status(403).type("html").send(message("Teacher authorization could not be completed.", "Sign in to the same Classroom Desk account that started this request."));
      if (typeof req.query.error === "string" || !code || !options.completeTeacherAuthorization) return res.status(400).type("html").send(message("Google teacher access was not granted.", "No teacher data was changed. You can return to Classroom Desk and try again."));
      const user = await options.store.getUser(session.userId);
      if (!user || user.status !== "active") return res.status(403).type("html").send(message("Account unavailable.", "Sign in again before authorizing teacher access."));
      const currentMcpUserId = await options.store.getClassroomMcpUserId(user.id);
      if (!currentMcpUserId || currentMcpUserId !== teacherFlow.mcpUserId) return res.status(409).type("html").send(message("Teacher authorization could not be completed.", "The Classroom account link changed while Google consent was open. Start authorization again."));
      try {
        await options.completeTeacherAuthorization({ mcpUserId: teacherFlow.mcpUserId, expectedGoogleSubject: user.googleSubject, code, verifier: teacherFlow.verifier, nonce: teacherFlow.nonce });
        res.setHeader("Cache-Control", "no-store");
        return res.redirect(303, "/app/teacher?authorization=complete");
      } catch {
        return res.status(400).type("html").send(message("Google teacher access could not be verified.", "The selected Google account must match this website account. No Classroom or billing data was changed."));
      }
    }
    const teacherWriteFlow = teacherFlow?.authorizationType === "write" ? teacherFlow : undefined;
    if (teacherWriteFlow) {
      if (options.teacherDraftWritesEnabled !== true) return res.redirect(303, "/app/teacher?coursework_authorization=disabled");
      const session = await currentSession(req.get("cookie"), options.store);
      if (!session || session.userId !== teacherWriteFlow.userId) return res.status(403).type("html").send(message("Google coursework-draft authorization could not be completed.", "Sign in to the same Classroom Desk account that started this request."));
      if (typeof req.query.error === "string" || !code || !options.completeTeacherWriteAuthorization) return res.redirect(303, "/app/teacher?coursework_authorization=cancelled");
      const user = await options.store.getUser(session.userId);
      if (!user || user.status !== "active") return res.status(403).type("html").send(message("Account unavailable.", "Sign in again before authorizing draft coursework creation."));
      const currentMcpUserId = await options.store.getClassroomMcpUserId(user.id);
      if (!currentMcpUserId || currentMcpUserId !== teacherWriteFlow.mcpUserId) return res.status(409).type("html").send(message("Reconnect the same Google account", "The website account or Classroom connection changed while authorization was open. No expanded permission was stored."));
      let currentEntitlement;
      try { currentEntitlement = await options.store.entitlement(user.id); }
      catch { return res.status(503).type("html").send(message("Teacher access is unavailable", "Account access could not be verified. No expanded permission was stored.")); }
      if (!currentEntitlement.allowed || currentEntitlement.plan !== "teacher") return res.status(403).type("html").send(message("Teacher access is unavailable", "An active Teacher plan is required. No additional Google permission was saved."));
      try {
        await options.completeTeacherWriteAuthorization({ mcpUserId: teacherWriteFlow.mcpUserId, expectedGoogleSubject: user.googleSubject, code, verifier: teacherWriteFlow.verifier, nonce: teacherWriteFlow.nonce });
        res.setHeader("Cache-Control", "no-store");
        return res.redirect(303, "/app/teacher?coursework_authorization=complete");
      } catch {
        return res.status(400).type("html").send(message("Google coursework-draft access could not be verified.", "The selected Google account must match this website account. Existing Classroom access was not changed."));
      }
    }
    let stored: { verifier: string; nonce: string; returnTo: string } | undefined;
    try { stored = options.oauthStateStore ? await options.oauthStateStore.takeEphemeral<{ verifier: string; nonce: string; returnTo: string }>(WEBSITE_LOGIN_STATE_KIND, state) : undefined; }
    catch { return res.status(400).type("html").send(message("Sign-in could not be completed.", "Return to Classroom Desk and start again.")); }
    const local = options.oauthStateStore ? undefined : pending.get(state); pending.delete(state);
    const login = stored ? { verifier: stored.verifier, nonce: stored.nonce, returnTo: safeWebsiteReturnPath(stored.returnTo) } : local ? { verifier: local.verifier, nonce: local.nonce, returnTo: safeWebsiteReturnPath(local.returnTo) } : undefined;
    if (!login || !code || !options.oauth) return res.status(400).type("html").send(message("Sign-in could not be completed.", "Return to Classroom Desk and start again."));
    try {
      const user = await completeWebsiteGoogleLogin(options.oauth, options.store, code, login.verifier, login.nonce);
      const session = await options.store.sessions.create(user.id);
      res.setHeader("Set-Cookie", [sessionCookie(session.token, options.secureCookies),loginCookie(options.secureCookies)]);
      res.setHeader("Cache-Control", "no-store");
      return res.redirect(303, login.returnTo);
    } catch (error) {
      const recoveryRequired = error instanceof Error && error.message === "stored_profile_unavailable";
      return res.status(recoveryRequired ? 409 : 400).type("html").send(message(
        recoveryRequired ? "Your existing account needs recovery." : "Google sign-in could not be verified.",
        recoveryRequired ? "We could not open the existing account profile. No account or billing data was changed. Use the protected recovery process." : "No Classroom or billing access was changed. Try again.",
        recoveryRequired,
      ));
    }
  });
  const endSession = async (req: express.Request, res: express.Response) => { const token = readSessionCookie(req.get("cookie")); if (token) await options.store.sessions.revoke(token); res.setHeader("Set-Cookie", clearSessionCookie); return res.redirect(303, "/"); };
  // Both backward-compatible paths are POST-only with identical origin checks.
  app.post("/logout", requireSameOrigin, endSession);
  app.post("/session/end", requireSameOrigin, endSession);
  app.post("/api/billing/trial/order", async (req, res) => {
    const session = await currentSession(req.get("cookie"), options.store);
    if (!session) return res.status(401).json({ error: "login_required" });
    if (!options.billingEnabled || !options.razorpay) return res.status(503).json({ error: "billing_not_enabled" });
    if (!(await options.store.beginTrialPurchase(session.userId))) return res.status(409).json({ error: "trial_not_eligible" });
    try {
      const order = await options.razorpay.createTrialOrder(trialOrderReceipt(`${session.userId}_${Date.now()}`), session.userId);
      if (!order || !/^order_[A-Za-z0-9_]+$/.test(order.id) || order.amount !== TRIAL_PRICE_PAISE || order.currency !== "INR" || order.status !== "created"
        || (order.notes?.user_id && order.notes.user_id !== session.userId)) throw new Error("billing_order_mismatch");
      if (!isTrialOrderCreatedByCutoff(order.created_at)) {
        await options.store.recordPendingTrialOrder(session.userId, order.id, order.amount, order.currency);
        await options.store.expirePendingTrialOrder(session.userId, order.id);
        return res.status(409).json({ error: "trial_not_eligible" });
      }
      await options.store.recordPendingTrialOrder(session.userId, order.id, order.amount, order.currency);
      return res.status(201).json({ orderId: order.id, amountPaise: order.amount, currency: order.currency, keyId: options.razorpayKeyId ?? null });
    }
    catch {
      // Provider success can be ambiguous when the response or local persistence fails.
      // Keep the eligibility reservation so a retry cannot create a duplicate order.
      return res.status(503).json({ error: "trial_creation_requires_reconciliation" });
    }
  });
  app.post("/api/billing/trial/resume", async (req, res) => {
    const session = await currentSession(req.get("cookie"), options.store);
    if (!session) return res.status(401).json({ error: "login_required" });
    if (!options.billingEnabled || !options.razorpay) return res.status(503).json({ error: "billing_not_enabled" });
    const pending = await options.store.pendingTrialOrder(session.userId);
    if (!pending) return res.status(409).json({ error: "trial_not_pending" });
    if (pending.kind === "reconciliation_required") return res.status(409).json({ error: "trial_creation_requires_reconciliation" });
    try {
      const [order, payments] = await Promise.all([options.razorpay.getOrder(pending.orderId), options.razorpay.getOrderPayments(pending.orderId, 100, 0)]);
      const paymentsComplete = payments.items.length < 100;
      const paymentsBelongToOrder = payments.items.every(payment => payment.order_id === pending.orderId);
      const paymentInFlightOrComplete = payments.items.some(payment => payment.status !== "failed");
      if (!paymentsComplete || !paymentsBelongToOrder || paymentInFlightOrComplete || order.status === "paid") return res.status(409).json({ error: "payment_processing" });
      if (order.id !== pending.orderId || !isTrialOrderCreatedByCutoff(order.created_at)) {
        await options.store.expirePendingTrialOrder(session.userId, pending.orderId);
        return res.status(409).json({ error: "trial_attempt_expired" });
      }
      if (!['created', 'attempted'].includes(order.status) || order.amount !== TRIAL_PRICE_PAISE || order.currency !== "INR" || (order.notes?.user_id && order.notes.user_id !== session.userId)) {
        await options.store.expirePendingTrialOrder(session.userId, pending.orderId);
        return res.status(409).json({ error: "trial_attempt_expired" });
      }
      if (order.amount_paid !== 0 || order.amount_due !== order.amount) return res.status(409).json({ error: "payment_processing" });
      return res.status(200).json({ orderId: order.id, amountPaise: order.amount, currency: order.currency, keyId: options.razorpayKeyId ?? null, resumed: true });
    } catch { return res.status(502).json({ error: "billing_provider_unavailable" }); }
  });
  app.post("/api/billing/subscription", async (req, res) => {
    const session = await currentSession(req.get("cookie"), options.store);
    if (!session) return res.status(401).json({ error: "login_required" });
    const plan: "student" | "teacher" | "" = req.body?.plan === "teacher" ? "teacher" : req.body?.plan === "student" ? "student" : "";
    const planId = plan ? options.razorpayPlanIds?.[plan] : undefined;
    if (plan === "teacher" && !options.teacherFeaturesEnabled) return res.status(403).json({ error: "teacher_features_disabled" });
    if (!plan || !options.billingEnabled || !options.razorpay || !planId) return res.status(503).json({ error: "billing_not_enabled" });
    let reservation: Awaited<ReturnType<SaaSStore["reserveSubscriptionCreation"]>>;
    try {
      reservation = await options.store.reserveSubscriptionCreation(session.userId, plan);
    } catch { return res.status(503).json({ error: "billing_unavailable" }); }
    if (reservation.kind === "resume") return res.status(200).json({ subscriptionId: reservation.subscriptionId, plan, keyId: options.razorpayKeyId ?? null, resumed: true });
    if (reservation.kind === "blocked") return res.status(409).json({ error: reservation.reason });
    try {
      const subscription = await options.razorpay.createSubscription(planId, 120, { user_id: session.userId, plan, request_id: reservation.requestId });
      if (!subscription || !/^sub_[A-Za-z0-9_]+$/.test(subscription.id) || subscription.plan_id !== planId
        || (subscription.notes?.user_id && subscription.notes.user_id !== session.userId)) throw new Error("billing_subscription_mismatch");
      await options.store.completeSubscriptionCreation(session.userId, plan, reservation.requestId, subscription.id);
      return res.status(201).json({ subscriptionId: subscription.id, plan, keyId: options.razorpayKeyId ?? null });
    }
    catch {
      try { await options.store.markSubscriptionCreationUnknown(session.userId, reservation.requestId); } catch { /* Keep the existing reservation; fail closed. */ }
      return res.status(503).json({ error: "subscription_creation_requires_reconciliation" });
    }
  });
  app.post("/api/billing/verify", async (req, res) => {
    const session = await currentSession(req.get("cookie"), options.store);
    if (!session || !options.billingEnabled || !options.razorpay || !options.razorpayKeyId || !options.razorpayKeySecret) return res.status(401).json({ error: "billing_unavailable" });
    const orderId = typeof req.body?.razorpay_order_id === "string" ? req.body.razorpay_order_id : "";
    const paymentId = typeof req.body?.razorpay_payment_id === "string" ? req.body.razorpay_payment_id : "";
    const subscriptionId = typeof req.body?.razorpay_subscription_id === "string" ? req.body.razorpay_subscription_id : "";
    const signature = typeof req.body?.razorpay_signature === "string" ? req.body.razorpay_signature : "";
    if (!/^pay_[A-Za-z0-9_]+$/.test(paymentId) || Boolean(orderId) === Boolean(subscriptionId) || !signature
      || !(subscriptionId ? /^sub_[A-Za-z0-9_]+$/.test(subscriptionId) && verifySubscriptionSignature(subscriptionId, paymentId, signature, options.razorpayKeySecret)
        : /^order_[A-Za-z0-9_]+$/.test(orderId) && verifyCheckoutSignature(orderId, paymentId, signature, options.razorpayKeySecret))) return res.status(400).json({ error: "invalid_payment_signature" });
    try {
      if (subscriptionId) {
        const association = await options.store.db.query<{ user_id: string; plan: "student" | "teacher"; status: string }>(`SELECT user_id,plan,status FROM classroom_desk_subscriptions WHERE provider_subscription_id=$1`, [subscriptionId]);
        const owned = association.rows[0];
        if (association.rows.length !== 1 || !owned || owned.user_id !== session.userId || !["student", "teacher"].includes(owned.plan)) return res.status(403).json({ error: "subscription_not_owned" });
        if (["refunded", "expired", "cancelled"].includes(owned.status)) return res.status(409).json({ error: "subscription_not_active" });
        const plan = owned.plan;
        const [payment, subscription] = await Promise.all([
          withProviderTimeout(() => options.razorpay!.getPayment(paymentId)),
          withProviderTimeout(() => options.razorpay!.getSubscription(subscriptionId)),
        ]);
        if (!validProviderPayment(payment, paymentId) || payment.status !== "captured" || payment.currency !== "INR" || paymentIsFullyRefunded(payment)) return res.status(409).json({ error: "payment_not_captured" });
        if (subscription.id !== subscriptionId || !options.razorpayPlanIds?.[plan] || subscription.plan_id !== options.razorpayPlanIds[plan]
          || subscription.status !== "active" || subscription.notes?.user_id !== session.userId
          || (subscription.notes.plan && subscription.notes.plan !== plan) || payment.amount !== planPricePaise(plan)
          || !paymentMatchesSubscriptionCycle(payment, subscription)
          || (payment.notes?.user_id && payment.notes.user_id !== session.userId)) return res.status(400).json({ error: "payment_mismatch" });
        if (payment.subscription_id) {
          if (payment.subscription_id !== subscriptionId) return res.status(400).json({ error: "payment_mismatch" });
        } else {
          if (!payment.invoice_id) return res.status(400).json({ error: "payment_mismatch" });
          const invoice = await withProviderTimeout(() => options.razorpay!.getInvoice(payment.invoice_id!));
          if (invoice.id !== payment.invoice_id || invoice.subscription_id !== subscriptionId || invoice.payment_id !== paymentId
            || invoice.amount !== payment.amount || invoice.currency !== payment.currency || invoice.status !== "paid"
            || (payment.order_id && invoice.order_id !== payment.order_id)) return res.status(400).json({ error: "payment_mismatch" });
        }
        const event = parseRazorpayEvent({ event: "subscription.charged", payload: { payment: { entity: payment }, subscription: { entity: subscription } } }, new Date(), session.userId, options.razorpayPlanIds);
        if (!event) return res.status(400).json({ error: "payment_mismatch" });
        await options.store.processWebhook(`checkout_${paymentId}`, "subscription.charged", JSON.stringify({ userId: session.userId, subscriptionId, paymentId }), event);
      } else {
        const association = await options.store.db.query<{ user_id: string; kind: string; amount_paise: number; currency: string; status: string; provider_payment_id: string | null }>(`SELECT user_id,kind,amount_paise,currency,status,provider_payment_id FROM classroom_desk_payments WHERE provider_order_id=$1`, [orderId]);
        const owned = association.rows[0];
        if (association.rows.length !== 1 || !owned || owned.user_id !== session.userId || owned.kind !== "trial"
          || Number(owned.amount_paise) !== TRIAL_PRICE_PAISE || owned.currency !== "INR"
          || (owned.provider_payment_id && owned.provider_payment_id !== paymentId)) return res.status(403).json({ error: "order_not_owned" });
        if (!["pending", "captured", "paid"].includes(owned.status)) return res.status(409).json({ error: "payment_not_captured" });
        const [payment, order] = await Promise.all([
          withProviderTimeout(() => options.razorpay!.getPayment(paymentId)),
          withProviderTimeout(() => options.razorpay!.getOrder(orderId)),
        ]);
        if (!validProviderPayment(payment, paymentId) || payment.status !== "captured" || payment.currency !== "INR" || paymentIsFullyRefunded(payment)) return res.status(409).json({ error: "payment_not_captured" });
        if (payment.amount !== TRIAL_PRICE_PAISE || payment.order_id !== orderId || payment.subscription_id || order.id !== orderId
          || order.amount !== TRIAL_PRICE_PAISE || order.currency !== "INR" || order.status !== "paid"
          || !isTrialOrderCreatedByCutoff(order.created_at)
          || order.notes?.user_id !== session.userId || order.notes.kind !== "trial" || order.notes.product !== "classroom_desk_trial"
          || (payment.notes?.user_id && payment.notes.user_id !== session.userId)) return res.status(400).json({ error: "payment_mismatch" });
        const event = parseRazorpayEvent({ event: "payment.captured", payload: { payment: { entity: payment }, order: { entity: order } } }, new Date(), session.userId);
        if (!event) return res.status(400).json({ error: "payment_mismatch" });
        await options.store.processWebhook(`checkout_${paymentId}`, "payment.captured", JSON.stringify({ userId: session.userId, orderId, paymentId }), event);
      }
      return res.json({ verified: true });
    } catch { return res.status(502).json({ error: "payment_verification_failed" }); }
  });
  app.post("/api/billing/subscription/cancel", async (req, res) => {
    const session = await currentSession(req.get("cookie"), options.store);
    if (!session) return res.status(401).json({ error: "login_required" });
    const subscriptionId = typeof req.body?.subscriptionId === "string" ? req.body.subscriptionId : "";
    if (!options.billingEnabled || !options.razorpay || !subscriptionId || !(await options.store.ownsSubscription(session.userId, subscriptionId))) return res.status(400).json({ error: "invalid_subscription" });
    if (req.body?.confirm !== "yes") return res.status(400).json({ error: "confirmation_required" });
    try {
      const subscription = await options.razorpay.cancelSubscription(subscriptionId, true);
      if (subscription.id !== subscriptionId) return res.status(502).json({ error: "billing_provider_mismatch" });
      return res.json({ cancelled: true, subscriptionId: subscription.id, scheduledAtCycleEnd: true, accessContinuesUntilProviderPaidThrough: true });
    }
    catch { return res.status(502).json({ error: "billing_provider_unavailable" }); }
  });
  app.get("/api/referrals", async (req, res) => {
    if (!options.referralRewardsEnabled) return res.status(503).json({ error: "referrals_not_enabled" });
    const session = await currentSession(req.get("cookie"), options.store);
    if (!session) return res.status(401).json({ error: "login_required" });
    try { return res.json(await options.store.referrals.summary(session.userId)); }
    catch { return res.status(503).json({ error: "referrals_unavailable" }); }
  });
  app.post("/api/classroom/link/start", async (req, res) => {
    const session = await currentSession(req.get("cookie"), options.store);
    if (!session) return res.status(401).json({ error: "login_required" });
    try { const link = await options.store.linking.start(session.userId); return res.status(201).json({ code: link.code, expiresAt: link.expiresAt.toISOString(), instruction: "Use this one-time code with your older Classroom Desk connection in ChatGPT. It does not grant Google access." }); }
    catch { return res.status(503).json({ error: "link_unavailable" }); }
  });
  app.post("/api/account/deletion-request", async (req, res) => {
    const session = await currentSession(req.get("cookie"), options.store);
    if (!session) return res.status(401).json({ error: "login_required" });
    if (req.body?.confirm !== "yes") return res.status(400).json({ error: "deletion_confirmation_required" });
    const reason = typeof req.body?.reason === "string" ? req.body.reason.slice(0, 1000) : undefined;
    try { return res.status(201).json({ requestId: await options.store.requestAccountDeletion(session.userId, reason), status: "requested", detail: "Your account remains active until this request is reviewed. Google authorization and billing are not changed automatically." }); }
    catch { return res.status(503).json({ error: "deletion_request_unavailable" }); }
  });
  app.post("/api/referrals/attribute", async (req, res) => {
    if (!options.referralRewardsEnabled) return res.status(503).json({ error: "referrals_not_enabled" });
    const session = await currentSession(req.get("cookie"), options.store);
    if (!session) return res.status(401).json({ error: "login_required" });
    const code = typeof req.body?.code === "string" ? req.body.code : "";
    if (!code) return res.status(400).json({ error: "invalid_referral" });
    try { return res.status(201).json({ referralId: await options.store.referrals.attribute(code, session.userId) }); }
    catch (error) { return res.status(409).json({ error: error instanceof Error ? error.message : "invalid_referral" }); }
  });
  app.post("/api/account/experience", async (req, res) => {
    const session = await currentSession(req.get("cookie"), options.store);
    if (!session) return res.status(401).type("html").send(message("Sign in required", "Sign in before selecting a dashboard."));
    const experience = req.body?.experience;
    if (experience !== "student" && experience !== "teacher") return res.status(400).type("html").send(message("Choose a dashboard", "Select Student or Teacher."));
    try { await options.store.setDashboardExperience(session.userId, experience as DashboardExperience); }
    catch { return res.status(503).type("html").send(message("Preference could not be saved", "Your account preference was not changed. Try again.")); }
    return res.redirect(303, "/app");
  });
  app.post("/api/teacher/authorization", async (req, res) => {
    const session = await currentSession(req.get("cookie"), options.store);
    if (!session) return res.status(401).type("html").send(message("Sign in required", "Sign in before connecting teacher access."));
    if (!options.beginTeacherAuthorization || !options.oauthStateStore) return res.status(503).type("html").send(message("Teacher access is unavailable", "Try again later or contact support."));
    const user = await options.store.getUser(session.userId);
    const mcpUserId = await options.store.getClassroomMcpUserId(session.userId);
    if (!user || user.status !== "active" || !mcpUserId) return res.status(409).type("html").send(message("Reconnect Classroom Desk", "Connect the Google account used for this signed-in account, then try again."));
    let entitlement;
    try { entitlement = await options.store.entitlement(user.id); }
    catch { return res.status(503).type("html").send(message("Teacher access is unavailable", "Account access could not be verified. No additional Google permissions were requested.")); }
    if (!entitlement.allowed || entitlement.plan !== "teacher") return res.status(403).type("html").send(message("Teacher access required", "An active Teacher plan is required before requesting access to rosters or submissions. Your Google access was not changed."));
    const state = randomBytes(24).toString("base64url");
    const verifier = randomBytes(32).toString("base64url");
    const nonce = randomBytes(32).toString("base64url");
    try {
      await options.oauthStateStore.putEphemeral("teacher_authorization", state, { userId: user.id, mcpUserId, verifier, nonce }, user.id, Date.now() + WEBSITE_LOGIN_STATE_TTL_MS);
      const authorizationUrl = await options.beginTeacherAuthorization({ mcpUserId, state, verifier, nonce });
      res.setHeader("Set-Cookie", loginCookie(options.secureCookies, state));
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Referrer-Policy", "no-referrer");
      return res.redirect(302, authorizationUrl);
    } catch {
      await options.oauthStateStore.takeEphemeral("teacher_authorization", state).catch(() => undefined);
      return res.status(503).type("html").send(message("Teacher authorization is unavailable", "Your current Classroom connection was not changed. Try again later."));
    }
  });
  app.post("/api/teacher/authorization/write", async (req, res) => {
    const session = await currentSession(req.get("cookie"), options.store);
    if (!session) return res.status(401).type("html").send(message("Sign in required", "Sign in before enabling draft coursework creation."));
    if (options.teacherDraftWritesEnabled !== true || !options.beginTeacherWriteAuthorization || !options.oauthStateStore) return res.status(503).type("html").send(message("Draft creation is unavailable", "This feature is not available right now."));
    const user = await options.store.getUser(session.userId);
    const mcpUserId = await options.store.getClassroomMcpUserId(session.userId);
    if (!user || user.status !== "active" || !mcpUserId) return res.status(409).type("html").send(message("Reconnect Classroom Desk", "Connect the Google account used for this signed-in account, then try again."));
    let entitlement;
    try { entitlement = await options.store.entitlement(user.id); }
    catch { return res.status(503).type("html").send(message("Teacher access is unavailable", "Account access could not be verified. No additional Google permissions were requested.")); }
    if (!entitlement.allowed || entitlement.plan !== "teacher") return res.status(403).type("html").send(message("Teacher access required", "An active Teacher plan is required before requesting access to create unpublished drafts."));
    const state = randomBytes(24).toString("base64url");
    const verifier = randomBytes(32).toString("base64url");
    const nonce = randomBytes(32).toString("base64url");
    try {
      await options.oauthStateStore.putEphemeral("teacher_authorization", state, { authorizationType: "write", userId: user.id, mcpUserId, verifier, nonce }, user.id, Date.now() + WEBSITE_LOGIN_STATE_TTL_MS);
      const authorizationUrl = await options.beginTeacherWriteAuthorization({ mcpUserId, state, verifier, nonce });
      res.setHeader("Set-Cookie", loginCookie(options.secureCookies, state));
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Referrer-Policy", "no-referrer");
      return res.redirect(302, authorizationUrl);
    } catch {
      await options.oauthStateStore.takeEphemeral("teacher_authorization", state).catch(() => undefined);
      return res.status(503).type("html").send(message("Draft creation is unavailable", "Your existing Classroom connection was not changed. Try again later."));
    }
  });
  app.post("/api/teacher/courses/:courseId/coursework/drafts", async (req, res) => {
    const userId = await requireTeacherMutationAccount(req, res);
    if (!userId) return;
    if (!options.createTeacherCourseworkDraft) return res.status(503).type("html").send(message("Draft creation is unavailable", "Google coursework draft creation is not configured."));
    if (req.body?.confirm !== "yes") return res.status(400).type("html").send(message("Draft not created", "Tick the confirmation box before creating an unpublished draft. No Classroom changes were made."));
    let input: TeacherCourseworkDraftInput;
    try { input = parseTeacherDraftForm(req.body); }
    catch { return res.status(400).type("html").send(message("Draft details are invalid", "Check the title, due date, due time, and points. No Classroom changes were made.")); }
    const courseId = String(req.params.courseId ?? "");
    try {
      await options.createTeacherCourseworkDraft(userId, courseId, input);
      return res.redirect(303, `/app/teacher/courses/${encodeURIComponent(courseId)}?draft=created`);
    } catch (error) { return sendTeacherDraftFailure(res, error); }
  });
  app.get("/app/assets/account.js", (_req, res) => res.type("js").send(accountScript));
  app.use("/app", async (req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Security-Policy", "default-src 'none'; img-src 'self' data: https://*.razorpay.com; style-src 'unsafe-inline' https://*.razorpay.com; script-src 'self' https://checkout.razorpay.com; connect-src 'self' https://api.razorpay.com; frame-src https://api.razorpay.com https://checkout.razorpay.com; form-action 'self' https://api.razorpay.com https://checkout.razorpay.com; base-uri 'none'; frame-ancestors 'none'");
    const token = readSessionCookie(req.get("cookie"));
    const session = token ? await options.store.sessions.find(token) : null;
    if (!session) return res.redirect(303, `/login?next=${encodeURIComponent(safeWebsiteReturnPath(req.originalUrl))}`);
    const user = await options.store.getUser(session.userId);
    if (!user || user.status !== "active") return res.status(403).type("html").send(message("Account unavailable", "Contact support to review your account status."));
    res.locals.accountUser = user;
    next();
  });
  const renderStudent = async (user: SaaSUser, res: express.Response) => {
    let result: StudentDashboardState = { state: "unavailable" };
    try { result = options.loadClassroomDashboard ? await options.loadClassroomDashboard(user.id) : { state: "not_connected" }; } catch { result = { state: "unavailable" }; }
    return res.type("html").send(renderStudentDashboard(user, result));
  };
  const renderTeacher = async (user: SaaSUser, res: express.Response, coursePageToken?: string) => {
    let result: TeacherDashboardState = { state: "unavailable" };
    try { result = options.loadTeacherDashboard ? await options.loadTeacherDashboard(user.id, coursePageToken) : { state: "authorization_required" }; } catch { result = { state: "unavailable" }; }
    return res.type("html").send(renderTeacherDashboard(user, result));
  };
  app.get("/app", async (_req, res) => {
    const user = res.locals.accountUser;
    const preference = await options.store.getDashboardExperience(user.id);
    if (!preference) return res.redirect(303, "/app/experience");
    return preference === "teacher" ? renderTeacher(user, res) : renderStudent(user, res);
  });
  app.get("/app/experience", async (_req, res) => res.type("html").send(renderExperienceSelector(res.locals.accountUser, await options.store.getDashboardExperience(res.locals.accountUser.id))));
  app.get("/app/student", async (_req, res) => renderStudent(res.locals.accountUser, res));
  app.get("/app/teacher", async (req, res) => {
    const token = req.query.coursePageToken;
    if (token !== undefined && (typeof token !== "string" || token.length < 1 || token.length > 4096)) return res.status(400).type("html").send(message("Invalid course page", "The Google Classroom course page could not be loaded. Return to the first page and try again."));
    return renderTeacher(res.locals.accountUser, res, typeof token === "string" ? token : undefined);
  });
  app.get("/app/teacher/courses/:courseId", async (req, res) => {
    if (!options.loadTeacherCourse) return res.status(503).type("html").send(message("Teacher course unavailable", "Teacher read access is not configured."));
    try { return res.type("html").send(renderTeacherCourse(res.locals.accountUser, await options.loadTeacherCourse(res.locals.accountUser.id, String(req.params.courseId)))); }
    catch (error) { const failure = teacherReadFailure(error, "course"); return res.status(failure.status).type("html").send(message(failure.title, failure.detail)); }
  });
  app.get("/app/teacher/courses/:courseId/coursework/:courseWorkId", async (req, res) => {
    if (!options.loadTeacherSubmissions) return res.status(503).type("html").send(message("Submissions unavailable", "Teacher submission reads are not configured."));
    try { return res.type("html").send(renderTeacherSubmissions(res.locals.accountUser, await options.loadTeacherSubmissions(res.locals.accountUser.id, String(req.params.courseId), String(req.params.courseWorkId)))); }
    catch (error) { const failure = teacherReadFailure(error, "submissions"); return res.status(failure.status).type("html").send(message(failure.title, failure.detail)); }
  });
  app.get("/app/subscription", async (_req, res) => res.type("html").send(renderSubscription(await options.store.accountOverview(res.locals.accountUser), options.billingEnabled === true, options.teacherFeaturesEnabled === true)));
  app.get("/app/referrals", async (req, res) => {
    const user = res.locals.accountUser;
    const summary = await options.store.referrals.summary(user.id, { createCode: options.referralRewardsEnabled === true });
    return res.type("html").send(renderReferrals(user, summary, options.referralRewardsEnabled === true, options.oauth?.origin ?? `${req.protocol}://${req.get("host")}`));
  });
  app.get("/app/connection", (_req, res) => res.type("html").send(renderConnection(res.locals.accountUser)));
  app.get("/app/settings", async (_req, res) => {
    const overview = await options.store.accountOverview(res.locals.accountUser);
    const connectionStatus = options.loadConnectionStatus ? await options.loadConnectionStatus(overview.user.id) : overview.linked ? "unavailable" : "not_linked";
    return res.type("html").send(renderProfile({ ...overview, connectionStatus }));
  });
  for (const [path, target] of [["/app/courses", "/app/student"], ["/app/assignments", "/app/student"], ["/app/deadlines", "/app/student"], ["/app/activity", "/app/student"], ["/app/billing", "/app/subscription"]] as const) {
    app.get(path, async (req, res) => {
      return res.redirect(303, target);
    });
  }
}

function parseTeacherDraftForm(value: unknown): TeacherCourseworkDraftInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_coursework_draft");
  const body = value as Record<string, unknown>;
  const allowed = new Set(["title", "description", "dueDate", "dueTime", "maxPoints", "confirm"]);
  if (Object.keys(body).some((key) => !allowed.has(key))) throw new Error("invalid_coursework_draft");
  const input: TeacherCourseworkDraftInput = {};
  for (const key of ["title", "description"] as const) {
    const field = body[key];
    if (field !== undefined) {
      if (typeof field !== "string") throw new Error("invalid_coursework_draft");
      input[key] = field;
    }
  }
  if (body.dueDate !== undefined && body.dueDate !== "") {
    if (typeof body.dueDate !== "string") throw new Error("invalid_coursework_draft");
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(body.dueDate);
    if (!match) throw new Error("invalid_coursework_draft");
    input.dueDate = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  }
  if (body.dueTime !== undefined && body.dueTime !== "") {
    if (typeof body.dueTime !== "string") throw new Error("invalid_coursework_draft");
    const match = /^(\d{2}):(\d{2})$/.exec(body.dueTime);
    if (!match) throw new Error("invalid_coursework_draft");
    input.dueTime = { hours: Number(match[1]), minutes: Number(match[2]) };
  }
  if (body.maxPoints !== undefined && body.maxPoints !== "") {
    if (typeof body.maxPoints !== "string" && typeof body.maxPoints !== "number") throw new Error("invalid_coursework_draft");
    input.maxPoints = Number(body.maxPoints);
  }
  return input;
}

function sendTeacherDraftFailure(res: express.Response, error: unknown) {
  const code = typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : "";
  const status = code === "invalid_coursework_draft" || code === "confirmation_required" ? 400 : code === "teacher_course_forbidden" ? 403 : 503;
  const detail = code === "teacher_course_forbidden"
    ? "Google did not authorize draft creation in that course. No draft was created."
    : "Google did not confirm draft creation. Check Google Classroom before retrying; Classroom Desk does not publish coursework or change grades.";
  return res.status(status).type("html").send(message("Coursework draft was not confirmed", detail));
}

async function currentSession(cookie: string | undefined, store: SaaSStore) {
  const token = readSessionCookie(cookie);
  const session = token ? await store.sessions.find(token) : null;
  if (!session) return null;
  const user = await store.getUser(session.userId);
  return user?.status === "active" ? session : null;
}

function message(title: string, detail: string, showRecoveryLink = false): string { return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex, nofollow"><title>${html(title)} · Classroom Desk</title></head><body style="font:16px system-ui;max-width:640px;margin:12vh auto;padding:24px;color:#202923"><p style="color:#207a55;font-weight:700">Classroom Desk</p><h1>${html(title)}</h1><p>${html(detail)}</p>${showRecoveryLink ? `<p><a href="/account/recovery">Start protected legacy-account recovery</a></p>` : ""}<a href="/">Return home</a></body></html>`; }
