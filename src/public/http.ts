import crypto from "node:crypto";
import { isIP } from "node:net";
import express, { type NextFunction, type Request, type Response } from "express";
import { ipKeyGenerator, rateLimit } from "express-rate-limit";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import { createClients } from "../classroom.js";
import type { ClassroomClients } from "../classroom.js";
import { OAuth2Client } from "googleapis-common";
import { createServer } from "../server.js";
import { MCP_OFFLINE_SCOPE, MCP_SCOPE, PublicOAuthProvider } from "./oauth.js";
import { loadSaaSFeatureFlags } from "../saas/flags.js";
import { isTrialPurchaseOpen, planPricePaise, TRIAL_PRICE_PAISE } from "../saas/campaign.js";
import type { PricingReferralView } from "../saas/pricing-referral-view.js";
import type { PublicAuthStore } from "./store.js";
import type { RuntimeConfig } from "./config.js";
import { logHttp, logOAuthCallbackRedirect, logOAuthCallbackRejected } from "./log.js";
import { socialPreviewPngBase64 } from "./social-preview-asset.js";
import { classroomDeskFaviconPngBase64, classroomDeskFaviconSvg, classroomDeskLogoPngBase64 } from "./logo-asset.js";
import { accessGuidance, MCP_ONBOARDING_TOOLS, registerMcpOnboarding } from "../saas/mcp-access.js";

type Session = { userId: string; transport: StreamableHTTPServerTransport; server: McpServer };
type AuthenticatedRequest = Request & { auth?: AuthInfo };
export type RawBodyRequest = Request & { rawBody?: Buffer };
type McpFactory = (auth: OAuth2Client, userId: string) => Promise<McpServer>;
type PublicAppOptions = { mcpFactory?: McpFactory; resourceName?: string; registerRoutes?: (app: express.Express) => void; entitlementCheck?: (userId: string) => Promise<{ allowed: boolean; reason: string }>; loadPricingReferral?: (cookieHeader: string | undefined) => Promise<PricingReferralView>; publicOnly?: boolean; internalDelegationSecret?: string; stagingSubjectFingerprint?: boolean };

export function createPublicApp(config: RuntimeConfig, store: PublicAuthStore, provider = new PublicOAuthProvider(store, config), readyCheck?: () => Promise<void>, clientsFactory: (auth: OAuth2Client) => ClassroomClients = createClients, options: PublicAppOptions = {}) {
  const app = express();
  const saasFlags = config.saasFlags ?? loadSaaSFeatureFlags(process.env);
  const workerKeyGenerator = config.workerClientIp ? (req: Request) => {
    const address = req.get("cf-connecting-ip") ?? "";
    return isIP(address) ? ipKeyGenerator(address, 56) : "missing-cloudflare-ip";
  } : undefined;
  const workerOAuthLimit = workerKeyGenerator ? { rateLimit: { keyGenerator: workerKeyGenerator } } : undefined;
  const sessions = new Map<string, Session>();
  app.disable("x-powered-by");
  app.set("trust proxy", config.production ? 1 : false);
  app.use((req, res, next) => {
    const started = Date.now();
    res.once("finish", () => logHttp(req.method, req.path, res.statusCode, Date.now() - started));
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cache-Control", "no-store, no-transform");
    if (config.production) res.setHeader("Strict-Transport-Security", "max-age=31536000");
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin-allow-popups");
    if (req.method === "GET" && ["/", "/pricing", "/connect", "/privacy", "/terms", "/refunds", "/support"].includes(req.path)) res.setHeader("Cache-Control", "public, max-age=0, must-revalidate, no-transform");
    res.setHeader("Content-Security-Policy", "default-src 'none'; img-src 'self' https://d2ol7oe51mr4n9.cloudfront.net; media-src https://d8j0ntlcm91z4.cloudfront.net; style-src 'unsafe-inline'; script-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
    const suppliedInternalToken = req.get("x-classroom-internal-token") ?? "";
    const expectedInternalToken = options.internalDelegationSecret ?? "";
    const trustedInternal = expectedInternalToken.length > 0 && suppliedInternalToken.length === expectedInternalToken.length && crypto.timingSafeEqual(Buffer.from(suppliedInternalToken), Buffer.from(expectedInternalToken));
    if (trustedInternal) {
      req.headers.host = config.origin.host;
    }
    let host = "";
    try { host = new URL(`http://${req.get("host") ?? ""}`).hostname; } catch { /* Invalid Host is rejected below. */ }
    if (!trustedInternal && req.path !== "/health" && req.path !== "/ready" && host !== config.origin.hostname) {
      console.log(JSON.stringify({ event: "internal_trust_rejected", path: req.path, headerPresent: suppliedInternalToken.length > 0, lengthMatched: expectedInternalToken.length > 0 && suppliedInternalToken.length === expectedInternalToken.length }));
      return res.status(400).json({ error: "invalid_host" });
    }
    if (req.get("origin") && req.get("origin") !== config.origin.origin) return res.status(403).json({ error: "invalid_origin" });
    next();
  });
  app.use(rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: "draft-8", legacyHeaders: false, keyGenerator: workerKeyGenerator,
    handler: (_req, res) => res.status(429).json({ error: "rate_limited", message: "Too many requests. Try again later." }),
  }));
  app.use(express.urlencoded({ extended: false, limit: "4kb" }));
  app.use(express.json({ limit: "64kb", verify: (req, _res, buffer) => { (req as RawBodyRequest).rawBody = Buffer.from(buffer); } }));

  const metadataUrl = new URL("/.well-known/oauth-protected-resource/mcp", config.origin).toString();
  app.get("/health", (_req, res) => res.status(200).json({ status: "ok" }));
  app.get("/pricing", async (req, res) => {
    const flags = config.saasFlags ?? loadSaaSFeatureFlags(process.env);
    const cookieHeader = req.get("cookie");
    const referralParam = req.query.ref;
    const referralCode = typeof referralParam === "string" ? normalizedReferralCode(referralParam) : null;
    const invalidReferralLink = referralParam !== undefined && !referralCode;
    if (cookieHeader || referralParam !== undefined) res.setHeader("Cache-Control", "no-store");
    let referralView: PricingReferralView = cookieHeader && !flags.referralRewards ? { state: "paused" } : { state: "signed_out" };
    if (flags.referralRewards && cookieHeader) {
      if (!options.loadPricingReferral) referralView = { state: "unavailable" };
      else {
        try { referralView = await options.loadPricingReferral(cookieHeader); }
        catch { referralView = { state: "unavailable" }; }
      }
    }
    return res.type("html").send(page("Pricing", "pricing", operator, support, config.origin, pricingBody(flags, referralView, referralCode, invalidReferralLink, config.origin)));
  });
  const readyLimit = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: "draft-8", legacyHeaders: false, keyGenerator: workerKeyGenerator,
    handler: (_req, res) => res.status(429).json({ error: "rate_limited" }),
  });
  app.get("/ready", readyLimit, async (_req, res) => {
    try { await readyCheck?.(); return res.status(200).json({ status: "ready" }); }
    catch { return res.status(503).json({ status: "unavailable" }); }
  });
  const operator = escapeHtml(config.operatorName ?? "Jarvis404");
  const support = escapeHtml(config.supportEmail ?? "support@example.invalid");
  const mailto = `mailto:${support}`;
  const chatgptPluginUrl = config.chatgptPluginUrl ? escapeHtml(config.chatgptPluginUrl) : undefined;
  app.get("/assets/classroom-desk-favicon.png", (_req, res) => {
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.type("png").send(Buffer.from(classroomDeskFaviconPngBase64, "base64"));
  });
  app.get("/assets/classroom-desk-logo.png", (_req, res) => {
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.type("png").send(Buffer.from(classroomDeskLogoPngBase64, "base64"));
  });
  app.get("/assets/classroom-desk-app-icon.png", (_req, res) => {
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.type("png").send(Buffer.from(classroomDeskLogoPngBase64, "base64"));
  });
  app.get("/assets/classroom-desk-favicon.svg", (_req, res) => {
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.type("svg").send(classroomDeskFaviconSvg);
  });
  app.get("/assets/classroom-desk-logo.svg", (_req, res) => {
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.type("png").send(Buffer.from(classroomDeskLogoPngBase64, "base64"));
  });
  app.get("/assets/classroom-desk-social-card.png", (_req, res) => {
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.type("png").send(Buffer.from(socialPreviewPngBase64, "base64"));
  });
  app.get("/assets/connect.js", (_req, res) => {
    res.setHeader("Cache-Control", "public, max-age=86400, no-transform");
    res.type("js").send(connectScript() + pricingReferralScript() + connectModalBridgeScript() + connectModalMarkupScript() + connectModalStateScript() + connectGuideBackStateScript() + connectModalBackDisabledScript() + connectModalProgressScript() + connectDemoScript() + connectDemoStyleScript() + connectAccountGuidanceScript() + connectModalCleanupScript() + homeMotionScript() + connectionCardScript());
  });
  app.get("/", (_req, res) => res.type("html").send(page("Classroom Desk", "home", operator, support, config.origin, homeBody(saasFlags))));
  app.get("/connect", (_req, res) => res.type("html").send(page("Connect to ChatGPT", "connect", operator, support, config.origin, connectBody())));
  app.get("/privacy", (_req, res) => res.type("html").send(page("Privacy policy", "privacy", operator, support, config.origin, `
    <article class="doc">
      <h1>Privacy policy</h1>
      <p class="updated">Last updated: 20 October 2026.</p>
      <p>Classroom Desk is operated by ${operator}. Contact: <a href="${mailto}">${support}</a>.</p>
      <h2>Data accessed and used</h2>
      <p>Student access requests six read-only Google Classroom permissions. Standard consent also asks for limited Google Drive access to files you create with Classroom Desk or select in Google Picker. This does not allow general browsing of your Drive. Teacher course lists and student submissions require separate consent; Classroom Desk checks with Google that you are a teacher in each course before showing them. When teacher draft tools are enabled, a further Google permission and your explicit confirmation are required to create or update an unpublished assignment draft. Google’s permission also covers grade management, but Classroom Desk does not write grades, publish drafts, or submit student work.</p>
      <p>Teacher attachment content is not read by default. If your connection supports reading a file, you can select that specific Classroom-linked file in Google Picker. This does not provide access to other Drive files.</p>
      <h2>Authentication and token handling</h2>
      <p>Google handles sign-in. Classroom Desk never receives your Google password. Google authorization tokens are encrypted before they are saved. The service also stores account and connection identifiers, the permissions you approved, and dates needed to maintain your connection.</p>
      <h2>Storage, sharing, and infrastructure</h2>
      <p>Connection details and encrypted Google authorization data are stored in the application database. We do not keep course content or attachment bodies as an application cache. When you request Classroom information through ChatGPT or another compatible connection, that information is sent to that app so it can answer. The connected app handles it under its own terms and privacy policy. Google processes sign-in and Classroom requests. Cloudflare and the database provider support hosting and storage.</p>
      <p>We do not sell Classroom data or use it for advertising. Generated-PDF transfer to Drive is currently unavailable. Download files yourself and attach them in Google Classroom; Classroom Desk does not claim that a Drive upload is a Classroom submission.</p>
      <h2>Google API Services Limited Use</h2>
      <p>Classroom Desk uses information received from Google only to provide the Classroom features you request and follows the <a href="https://developers.google.com/terms/api-services-user-data-policy" target="_blank" rel="noopener noreferrer">Google API Services User Data Policy</a>, including its Limited Use requirements. When you ask ChatGPT to answer from your Classroom, the requested information is sent to ChatGPT so it can respond. Classroom Desk does not use Classroom data for advertising or to train generalized models.</p>
      <h2>Retention, disconnect, and deletion</h2>
      <p>Authorization records remain while your connection is active and are removed when you disconnect. Connection requests expire after a short time. Access tokens expire after one hour; renewal tokens expire after 30 days. Disconnect asks Google to revoke access and removes this service’s local authorization records. You can also revoke access in your Google Account.</p>
      <p>To request help or deletion, contact ${support}. Service logs record the page or service area, response status, request duration, and fixed error categories. They do not include tokens, request bodies, or Classroom content.</p>
    </article>
  `)));
  app.get("/terms", (_req, res) => res.type("html").send(page("Terms of service", "terms", operator, support, config.origin, `
    <article class="doc">
      <h1>Terms of service</h1>
      <p class="updated">Last updated: 20 October 2026.</p>
      <p>This service is operated by ${operator}. Use only accounts and Classroom courses you are authorized to access, and follow your school’s rules and Google’s applicable terms.</p>
      <h2>What the service does</h2>
      <p>Classroom Desk helps ChatGPT or another compatible connection answer questions about your Google Classroom courses, announcements, assignments, materials, topics, deadlines, and your own submission status. Some connections can read a specific Classroom-linked file after you select it in Google Picker. You can also ask Classroom Desk to check the submission status Google reports. Classroom Desk does not transfer generated PDFs to Drive; download files and attach them in Google Classroom yourself.</p>
      <h2>Limits</h2>
      <p>The service may be unavailable when Google, a school administrator, the connected app, or the hosting provider limits access. Classroom information may be incomplete or delayed; check the original Classroom item before relying on a deadline or grade. If teacher draft tools are available, you separately authorize the required Google permission and confirm each action before Classroom Desk creates or updates an unpublished assignment draft in a course where Google verifies you as a teacher. It does not change published coursework, publish drafts, submit student work, or write grades. Generated PDFs are not transferred to Drive; attach downloaded files yourself, and submit through Google Classroom yourself.</p>
      <h2>Copyright and trademarks</h2>
      <p>© 2026 ${operator}. Classroom Desk source code is licensed under Apache-2.0; see the <a href="https://github.com/Fawzankhan-404/Classroom-Desk/blob/main/LICENSE">license file</a>. Your Classroom content remains subject to the rights of its respective owners; using this service does not transfer ownership of that content.</p>
      <p>Google Classroom is a trademark of Google LLC. ChatGPT and OpenAI are trademarks of OpenAI. These names describe the services this independent integration connects with. Google and OpenAI do not operate or endorse Classroom Desk.</p>
      <h2>Support</h2>
      <p>For support or account disconnection help, contact <a href="${mailto}">${support}</a>. Do not send OAuth tokens, passwords, or private Classroom content.</p>
    </article>
  `)));
  app.get("/support", (_req, res) => res.type("html").send(page("Support", "support", operator, support, config.origin, `
    <article class="doc support-card" id="project-support" aria-labelledby="project-support-title">
      <h1 id="project-support-title">Support Classroom Desk</h1>
      <p class="updated">Optional support for a free, open-source project.</p>
      <p>Classroom Desk is an independently developed, open-source project that connects Google Classroom with ChatGPT, making it easier for students to access their courses, assignments, deadlines, and learning information.</p>
      <p>Building and maintaining this project takes time and resources. Contributions help us keep improving it and make access more affordable for students who need it.</p>
      <p><a class="button" href="https://github.com/Fawzankhan-404/Classroom-Desk" target="_blank" rel="noopener noreferrer">View Classroom Desk on GitHub</a></p>

      <h2>Where your support goes</h2>
      <div class="faq-list">
        <section class="panel"><h3>Student access</h3><p>Help us provide sponsored or discounted Classroom Desk access to students who cannot afford a subscription.</p></section>
        <section class="panel"><h3>Hosting and maintenance</h3><p>Support the infrastructure, security updates, bug fixes, and ongoing reliability of Classroom Desk.</p></section>
        <section class="panel"><h3>Open-source development</h3><p>Help us maintain the codebase, improve documentation, and build useful features for the community.</p></section>
      </div>

      <h2>Every contribution helps</h2>
      <p>Whether you're a student, developer, educator, or someone who believes in accessible education, your support helps keep Classroom Desk moving forward.</p>
      <p><a class="button secondary" href="mailto:${support}">Support Classroom Desk</a></p>
      <p class="fine-print">Classroom Desk is an independent open-source project. Contributions are voluntary and do not purchase a subscription or guarantee access to paid features.</p>
      <p class="fine-print">Online contributions are not enabled yet. No payment can be made from this page until the merchant account and contribution checkout have been separately approved and configured.</p>
    </article>
  `)));
  app.get("/refunds", (_req, res) => res.type("html").send(page("Refund and cancellation policy", "refunds", operator, support, config.origin, `
    <article class="doc">
      <h1>Refund and cancellation policy</h1>
      <p class="updated">Last updated: 20 October 2026.</p>
      <p>This policy explains refunds and cancellations for existing Classroom Desk payments and subscriptions. The price and terms shown during checkout and on your receipt apply to that purchase. Prices are shown in INR.</p>
      <h2>Introductory trial</h2>
      <p>The ₹9 introductory trial was a one-time payment for 168 hours from verified payment. It did not renew automatically. Existing valid trials remain active until their recorded expiry.</p>
      <h2>Monthly subscriptions</h2>
      <p>An existing monthly plan renews under the recurring payment permission you approved. Where cancellation is supported, it stops future renewals; paid access continues until the payment provider confirms its end date.</p>
      <h2>Refunds and disputes</h2>
      <p>Refund requests are reviewed against the payment, the period of access, and the applicable refund policy. Confirmed refunds or chargebacks can change account access. Do not send card details, passwords, OAuth tokens, or private Classroom content.</p>
      <h2>Contact</h2>
      <p>For billing questions or refund requests, contact <a href="${mailto}">${support}</a> with the provider payment reference and account email only.</p>
    </article>
  `)));
  if (options.publicOnly) return { app, provider, sessions, closeSessions: () => sessions.clear() };
  app.use((req, _res, next) => {
    if (req.path === "/token" && req.method === "POST") {
      const body = req.body && typeof req.body === "object" ? req.body as Record<string, unknown> : {};
      console.log(JSON.stringify({ event: "mcp_token_input", contentType: req.get("content-type")?.split(";")[0] ?? "", grantType: typeof body.grant_type === "string" ? body.grant_type : "missing", hasCode: typeof body.code === "string", hasRefreshToken: typeof body.refresh_token === "string", hasClientId: typeof body.client_id === "string", hasRedirectUri: typeof body.redirect_uri === "string", hasCodeVerifier: typeof body.code_verifier === "string", hasResource: typeof body.resource === "string" }));
    }
    next();
  });
  // Internal account/policy routes must precede the MCP router. The SDK router
  // owns protocol endpoints and may emit a generic 400 for unknown requests.
  // Keeping these trusted service-binding routes first preserves the public
  // MCP surface while allowing canonical policy evaluation to run.
  options.registerRoutes?.(app);
  // The MCP SDK redirects provider errors to the requested redirect_uri. Reject
  // disallowed destinations before its handler so a rejected client never
  // receives even an OAuth error redirect.
  const rejectUnsafeAuthorizationRedirect = async (req: Request, res: Response, next: NextFunction) => {
    const params = (req.method === "GET" ? req.query : req.body) as Record<string, unknown> | undefined;
    const clientId = typeof params?.client_id === "string" ? params.client_id : undefined;
    if (!clientId) return next();
    try {
      const client = await provider.clientsStore.getClient(clientId);
      if (!client) return next(); // The SDK returns invalid_client directly, before redirect handling.
      const redirectUri = typeof params?.redirect_uri === "string"
        ? params.redirect_uri
        : client.redirect_uris.length === 1 ? client.redirect_uris[0] : undefined;
      if (redirectUri && !provider.isAllowedAuthorizationRedirect(client as OAuthClientInformationFull, redirectUri)) {
        return res.status(400).json({ error: "invalid_request", error_description: "Unsupported redirect URI." });
      }
      return next();
    } catch {
      // Fail closed without redirecting to any client-controlled destination.
      return res.status(400).json({ error: "invalid_request", error_description: "Authorization request could not be validated." });
    }
  };
  app.get("/authorize", rejectUnsafeAuthorizationRedirect);
  app.post("/authorize", rejectUnsafeAuthorizationRedirect);
  app.use(mcpAuthRouter({
    provider, issuerUrl: config.origin, baseUrl: config.origin, resourceServerUrl: config.mcpResource,
    scopesSupported: [MCP_SCOPE, MCP_OFFLINE_SCOPE], resourceName: options.resourceName ?? "Classroom Desk MCP access",
    authorizationOptions: workerOAuthLimit,
    clientRegistrationOptions: workerOAuthLimit,
    tokenOptions: workerOAuthLimit,
    revocationOptions: workerOAuthLimit,
  }));

  app.get("/connect/google", async (req, res) => {
    const flow = typeof req.query.flow === "string" ? req.query.flow : "";
    const oauthFlow = flow ? await store.getFlow(flow) : undefined;
    if (!oauthFlow || !provider.isAllowedFlowRedirect(oauthFlow)) return res.status(400).type("text").send("This connection request expired or could not be checked. Return to the app where you started and try connecting again.");
    const hiddenFlow = escapeHtml(flow);
    const clientName = typeof oauthFlow.client.client_name === "string"
      ? oauthFlow.client.client_name.slice(0, 160)
      : "Unidentified MCP client";
    const redirectUri = oauthFlow.params.redirectUri;
    let responseRecipient = "Unavailable; cancel this request";
    if (typeof redirectUri === "string") {
      try {
        const recipient = new URL(redirectUri);
        if ((recipient.protocol === "https:" || recipient.protocol === "http:") && !recipient.search && !recipient.hash) responseRecipient = `${recipient.origin}${recipient.pathname}`.slice(0, 320);
      } catch { /* Keep the fail-closed display if the registered callback cannot be parsed. */ }
    }
    const googleScopes = provider.config.googleScopes ?? [];
    const hasDriveFileScope = googleScopes.includes("https://www.googleapis.com/auth/drive.file");
    const hasTeacherReadConsent = Boolean(provider.config.teacherScopes?.length);
    const hasTeacherDraftConsent = Boolean(provider.config.teacherWriteScopes?.length);
    const driveDisclosure = hasDriveFileScope
      ? "The standard Google request also allows Classroom Desk to see, create, edit, and delete specific files you create with it or choose in Google Picker. It does not allow general browsing of your Drive."
      : "This consent does not request Google Drive access.";
    const teacherReadDisclosure = hasTeacherReadConsent
      ? "Viewing course rosters and student submissions requires separate consent. Google checks that you are a teacher in each course."
      : "";
    const teacherDraftDisclosure = hasTeacherDraftConsent
      ? "Teacher draft tools need an additional Google permission and your confirmation for each action. Google’s permission also covers grade management, but Classroom Desk does not write grades, publish drafts, or submit student work."
      : "";
    // A no-referrer policy can cause browser form POSTs to send Origin: null.
    // Keep the same-origin CSRF check and send only the origin to Google on navigation.
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("Content-Security-Policy", "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; form-action 'self' https://accounts.google.com; base-uri 'none'; frame-ancestors 'none'");
    res.type("html").send(page("Connect Classroom Desk", "connect", operator, support, config.origin, `
      <section class="connect-card">
        ${logoMark()}
        <h1>Connect Classroom Desk</h1>
        <div class="permission-note">
          <h2>Connection requested by</h2>
          <p><strong>${escapeHtml(clientName)}</strong></p>
          <p>After Google authorization, the response will be returned to <code>${escapeHtml(responseRecipient)}</code>.</p>
          <p>The app name is supplied by the app requesting access and is not verified by Classroom Desk. Continue only if you recognize both the app and destination.</p>
        </div>
        <p>Student tools request read-only access to supported Google Classroom data. ${driveDisclosure} ${teacherReadDisclosure} ${teacherDraftDisclosure}</p>
        <div class="badge-row"><span>Classroom reads</span><span>${hasDriveFileScope ? "File-scoped Drive access" : "No Google Drive access"}</span><span>No gradebook writes</span></div>
        <div class="permission-note">
          <h2>Before you continue</h2>
          <ul>
            <li>Google will show the permissions requested by this connection before you approve them.</li>
            ${hasTeacherReadConsent ? "<li>Teacher roster and submission access requires separate consent and a Google-verified teacher role.</li>" : ""}
            ${hasTeacherDraftConsent ? "<li>Creating an unpublished teacher assignment draft requires a further permission and your explicit confirmation.</li>" : ""}
            <li>Classroom Desk does not submit student work or write grades. It does not publish teacher drafts.</li>
            <li>Classroom Desk is operated by ${operator}.</li>
            <li>We never ask for your Google password.</li>
            <li>Disconnect is available from the connected client and revokes/deletes the local authorization where possible.</li>
          </ul>
        </div>
        <form method="post" action="/connect/google">
          <input type="hidden" name="flow" value="${hiddenFlow}">
          <button class="button" type="submit">Continue with Google</button>
        </form>
        <p class="fine-print"><a href="/privacy">Privacy</a> · <a href="/terms">Terms</a> · <a href="/support">Support</a></p>
        <p class="fine-print">Built by <a href="https://fawzankhan-404.github.io/" target="_blank" rel="noopener noreferrer">${operator}</a>. Questions? <a href="${mailto}">Get in touch</a>.</p>
      </section>
    `, true));
  });

  app.post("/connect/google", async (req, res) => {
    if (req.get("origin") !== config.origin.origin) return res.status(403).type("text").send("Connection request could not be validated.");
    const flow = typeof req.body?.flow === "string" ? req.body.flow : "";
    try { return res.redirect(303, await provider.beginGoogle(flow)); }
    catch { return res.status(400).type("text").send("This connection request expired or has already started. Return to the app where you began and try again."); }
  });

  app.get("/oauth/google/callback", async (req, res) => {
    try {
      const state = typeof req.query.state === "string" ? req.query.state : undefined;
      const code = typeof req.query.code === "string" ? req.query.code : undefined;
      const error = typeof req.query.error === "string" ? req.query.error : undefined;
      const location = await provider.completeGoogle(state, code, error);
      logOAuthCallbackRedirect(location, 303, error);
      return res.redirect(303, location);
    } catch {
      logOAuthCallbackRejected();
      return res.status(400).type("text").send("Google authorization could not be completed. Return to the app where you began and try again.");
    }
  });

  const authenticate = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    const match = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/.exec(req.get("authorization") ?? "");
    if (!match?.[1]) {
      res.setHeader("WWW-Authenticate", `Bearer resource_metadata="${metadataUrl}"`);
      return res.status(401).json({ error: "authentication_required", message: "Authentication required." });
    }
    try {
      const auth = await provider.verifyAccessToken(match[1]);
      if (!auth.scopes.includes(MCP_SCOPE) || auth.resource?.href !== config.mcpResource.href) throw new Error("invalid");
      req.auth = auth;
      return next();
    } catch {
      res.setHeader("WWW-Authenticate", `Bearer error="invalid_token", resource_metadata="${metadataUrl}"`);
      return res.status(401).json({ error: "invalid_token", message: "Authentication required." });
    }
  };

  app.post("/disconnect/google", authenticate, async (req: AuthenticatedRequest, res) => {
    const userId = req.auth?.extra?.userId;
    if (typeof userId !== "string") return res.status(401).json({ error: "invalid_token", message: "Authentication required." });
    try {
      const result = await provider.disconnectGoogle(userId);
      return res.status(200).json({ disconnected: true, googleRevocationConfirmed: result.revoked });
    } catch { return res.status(503).json({ error: "disconnect_failed", message: "Disconnect could not be confirmed. Try again." }); }
  });

  app.options("/mcp", (_req, res) => {
    res.setHeader("Access-Control-Allow-Origin", config.origin.origin);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID");
    res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id, WWW-Authenticate");
    res.status(204).end();
  });
  app.all("/mcp", authenticate, async (req: AuthenticatedRequest, res) => {
    res.setHeader("Access-Control-Allow-Origin", config.origin.origin);
    res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id, WWW-Authenticate");
    if (!["GET", "POST", "DELETE"].includes(req.method)) {
      res.setHeader("Allow", "GET, POST, DELETE, OPTIONS");
      return res.status(405).json({ error: "method_not_allowed" });
    }
    const userId = req.auth?.extra?.userId;
    if (typeof userId !== "string") return res.status(401).json({ error: "authentication_required" });
    if (req.method === "POST" && !req.is("application/json")) return res.status(415).json({ error: "unsupported_media_type" });
    // Check every invocation, including established sessions. Tool arguments and
    // caller headers never supply identity, plan or enforcement state.
    // The SDK supports JSON-RPC batches. Inspect the entire envelope before any
    // member is dispatched; checking only body.method would bypass this gate.
    const messages: unknown[] = Array.isArray(req.body) ? req.body : [req.body];
    const protectedInvocation = req.method === "POST" && messages.some(message => {
      if (!message || typeof message !== "object") return false;
      const call = message as { method?: unknown; params?: { name?: unknown } };
      return call.method === "tools/call" && (typeof call.params?.name !== "string" || !MCP_ONBOARDING_TOOLS.has(call.params.name));
    });
    const denyTool = (reason: string) => {
      const result = accessGuidance({ allowed: false, reason }, config.origin.origin);
      // Reject a denied envelope atomically, without executing even its safe
      // members. Notifications have no response, including in mixed batches.
      const responses = messages.filter(message => message && typeof message === "object" && Object.hasOwn(message, "id")).map(message => ({
        jsonrpc: "2.0", id: (message as { id: unknown }).id,
        result: { isError: true, content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result },
      }));
      if (!responses.length) return res.status(202).end();
      return res.status(200).json(Array.isArray(req.body) ? responses : responses[0]);
    };
    if (protectedInvocation && config.saasFlags?.enforceEntitlements) {
      try {
        const entitlement = await options.entitlementCheck?.(userId);
        if (!entitlement?.allowed) return denyTool(entitlement?.reason ?? "temporarily_unavailable");
      } catch { return denyTool("temporarily_unavailable"); }
    }
    const makeServer = async () => {
      let auth = await provider.googleAuthForUser(userId).catch(() => undefined);
      if (!auth && protectedInvocation) return undefined;
      auth ??= new OAuth2Client(); // Discovery/onboarding never calls Google.
      const mcp = options.mcpFactory ? await options.mcpFactory(auth, userId) : await createServer(clientsFactory(auth), { publicV1: true });
      registerMcpOnboarding(mcp, () => options.entitlementCheck?.(userId) ?? Promise.resolve({ allowed: false, reason: "account_setup_required" }), config.origin.origin, options.stagingSubjectFingerprint ? userId : undefined);
      return mcp;
    };
    if (config.production) {
      const mcp = await makeServer();
      if (!mcp) return denyTool("google_authorization_required");
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      try {
        await mcp.connect(transport);
        await transport.handleRequest(req, res, req.body);
      } catch {
        if (!res.headersSent) res.status(500).json({ error: "mcp_request_failed", message: "MCP request failed." });
        else res.destroy();
      } finally { await mcp.close().catch(() => undefined); }
      return;
    }
    const sessionId = req.get("mcp-session-id");
    let session = sessionId ? sessions.get(sessionId) : undefined;
    if (sessionId && (!session || session.userId !== userId)) return res.status(404).json({ error: "session_not_found" });
    if (!session) {
      if (req.method !== "POST") return res.status(400).json({ error: "initialization_required" });
      const mcp = await makeServer();
      if (!mcp) return denyTool("google_authorization_required");
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: (newSessionId) => { sessions.set(newSessionId, { userId, transport, server: mcp }); },
        onsessionclosed: async (closedId) => {
          const existing = sessions.get(closedId);
          sessions.delete(closedId);
          if (existing) await existing.server.close().catch(() => undefined);
        },
      });
      transport.onclose = () => { if (transport.sessionId) sessions.delete(transport.sessionId); };
      session = { userId, transport, server: mcp };
      await mcp.connect(transport);
    }
    try {
      await session.transport.handleRequest(req as Request & { auth?: AuthInfo }, res, req.body);
      if (session.transport.sessionId) sessions.set(session.transport.sessionId, session);
    } catch {
      if (!res.headersSent) res.status(500).json({ error: "mcp_request_failed", message: "MCP request failed." });
      else res.destroy();
    }
  });

  app.use((_req, res) => res.status(404).json({ error: "not_found" }));
  app.use((_error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (!res.headersSent) {
      const status = (_error as { status?: number })?.status;
      res.status(status === 413 ? 413 : status === 400 ? 400 : 500).json({ error: status === 413 ? "request_too_large" : status === 400 ? "invalid_request" : "server_error", message: "Request failed." });
    }
  });
  const closeSessions = async () => {
    for (const session of sessions.values()) await session.server.close().catch(() => undefined);
    sessions.clear();
  };
  return { app, provider, sessions, closeSessions };
}

function legacyHomeBody(flags: ReturnType<typeof loadSaaSFeatureFlags>, now = new Date()) {
  const trialState = !flags.billingUi ? "Checkout unavailable" : isTrialPurchaseOpen(now) ? "Check eligibility" : "Offer ended";
  const studentState = flags.billingUi ? "Plan details" : "Checkout unavailable";
  const teacherState = !flags.teacherFeatures ? "Not available yet" : flags.billingUi ? "Plan details" : "Checkout unavailable";
  const connectionCard = `<div class="connection-card hero-connection-card" data-connection-card tabindex="0" aria-label="Interactive connection guide"><div class="connection-card-head"><span>Connect in 3 steps</span><strong data-connection-progress>01 / 03</strong></div><div class="connection-card-track" aria-hidden="true"><i></i><i></i><i></i></div><section data-connection-step><span class="connection-card-icon">01</span><h3>Open ChatGPT Plugins</h3><p>Add a custom MCP server from ChatGPT's Plugins or developer settings.</p></section><section data-connection-step hidden><span class="connection-card-icon">02</span><h3>Add Classroom Desk</h3><p>Enter the server address and configure OAuth.</p><div class="connection-url"><code>https://classroom.jarvis404.com/mcp</code><button class="button secondary" type="button" data-copy-mcp-card>Copy URL</button></div></section><section data-connection-step hidden><span class="connection-card-icon">03</span><h3>Authorize &amp; start asking</h3><p>Complete Google authorization, install and select Classroom Desk, then ask your first question.</p></section><div class="connection-card-actions"><button class="button secondary" type="button" data-connection-back disabled>Back</button><button class="button" type="button" data-connection-next>Next</button><a class="text-link" href="/connect">Get started ↗</a></div></div>`;
  return `<section class="home-stage" data-home-stage aria-labelledby="home-title"><video class="stage-motion stage-motion--wide" autoplay muted loop playsinline preload="metadata" aria-hidden="true" poster="https://d2ol7oe51mr4n9.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/5c3ec08f-2dbf-4c0a-8588-f6106a789443.webp" data-stage-src="https://d8j0ntlcm91z4.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/hf_20260826_125226_45cb4f38-aa7e-47e1-885d-ae0b69745369.mp4"></video><video class="stage-motion stage-motion--narrow" muted loop playsinline preload="none" aria-hidden="true" poster="https://d2ol7oe51mr4n9.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/0f4926a4-e660-4df2-9195-2bfb3e341bdd.webp" data-stage-src="https://d8j0ntlcm91z4.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/hf_20260826_125242_daae1570-386d-4bd5-8896-80499e2371e0.mp4"></video><svg class="home-stage-noise" viewBox="0 0 160 160" preserveAspectRatio="none" aria-hidden="true"><filter id="homeNoise"><feTurbulence type="fractalNoise" baseFrequency=".72" numOctaves="2" seed="8" stitchTiles="stitch"/><feColorMatrix type="saturate" values="0"/><feComponentTransfer><feFuncA type="table" tableValues="0 .14"/></feComponentTransfer></filter><rect width="160" height="160" filter="url(#homeNoise)"/></svg><div class="home-stage-inner"><div class="home-masthead"><div class="home-copy"><p class="eyebrow home-eyebrow">Google Classroom for ChatGPT</p><h1 id="home-title">Built for <span>Classroom clarity</span>.</h1><p class="home-intro">Bring your authorized Google Classroom context into a conversation that helps you know what is due, what changed, and what to do next.</p><div class="actions"><button class="button" type="button" data-connect-open>Connect to ChatGPT</button><a class="text-link" href="#features">See what you can ask <span aria-hidden="true">↗</span></a></div><p class="home-note">Illustrative product experience. Connect your account for live Classroom answers.</p></div><div class="home-console" aria-label="Interactive illustrative Classroom Desk conversation"><div class="console-top"><span class="console-title"><span class="console-mark" aria-hidden="true"></span>Classroom Desk example</span><span class="console-status">Illustrative only</span></div><div class="example-panel home-example-panel" aria-live="polite"><span class="example-badge">Example question</span><h2 class="example-question" data-example-question>What assignments do I have?</h2><p class="example-answer" data-example-answer>“You have three current items: a Physics lab report, History reading notes, and a returned Biology assignment. Check each Classroom item for its latest details.”</p><small>Illustrative response. It is not live account data.</small></div><div class="prompt-tabs home-prompt-tabs" role="tablist" aria-label="Choose an illustrative question"><p class="prompt-label">Try an example</p><button role="tab" aria-selected="true" data-prompt-tab="0" data-copy-prompt="What assignments do I have?">What assignments do I have?<span>Copy</span></button><button role="tab" aria-selected="false" data-prompt-tab="1" data-copy-prompt="What deadlines are coming up?">What deadlines are coming up?<span>Copy</span></button><button role="tab" aria-selected="false" data-prompt-tab="2" data-copy-prompt="Show my recent Classroom activity.">Recent activity<span>Copy</span></button><button role="tab" aria-selected="false" data-prompt-tab="3" data-copy-prompt="Show announcements from my courses.">Announcements<span>Copy</span></button><button role="tab" aria-selected="false" data-prompt-tab="4" data-copy-prompt="Find missing or returned work.">Missing work<span>Copy</span></button><button role="tab" aria-selected="false" data-prompt-tab="5" data-copy-prompt="Explain the instructions for my assignment.">Instructions<span>Copy</span></button></div></div></div><section id="features" class="capability-section" aria-labelledby="capability-title"><div class="capability-heading"><p class="eyebrow">What you can ask</p><h2 id="capability-title">Useful context, without the noise.</h2><p>Classroom Desk keeps the answer close to the source you authorized and clear about what it can do.</p></div><div class="capability-cards"><article class="capability-card"><div class="capability-card-top"><span>01</span><span>Course context</span></div><h3>Ask about the work in front of you.</h3><p>Bring questions about courses, coursework, announcements, and your own submission status into one conversation.</p><svg class="capability-visual" viewBox="0 0 240 92" aria-hidden="true"><path d="M8 68h224M18 52h48M18 37h86M18 22h125" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="188" cy="22" r="6" fill="currentColor"/><circle cx="207" cy="37" r="6" fill="currentColor"/><circle cx="225" cy="52" r="6" fill="currentColor"/></svg></article><article class="capability-card"><div class="capability-card-top"><span>02</span><span>Due date clarity</span></div><h3>Know what needs your attention.</h3><p>Find upcoming, missing, and returned work with answers grounded in the Classroom data you approved.</p><svg class="capability-visual" viewBox="0 0 240 92" aria-hidden="true"><rect x="16" y="16" width="52" height="52" rx="8" fill="none" stroke="currentColor" stroke-width="2"/><path d="M30 43l9 9 18-22M94 25h116M94 46h86M94 67h58" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="214" cy="25" r="5" fill="currentColor"/></svg></article><article class="capability-card"><div class="capability-card-top"><span>03</span><span>Clear boundaries</span></div><h3>Understand the task, stay in control.</h3><p>Teacher files require explicit authorization, and Classroom Desk never submits or edits work automatically.</p><svg class="capability-visual" viewBox="0 0 240 92" aria-hidden="true"><path d="M42 18h58l24 24v32H42zM100 18v25h24M58 59h50M160 26h54M160 46h40M160 66h26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="144" cy="26" r="6" fill="currentColor"/></svg></article></div></section></div></section>
  <section id="how-it-works" class="section how-section"><p class="eyebrow">How it works</p><h2>Connect in 3 steps.</h2><div class="connection-card" data-connection-card tabindex="0" aria-label="Interactive connection guide"><div class="connection-card-head"><span>Classroom Desk</span><strong data-connection-progress>01 / 03</strong></div><div class="connection-card-track" aria-hidden="true"><i></i><i></i><i></i></div><section data-connection-step><span class="connection-card-icon">01</span><h3>Open ChatGPT Plugins</h3><p>Add a custom MCP server from ChatGPT's Plugins or developer settings.</p></section><section data-connection-step hidden><span class="connection-card-icon">02</span><h3>Add Classroom Desk</h3><p>Enter the server address and configure OAuth.</p><div class="connection-url"><code>https://classroom.jarvis404.com/mcp</code><button class="button secondary" type="button" data-copy-mcp-card>Copy URL</button></div></section><section data-connection-step hidden><span class="connection-card-icon">03</span><h3>Authorize &amp; start asking</h3><p>Complete Google authorization, install and select Classroom Desk, then ask your first question.</p></section><div class="connection-card-actions"><button class="button secondary" type="button" data-connection-back>Back</button><button class="button" type="button" data-connection-next>Next</button><a class="text-link" href="/connect">Get started ↗</a></div></div></section>
  <section class="section trust-section"><div><p class="eyebrow">Your control</p><h2>You stay in control.</h2><p>Classroom Desk uses Google access you approve. It does not submit student work or change grades automatically. Any available teacher draft change needs separate permission and your confirmation.</p><a class="text-link" href="/privacy">Read the privacy policy <span aria-hidden="true">↗</span></a></div><div class="trust-columns"><div><h3>What it can help with</h3><ul><li>Courses and coursework</li><li>Deadlines and activity</li><li>Announcements and topics</li><li>Your submission status</li><li>Selected teacher files, when file reading is supported and you authorize the specific file</li><li>If ChatGPT creates a file, download it and attach it in Classroom yourself</li></ul></div><div><h3>What it will not do automatically</h3><ul><li>Browse your Drive</li><li>Submit student work or publish teacher drafts</li><li>Write grades automatically</li><li>Read Gmail</li><li>Claim a save is a submission</li></ul></div></div></section>
  <section class="section pricing-teaser"><p class="eyebrow">Pricing</p><h2>Plan details, clearly explained.</h2><div class="price-list"><div><strong>Trial</strong><span>₹${TRIAL_PRICE_PAISE / 100} once</span><em>${trialState}</em></div><div><strong>Student</strong><span>₹${planPricePaise("student") / 100} per month</span><em>${studentState}</em></div><div><strong>Teacher</strong><span>₹${planPricePaise("teacher") / 100} per month</span><em>${teacherState}</em></div></div><a class="text-link" href="/pricing">Compare plan details <span aria-hidden="true">↗</span></a></section>
  <section class="section faq-section"><p class="eyebrow">Questions</p><h2>Questions, answered.</h2><div class="faq-list"><details open><summary>Does copying the address connect my Classroom?</summary><p>No. You still need a compatible ChatGPT connection and Google authorization.</p></details><details><summary>Which ChatGPT plans can use it?</summary><p>Availability depends on your ChatGPT plan and workspace settings. ChatGPT may ask you to turn on Developer mode, and workspace admins may need to allow it.</p></details><details><summary>What does Classroom Desk read?</summary><p>With your permission, it reads supported courses, assignments, announcements, topics and your own submission status. File content is available only for supported connections and files you specifically authorize.</p></details><details><summary>Does a subscription give access to my Classroom data?</summary><p>No. Billing and Google authorization are separate decisions.</p></details><details><summary>Is this official Google or ChatGPT software?</summary><p>No. Classroom Desk is an independent integration.</p></details></div></section>
  <section class="closing-cta"><h2>Ready to ask your Classroom a question?</h2><div><button class="button" type="button" data-connect-open>Connect to ChatGPT</button><a class="text-link" href="/pricing">See pricing <span aria-hidden="true">↗</span></a></div></section>`;
}

function homeBody(flags: ReturnType<typeof loadSaaSFeatureFlags>, now = new Date()) {
  const html = legacyHomeBody(flags, now);
  const card = html.match(/<section id="how-it-works"[\s\S]*?(<div class="connection-card"[\s\S]*?<\/div><\/section>)/)?.[1] ?? '';
  return html
    .replace('<p class="home-note">Illustrative product experience. Connect your account for live Classroom answers.</p>', card)
    .replace(/<section id="how-it-works"[\s\S]*?<\/section>/, '');
}

function pricingBody(flags: ReturnType<typeof loadSaaSFeatureFlags>, referralView: PricingReferralView, referralCode: string | null, invalidReferralLink: boolean, origin: URL, now = new Date()) {
  const checkoutStatus = flags.billingUi ? "" : `<p class="status-strip">Checkout is unavailable right now. Plan details are shown for reference.</p>`;
  const accountAction = flags.billingUi ? `<a class="button" href="/app/billing">View account options</a>` : `<span class="disabled-control">Checkout unavailable</span>`;
  const trialOpen = flags.billingUi && isTrialPurchaseOpen(now);
  const trialAction = trialOpen ? accountAction : `<p class="muted">${flags.billingUi ? "The introductory offer has ended. Existing valid trials continue until their recorded expiry." : "The introductory offer is not available while checkout is closed."}</p>`;
  const teacherAction = flags.billingUi && flags.teacherFeatures ? accountAction : `<p class="muted">Teacher plan checkout is not available yet.</p>`;
  const trialCard = `<article class="plan-card"><p class="eyebrow">Introductory offer</p><h2>₹${TRIAL_PRICE_PAISE / 100} once</h2><p>Seven days from verified payment. It does not automatically convert to a subscription.</p><ul><li>Ask about courses and coursework</li><li>Check deadlines and activity</li><li>Review announcements and submissions</li></ul>${trialAction}</article>`;
  const studentCard = `<article class="plan-card featured"><p class="eyebrow">For students</p><h2>₹${planPricePaise("student") / 100} <small>per month</small></h2><p>Keep everyday coursework questions close to the conversation.</p><ul><li>Authorized courses and coursework</li><li>Upcoming, missing and returned work</li><li>Announcements, topics and activity</li><li>Your own submission status</li><li>Teacher file access only when supported and specifically authorized</li><li>ChatGPT can help prepare work; attach files yourself in Classroom</li></ul>${accountAction}</article>`;
  const teacherCard = `<article class="plan-card"><p class="eyebrow">For teachers</p><h2>₹${planPricePaise("teacher") / 100} <small>per month</small></h2><p>Teacher access depends on the available Classroom features and Google permissions for your account.</p><ul><li>Google authorization required</li><li>Teacher role checked for each course</li><li>Gradebook writes remain disabled</li></ul>${teacherAction}</article>`;
  const referrals = renderPricingReferralSection(flags.referralRewards, referralView, referralCode, invalidReferralLink, origin);
  const referralJump = `<a class="button secondary referral-jump" href="#refer-and-earn">Refer &amp; Earn <span aria-hidden="true">↓</span></a>`;
  return `<article class="pricing-page"><p class="eyebrow">Pricing</p><h1>Plan details, clearly explained.</h1><p class="page-lead">Classroom Desk brings authorized Google Classroom information into ChatGPT. A plan does not grant Google access; you choose what to authorize with Google.</p>${checkoutStatus}<section class="pricing-grid" aria-label="Classroom Desk plans">${trialCard}${studentCard}${teacherCard}</section>${referralJump}${referrals}<section class="compare"><h2>What every plan requires</h2><div class="table-scroll"><table><thead><tr><th>Requirement</th><th>Why it matters</th></tr></thead><tbody><tr><th>Compatible ChatGPT connection</th><td>ChatGPT controls whether custom connections are available to your plan or workspace.</td></tr><tr><th>Your Google authorization</th><td>A subscription does not grant access to Classroom data by itself.</td></tr><tr><th>Classroom changes</th><td>Classroom Desk does not submit student work or write grades. Any available unpublished teacher draft change requires separate permission and your confirmation.</td></tr></tbody></table></div></section><section class="plain-billing"><h2>Billing in plain words</h2><div><p><strong>Introductory offer</strong><br>The ₹${TRIAL_PRICE_PAISE / 100} offer lasts exactly 168 hours from verified payment and does not renew automatically.</p><p><strong>Monthly plans</strong><br>Existing monthly plans renew under the payment permission you approved. Where cancellation is supported, it stops future renewals; paid access continues until the payment provider confirms its end date.</p><p><strong>Refunds</strong><br>Refund requests are reviewed against the payment, the period of access, and the applicable refund policy.</p></div><a class="text-link" href="/refunds">Read the refund and cancellation policy <span aria-hidden="true">↗</span></a></section></article>`;
}
function normalizedReferralCode(value: string): string | null {
  const code = value.trim().toUpperCase();
  return /^CD-[0-9A-F]{10}$/.test(code) ? code : null;
}

export function renderPricingReferralSection(enabled: boolean, view: PricingReferralView, referralCode: string | null, invalidReferralLink: boolean, origin: URL): string {
  const title = `<div class="referral-intro"><p class="eyebrow">Referral program</p><h2 id="referral-title">Refer &amp; Earn</h2>`;
  const steps = `<div class="referral-rules"><h3>How it works</h3><ol class="referral-steps"><li><span>Share your link.</span> The invited person signs in and applies the code before their first paid subscription payment.</li><li><span>First verified monthly payment.</span> Trials and link visits alone do not qualify.</li><li><span>Two qualifying referrals.</span> The referrer receives 30 days of Student access.</li></ol><details class="referral-terms"><summary>Eligibility and restrictions</summary><p>Referred accounts must have no previous subscription payment. Self-referrals and duplicate attributions are rejected. A full verified refund can remove a qualifying payment and reverse related rewards; partial refunds do not currently reverse referral qualification. Rewards are account access, not cash payouts.</p></details></div>`;
  const sectionOpen = `<section id="refer-and-earn" class="referral-program" aria-labelledby="referral-title">`;
  if (view.state === "signed_out" && !enabled) {
    const href = `/login?next=${encodeURIComponent("/pricing#refer-and-earn")}`;
    return `${sectionOpen}${title}<p>Referral rewards are paused in this environment. Sign-in is required for account referral details, but no referral code or reward is created while the backend reward setting is off.</p></div><div class="referral-panel"><p class="referral-state">Not currently active</p><a class="button" href="${escapeHtml(href)}">Sign in to Refer</a><p class="referral-note">If the program reopens, your personal code and progress will appear only after the server verifies your account session.</p></div></section>`;
  }
  if (!enabled || view.state === "paused") {
    return `${sectionOpen}${title}<p>Referral rewards are paused in this environment. New referral codes, attributions, and reward grants are disabled. Existing account records remain intact.</p></div><div class="referral-panel"><p class="referral-state">Not currently active</p><p>No new rewards are available while the backend reward setting is off.</p></div></section>`;
  }
  if (view.state === "signed_out") {
    const next = `/pricing${referralCode ? `?ref=${encodeURIComponent(referralCode)}` : ""}#refer-and-earn`;
    const href = `/login?next=${encodeURIComponent(next)}`;
    const message = invalidReferralLink ? "This referral link is incomplete or invalid." : referralCode ? "Sign in to apply the invitation code to your account." : "Sign in to create or view your personal referral link.";
    return `${sectionOpen}${title}<p>Share Classroom Desk with someone who could use a clearer view of their Classroom work. Referral progress comes from account records, not link clicks.</p>${steps}</div><div class="referral-panel">${invalidReferralLink ? `<p class="referral-state" role="status">${message}</p>` : `<p>${message}</p>`}<a class="button" href="${escapeHtml(href)}">Sign in to Refer</a><p class="referral-note">Sign-in returns to this Pricing section. Your own referral details are shown only after the server verifies your account session.</p></div></section>`;
  }
  if (view.state !== "ready") {
    return `${sectionOpen}${title}<p>Referral progress is available only after the signed-in account is verified.</p>${steps}</div><div class="referral-panel"><p role="status">We could not load referral information right now.</p><a class="text-link" href="/app/referrals">Open your referral dashboard</a></div></section>`;
  }

  const summary = view.summary;
  const shareUrl = new URL(`/pricing?ref=${encodeURIComponent(summary.code)}`, origin).toString();
  const remaining = summary.qualified % 2 === 0 ? 2 : 1;
  const history = summary.history?.length
    ? `<ul class="referral-history">${summary.history.map(reward => {
      const state = reward.revoked ? "Reversed" : reward.expiresAt.getTime() <= Date.now() ? "Expired" : reward.startsAt.getTime() > Date.now() ? "Scheduled" : "Available";
      return `<li><span>30-day Student access</span><span>${state} · ${escapeHtml(formatReferralDate(reward.startsAt))}–${escapeHtml(formatReferralDate(reward.expiresAt))}</span></li>`;
    }).join("")}</ul>`
    : `<p>No reward credits recorded yet.</p>`;
  const invitation = invalidReferralLink
    ? `<p class="referral-state" role="status">This referral link is incomplete or invalid.</p>`
    : referralCode
    ? `<form class="referral-apply" data-referral-attribute><input type="hidden" name="code" value="${escapeHtml(referralCode)}"><p>An invitation code is ready. Apply it to this signed-in account before its first paid subscription payment.</p><button class="button" type="submit">Apply referral code</button><p class="referral-state" data-referral-feedback role="status" aria-live="polite"></p><a class="text-link" data-referral-login href="/login?next=${encodeURIComponent(`/pricing?ref=${encodeURIComponent(referralCode)}#refer-and-earn`)}" hidden>Sign in again</a></form>`
      : `<p class="referral-note">A referral is recorded only after the invited person signs in and applies this code. Opening the link does not qualify a referral.</p>`;
  return `${sectionOpen}${title}<p>Earn account credit for inviting eligible Classroom Desk users. The existing server-side referral and billing rules apply.</p>${steps}</div><div class="referral-panel"><p class="referral-state">Your personal referral link</p><label class="referral-link-label" for="personal-referral-link">Share this link</label><div class="referral-link-row"><input id="personal-referral-link" type="url" readonly value="${escapeHtml(shareUrl)}"><button class="button secondary" type="button" data-copy-referral="${escapeHtml(shareUrl)}"><span data-copy-label>Copy link</span></button></div><dl class="referral-stats"><div><dt>Attributed accounts</dt><dd>${summary.total}</dd></div><div><dt>Awaiting payment</dt><dd>${summary.pending}</dd></div><div><dt>Qualifying payments</dt><dd>${summary.qualified}</dd></div><div><dt>Rewards recorded</dt><dd>${summary.rewards}</dd></div></dl><p>${remaining} more qualifying payment${remaining === 1 ? "" : "s"} toward the next 30-day Student access credit. Verified rewards are applied automatically; no redemption request is needed.</p><h3>Reward status</h3>${history}${invitation}</div></section>`;
}

function formatReferralDate(value: Date): string {
  return Number.isNaN(value.getTime()) ? "Date unavailable" : value.toLocaleDateString("en-IN", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
}
function connectBody() {
  return `<article class="guide-page"><p class="eyebrow">Connection guide</p><h1>Connect Classroom Desk to ChatGPT.</h1><p class="page-lead">Follow these three steps. ChatGPT controls its own connection settings, and Google will show you the permissions before you approve them.</p>${connectGuideMarkup(true)}<details class="troubleshooting"><summary>Troubleshooting</summary><ul><li>If you do not see a custom connection option, your plan or workspace may not offer it.</li><li>If Google authorization fails, restart from ChatGPT and use the intended Google account.</li><li>If tools return an authorization error, reconnect Google Classroom. Website sign-in and Classroom authorization are separate.</li><li>For help, contact support without sending passwords, OAuth codes or private Classroom content.</li></ul></details><p class="test-prompt">Test it: ask “What assignments do I have?”</p></article>`;
}

function connectGuideMarkup(inline = false) {
  return `<div class="connect-guide ${inline ? "inline-guide" : ""}" data-connect-guide><div class="guide-steps"><p class="step-kicker">Step <span data-guide-number>1</span> of 3</p><section data-guide-step><h2>Open ChatGPT</h2><p>Go to ChatGPT's apps or developer settings.</p><a class="button" href="https://chatgpt.com/plugins" target="_blank" rel="noopener noreferrer">Open ChatGPT</a><p class="help-text">ChatGPT may ask you to turn on Developer mode first. If you do not see the option, your plan or workspace may not allow custom connections. Ask your workspace admin.</p></section><section data-guide-step hidden><h2>Add Classroom Desk</h2><p>Create a new connection, name it Classroom Desk, and paste this address. If ChatGPT asks how to sign in, choose OAuth.</p><div class="copy-chip"><code>https://classroom.jarvis404.com/mcp</code><button type="button" data-copy-mcp="https://classroom.jarvis404.com/mcp">Copy</button></div><p class="help-text">Button names vary between ChatGPT versions. ChatGPT may call this the server URL.</p></section><section data-guide-step hidden><h2>Approve Google and ask</h2><p>ChatGPT will send you to Google. Review the permissions, approve them, then try:</p><div class="copy-chip"><code>What assignments do I have?</code><button type="button" data-copy-prompt="What assignments do I have?">Copy</button></div><p class="help-text">This guide cannot detect or complete the connection for you.</p></section></div><div class="guide-visual" aria-hidden="true"><span class="example-badge">Illustration</span><div class="guide-visual-board"><span></span><span></span><span></span><span></span></div></div><div class="guide-controls"><button class="button secondary" type="button" data-guide-back hidden>Back</button><button class="button" type="button" data-guide-next>Next</button><a class="text-link" href="/support">Need help?</a></div></div>`;
}

function connectGuideModal() {
  return `<dialog class="connect-modal" data-connect-modal aria-labelledby="connect-modal-title"><div class="modal-shell"><div class="modal-header"><div><p class="eyebrow">Connection guide</p><h2 id="connect-modal-title">Connect Classroom Desk to ChatGPT</h2></div><button class="close-button" type="button" data-connect-close aria-label="Close connection guide">×</button></div><p class="modal-progress">Step <span data-guide-number>1</span> of 3</p>${connectGuideMarkup()}<div class="modal-footer"><button class="button secondary" type="button" data-guide-back hidden>Back</button><button class="button" type="button" data-guide-next>Next</button><a class="text-link" href="/support">Need help?</a></div></div></dialog>`;
}

function connectScript() {
  return `(() => {
    const card = document.querySelector("[data-connection-card]");
    const copy = document.querySelector(".home-copy");
    const section = card?.closest("#how-it-works");
    if (card && copy && section) {
      const heading = document.createElement("p");
      heading.className = "hero-connection-title";
      heading.textContent = "Connect in 3 steps.";
      card.querySelector(".connection-card-head span")?.replaceChildren(document.createTextNode("Connect in 3 steps"));
      card.classList.add("hero-connection-card");
      card.prepend(heading);
      copy.querySelector(".home-note")?.remove();
      copy.append(card);
      section.remove();
      const style = document.createElement("style");
      style.textContent = ".hero-connection-title{margin:0 0 10px;color:#0b6247;font-size:12px;font-weight:800;letter-spacing:.08em;text-transform:uppercase}.hero-connection-card{max-width:560px;min-height:0;margin:24px 0 0;padding:20px;border-radius:18px}.hero-connection-card[data-connection-card] section{min-height:132px}.hero-connection-card[data-connection-card] h3{font-size:clamp(22px,2.5vw,30px);margin:14px 0 6px}.hero-connection-card[data-connection-card] p{font-size:15px}.hero-connection-card .connection-card-track{margin:16px 0 20px}.hero-connection-card .connection-card-actions{margin-top:16px}.hero-connection-card .connection-card-actions .text-link{margin-left:auto}@media(max-width:1023px){.hero-connection-card{max-width:680px}}@media(max-width:767px){.hero-connection-card{margin-top:20px;padding:17px}.hero-connection-card[data-connection-card] section{min-height:142px}.hero-connection-card .connection-url{align-items:stretch;flex-direction:column}.hero-connection-card .connection-card-actions{gap:10px;flex-wrap:wrap}.hero-connection-card .connection-card-actions .text-link{width:100%;margin-left:0}}@media(prefers-reduced-motion:reduce){.hero-connection-card{backdrop-filter:none;-webkit-backdrop-filter:none}}";
      document.head.append(style);
    }
    const bindCopy = (button, value) => {
      const feedback = button.querySelector("span") || (button.hasAttribute("data-prompt-tab") ? null : button);
      const label = feedback?.textContent ?? "Copy";
      let timer;
      let attempt = 0;
      feedback?.setAttribute("aria-live", "polite");
      feedback?.setAttribute("aria-atomic", "true");
      button.addEventListener("click", async () => {
        const currentAttempt = ++attempt;
        clearTimeout(timer);
        if (feedback) feedback.textContent = label;
        let copied = false;
        try {
          await navigator.clipboard.writeText(value());
          copied = true;
        } catch {
          if (currentAttempt !== attempt) return;
          let area;
          try {
            area = document.createElement("textarea");
            area.value = value();
            area.setAttribute("readonly", "");
            document.body.append(area);
            area.select();
            copied = document.execCommand("copy") === true;
          } catch {
            copied = false;
          } finally {
            area?.remove();
          }
        }
        if (currentAttempt !== attempt || !feedback) return;
        feedback.textContent = copied ? "Copied" : "Copy failed";
        timer = setTimeout(() => { feedback.textContent = label; }, 2000);
      });
    };
    document.querySelectorAll("[data-copy-mcp]").forEach(b => bindCopy(b, () => b.dataset.copyMcp || ""));
    document.querySelectorAll("[data-copy-prompt]").forEach(b => bindCopy(b, () => b.dataset.copyPrompt || ""));
    const guides = [...document.querySelectorAll("[data-connect-guide]")]; const setGuide = (root, index) => { const steps = [...root.querySelectorAll("[data-guide-step]")]; const number = root.querySelector("[data-guide-number]"); const back = root.querySelector("[data-guide-back]"); const next = root.querySelector("[data-guide-next]"); steps.forEach((s, i) => { s.hidden = i !== index; }); if (number) number.textContent = String(index + 1); if (back) back.hidden = index === 0; if (next) next.textContent = index === steps.length - 1 ? "Done" : "Next"; root.dataset.step = String(index); }; guides.forEach(root => { let index = 0; const next = root.querySelector("[data-guide-next]"); const back = root.querySelector("[data-guide-back]"); next?.addEventListener("click", () => { if (index < 2) { index += 1; setGuide(root, index); } }); back?.addEventListener("click", () => { index = Math.max(0, index - 1); setGuide(root, index); }); setGuide(root, 0); }); const modal = document.querySelector("[data-connect-modal]"); let lastTrigger = null; const open = trigger => { lastTrigger = trigger; modal?.showModal(); document.body.classList.add("modal-open"); modal?.querySelector("button")?.focus(); }; document.querySelectorAll("[data-connect-open]").forEach(b => b.addEventListener("click", () => open(b))); modal?.querySelector("[data-connect-close]")?.addEventListener("click", () => modal.close()); modal?.addEventListener("click", e => { if (e.target === modal) modal.close(); }); modal?.addEventListener("close", () => { document.body.classList.remove("modal-open"); lastTrigger?.focus(); }); const menu = document.querySelector(".menu-toggle"); const mobile = document.querySelector("#mobile-menu"); menu?.addEventListener("click", () => { const open = menu.getAttribute("aria-expanded") === "true"; menu.setAttribute("aria-expanded", String(!open)); mobile.hidden = open; }); const tabs = [...document.querySelectorAll("[data-prompt-tab]")]; const answers = ["What assignments do I have?", "What deadlines are coming up?", "Show my recent Classroom activity.", "Show announcements from my courses.", "Find missing or returned work.", "Explain the instructions for my assignment."]; const replies = ["You have three current items: a Physics lab report, History reading notes, and a returned Biology assignment. Check each Classroom item for its latest details.", "Your next example deadline is a Physics lab report tomorrow, followed by History reading notes on Friday.", "Your recent example activity includes one returned assignment and two course updates.", "Your courses have example announcements about a reading reminder and a lab session.", "Example results show one returned item and one missing item. Open Classroom for the source details.", "I can explain instructions returned from Classroom. For an attachment, authorize that exact file first."]; const q = document.querySelector("[data-example-question]"); const a = document.querySelector("[data-example-answer]"); tabs.forEach((tab, i) => { tab.addEventListener("click", () => { tabs.forEach(t => t.setAttribute("aria-selected", "false")); tab.setAttribute("aria-selected", "true"); if(q) q.textContent = answers[i]; if(a) a.textContent = replies[i]; }); tab.addEventListener("keydown", e => { if (!["ArrowDown","ArrowRight","ArrowUp","ArrowLeft","Home","End"].includes(e.key)) return; e.preventDefault(); let j = e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : (i + (e.key.includes("Down") || e.key.includes("Right") ? 1 : -1) + tabs.length) % tabs.length; tabs[j].focus(); tabs[j].click(); }); }); })();`;
}

function pricingReferralScript() {
  return `(() => {
    const writeClipboard = async text => {
      try { await navigator.clipboard.writeText(text); return true; }
      catch {
        let area;
        try { area = document.createElement("textarea"); area.value = text; area.readOnly = true; document.body.append(area); area.select(); return document.execCommand("copy"); }
        catch { return false; }
        finally { area?.remove(); }
      }
    };
    document.querySelectorAll("[data-copy-referral]").forEach(button => {
      const label = button.querySelector("[data-copy-label]");
      const initial = label?.textContent || "Copy link";
      button.addEventListener("click", async () => {
        const copied = await writeClipboard(button.dataset.copyReferral || "");
        if (!label) return;
        label.textContent = copied ? "Copied" : "Copy failed";
        window.setTimeout(() => { label.textContent = initial; }, 1800);
      });
    });
    const messages = {
      invalid_referral: "This referral code is invalid or cannot be applied to this account.",
      referral_requires_new_customer: "This account is not eligible because it already has a subscription payment.",
      referral_already_attributed: "A referral has already been recorded for this account.",
      referrals_not_enabled: "Referral rewards are paused in this environment."
    };
    document.querySelectorAll("form[data-referral-attribute]").forEach(form => {
      form.addEventListener("submit", async event => {
        event.preventDefault();
        const button = form.querySelector("button[type=submit]");
        const feedback = form.querySelector("[data-referral-feedback]");
        const login = form.querySelector("[data-referral-login]");
        const code = form.querySelector('input[name="code"]')?.value || "";
        if (!button || !feedback || !code) return;
        button.disabled = true;
        feedback.textContent = "Saving referral…";
        try {
          const response = await fetch("/api/referrals/attribute", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "Accept": "application/json" }, body: JSON.stringify({ code }) });
          const result = await response.json().catch(() => ({}));
          if (response.ok) {
            feedback.textContent = "Referral saved. Rewards require a verified first monthly subscription payment.";
            form.dataset.referralApplied = "true";
            return;
          }
          const error = typeof result.error === "string" ? result.error : "";
          feedback.textContent = response.status === 401 ? "Your sign-in has expired. Sign in again to apply this code." : messages[error] || "We could not apply this referral code. Please try again.";
          if (response.status === 401 && login) login.hidden = false;
        } catch {
          feedback.textContent = "We could not reach Classroom Desk. Check your connection and try again.";
        } finally {
          if (form.dataset.referralApplied !== "true") button.disabled = false;
        }
      });
    });
  })();`;
}

function connectModalBridgeScript() {
  return `document.querySelectorAll(".connect-modal").forEach(modal => { const root = modal.querySelector("[data-connect-guide]"); const next = modal.querySelector(".modal-footer [data-guide-next]"); const back = modal.querySelector(".modal-footer [data-guide-back]"); const progress = modal.querySelector(".modal-progress [data-guide-number]"); const sync = () => { const number = root?.querySelector(".step-kicker [data-guide-number]"); if (progress && number) progress.textContent = number.textContent || "1"; }; next?.addEventListener("click", () => { root?.querySelector("[data-guide-next]")?.click(); sync(); }); back?.addEventListener("click", () => { root?.querySelector("[data-guide-back]")?.click(); sync(); }); }); const menu = document.querySelector(".menu-toggle"); const mobile = document.querySelector("#mobile-menu"); menu?.addEventListener("keydown", event => { if (event.key === "Escape" && menu.getAttribute("aria-expanded") === "true") { menu.click(); menu.focus(); } }); mobile?.querySelectorAll("a").forEach(link => link.addEventListener("click", () => { if (menu?.getAttribute("aria-expanded") === "true") menu.click(); }));`;
}

function connectModalMarkupScript() {
  return `document.querySelectorAll(".connect-modal .step-kicker").forEach(label => label.remove());`;
}

function connectModalCleanupScript() {
  return `document.querySelectorAll(".connect-modal").forEach(modal => { const clear = () => document.body.classList.remove("modal-open"); modal.addEventListener("close", clear); modal.addEventListener("cancel", clear); modal.querySelector("[data-connect-close]")?.addEventListener("click", clear); });`;
}

function homeMotionScript() {
  return `(() => { const stage = document.querySelector("[data-home-stage]"); if (!stage) return; const reduced = window.matchMedia("(prefers-reduced-motion: reduce)"); const wide = window.matchMedia("(min-width: 768px)"); const loadStageMotion = () => { if (reduced.matches || !wide.matches) return; const video = stage.querySelector(".stage-motion--wide"); if (!video || video.getAttribute("src")) return; const source = video.getAttribute("data-stage-src"); if (!source) return; video.setAttribute("src", source); video.load(); const playback = video.play(); if (playback && typeof playback.catch === "function") playback.catch(() => undefined); }; if (!reduced.matches) requestAnimationFrame(() => stage.classList.add("is-ready")); loadStageMotion(); wide.addEventListener?.("change", loadStageMotion); reduced.addEventListener?.("change", () => { if (reduced.matches) stage.classList.add("motion-reduced"); }); })();`;
}

function connectionCardScript() {
  return String.raw`(() => { const card = document.querySelector("[data-connection-card]"); if (!card) return; const steps = [...card.querySelectorAll("[data-connection-step]")]; const status = card.querySelector("[data-connection-progress]"); const segments = [...card.querySelectorAll(".connection-card-track i")]; const icons = ["<svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path d=\"M6 18h12a3 3 0 0 0 .4-6A6 6 0 0 0 7 10.5 3.5 3.5 0 0 0 6 18Z\"/><path d=\"M9 14h6M12 11v6\"/></svg>", "<svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path d=\"M8 7h8v10H8z\"/><path d=\"M5 10V5h5M19 14v5h-5M10 5l-2 2 2 2M14 19l2-2-2-2\"/></svg>", "<svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><circle cx=\"12\" cy=\"12\" r=\"8\"/><path d=\"m8.5 12 2.3 2.3 4.8-5\"/></svg>"]; const reduced = window.matchMedia("(prefers-reduced-motion: reduce)"); let index = 0; steps.forEach((step, i) => { const icon = step.querySelector(".connection-card-icon"); if (icon) { icon.innerHTML = icons[i]; icon.setAttribute("role", "img"); icon.setAttribute("aria-label", ["ChatGPT connection", "MCP server connection", "Google authorization verified connection"][i]); } }); const render = () => { steps.forEach((step, i) => { step.hidden = i !== index; step.setAttribute("aria-hidden", String(i !== index)); }); if (status) status.textContent = String(index + 1).padStart(2, "0") + " / 03"; segments.forEach((segment, i) => segment.classList.toggle("is-active", i <= index)); card.querySelector("[data-connection-back]")?.toggleAttribute("disabled", index === 0); card.querySelector("[data-connection-next]")?.toggleAttribute("disabled", index === steps.length - 1); }; const advance = delta => { index = Math.max(0, Math.min(steps.length - 1, index + delta)); render(); }; card.querySelector("[data-connection-back]")?.addEventListener("click", () => advance(-1)); card.querySelector("[data-connection-next]")?.addEventListener("click", () => advance(1)); card.addEventListener("keydown", event => { if (event.key === "ArrowRight" || event.key === "ArrowDown") { event.preventDefault(); advance(1); } if (event.key === "ArrowLeft" || event.key === "ArrowUp") { event.preventDefault(); advance(-1); } }); let startX = 0; let startY = 0; card.addEventListener("touchstart", event => { const touch = event.changedTouches[0]; startX = touch.clientX; startY = touch.clientY; }, { passive: true }); card.addEventListener("touchend", event => { const touch = event.changedTouches[0]; const dx = touch.clientX - startX; const dy = touch.clientY - startY; if (Math.abs(dx) > 44 && Math.abs(dx) > Math.abs(dy)) advance(dx < 0 ? 1 : -1); }, { passive: true }); card.addEventListener("wheel", event => { if (Math.abs(event.deltaY) < 12) return; advance(event.deltaY > 0 ? 1 : -1); }, { passive: true }); card.querySelector("[data-copy-mcp-card]")?.addEventListener("click", async event => { const button = event.currentTarget; try { await navigator.clipboard.writeText("https://classroom.jarvis404.com/mcp"); button.textContent = "Copied"; window.setTimeout(() => button.textContent = "Copy URL", 1400); } catch { button.textContent = "Select URL"; } }); if (document.body.classList.contains("home-page")) { document.querySelectorAll("[data-connect-open]").forEach(button => { const link = document.createElement("a"); link.className = button.className; link.href = "/connect"; link.textContent = button.textContent; button.replaceWith(link); }); document.querySelector(".home-note")?.remove(); const disclosure = document.querySelector(".home-example-panel small"); if (disclosure) disclosure.textContent = "Example conversation"; document.querySelector(".home-example-panel .demo-status")?.remove(); } render(); })();`;
}

function connectDemoScript() {
  return `(() => { const panel = document.querySelector("[data-example-answer]")?.closest(".example-panel"); const answer = document.querySelector("[data-example-answer]"); if (!panel || !answer) return; const reduced = window.matchMedia("(prefers-reduced-motion: reduce)"); const replies = ["You have three current items: a Physics lab report, History reading notes, and a returned Biology assignment. Check each Classroom item for its latest details.", "Your next example deadline is a Physics lab report tomorrow, followed by History reading notes on Friday.", "Example results show one returned item and one missing item. Open Classroom for the source details.", "Your courses have example announcements about a reading reminder and a lab session.", "Your recent example activity includes one returned assignment and two course updates.", "I can explain instructions returned from Classroom. For an attachment, authorize that exact file first."]; const replay = document.createElement("button"); replay.type = "button"; replay.className = "button secondary demo-replay"; replay.textContent = "Replay example"; replay.setAttribute("data-demo-replay", ""); const status = document.createElement("small"); status.className = "demo-status"; status.setAttribute("aria-live", "polite"); status.textContent = "Example conversation"; const actions = document.createElement("div"); actions.className = "example-actions"; actions.append(replay, status); panel.append(actions); let timer; const play = index => { window.clearInterval(timer); const text = replies[index] || replies[0]; answer.textContent = ""; if (reduced.matches) { answer.textContent = "“" + text + "”"; status.textContent = "Example conversation"; return; } status.textContent = "Example conversation loading…"; let i = 0; timer = window.setInterval(() => { answer.textContent = "“" + text.slice(0, ++i) + (i < text.length ? "▌" : "”"); if (i >= text.length) { window.clearInterval(timer); status.textContent = "Example conversation"; } }, 12); }; document.querySelectorAll("[data-prompt-tab]").forEach((tab, index) => tab.addEventListener("click", () => window.setTimeout(() => play(index), 0))); replay.addEventListener("click", () => { const active = [...document.querySelectorAll("[data-prompt-tab]")].findIndex(tab => tab.getAttribute("aria-selected") === "true"); play(active < 0 ? 0 : active); }); })();`;
}

function connectAccountGuidanceScript() {
  return `if (location.pathname === "/connect") { const lead = document.querySelector(".guide-page .page-lead"); if (lead) lead.textContent = "Connect the Google account you actually use for Google Classroom. If you use more than one Google account, choose the one containing your courses when Google shows the account chooser. Website sign-in, Google Classroom authorization, and the ChatGPT connection are separate steps."; }`;
}

function connectDemoStyleScript() {
  return `document.querySelectorAll("[data-demo-replay]").forEach(button => { button.style.cssText = "min-height:44px;background:#0e7c5a!important;color:#fff!important;border:1px solid #55c49a;padding:.75rem 1rem;opacity:1"; });`;
}

function connectModalStateScript() {
  return `document.querySelectorAll(".connect-modal").forEach(modal => { const root = modal.querySelector("[data-connect-guide]"); const footer = modal.querySelector(".modal-footer"); const sync = () => { const innerBack = root?.querySelector("[data-guide-back]"); const innerNext = root?.querySelector("[data-guide-next]"); const outerBack = footer?.querySelector("[data-guide-back]"); const outerNext = footer?.querySelector("[data-guide-next]"); if (outerBack && innerBack) outerBack.hidden = innerBack.hidden; if (outerNext && innerNext) outerNext.textContent = innerNext.textContent || "Next"; }; footer?.addEventListener("click", () => queueMicrotask(sync)); sync(); });`;
}

function connectGuideBackStateScript() {
  return `document.querySelectorAll("[data-connect-guide]").forEach(root => { const back = root.querySelector("[data-guide-back]"); if (!back) return; const apply = () => { const first = root.dataset.step === "0"; back.hidden = false; back.disabled = first; back.setAttribute("aria-disabled", String(first)); }; apply(); new MutationObserver(apply).observe(root, { attributes: true, attributeFilter: ["data-step"] }); });`;
}

function connectModalBackDisabledScript() {
  return `document.querySelectorAll(".connect-modal").forEach(modal => { const root = modal.querySelector("[data-connect-guide]"); const outer = modal.querySelector(".modal-footer [data-guide-back]"); const sync = () => { const inner = root?.querySelector("[data-guide-back]"); if (outer && inner) { outer.hidden = false; outer.disabled = inner.disabled; outer.setAttribute("aria-disabled", inner.getAttribute("aria-disabled") || "false"); } }; sync(); if (root) new MutationObserver(sync).observe(root, { attributes: true, attributeFilter: ["data-step"] }); });`;
}

function connectModalProgressScript() {
  return `document.querySelectorAll(".connect-modal").forEach(modal => { const root = modal.querySelector("[data-connect-guide]"); const progress = modal.querySelector(".modal-progress [data-guide-number]"); const sync = () => { if (progress) progress.textContent = String(Number(root?.getAttribute("data-step") || "0") + 1); }; sync(); if (root) new MutationObserver(sync).observe(root, { attributes: true, attributeFilter: ["data-step"] }); });`;
}

function page(title: string, active: string, operator: string, support: string, origin: URL, body: string, compact = false) {
  const nav = (href: string, key: string, label: string) => `<a ${active === key ? 'aria-current="page"' : ""} href="${href}">${label}</a>`;
  const projectSupportLink = active === "connect" ? "" : '<a href="/support#project-support">Support the Project</a>';
  const documentTitle = title === "Classroom Desk" ? "Classroom Desk | Google Classroom Meets ChatGPT" : `${title} | Classroom Desk`;
  const descriptions: Record<string,string> = { home:"Ask ChatGPT about your authorized Google Classroom courses, assignments, announcements, and deadlines.", pricing:"Review Classroom Desk plan details, current availability, and Google authorization requirements.", connect:"Set up Classroom Desk in ChatGPT, choose the Google account you use for Classroom, and review permissions.", refunds:"Information about existing Classroom Desk payments, subscriptions, cancellations, and refund requests.", privacy:"Learn what Classroom information Classroom Desk accesses, stores, and shares with your connected app.", terms:"Read the Classroom Desk service terms, authorized-use requirements, and source-code license.", support:"Get help connecting Classroom Desk, managing your account, or with a payment question." };
  const description = descriptions[active] ?? descriptions.home!;
  const canonicalUrl = new URL(active === "home" ? "/" : `/${active}`, origin).toString();
  const imageUrl = new URL("/assets/classroom-desk-social-card.png?v=20261012-layout2", origin).toString();
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${documentTitle}</title>
<meta name="description" content="${escapeHtml(description)}">
<link rel="canonical" href="${escapeHtml(canonicalUrl)}">
<meta property="og:title" content="${escapeHtml(documentTitle)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:type" content="website">
<meta property="og:url" content="${escapeHtml(canonicalUrl)}">
<meta property="og:image" content="${escapeHtml(imageUrl)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="Classroom Desk — Google Classroom Meets ChatGPT">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escapeHtml(documentTitle)}">
<meta name="twitter:description" content="${escapeHtml(description)}">
<meta name="twitter:image" content="${escapeHtml(imageUrl)}">
${title === "Classroom Desk" ? '<link rel="preload" as="image" href="https://d2ol7oe51mr4n9.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/5c3ec08f-2dbf-4c0a-8588-f6106a789443.webp" media="(min-width:768px)" fetchpriority="high"><link rel="preload" as="image" href="https://d2ol7oe51mr4n9.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/0f4926a4-e660-4df2-9195-2bfb3e341bdd.webp" media="(max-width:767px)" fetchpriority="high">' : ""}
<link rel="icon" type="image/svg+xml" href="/assets/classroom-desk-favicon.svg">
<link rel="apple-touch-icon" href="/assets/classroom-desk-app-icon.png">
<style>${siteStyles()}${designStyles()}${pricingReferralStyles()}.numbered-steps b{color:#176b4b!important}.site-header .brand,.desktop-nav a,.header-actions a{min-height:44px;display:inline-flex;align-items:center}.header-cta{min-height:44px!important}.modal-header .eyebrow{color:#b8f3d5}.close-button{min-width:44px;min-height:44px;flex-shrink:0}.copy-chip button{min-width:44px;min-height:44px}@media(max-width:767px) and (max-height:900px){.modal-shell .guide-visual{display:none}}${active === "support" ? ".support-amounts article{min-height:0}.support-custom-amount{display:grid;gap:.5rem;max-width:420px;margin:1rem 0}.support-custom-amount label{font-weight:750;color:var(--deep)}.support-custom-amount input{min-width:0;width:100%;border:1px solid var(--line);border-radius:8px;padding:.8rem;font:inherit;color:var(--deep);background:var(--soft)}.support-custom-amount input:disabled{opacity:.65;cursor:not-allowed}" : ""}</style>
</head>
<body class="${compact ? "compact" : ""}${title === "Classroom Desk" ? " home-page" : ""}">
<a class="skip-link" href="#main-content">Skip to content</a>
<header class="site-header">
  <a class="brand" href="/" aria-label="Classroom Desk home">${logoMark()}<span>Classroom Desk</span></a>
  <nav class="desktop-nav" aria-label="Primary">${nav("/#features", "features", "Features")}${nav("/#how-it-works", "how", "How it works")}${nav("/pricing", "pricing", "Pricing")}${nav("/support", "support", '<span class="support-heart" aria-hidden="true">♥</span> Support')}</nav>
  <div class="header-actions"><a class="nav-signin" href="/login">Sign in</a><button class="button header-cta" type="button" data-connect-open>Connect to ChatGPT</button><button class="menu-toggle" type="button" aria-expanded="false" aria-controls="mobile-menu">Menu</button></div>
</header>
<nav id="mobile-menu" class="mobile-menu" aria-label="Mobile navigation" hidden>${nav("/#features", "features", "Features")}${nav("/#how-it-works", "how", "How it works")}${nav("/pricing", "pricing", "Pricing")}${nav("/support", "support", '<span class="support-heart" aria-hidden="true">♥</span> Support')}<a href="/login">Sign in</a><button class="button" type="button" data-connect-open>Connect to ChatGPT</button></nav>
<main id="main-content">${active === "home" ? body.replace("Illustrative product experience. Connect your account for live Classroom answers.", "").replace("Illustrative response. It is not live account data.", "Example conversation") : body}</main>
<footer class="site-footer">
  <div class="footer-grid"><div><a class="brand footer-brand" href="/">${logoMark()}<span>Classroom Desk</span></a><p>Ask ChatGPT about your own authorized Google Classroom.</p></div><div><h2>Product</h2><a href="/#features">Features</a><a href="/#how-it-works">How it works</a><a href="/pricing">Pricing</a><a href="/connect">Connect</a></div><div><h2>Legal</h2><a href="/privacy">Privacy</a><a href="/terms">Terms</a><a href="/refunds">Refunds and cancellation</a><a href="/support">Support</a>${projectSupportLink}</div><div><h2>Contact</h2><a href="mailto:${support}">${support}</a><p class="developer-credit">Built by <a href="https://fawzankhan-404.github.io/" target="_blank" rel="noopener noreferrer">${operator}</a>, an independent developer</p></div></div>
  <p class="disclaimer">Classroom Desk is an independent integration and is not affiliated with or endorsed by Google or OpenAI. Google Classroom, ChatGPT, and OpenAI are trademarks of their respective owners.</p>
</footer>
${active === "home" ? "" : connectGuideModal()}
 <script src="/assets/connect.js?v=20261025-hero3" defer></script>
</body>
</html>`;
}

function logoMark() {
  return `<span class="logo" aria-hidden="true"><img src="/assets/classroom-desk-logo.png" width="32" height="32" alt=""></span>`;
}

function designStyles() {
  return `
.connection-card-icon svg{width:24px;height:24px;display:block;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}.connection-card-track i{transition:background-color 180ms ease}.connection-card-track i.is-active{background:var(--emerald-500)!important}

:root{--paper:#f7f9f6;--ink:#17231d;--muted:#4d6055;--line:#cbd8cf;--soft:#e8f1eb;--deep:#15543b;--green:#166c48}
body{font-family:"Segoe UI",Arial,sans-serif;letter-spacing:-.012em}
.connection-card[data-connection-card]{max-width:680px;min-height:360px;margin:28px 0 0;padding:28px;border:1px solid rgb(255 255 255 / .72);border-radius:24px;background:linear-gradient(145deg,rgb(255 255 255 / .86),rgb(232 247 239 / .72));box-shadow:0 24px 54px rgb(34 56 45 / .14),inset 0 1px 0 #fff;backdrop-filter:blur(16px);display:block;outline:none}.connection-card[data-connection-card]:focus-visible{outline:3px solid var(--emerald-500);outline-offset:4px}.connection-card-head,.connection-card-actions{display:flex;align-items:center;gap:14px}.connection-card-head{justify-content:space-between;color:var(--emerald-900);font-size:13px;font-weight:700}.connection-card-head strong{color:var(--emerald-700);letter-spacing:.08em}.connection-card-track{display:flex;gap:8px;margin:26px 0 34px}.connection-card-track i{height:4px;flex:1;border-radius:99px;background:var(--emerald-100)}.connection-card-track i:first-child{background:var(--emerald-500)}.connection-card[data-connection-card] section{min-height:170px}.connection-card-icon{display:grid;place-items:center;width:44px;height:44px;border-radius:12px;background:var(--emerald-700);color:#fff;font-weight:800}.connection-card[data-connection-card] h3{margin:18px 0 8px;font-size:clamp(26px,3vw,38px);letter-spacing:-.05em}.connection-card[data-connection-card] p{max-width:520px;color:var(--ink-2);font-size:17px}.connection-url{display:flex;align-items:center;gap:10px;margin-top:20px;padding:10px 12px;border:1px solid var(--line);border-radius:12px;background:rgb(255 255 255 / .66)}.connection-url code{flex:1;overflow-wrap:anywhere;color:var(--emerald-900);font-size:13px}.connection-card-actions{margin-top:26px}.connection-card-actions .text-link{margin-left:auto}.connection-card-actions button:disabled{opacity:.45;cursor:not-allowed}
.home-note{display:none}
.site-header{max-width:1200px;padding:1.15rem 1.6rem;border-bottom:1px solid var(--line)}
.brand{font-size:1.02rem;letter-spacing:-.03em}.logo{width:44px;height:44px;object-fit:cover;border-radius:11px;border:1px solid var(--line);background:white}
.site-header nav a{border-radius:5px}.site-header nav a[aria-current=page],.site-header nav a:hover{background:transparent;box-shadow:inset 0 -2px var(--green)}.support-heart{color:var(--green);font-size:1.1em;line-height:1;margin-right:.3rem}
main{max-width:1200px;padding:0 1.6rem 4.5rem}.hero{grid-template-columns:minmax(0,1.2fr) minmax(290px,.8fr);gap:clamp(2rem,6vw,6rem);padding:clamp(3rem,8vw,7rem) 0 3rem;align-items:center}
.hero h1{font-size:clamp(3.3rem,7.6vw,7.2rem);line-height:.92;letter-spacing:-.072em;max-width:750px;margin:1.6rem 0 1.4rem;font-weight:780}
.hero-copy>p:not(.lede):not(.trust-line){font-size:1.1rem;line-height:1.65;max-width:580px}.lede{font-size:clamp(1.4rem,2.8vw,2.15rem);letter-spacing:-.035em;font-weight:580}
.mark-row{gap:1rem;font-size:.84rem;font-weight:650;letter-spacing:0}.mark-rule{height:1px;width:28px;background:var(--green)}
 .hero-visual{position:relative;align-self:stretch;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:1.25rem}.hero-logo{display:block;width:min(100%,430px);aspect-ratio:1}.hero-logo svg{display:block;width:100%;height:auto;border-radius:27%;box-shadow:0 24px 80px rgba(11,58,37,.12)}.hero-visual img{display:block;width:min(100%,430px);height:auto;border-radius:27%;box-shadow:0 24px 80px rgba(11,58,37,.12)}.hero-visual p{font-size:.9rem;color:var(--muted);text-align:center;margin:0}
.button{border-radius:7px;font-weight:700;letter-spacing:-.01em;padding:.86rem 1.25rem}.button.secondary{background:transparent}.trust-line{font-size:.9rem!important;margin-top:1.4rem;color:var(--deep)}
.ledger{display:grid;grid-template-columns:190px 1fr;gap:1.6rem;padding:1.6rem 0;border:0;border-top:2px solid var(--ink);border-bottom:1px solid var(--line);border-radius:0;box-shadow:none;background:transparent}.ledger h2{font-size:1rem;margin:0}.ledger dl{display:grid;grid-template-columns:repeat(3,1fr);gap:1.4rem}.ledger dl div{padding:0;border:0}.ledger dt{font-size:.95rem}.ledger dd{font-size:.9rem;line-height:1.5}
.section{padding:4.5rem 0}.section h2{font-size:clamp(2rem,4.3vw,3.6rem);letter-spacing:-.055em}.section-heading{align-items:start}.section-heading p{max-width:200px;margin-top:.3rem}.steps{grid-template-columns:repeat(4,1fr);gap:0;border-top:1px solid var(--line)}.step{border:0;border-radius:0;background:transparent;border-right:1px solid var(--line);padding:1.5rem 1.2rem 1rem 0}.step:not(:first-child){padding-left:1.2rem}.step:last-child{border-right:0}.step-num{background:transparent;border:1px solid var(--green);color:var(--deep)}.setup-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:1rem;margin:1.5rem 0}.setup-grid article,.price-strip article{background:var(--white);border:1px solid var(--line);border-radius:16px;padding:1.25rem}.setup-number{display:grid;place-items:center;width:2.25rem;height:2.25rem;border:1px solid var(--green);border-radius:50%;color:var(--deep);font-weight:800}.setup-grid h3{margin:1rem 0 .35rem}.setup-grid p,.price-strip p{color:var(--muted);margin:.2rem 0}.setup-grid code{font-size:.88em;color:var(--deep);overflow-wrap:anywhere}.price-strip{display:grid;grid-template-columns:repeat(3,1fr);gap:1rem;margin:1.5rem 0}.price-strip article{display:flex;flex-direction:column;min-height:160px}.price-strip article.featured{border-color:var(--green);box-shadow:0 14px 35px rgba(23,66,54,.1)}.price-strip strong{font-size:clamp(2rem,4vw,3rem);line-height:1;margin:.8rem 0 .35rem;color:var(--deep)}.price-strip strong span{font-size:1rem;font-weight:650;color:var(--muted)}.faq-list{max-width:850px;border-top:1px solid var(--line)}.faq-list details{border-bottom:1px solid var(--line);padding:1rem 0}.faq-list summary{cursor:pointer;font-weight:760;color:var(--deep);padding-right:2rem}.faq-list p{max-width:720px;margin:.7rem 0 0}
.prompt-grid{display:block;columns:2;column-gap:3rem}.prompt-grid li{display:list-item;break-inside:avoid;background:transparent;color:var(--ink);border-radius:0;min-height:auto;border-bottom:1px solid var(--line);padding:1rem 0;font-weight:650;font-size:1.08rem}.prompt-grid li::marker{color:var(--green)}
.panel{box-shadow:none;border-radius:4px}.panel.ok{border-top:3px solid var(--green)}.panel.no{border-top:3px solid #a66730}.callout{background:var(--deep);color:white;border:0;border-radius:4px;padding:clamp(2rem,5vw,4rem)}.callout p{color:#e0f0e5}.callout .button{background:white;color:var(--deep)}
.about{display:grid;grid-template-columns:minmax(0,1fr) 260px;gap:3rem;border-bottom:0}.about>div{max-width:730px}.about h2{max-width:650px}.about p{font-size:1.08rem;line-height:1.7}.about .disclaimer{align-self:end;font-size:.88rem;border-left:2px solid var(--line);padding-left:1rem}.text-link{font-weight:750;text-decoration-thickness:2px}
.doc{border:0;border-top:3px solid var(--green);border-radius:0;box-shadow:none;margin:3rem auto}.connect-card{border-radius:6px;box-shadow:0 24px 70px rgba(18,55,34,.08);border-top:4px solid var(--green)}.connect-card .logo{width:70px;height:70px}.badge-row span{border-radius:5px}.site-footer{max-width:1200px}.wizard-shell{margin-top:1.5rem;border:1px solid var(--line);background:#fbfdfb}.wizard-progress{display:grid;grid-template-columns:repeat(4,1fr);gap:0;list-style:none;margin:0;padding:0;border-bottom:1px solid var(--line)}.wizard-progress li{padding:.8rem .65rem;font-size:.82rem;color:var(--muted);border-right:1px solid var(--line)}.wizard-progress li:last-child{border-right:0}.wizard-progress li.active{color:var(--deep);font-weight:800;background:var(--soft);box-shadow:inset 0 -3px 0 var(--green)}.wizard-panel{padding:1.25rem;min-height:360px}.wizard-panel h2{margin:.35rem 0 .6rem;font-size:clamp(1.5rem,3vw,2.2rem)}.wizard-kicker{color:var(--green);font-weight:800;font-size:.85rem}.chatgpt-preview,.dropdown-preview,.trust-preview,.config-preview{border:1px solid #c8d8cd;background:#fff;padding:1rem;margin:1rem 0}.chatgpt-preview header{display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid var(--line);padding-bottom:.75rem}.chatgpt-preview header button{border:1px solid var(--green);background:var(--yellow);border-radius:7px;padding:.35rem .65rem;font-weight:800}.chatgpt-preview label{display:flex;gap:.5rem;align-items:center;border:1px solid var(--line);margin:1rem 0;padding:.45rem .65rem;color:var(--muted)}.chatgpt-preview input{border:0;outline:0;background:transparent;width:100%;font:inherit}.chatgpt-preview ul{list-style:none;padding:0;margin:0;display:grid;gap:.5rem}.chatgpt-preview li{display:flex;align-items:center;gap:.65rem;padding:.55rem;border-bottom:1px solid #edf2ed}.plugin-glyph{display:grid;place-items:center;width:2rem;height:2rem;background:var(--soft);color:var(--deep);font-weight:800;border-radius:6px}.chatgpt-preview small{display:block;color:var(--muted)}.preview-highlight{border-left:3px solid #a96b00;background:#fff6d9;padding:.65rem;margin-top:.75rem;font-size:.9rem}.dropdown-preview{max-width:480px;display:grid;gap:.4rem}.dropdown-preview span{font-size:.82rem;color:var(--muted)}.dropdown-preview strong{display:flex;justify-content:space-between;border:1px solid var(--line);padding:.75rem}.dropdown-preview small{color:var(--muted)}.config-preview{margin-bottom:1rem}.config-preview div{display:grid;grid-template-columns:120px 1fr;gap:1rem;padding:.55rem 0;border-bottom:1px solid #edf2ed}.config-preview div:last-child{border-bottom:0}.config-preview dt{font-weight:800;color:var(--deep)}.config-preview dd{margin:0;overflow-wrap:anywhere}.config-preview code{font-size:.9em;color:var(--deep)}.trust-preview{display:flex;gap:.8rem;align-items:flex-start;background:#f3faf5}.trust-preview>span{display:grid;place-items:center;width:2rem;height:2rem;border-radius:50%;background:var(--green);color:#fff;font-weight:900}.trust-preview p{margin:.2rem 0 0;color:var(--muted)}.wizard-path{border-block:1px solid var(--line);padding:.85rem 0;color:var(--deep);font-weight:800}.wizard-path b{color:var(--green);padding:0 .35rem}.wizard-actions{display:flex;justify-content:space-between;gap:.75rem;padding:0 1.25rem 1.25rem}.wizard-actions [hidden]{display:none}
@media(max-width:900px){.ledger{grid-template-columns:1fr}.ledger dl{grid-template-columns:repeat(3,1fr)}.hero{gap:2rem}}
 @media(max-width:650px){.site-header,main{padding-left:1rem;padding-right:1rem}.hero{grid-template-columns:1fr;padding-top:2.2rem}.hero h1{font-size:clamp(3.1rem,14vw,5rem)}.hero-visual{align-items:flex-start}.hero-logo{width:min(68vw,260px)}.hero-visual img{width:min(68vw,260px)}.hero-visual p{text-align:left}.ledger dl,.steps,.access-grid,.about,.setup-grid,.price-strip{grid-template-columns:1fr}.steps{border-top:0}.step,.step:not(:first-child){border-right:0;border-top:1px solid var(--line);padding:1rem 0}.prompt-grid{columns:1}.section{padding:3rem 0}.section-heading p{max-width:none}.about{gap:1rem}.about .disclaimer{align-self:start}.connect-card{margin:1.5rem auto}.price-strip article{min-height:0}.wizard-progress{grid-template-columns:1fr 1fr}.wizard-progress li:nth-child(2){border-right:0}.wizard-progress li:nth-child(-n+2){border-bottom:1px solid var(--line)}.wizard-panel{min-height:0;padding:1rem}.wizard-actions{padding:0 1rem 1rem}.config-preview div{grid-template-columns:1fr;gap:.15rem}}
:root{--ink:#102c21;--muted:#294c3a;--paper:#f7faf6;--soft:#e4f4e8;--line:#abc7b5;--green:#0f6b43;--deep:#124d35;--yellow:#ffc947}
body{font-size:17px;line-height:1.7;color:var(--ink)}
.hero{border-top:6px solid var(--yellow)}.hero h1{color:var(--ink)}
.mark-row{color:var(--deep);font-size:.95rem}.mark-row span:first-child{background:var(--yellow);color:#26300d;padding:.3rem .55rem;border-radius:3px}.mark-rule{display:none}
.developer-intro{font-size:1rem!important;color:var(--ink)!important;border-left:4px solid var(--yellow);padding:.3rem 0 .3rem 1rem;margin-top:1.3rem;line-height:1.55!important}
.developer-intro a{font-weight:750;color:#075637;text-decoration-thickness:2px}
.section-heading p,.section p,.doc p,.connect-card p,.ledger dd,.step>span:not(.step-num),.disclaimer,.fine-print,.updated,.hero-visual p,.site-footer{color:var(--muted)}
.section h2,.doc h1,.connect-card h1{color:var(--ink)}.section-heading p{font-size:1rem}.ledger dd,.step>span:not(.step-num){font-size:1rem}.ledger dt{color:var(--deep);font-size:1rem}
.site-header nav a{color:var(--deep);font-weight:600}.site-footer a,.fine-print a,.doc a{color:#075637;font-weight:650}
.site-header nav .nav-github{background:var(--deep);color:#fff;padding:.45rem .9rem;border-radius:5px;margin-left:.35rem}.site-header nav .nav-github:hover{background:#0b3827;color:#fff;box-shadow:none}
.roadmap-note{grid-column:1/-1;border-left:4px solid var(--yellow);background:#fff8dc;padding:.8rem 1rem;color:#523d00!important}
.callout h2{color:#fff}.callout p,.section.callout p{color:#e8f8ee!important}.callout .button{background:#fff;color:var(--deep);border:2px solid #fff}.callout .button:hover{background:var(--yellow);border-color:var(--yellow);color:var(--ink)}
.about{background:#e9f5eb;border-top:4px solid var(--yellow);padding:clamp(2rem,5vw,4rem);margin-top:1rem}.about p{color:var(--ink)}.about .disclaimer{color:#345644}
.nav-signin{background:var(--deep)!important;color:#fff!important;padding-inline:1rem!important}.nav-signin:hover{background:#0b3827!important;box-shadow:none!important}.product-preview{width:min(100%,430px);background:#fff;border:1px solid var(--line);box-shadow:14px 14px 0 var(--yellow);border-radius:10px;overflow:hidden;text-align:left}.preview-bar{display:flex;align-items:center;gap:.35rem;border-bottom:1px solid var(--line);padding:.7rem .8rem}.preview-bar span{width:7px;height:7px;border-radius:50%;background:#b8d5c0}.preview-bar span:nth-child(2){background:#e5c66c}.preview-bar span:nth-child(3){background:#d99578}.preview-bar b{margin-left:auto;font-size:.7rem;color:var(--deep)}.preview-body{display:grid;grid-template-columns:48px 1fr;min-height:190px}.preview-sidebar{border-right:1px solid var(--line);padding:.9rem .75rem}.preview-sidebar i{display:block;height:8px;background:#dcece0;margin-bottom:.85rem;border-radius:2px}.preview-sidebar i:first-child{background:var(--green)}.preview-content{padding:1.2rem}.preview-content small{color:var(--green);font-size:.65rem;font-weight:800;letter-spacing:.08em}.preview-content strong{display:block;font-size:1.2rem;line-height:1.15;margin:.65rem 0 1.1rem}.preview-row{display:flex;align-items:center;gap:.45rem;border-top:1px solid var(--line);padding:.65rem 0;font-size:.72rem}.preview-row em{width:8px;height:8px;border-radius:50%;background:var(--green)}.preview-row mark{margin-left:auto;background:#fff3c5;color:#6f5100;padding:.1rem .3rem;border-radius:3px}.installation-guide{text-align:left}.installation-guide>.hero-logo{width:58px;height:58px;margin-bottom:1rem}.eyebrow{font-size:.78rem;letter-spacing:.08em;text-transform:uppercase;color:var(--green);font-weight:800}.mcp-url-row{display:grid;grid-template-columns:1fr auto;gap:.6rem;align-items:end;margin:1.5rem 0}.mcp-url-row label{grid-column:1/-1;font-weight:750;color:var(--deep)}.mcp-url-row input{min-width:0;width:100%;border:1px solid var(--line);border-radius:8px;padding:.8rem;font:inherit;color:var(--deep);background:var(--soft)}.installation-steps{display:grid;gap:.9rem;padding-left:1.5rem}.installation-steps li{padding-left:.35rem}.installation-steps strong,.installation-steps span{display:block}.installation-steps span{color:var(--muted);margin-top:.2rem}.guide-actions{display:flex;gap:.7rem;flex-wrap:wrap;margin:1.5rem 0}.troubleshooting{border-top:1px solid var(--line);padding-top:1rem;color:var(--muted)}.troubleshooting summary{cursor:pointer;color:var(--deep);font-weight:750}.troubleshooting li{margin:.5rem 0}
.badge-row span{color:var(--deep);background:#e4f4e8}.permission-note li{margin:.5rem 0}
.site-footer{line-height:1.55}.site-footer p{max-width:850px;margin:.45rem 0}.site-footer .copyright{color:var(--ink);font-weight:750}
@media(max-width:650px){body{font-size:16.5px}.hero{border-top-width:4px}.mark-row{flex-wrap:wrap;gap:.6rem}.developer-intro{font-size:1rem!important}.about{padding:1.4rem}.hero h1{line-height:1}}
.journey{background:#edf6ee;border-top:0;margin:3rem -1.6rem 0;padding:clamp(3rem,6vw,5.5rem) 1.6rem;position:relative;overflow:hidden}.journey:before{content:"";position:absolute;top:0;left:1.6rem;width:88px;height:7px;background:var(--yellow)}
.journey .section-heading{margin-bottom:2.2rem;align-items:end}.journey .section-heading h2{font-size:clamp(2.5rem,5vw,4.7rem);max-width:750px;line-height:1.03}.journey .section-heading p{max-width:230px;font-size:1rem;color:var(--deep)}
.journey-layout{display:grid;grid-template-columns:minmax(0,1.12fr) minmax(310px,.88fr);gap:clamp(2rem,5vw,5rem);align-items:start}
.journey-steps{border-top:2px solid var(--deep)}.journey-steps details{border-bottom:1px solid #a8c6af;background:transparent}.journey-steps details[open]{background:#fff;padding-bottom:.25rem;box-shadow:inset 4px 0 var(--yellow)}
.journey-steps summary{list-style:none;display:grid;grid-template-columns:54px 1fr 32px;gap:1rem;align-items:center;cursor:pointer;padding:1.3rem 1.2rem;font-size:clamp(1.1rem,2vw,1.45rem);font-weight:750;line-height:1.25;color:var(--ink)}.journey-steps summary::-webkit-details-marker{display:none}.journey-steps summary:hover{background:#fff}.journey-steps summary:focus-visible{outline:3px solid var(--green);outline-offset:-3px}
.journey-number{font-family:Georgia,serif;font-size:1.55rem;font-weight:400;color:var(--green)}.journey-toggle{font-size:1.5rem;font-weight:400;text-align:center;border:1px solid var(--line);border-radius:50%;width:30px;height:30px;line-height:25px}.journey-steps details[open] .journey-toggle{transform:rotate(45deg);border-color:var(--green)}.journey-steps details p{max-width:580px;padding:0 2rem 1.4rem 5.4rem;margin:0;color:var(--muted);font-size:1rem;line-height:1.7}
.journey-example{background:var(--deep);color:white;min-height:420px;padding:clamp(1.4rem,3vw,2.5rem);display:flex;flex-direction:column;position:relative;box-shadow:14px 14px 0 var(--yellow)}.example-topline{display:flex;align-items:center;gap:.65rem;color:#e2f4e6;font-size:.85rem;font-weight:700}.example-topline span:last-child{margin-left:auto;border:1px solid #9cc8aa;padding:.2rem .5rem;border-radius:3px}.example-dot{width:9px;height:9px;background:var(--yellow);border-radius:50%}
.example-question{font-size:clamp(1.7rem,3vw,2.5rem);line-height:1.16;letter-spacing:-.045em;font-weight:700;color:#fff!important;margin:3rem 0 2rem}.example-route{display:flex;gap:.75rem;align-items:center;border-top:1px solid #82b49a;border-bottom:1px solid #82b49a;padding:1rem 0;font-size:.91rem;line-height:1.35;color:#e2f4e6}.example-route span:nth-child(2){color:var(--yellow);font-size:1.5rem}.example-explain{font-size:1rem;line-height:1.6;color:#e2f4e6!important;margin:1.2rem 0 2rem}.example-foot{margin-top:auto;color:#fff;font-size:.9rem;font-weight:700}.example-lock{display:inline-grid;place-items:center;width:1.4rem;height:1.4rem;border-radius:50%;background:var(--yellow);color:var(--deep);margin-right:.4rem}
.examples{background:#fff;margin:0 -1.6rem;padding:clamp(3rem,6vw,5rem) 1.6rem}.examples .section-heading h2{max-width:650px}.prompt-grid{columns:initial;display:grid;grid-template-columns:repeat(6,1fr);gap:.75rem}.prompt-grid li{display:flex;align-items:flex-end;grid-column:span 2;min-height:160px;padding:1.2rem;background:#e8f4eb;border:0;border-top:4px solid var(--green);font-size:clamp(1.05rem,2vw,1.4rem);line-height:1.25}.prompt-grid li:nth-child(2),.prompt-grid li:nth-child(5){background:#fff2c9;border-color:#a96b00}.prompt-grid li:nth-child(4){grid-column:span 3}.prompt-grid li:nth-child(5){grid-column:span 3}.prompt-grid li::marker{content:""}
@media(max-width:900px){.journey-layout{grid-template-columns:1fr}.journey-example{min-height:340px}.journey .section-heading{display:block}}
@media(max-width:650px){.journey,.examples{margin-left:-1rem;margin-right:-1rem;padding:3rem 1rem}.journey:before{left:1rem}.journey .section-heading h2 br{display:none}.journey-steps summary{grid-template-columns:38px 1fr 30px;gap:.5rem;padding:1rem .6rem}.journey-number{font-size:1.25rem}.journey-steps details p{padding:0 1rem 1.2rem 3.4rem}.journey-example{box-shadow:8px 8px 0 var(--yellow);min-height:390px}.prompt-grid{grid-template-columns:1fr 1fr}.prompt-grid li,.prompt-grid li:nth-child(4),.prompt-grid li:nth-child(5){grid-column:span 1;min-height:135px}.prompt-grid li:last-child{grid-column:span 2}}

/* Classroom Desk public redesign: calm desk, clear answer. */
:root{--emerald-50:#ecf7f2;--emerald-100:#d3efe3;--emerald-500:#12906a;--emerald-600:#0e7c5a;--emerald-700:#0b6247;--emerald-900:#073f2e;--mint:#bfe8d6;--paper:#faf8f3;--surface:#fff;--line:#e6e2d8;--ink:#14201b;--ink-2:#3c4a43;--muted:#4f5f56;--graphite-900:#0f1714;--graphite-800:#17211d;--graphite-line:#2a3832}
html{scroll-behavior:smooth}body{background:var(--paper);color:var(--ink);font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;font-size:16px;line-height:1.6;letter-spacing:0}a{color:var(--emerald-700)}a:focus-visible,button:focus-visible{outline:2px solid var(--emerald-600);outline-offset:3px}.skip-link{position:absolute;left:1rem;top:-4rem;background:var(--graphite-900);color:#fff;padding:.6rem 1rem;border-radius:10px;z-index:20}.skip-link:focus{top:1rem}.site-header{position:sticky;top:0;z-index:10;height:64px;max-width:none;padding:0 max(24px,calc((100% - 1200px)/2));background:rgb(250 248 243 / .96);border-bottom:1px solid var(--line);backdrop-filter:blur(12px)}.brand{font-size:18px;font-weight:650;color:var(--ink);gap:10px}.logo{width:32px;height:32px;flex:0 0 32px;display:block}.logo svg{display:block;width:32px;height:32px}.desktop-nav{display:flex!important;gap:28px;margin-left:auto;margin-right:28px}.desktop-nav a,.header-actions a{font-size:14px;padding:4px 0;color:var(--ink-2);border-radius:0}.desktop-nav a:hover,.desktop-nav a[aria-current=page]{color:var(--emerald-700);background:none;box-shadow:inset 0 -2px var(--emerald-600)}.header-actions{display:flex;align-items:center;gap:18px}.header-cta{min-height:40px;padding:0 14px!important;font-size:14px!important}.menu-toggle{display:none;background:none;border:1px solid var(--line);border-radius:10px;padding:7px 10px;color:var(--ink);font:inherit}.mobile-menu{display:none}.site-header nav a.nav-signin{background:none!important;color:var(--ink-2)!important;padding:4px 0!important}.site-header nav a.nav-signin:hover{box-shadow:inset 0 -2px var(--emerald-600)!important}.button{min-height:44px;border-radius:10px;background:var(--emerald-600);color:#fff!important;padding:0 16px;border:1px solid var(--emerald-600);font-size:15px;font-weight:650;cursor:pointer;transition:background-color 150ms ease,color 150ms ease,transform 150ms ease}.button:hover{background:var(--emerald-700);transform:translateY(-1px)}.button.secondary{background:transparent;color:var(--ink)!important;border-color:var(--line)}.button.secondary:hover{background:var(--surface);color:var(--emerald-700)!important}.text-link{font-weight:650;text-decoration-thickness:1px;text-underline-offset:4px}.text-link span{font-size:1.1em}.site-header+.mobile-menu+main,main{max-width:1200px;padding:0 24px 64px;margin:0 auto}.hero{min-height:calc(100dvh - 64px);display:grid;grid-template-columns:minmax(0,1fr) minmax(360px,.9fr);gap:64px;align-items:center;padding:64px 0 72px;border:0}.eyebrow{font-size:12px;line-height:1.2;letter-spacing:.08em;text-transform:uppercase;color:var(--emerald-700);font-weight:700}.hero h1,.section h2,.closing-cta h2,.pricing-page h1,.guide-page h1{font-family:ui-sans-serif,system-ui,sans-serif;font-weight:650;letter-spacing:-.04em}.hero h1{font-size:clamp(36px,4.6vw,60px);line-height:1.06;max-width:650px;margin:18px 0}.hero-lead{font-size:18px;line-height:1.55;max-width:570px;color:var(--ink-2)}.actions{display:flex;align-items:center;gap:24px;margin-top:28px}.hero-note{font-size:14px;color:var(--muted);max-width:520px;margin-top:20px}.demo-frame,.example-panel{background:var(--graphite-800);color:#f4fbf7;border-radius:24px;box-shadow:0 8px 24px -8px rgb(20 32 27 / .14);padding:28px}.demo-frame{min-height:410px;display:flex;flex-direction:column;justify-content:center}.demo-top{display:flex;justify-content:space-between;align-items:center;color:#b7c9c0;font-size:13px}.example-badge{display:inline-flex;border:1px solid #587267;border-radius:6px;padding:4px 8px;font-size:12px;color:#e6f4ec}.demo-user{align-self:flex-end;background:#2a3933;border-radius:16px 16px 4px 16px;padding:12px 16px;margin:56px 0 20px;max-width:80%}.demo-reply{border-top:1px solid var(--graphite-line);padding-top:20px}.demo-reply strong{font-size:15px}.demo-reply ul{padding-left:20px;color:#d6e8df}.demo-reply small,.example-panel small{display:block;color:#a9c2b6;margin-top:22px}.value-strip{display:grid;grid-template-columns:repeat(3,1fr);border-block:1px solid var(--line);padding:28px 0;margin-bottom:24px}.value-strip>div{padding:0 28px;border-left:1px solid var(--line)}.value-strip>div:first-child{padding-left:0;border-left:0}.outline-icon{color:var(--emerald-600);font-size:24px}.value-strip h2{font-size:18px;margin:10px 0 4px}.value-strip p{margin:0;color:var(--muted);font-size:14px}.section{padding:88px 0;border-top:1px solid var(--line)}.section-heading{display:block;margin-bottom:32px}.section h2,.closing-cta h2{font-size:clamp(28px,3vw,40px);line-height:1.12;margin:8px 0 0}.prompt-layout{display:grid;grid-template-columns:1fr 1fr;gap:48px;align-items:stretch}.prompt-tabs{display:grid;gap:0}.prompt-tabs p{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin:16px 0 4px}.prompt-tabs button{display:flex;align-items:center;justify-content:space-between;gap:16px;text-align:left;border:0;border-bottom:1px solid var(--line);background:none;color:var(--ink);padding:15px 0;font:inherit;cursor:pointer}.prompt-tabs button[aria-selected=true]{color:var(--emerald-700);font-weight:650}.prompt-tabs button span{font-size:12px;color:var(--muted);white-space:nowrap}.example-panel{min-height:320px;display:flex;flex-direction:column;justify-content:center}.example-question{font-size:28px;line-height:1.2;margin:24px 0}.example-panel p:not(.example-question){color:#d6e8df}.numbered-steps{display:grid;grid-template-columns:repeat(3,1fr);gap:28px;border-top:1px solid var(--line);padding-top:28px}.numbered-steps b{color:var(--emerald-600);font-size:14px}.numbered-steps h3{font-size:18px;margin:18px 0 8px}.numbered-steps p,.trust-section p{color:var(--muted);margin:0}.section-actions{display:flex;gap:24px;align-items:center;margin-top:32px}.trust-section{display:grid;grid-template-columns:.8fr 1.2fr;gap:72px}.trust-columns{display:grid;grid-template-columns:1fr 1fr;gap:32px}.trust-columns h3{font-size:18px;margin-top:0}.trust-columns ul{list-style:none;padding:0;margin:0;color:var(--ink-2)}.trust-columns li{padding:8px 0 8px 24px;border-bottom:1px solid var(--line);position:relative}.trust-columns li:before{content:"✓";position:absolute;left:0;color:var(--emerald-600)}.pricing-teaser{padding-bottom:72px}.price-list{border-top:1px solid var(--line);margin:24px 0 18px}.price-list div{display:grid;grid-template-columns:1fr 1fr auto;align-items:center;gap:12px;padding:15px 0;border-bottom:1px solid var(--line)}.price-list strong{font-size:18px}.price-list span{color:var(--muted)}.price-list em,.status-strip,.disabled-control{font-style:normal;font-size:12px;background:#f1eee7;border:1px solid var(--line);border-radius:6px;padding:5px 8px;color:var(--ink-2);justify-self:end}.faq-list{max-width:760px;border-top:1px solid var(--line)}.faq-list details{border-bottom:1px solid var(--line);padding:17px 0}.faq-list summary{cursor:pointer;font-weight:650;list-style:none}.faq-list summary::-webkit-details-marker{display:none}.faq-list summary:after{content:"+";float:right;color:var(--emerald-600);font-size:20px}.faq-list details[open] summary:after{content:"−"}.faq-list p{max-width:650px;color:var(--muted);margin:10px 0 0}.closing-cta{background:var(--graphite-900);color:#f4fbf7;border-radius:24px;padding:64px;margin:24px 0 0}.closing-cta h2{max-width:620px}.closing-cta>div{display:flex;align-items:center;gap:24px;margin-top:28px}.closing-cta .text-link{color:#d6e8df}.site-footer{max-width:1200px;margin:0 auto;padding:56px 24px 36px;border-top:1px solid var(--line);color:var(--muted)}.footer-grid{display:grid;grid-template-columns:1.5fr repeat(3,1fr);gap:40px}.footer-grid h2{font-size:13px;color:var(--ink);margin:0 0 14px}.footer-grid>a,.footer-grid div>a{display:block;margin:8px 0}.footer-brand{display:inline-flex!important;margin:0!important}.developer-credit{font-size:13px;margin-top:28px}.disclaimer{border-top:1px solid var(--line);padding-top:20px;margin-top:40px;font-size:13px;max-width:900px}.pricing-page,.guide-page{padding:80px 0 0;max-width:1000px}.pricing-page h1,.guide-page h1{font-size:clamp(36px,4.6vw,60px);max-width:720px;margin:16px 0}.page-lead{max-width:650px;font-size:18px;color:var(--ink-2)}.status-strip{display:inline-block;margin:28px 0}.pricing-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin:32px 0 72px}.plan-card{border:1px solid var(--line);border-radius:16px;padding:24px;background:var(--surface);display:flex;flex-direction:column;gap:10px}.plan-card.featured{border-top:2px solid var(--emerald-600)}.plan-card h2{font-size:30px;margin:0}.plan-card h2 small{font-size:14px;color:var(--muted);font-weight:500}.plan-card p{color:var(--muted)}.plan-card ul{padding-left:20px;color:var(--ink-2);min-height:145px}.plan-card .button,.plan-card .disabled-control{align-self:flex-start;margin-top:auto}.plan-card .text-link{margin-top:8px}.compare,.plain-billing{border-top:1px solid var(--line);padding-top:40px;margin-bottom:64px}.table-scroll{overflow-x:auto}.compare table{border-collapse:collapse;width:100%;min-width:650px}.compare th,.compare td{text-align:left;padding:14px 12px;border-bottom:1px solid var(--line)}.compare th{color:var(--ink)}.compare td{color:var(--muted)}.plain-billing>div{display:grid;grid-template-columns:repeat(3,1fr);gap:28px}.plain-billing p{color:var(--muted)}.guide-page{max-width:1040px}.connect-guide{display:grid;grid-template-columns:5fr 7fr;gap:28px;background:var(--graphite-900);color:#f4fbf7;border-radius:24px;padding:28px;margin-top:36px;position:relative}.connect-guide h2{font-size:28px;line-height:1.2;margin:8px 0}.connect-guide p{color:#c8d9d0}.guide-steps{min-height:300px}.step-kicker{font-size:13px!important;color:var(--mint)!important}.connect-guide section[hidden]{display:none}.help-text{font-size:13px!important;color:#a9c2b6!important;margin-top:22px}.copy-chip{display:flex;align-items:center;gap:10px;background:var(--graphite-800);border:1px solid var(--graphite-line);border-radius:10px;padding:10px}.copy-chip code{overflow-wrap:anywhere;color:var(--mint);font-family:ui-monospace,monospace;font-size:13px;flex:1}.copy-chip button{background:none;border:1px solid #587267;color:#f4fbf7;border-radius:6px;padding:7px 9px;cursor:pointer}.guide-visual{border:1px solid var(--graphite-line);border-radius:16px;min-height:300px;padding:20px;display:flex;flex-direction:column;justify-content:center;align-items:center;background:var(--graphite-800)}.guide-visual-board{width:min(80%,320px);aspect-ratio:1.4;border:2px solid var(--mint);border-radius:12px;padding:32px;display:grid;gap:12px;align-content:center}.guide-visual-board span{display:block;height:12px;border-radius:6px;background:#6c9482}.guide-visual-board span:first-child{width:75%;background:var(--mint)}.guide-controls,.modal-footer{grid-column:1/-1;display:flex;align-items:center;gap:16px;border-top:1px solid var(--graphite-line);padding-top:20px}.guide-controls .text-link,.modal-footer .text-link{color:#d6e8df;margin-left:auto}.troubleshooting{margin-top:30px;border-top:1px solid var(--line);padding-top:20px}.troubleshooting summary{cursor:pointer;font-weight:650}.test-prompt{margin-top:28px;color:var(--emerald-700);font-weight:650}.connect-modal{border:0;padding:0;background:transparent;max-width:960px;width:calc(100% - 32px);color:#f4fbf7}.connect-modal::backdrop{background:rgb(15 23 20 / .6)}.modal-shell{background:var(--graphite-900);border-radius:24px;padding:28px;box-shadow:0 24px 64px -16px rgb(0 0 0 / .45)}.modal-header{display:flex;justify-content:space-between;gap:20px}.modal-header h2{font-size:24px;margin:5px 0 0}.close-button{background:none;border:1px solid var(--graphite-line);color:#f4fbf7;border-radius:8px;font-size:24px;width:40px;height:40px;cursor:pointer}.modal-progress{color:var(--mint);font-size:13px}.modal-shell .connect-guide{margin-top:0;padding:0;background:none}.modal-shell .guide-controls{display:none}.modal-footer{margin-top:24px}.modal-open{overflow:hidden}.compact main{min-height:0}
@media(max-width:1023px){.hero{grid-template-columns:1fr;min-height:0;padding-top:56px}.demo-frame{max-width:620px}.trust-section{grid-template-columns:1fr;gap:32px}.pricing-grid{grid-template-columns:1fr 1fr}.plan-card:last-child{grid-column:1/-1}.footer-grid{grid-template-columns:repeat(2,1fr)}.connect-guide{grid-template-columns:1fr}.guide-visual{min-height:160px}}
@media(max-width:767px){.site-header{height:56px;padding:0 16px}.desktop-nav,.header-actions .nav-signin{display:none!important}.header-actions{margin-left:auto;gap:8px}.header-cta{min-height:40px;padding:0 12px!important}.menu-toggle{display:block}.mobile-menu{display:grid;gap:0;padding:12px 16px;background:var(--paper);border-bottom:1px solid var(--line)}.mobile-menu[hidden]{display:none}.mobile-menu a{padding:12px 0;border-bottom:1px solid var(--line);color:var(--ink);text-decoration:none}.mobile-menu .button{margin-top:12px}.site-header+.mobile-menu+main,main{padding:0 16px 48px}.hero{padding:48px 0 56px;gap:36px}.hero h1{font-size:clamp(36px,12vw,52px)}.hero-lead{font-size:17px}.actions,.section-actions,.closing-cta>div{align-items:stretch;flex-direction:column;gap:12px}.actions .button,.closing-cta .button{width:100%}.value-strip{grid-template-columns:1fr;gap:18px}.value-strip>div{padding:18px 0;border-left:0;border-top:1px solid var(--line)}.value-strip>div:first-child{padding-top:0;border-top:0}.prompt-layout{grid-template-columns:1fr;gap:28px}.prompt-tabs{display:flex;overflow-x:auto;scroll-snap-type:x mandatory;gap:8px}.prompt-tabs p{display:none}.prompt-tabs button{min-width:220px;scroll-snap-align:start;border:1px solid var(--line);border-radius:10px;padding:12px;display:block}.prompt-tabs button span{display:block;margin-top:8px}.numbered-steps,.trust-columns,.plain-billing>div{grid-template-columns:1fr;gap:24px}.price-list div{grid-template-columns:1fr auto}.price-list em{grid-column:2;grid-row:1 / span 2}.closing-cta{padding:40px 24px}.footer-grid{grid-template-columns:1fr 1fr;gap:28px}.pricing-page,.guide-page{padding-top:48px}.pricing-grid{grid-template-columns:1fr;margin-bottom:48px}.plan-card:last-child{grid-column:auto}.plan-card ul{min-height:0}.connect-guide,.modal-shell{padding:20px;border-radius:16px}.guide-visual{min-height:110px}.guide-visual-board{width:180px}.connect-modal{width:100%;height:100%;max-width:none}.connect-modal[open]{display:flex;align-items:stretch}.modal-shell{border-radius:0;width:100%;overflow:auto}.modal-shell .guide-visual{min-height:90px}.modal-footer{flex-wrap:wrap}.modal-footer .text-link{width:100%;margin-left:0}.site-footer{padding-inline:16px}}
 .modal-shell .step-kicker{display:none}.modal-footer button{min-height:44px;min-width:88px}.modal-footer .button.secondary{background:#f4fbf7;color:#10251c;border:1px solid #f4fbf7}.modal-footer .button.secondary:disabled{background:#355a4a!important;color:#d7e6de!important;border-color:#8bc7a7!important;opacity:1}.modal-footer .button:not(.secondary){background:#0e7c5a;color:#fff;border:1px solid #55c49a}.modal-footer button:focus-visible{outline:3px solid #b8f3d5;outline-offset:3px}
 /* Intelligent Performance adaptation: a paper stage, focused product proof, and restrained glass surfaces. */
 .home-page{background:#ececeb;color:#202020}.home-page main{max-width:none;padding:0 24px 72px}.home-stage{position:relative;isolation:isolate;min-height:clamp(760px,calc(100svh - 64px),980px);margin:0 -24px;padding:clamp(36px,7vh,80px) max(24px,calc((100% - 1200px)/2)) 64px;overflow:hidden;background:linear-gradient(135deg,rgba(236,236,234,.92),rgba(236,236,234,.72)),#ececeb}.home-stage:after{content:"";position:absolute;inset:0;z-index:-1;background:radial-gradient(circle at 12% 10%,rgba(18,144,106,.16),transparent 34%),radial-gradient(circle at 88% 23%,rgba(208,143,106,.14),transparent 31%),linear-gradient(180deg,rgba(255,255,255,.14),transparent 48%,rgba(20,32,27,.08));pointer-events:none}.stage-motion{position:absolute;inset:0;z-index:-3;width:100%;height:100%;object-fit:cover;opacity:.24;mix-blend-mode:multiply;pointer-events:none}.stage-motion--narrow{display:none}.home-stage-noise{position:absolute;inset:0;z-index:-1;width:100%;height:100%;opacity:.24;mix-blend-mode:multiply;pointer-events:none}.home-stage-inner{position:relative;z-index:1;max-width:1200px;margin:0 auto}.home-masthead{display:grid;grid-template-columns:minmax(0,1fr) minmax(360px,510px);gap:clamp(36px,6vw,88px);align-items:center}.home-copy{max-width:660px}.home-eyebrow{color:#0b6247}.home-copy h1{max-width:680px;margin:18px 0 20px;color:#202020;font-size:clamp(42px,min(5.2vw,8vh),72px);font-weight:520;letter-spacing:-.062em;line-height:1.01}.home-copy h1 span{color:#0e7c5a}.home-intro{max-width:610px;margin:0;color:#394a42;font-size:clamp(17px,1.65vw,22px);line-height:1.48;letter-spacing:-.02em}.home-copy .actions{margin-top:28px}.home-note{max-width:520px;margin:20px 0 0;color:#52645a;font-size:14px}.home-console{position:relative;overflow:hidden;border:1px solid rgba(255,255,255,.56);border-radius:22px;background:linear-gradient(145deg,rgba(255,255,255,.58),rgba(255,255,255,.18)),rgba(240,246,242,.38);box-shadow:0 26px 70px rgba(34,56,45,.18),inset 0 1px 0 rgba(255,255,255,.72);backdrop-filter:blur(18px) saturate(1.12);-webkit-backdrop-filter:blur(18px) saturate(1.12)}.home-console:before{content:"";position:absolute;inset:0;background:linear-gradient(120deg,rgba(255,255,255,.35),transparent 32%,rgba(255,255,255,.12) 68%,transparent);pointer-events:none}.console-top{position:relative;display:flex;align-items:center;justify-content:space-between;gap:16px;padding:17px 20px;border-bottom:1px solid rgba(20,32,27,.12);color:#33483d;font-size:12px;letter-spacing:.02em}.console-title{display:inline-flex;align-items:center;gap:8px;font-weight:700}.console-mark{width:8px;height:8px;border-radius:50%;background:#0e7c5a;box-shadow:0 0 0 4px rgba(14,124,90,.12)}.console-status{color:#587064}.home-example-panel{position:relative;z-index:1;min-height:315px;padding:30px 28px 18px;background:transparent!important;border-radius:0;box-shadow:none;color:#17211d}.home-example-panel .example-badge{border-color:rgba(14,124,90,.36);color:#0b6247;background:rgba(255,255,255,.35)}.home-example-panel .example-question{max-width:390px;margin:24px 0 16px;color:#14201b!important;font-size:clamp(27px,3vw,39px);font-weight:620;letter-spacing:-.045em;line-height:1.08}.home-example-panel .example-answer{max-width:430px;margin:0;color:#3f5549!important;font-size:16px;line-height:1.58}.home-example-panel small{max-width:400px;margin-top:22px;color:#60756a}.home-example-panel .example-actions{display:flex;align-items:center;gap:12px;margin-top:22px}.home-example-panel .demo-status{margin:0}.home-prompt-tabs{position:relative;z-index:1;display:grid;grid-template-columns:repeat(3,1fr);gap:8px;padding:16px 20px 20px;border-top:1px solid rgba(20,32,27,.12)}.home-prompt-tabs .prompt-label{grid-column:1/-1;margin:0 0 2px;color:#587064;font-size:11px;letter-spacing:.1em;text-transform:uppercase}.home-prompt-tabs button{min-height:54px;display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 11px;border:1px solid rgba(20,32,27,.14);border-radius:11px;background:rgba(255,255,255,.38);color:#20352a;font-size:13px;line-height:1.25}.home-prompt-tabs button:hover,.home-prompt-tabs button[aria-selected=true]{border-color:rgba(14,124,90,.55);background:rgba(255,255,255,.68);color:#0b6247}.home-prompt-tabs button span{color:#6a7b71;font-size:10px;white-space:nowrap}.capability-section{margin-top:clamp(54px,9vh,96px)}.capability-heading{display:grid;grid-template-columns:minmax(0,1fr) minmax(260px,390px);gap:24px;align-items:end;margin-bottom:25px}.capability-heading .eyebrow{grid-column:1/-1;margin:0}.capability-heading h2{margin:0;max-width:680px;color:#202020;font-size:clamp(30px,3.3vw,48px);letter-spacing:-.052em;line-height:1.05}.capability-heading>p:last-child{margin:0;color:#52645a;line-height:1.55}.capability-cards{display:grid;grid-template-columns:repeat(3,1fr);gap:clamp(12px,1.5vw,22px)}.capability-card{position:relative;min-height:310px;display:flex;flex-direction:column;overflow:hidden;padding:23px;border:1px solid rgba(255,255,255,.58);border-radius:17px;background:linear-gradient(145deg,rgba(255,255,255,.68),rgba(255,255,255,.24)),rgba(220,238,228,.34);box-shadow:0 12px 30px rgba(34,56,45,.12),inset 0 1px 0 rgba(255,255,255,.78);backdrop-filter:blur(13px);-webkit-backdrop-filter:blur(13px)}.capability-card:after{content:"";position:absolute;inset:0;background:radial-gradient(circle at 86% 12%,rgba(14,124,90,.12),transparent 34%);pointer-events:none}.capability-card-top{position:relative;z-index:1;display:flex;justify-content:space-between;color:#4e6759;font-size:11px;letter-spacing:.09em;text-transform:uppercase}.capability-card h3{position:relative;z-index:1;max-width:300px;margin:42px 0 10px;color:#17251e;font-size:clamp(21px,2vw,28px);letter-spacing:-.04em;line-height:1.1}.capability-card p{position:relative;z-index:1;max-width:330px;margin:0;color:#52645a;line-height:1.52}.capability-visual{position:relative;z-index:1;width:100%;height:92px;margin-top:auto;color:#0e7c5a;opacity:.72}.home-page .how-section,.home-page .trust-section,.home-page .pricing-teaser,.home-page .faq-section,.home-page .closing-cta{max-width:1200px;margin-left:auto;margin-right:auto}.home-page .how-section{margin-top:34px}.home-page .closing-cta{box-shadow:0 18px 44px rgba(34,56,45,.12)}
 @media(max-width:1023px){.home-masthead{grid-template-columns:1fr;gap:34px}.home-copy{max-width:760px}.home-console{max-width:680px;width:100%;margin-inline:auto}.capability-heading{grid-template-columns:1fr}.capability-heading>p:last-child{max-width:560px}.capability-cards{grid-template-columns:1fr 1fr}.capability-card:last-child{grid-column:1/-1}}
 @media(max-width:767px){.home-page main{padding-inline:16px}.home-stage{min-height:0;margin-inline:-16px;padding:38px 16px 50px;background:linear-gradient(180deg,rgba(236,236,234,.84),rgba(236,236,234,.94)),#ececeb}.stage-motion--wide{display:none}.stage-motion--narrow{display:block;opacity:.14}.home-masthead{gap:30px}.home-copy h1{font-size:clamp(40px,12vw,60px)}.home-intro{font-size:18px}.home-copy .actions{align-items:stretch;flex-direction:column;gap:12px}.home-copy .actions .button{width:100%}.home-note{margin-top:17px}.home-console{border-radius:17px}.console-top{padding:14px 15px}.home-example-panel{min-height:310px;padding:24px 20px 14px}.home-example-panel .example-question{font-size:31px}.home-prompt-tabs{grid-template-columns:1fr 1fr;padding:14px 15px 15px}.home-prompt-tabs button{min-height:58px;display:block;text-align:left}.home-prompt-tabs button span{display:block;margin-top:6px}.capability-section{margin-top:56px}.capability-heading h2{font-size:34px}.capability-cards{grid-template-columns:1fr}.capability-card:last-child{grid-column:auto}.capability-card{min-height:270px}.home-page .how-section{margin-top:0}}
 @keyframes homeRise{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}
 @media(prefers-reduced-motion:no-preference){.home-page .home-masthead{animation:homeRise .72s cubic-bezier(.16,1,.3,1) both}.home-page .capability-section{animation:homeRise .72s cubic-bezier(.22,1,.36,1) .12s both}}
 @media(max-height:720px) and (min-width:768px){.home-stage{min-height:900px}.home-masthead{align-items:start}.home-copy h1{font-size:clamp(40px,5vw,62px)}}
 @media(prefers-reduced-motion:reduce){.stage-motion{display:none!important}.home-page .home-masthead,.home-page .capability-section{animation:none!important}.home-console,.capability-card{backdrop-filter:none;-webkit-backdrop-filter:none;background:rgba(255,255,255,.9)}}
 /* Keep the shared header on one intentional row before the compact mobile menu takes over. */
 .site-header{display:flex;align-items:center;justify-content:space-between;gap:16px;min-width:0}.brand{min-width:0;flex:0 1 auto}.brand span{white-space:nowrap}.desktop-nav{flex-wrap:nowrap}
 @media(max-width:900px){.site-header{height:64px;padding:0 20px}.desktop-nav,.header-actions .nav-signin{display:none!important}.header-actions{display:flex;align-items:center;margin-left:auto;gap:8px;flex:0 0 auto}.menu-toggle{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:7px 11px}.mobile-menu{display:grid;gap:0;padding:12px 20px;background:var(--paper);border-bottom:1px solid var(--line)}.mobile-menu[hidden]{display:none}.mobile-menu a{padding:12px 0;border-bottom:1px solid var(--line);color:var(--ink);text-decoration:none}.mobile-menu .button{margin-top:12px}}
 @media(max-width:420px){.site-header{padding:0 16px}.header-cta{display:none!important}.mobile-menu{padding-inline:16px}.footer-grid{grid-template-columns:1fr}}
 @media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}.button{transition:none}.example-panel{animation:none}}
`;
}

function pricingReferralStyles() {
  return `
.referral-program{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:1.75rem 3rem;margin:3rem 0;padding:2rem 0;border-top:2px solid var(--ink);border-bottom:1px solid var(--line);align-items:start}
.referral-jump{margin:.5rem 0 1rem;text-decoration:none}
.referral-intro h2{font-size:clamp(2rem,4vw,3.1rem);line-height:1;letter-spacing:-.055em;margin:.15rem 0 .85rem;color:var(--ink)}
.referral-intro>p:not(.eyebrow){max-width:40rem;color:var(--muted);margin:.25rem 0 1.35rem}
.referral-rules{border-top:1px solid var(--line);padding-top:1rem}
.referral-rules h3,.referral-panel h3{font-size:1rem;letter-spacing:-.015em;margin:.1rem 0 .8rem}
.referral-steps{margin:.2rem 0 .9rem;padding-left:1.25rem}
.referral-steps li{padding:.22rem 0 .35rem .2rem;color:var(--muted)}
.referral-steps li span{color:var(--ink);font-weight:700}
.referral-terms{margin-top:.8rem;border-top:1px solid var(--line);padding-top:.65rem}
.referral-terms summary{cursor:pointer;color:var(--deep);font-weight:700}
.referral-terms p{margin:.55rem 0 0;color:var(--muted);font-size:.9rem}
.referral-note{font-size:.9rem;line-height:1.55;color:var(--muted);margin:.8rem 0 0}
.referral-panel{min-width:0;padding:1.4rem 0 0 1.5rem;border-left:1px solid var(--line)}
.referral-panel>p:first-child{margin-top:0}
.referral-state{font-weight:700;color:var(--deep)}
.referral-link-label{display:block;font-size:.9rem;font-weight:700;margin:.85rem 0 .35rem}
.referral-link-row{display:flex;align-items:stretch;gap:.55rem;min-width:0}
.referral-link-row input{min-width:0;flex:1;border:1px solid var(--line);border-radius:7px;background:var(--white);padding:.7rem .75rem;color:var(--ink);font:inherit;font-size:.88rem}
.referral-link-row .button{flex:0 0 auto;min-height:44px;padding:.65rem .9rem}
.referral-stats{display:grid;grid-template-columns:1fr 1fr;gap:.65rem 1rem;margin:1.15rem 0;padding:.9rem 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line)}
.referral-stats div{min-width:0}.referral-stats dt{font-size:.82rem;color:var(--muted)}.referral-stats dd{margin:.08rem 0 0;font-size:1.25rem;font-weight:750;color:var(--deep)}
.referral-history{list-style:none;margin:.4rem 0 1.1rem;padding:0;border-top:1px solid var(--line)}
.referral-history li{display:flex;justify-content:space-between;gap:1rem;padding:.65rem 0;border-bottom:1px solid var(--line);font-size:.9rem}
.referral-history li span:last-child{color:var(--muted);text-align:right}
.referral-apply{border-top:1px solid var(--line);padding-top:1rem;margin-top:1rem}
.referral-apply button:disabled{opacity:.65;cursor:wait}
.referral-apply [role=status]{min-height:1.5em}
.connection-cards{display:flex;gap:16px;overflow-x:auto;padding:18px 4px 24px;scroll-snap-type:x mandatory;scrollbar-width:thin}.connection-card{position:relative;flex:0 0 min(340px,82vw);min-height:210px;display:flex;flex-direction:column;justify-content:space-between;gap:24px;padding:24px;border:1px solid var(--line);border-radius:18px;background:var(--surface);box-shadow:0 12px 28px rgb(20 32 27 / .08);scroll-snap-align:start;transition:transform 180ms ease,box-shadow 180ms ease,border-color 180ms ease}.connection-card:hover{transform:translateY(-4px);border-color:var(--emerald-500);box-shadow:0 18px 34px rgb(20 32 27 / .13)}.connection-card-number{color:var(--emerald-700);font-size:13px;font-weight:750;letter-spacing:.08em}.connection-card h3{margin:0 0 8px;font-size:22px;letter-spacing:-.03em}.connection-card p{margin:0;color:var(--muted);line-height:1.5}.connection-card-arrow{align-self:flex-end;color:var(--emerald-600);font-size:24px;line-height:1}
@media(max-width:767px){.referral-program{grid-template-columns:1fr;gap:1.4rem;margin:2.5rem 0;padding:1.5rem 0}.referral-panel{border-left:0;border-top:1px solid var(--line);padding:1.25rem 0 0}.referral-link-row{flex-wrap:wrap}.referral-link-row input{flex-basis:100%}.referral-link-row .button{width:100%}.referral-history li{align-items:flex-start;flex-direction:column;gap:.15rem}.referral-history li span:last-child{text-align:left}}
`;
}

function siteStyles() {
  return `
:root{color-scheme:light;--ink:#13231d;--muted:#58675f;--paper:#fbfdfb;--soft:#eef6f0;--line:#d8e6dc;--green:#207a55;--deep:#174236;--warn:#8a4b14;--white:#fff}
*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.6 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}a{color:var(--deep);text-underline-offset:.18em}a:focus-visible,button:focus-visible{outline:3px solid #8bc7a7;outline-offset:3px}.site-header{display:flex;align-items:center;justify-content:space-between;gap:1.5rem;max-width:1120px;margin:0 auto;padding:1.1rem 1.25rem}.brand{display:inline-flex;align-items:center;gap:.65rem;text-decoration:none;font-weight:750;color:var(--ink)}.logo{width:38px;height:38px;flex:0 0 auto}.site-header nav{display:flex;gap:.35rem;flex-wrap:wrap}.site-header nav a{padding:.45rem .7rem;border-radius:999px;text-decoration:none;color:var(--muted);font-size:.95rem}.site-header nav a[aria-current=page],.site-header nav a:hover{background:var(--soft);color:var(--deep)}main{max-width:1120px;margin:0 auto;padding:1rem 1.25rem 4rem}.hero{display:grid;grid-template-columns:minmax(0,1.2fr) minmax(300px,.8fr);gap:2rem;align-items:center;padding:3.5rem 0 2.5rem}.mark-row{display:flex;align-items:center;gap:.7rem;color:var(--muted);font-size:.95rem}.hero .logo{width:46px;height:46px}.hero h1{font-size:clamp(2.65rem,8vw,5.9rem);line-height:.94;letter-spacing:0;margin:1.25rem 0}.lede{font-size:clamp(1.35rem,2.6vw,2rem);line-height:1.2;color:var(--deep);font-weight:680;margin:.4rem 0}.hero p{max-width:690px}.actions,.badge-row{display:flex;gap:.75rem;flex-wrap:wrap;align-items:center;margin-top:1.4rem}.button{display:inline-flex;align-items:center;justify-content:center;border:0;border-radius:12px;background:var(--deep);color:#fff;text-decoration:none;font-weight:720;padding:.82rem 1rem;min-height:44px;cursor:pointer;font:inherit}.button:hover{background:#0f3027}.button.secondary{background:var(--soft);color:var(--deep);border:1px solid var(--line)}.trust-line{font-weight:700;color:var(--green)}.ledger,.panel,.connect-card{background:var(--white);border:1px solid var(--line);border-radius:18px;box-shadow:0 18px 60px rgba(23,66,54,.08)}.ledger{padding:1.35rem}.ledger h2{margin:.1rem 0 1rem;font-size:1.2rem}.ledger dl{display:grid;gap:.85rem;margin:0}.ledger div{border-left:4px solid var(--green);padding-left:.8rem}.ledger dt{font-weight:800}.ledger dd{margin:.15rem 0 0;color:var(--muted)}.section{padding:3rem 0;border-top:1px solid var(--line)}.section-heading{display:flex;justify-content:space-between;gap:2rem;align-items:end;margin-bottom:1.25rem}.section h2,.doc h1,.connect-card h1{font-size:clamp(1.8rem,4vw,3rem);line-height:1.04;margin:0 0 .75rem}.section-heading p,.section p,.doc p,.connect-card p{color:var(--muted)}.steps{display:grid;grid-template-columns:repeat(4,1fr);gap:.85rem}.step{background:var(--white);border:1px solid var(--line);border-radius:16px;padding:1rem}.step-num{display:grid;place-items:center;width:2rem;height:2rem;border-radius:50%;background:var(--soft);color:var(--deep);font-weight:800;margin-bottom:.85rem}.steps strong,.steps span{display:block}.steps .step>span:not(.step-num){color:var(--muted);margin-top:.35rem}.prompt-grid{list-style:none;padding:0;margin:0;display:grid;grid-template-columns:repeat(5,1fr);gap:.75rem}.prompt-grid li{background:var(--deep);color:#fff;border-radius:16px;padding:1rem;min-height:106px;display:flex;align-items:flex-end;font-weight:680}.split{display:grid;grid-template-columns:.75fr 1.25fr;gap:1.5rem}.access-grid{display:grid;grid-template-columns:1fr 1fr;gap:1rem}.panel{padding:1.15rem}.panel h3{margin:.1rem 0 .7rem}.panel ul{margin:.5rem 0 0;padding-left:1.2rem}.panel li{margin:.22rem 0}.panel.ok{border-color:#b8dfc4}.panel.no{border-color:#efd4b8}.callout{background:linear-gradient(135deg,#eaf6ef,#f8fcf9);border:1px solid var(--line);border-radius:20px;padding:2rem;margin:2rem 0}.about{border-bottom:1px solid var(--line)}.disclaimer,.fine-print,.updated{font-size:.95rem;color:var(--muted)}.doc{max-width:820px;background:var(--white);border:1px solid var(--line);border-radius:20px;padding:clamp(1.25rem,4vw,2.5rem);margin:2rem auto}.doc h2{margin-top:1.8rem;color:var(--deep)}.support-card .panel{background:var(--soft);box-shadow:none}.connect-card{max-width:720px;margin:3rem auto;padding:clamp(1.25rem,4vw,2.4rem);text-align:left}.connect-card .logo{width:58px;height:58px}.badge-row span{background:var(--soft);border:1px solid var(--line);border-radius:999px;padding:.35rem .6rem;font-weight:720;color:var(--deep)}.permission-note{border-top:1px solid var(--line);border-bottom:1px solid var(--line);margin:1.4rem 0;padding:1rem 0}.permission-note h2{font-size:1.1rem;margin:.2rem 0}.permission-note ul{margin:.5rem 0;padding-left:1.2rem}.site-footer{border-top:1px solid var(--line);max-width:1120px;margin:0 auto;padding:1.5rem 1.25rem 2rem;color:var(--muted);font-size:.92rem}.site-footer a{margin-right:.8rem}.compact main{min-height:68vh}@media (max-width:860px){.site-header{align-items:flex-start;flex-direction:column}.hero,.split,.access-grid{grid-template-columns:1fr}.steps{grid-template-columns:1fr 1fr}.prompt-grid{grid-template-columns:1fr 1fr}.section-heading{display:block}}@media (max-width:560px){main{padding-inline:1rem}.site-header{padding-inline:1rem}.hero{padding-top:1.8rem}.steps,.prompt-grid{grid-template-columns:1fr}.actions .button{width:100%}.site-header nav a{padding:.35rem .5rem}.doc,.connect-card{border-radius:14px}}@media (prefers-reduced-motion:reduce){html{scroll-behavior:auto}}`;
}

function escapeHtml(value: string) { return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!); }
