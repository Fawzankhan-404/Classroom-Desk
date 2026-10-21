import { httpServerHandler } from "cloudflare:node";
import { isIP } from "node:net";
import { createHash, randomBytes } from "node:crypto";
import { OAuth2Client } from "googleapis-common";
import { checkRequestRateLimits } from "./saas/rate-limit.js";
import { loadRuntimeConfig } from "./public/config.js";
import { createPublicApp, type RawBodyRequest } from "./public/http.js";
import { PostgresPublicAuthStore } from "./public/postgres.js";
import { D1SqlDatabase } from "./public/d1-database.js";
import { createClients } from "./classroom.js";
import { createV2CombinedServer } from "./v2/server.js";
import { V2_UNIFIED_SCOPES, V2_TEACHER_SCOPES, V2_TEACHER_REQUIRED_SCOPES, V2_TEACHER_WRITE_SCOPES, isExactV2UnifiedGrant, isExactV2TeacherGrant, isExactV2TeacherWriteGrant, isSupportedV2StoredGrant, isValidV2AuthorizationGrant } from "./v2/scopes.js";
import { getStudentOverview } from "./v2/student.js";
import { classifyGoogleReadFailure } from "./v2/workflow.js";
import { createTeacherCourseworkDraft, getTeacherCourseDetail, getTeacherCourseworkDrafts, getTeacherOverview, getTeacherSubmissions } from "./v2/teacher.js";
import { DurableAttachmentAuthorizationStore } from "./v2/attachments.js";
import { GoogleDriveAttachmentReader } from "./v2/attachment-content.js";
import { buildOnePickAuthorizationUrl, parseOnePickCallback, DRIVE_FILE_SCOPE } from "./v2/picker.js";
import { buildPickerUrl } from "./v2/urls.js";
import { discoverAttachments } from "./v2/attachments.js";
import { isSaaSReconciliationEnabled, loadSaaSFeatureFlags } from "./saas/flags.js";
import { SaaSStore } from "./saas/store.js";
import { loadPricingReferralView } from "./saas/pricing-referral-view.js";
import { registerWebsiteRoutes } from "./saas/website-routes.js";
import { registerAdminRoutes } from "./saas/admin-routes.js";
import { registerInternalConnectionStatus } from "./saas/connection-status.js";
import { verifyRazorpaySignature } from "./saas/razorpay.js";
import { parseRazorpayEvent } from "./saas/billing-events.js";
import { RazorpayClient } from "./saas/razorpay-client.js";
import { reconcileRecentPayments } from "./saas/reconciliation.js";
import { PublicOAuthProvider } from "./public/oauth.js";
import { evaluateInternalPolicy, registerInternalLink, internalTokenMatches } from "./saas/internal-link.js";
import { hasTeacherMcpEntitlement, isStagingTestOrigin, resolveMcpAccess } from "./saas/mcp-access.js";

type Bindings = {
  DB: { prepare(sql: string): { bind(...values: unknown[]): { all<T>(): Promise<{ results?: T[]; success: boolean; error?: string }> } }; batch<T = Record<string, unknown>>(statements: Array<{ all<T>(): Promise<{ results?: T[]; success: boolean; error?: string }> }>): Promise<Array<{ results?: T[]; success: boolean; error?: string }>> };
  INTERNAL_DELEGATION_SECRET: string;
  MCP_GRANDFATHERED_SUBJECT_HASHES?: string;
  MCP_STAGING_DIAGNOSTICS_ENABLED?: string;
  MCP_STAGING_TEST_ENTITLEMENT_ENABLED?: string;
  MCP_STAGING_TEST_ENTITLEMENT_SUBJECT_HASHES?: string;
  MCP_STAGING_TEST_ENTITLEMENT_EXPIRES_AT?: string;
  MCP_ACCESS_POLICY_SECRET?: string;
  V2_PUBLIC_RATE_LIMIT: { limit(input: { key: string }): Promise<{ success: boolean }> };
  V2_AUTH_RATE_LIMIT: { limit(input: { key: string }): Promise<{ success: boolean }> };
  V2_PUBLIC_APP_ORIGIN: string;
  V2_PUBLIC_OPERATOR_NAME: string;
  V2_PUBLIC_SUPPORT_EMAIL: string;
  V2_PUBLIC_AUTH_ENCRYPTION_KEY_B64: string;
  V2_PROFILE_BACKFILL_ENABLED?: string;
  V2_PROFILE_BACKFILL_SUBJECT_PREFIX?: string;
  V2_GOOGLE_OAUTH_CLIENT_ID: string;
  V2_GOOGLE_OAUTH_CLIENT_SECRET: string;
  V2_PICKER_CALLBACK_URL: string;
  V2_AUTH_TABLE?: string;
  SAAS_BILLING_UI_ENABLED?: string;
  SAAS_RECONCILIATION_ENABLED?: string;
  SAAS_TEACHER_FEATURES_ENABLED?: string;
  SAAS_TEACHER_DRAFT_WRITES_ENABLED?: string;
  SAAS_REFERRAL_REWARDS_ENABLED?: string;
  SAAS_ENFORCE_ENTITLEMENTS?: string;
  RAZORPAY_WEBHOOK_SECRET?: string;
  RAZORPAY_KEY_ID?: string;
  RAZORPAY_KEY_SECRET?: string;
  RAZORPAY_STUDENT_PLAN_ID?: string;
  RAZORPAY_TEACHER_PLAN_ID?: string;
};

const betaGrant = (scopes: string[]) => isExactV2UnifiedGrant(scopes);
const betaStoredGrant = (scopes: string[]) => isSupportedV2StoredGrant(scopes);

export const pickerUrl = buildPickerUrl;

const handlers = new Map<string, ReturnType<typeof httpServerHandler>>();
let nextPort = 3001;

export default {
  async fetch(request: Request, bindings: Bindings, context: unknown) {
    const path = new URL(request.url).pathname;
    const clientIp = request.headers.get("cf-connecting-ip") ?? "";
    const internalPath = path === "/internal/account/link" || path === "/internal/account/access" || path === "/internal/transport/ping" || path === "/internal/transport/policy-shape";
    const trustedAccountLink = internalPath && (path === "/internal/account/access" || path === "/internal/transport/ping" || path === "/internal/transport/policy-shape"
      ? internalTokenMatches(request.headers.get("x-classroom-access-policy-token") ?? "", bindings.MCP_ACCESS_POLICY_SECRET)
      : internalTokenMatches(request.headers.get("x-classroom-internal-token") ?? "", bindings.INTERNAL_DELEGATION_SECRET));
    if (internalPath && !trustedAccountLink) return new Response(null,{status:404});
    if (path !== "/health" && !trustedAccountLink && !isIP(clientIp)) { const response = Response.json({ error: "invalid_client_address" }, { status: 400 }); response.headers.set("x-classroom-policy-stage", "network_admission"); return response; }
    const receivedOrigin = new URL(request.url).origin;
    const configuredOrigin = new URL(bindings.V2_PUBLIC_APP_ORIGIN).origin;
    const isolatedStaging = isStagingTestOrigin(configuredOrigin);
    const stagingDiagnosticsEnabled = isolatedStaging && bindings.MCP_STAGING_DIAGNOSTICS_ENABLED?.trim().toLowerCase() === "true";
    const stagingTestEntitlement = isolatedStaging && bindings.MCP_STAGING_TEST_ENTITLEMENT_ENABLED?.trim().toLowerCase() === "true"
      ? { enabled: true, origin: configuredOrigin, subjectHashes: bindings.MCP_STAGING_TEST_ENTITLEMENT_SUBJECT_HASHES, expiresAt: bindings.MCP_STAGING_TEST_ENTITLEMENT_EXPIRES_AT }
      : undefined;
    // Cloudflare service bindings may normalize the received URL/Host. A
    // trusted service-binding token is the internal proof; public requests
    // still require an exact canonical origin and same-origin header.
    if (!trustedAccountLink && receivedOrigin !== configuredOrigin) { const response = Response.json({ error: "invalid_origin" }, { status: 400 }); response.headers.set("x-classroom-policy-stage", "origin_validation"); return response; }
    const requestOrigin = trustedAccountLink ? configuredOrigin : receivedOrigin;
    if (!trustedAccountLink && request.headers.has("origin") && request.headers.get("origin") !== requestOrigin) { const response = Response.json({ error: "invalid_origin" }, { status: 403 }); response.headers.set("x-classroom-policy-stage", "origin_validation"); return response; }
    if (path === "/health") return Response.json({ status: "ok" });
    if (path === "/internal/transport/ping") {
      const requestId = request.headers.get("x-classroom-policy-request-id") ?? "missing";
      const response = Response.json({ ok: true, requestId, identityDataDisplayed: false });
      response.headers.set("x-classroom-policy-stage", "canonical_entrypoint");
      return response;
    }
    if (path === "/internal/transport/policy-shape") {
      const body = await request.arrayBuffer();
      const requestId = request.headers.get("x-classroom-policy-request-id") ?? "missing";
      const response = Response.json({ ok: true, requestId, method: request.method, contentType: request.headers.get("content-type"), contentLength: request.headers.get("content-length"), bodyBytes: body.byteLength, hostPresent: request.headers.has("host") });
      response.headers.set("x-classroom-policy-stage", "canonical_transport_shape");
      return response;
    }
    if (!trustedAccountLink) {
      const decision = await checkRequestRateLimits(path, clientIp, bindings.V2_PUBLIC_RATE_LIMIT, bindings.V2_AUTH_RATE_LIMIT);
      if (!decision.allowed) return Response.json({error: decision.error}, {status: decision.status});
    }
    let handler = handlers.get(requestOrigin);
    if (!handler) {
      const config = loadRuntimeConfig({
        NODE_ENV: "production", PUBLIC_AUTH_STORE: "d1",
        PUBLIC_APP_ORIGIN: requestOrigin, PUBLIC_OPERATOR_NAME: bindings.V2_PUBLIC_OPERATOR_NAME,
        PUBLIC_SUPPORT_EMAIL: bindings.V2_PUBLIC_SUPPORT_EMAIL, PUBLIC_AUTH_ENCRYPTION_KEY_B64: bindings.V2_PUBLIC_AUTH_ENCRYPTION_KEY_B64,
        GOOGLE_OAUTH_CLIENT_ID: bindings.V2_GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET: bindings.V2_GOOGLE_OAUTH_CLIENT_SECRET,
        GOOGLE_OAUTH_CALLBACK_URL: `${requestOrigin}/oauth/google/callback`, MCP_RESOURCE_URL: `${requestOrigin}/mcp`,
      });
      config.saasFlags = loadSaaSFeatureFlags(bindings);
      config.googleScopes = V2_UNIFIED_SCOPES;
      config.teacherScopes = V2_TEACHER_SCOPES;
      if (config.saasFlags.teacherDraftWrites) config.teacherWriteScopes = V2_TEACHER_WRITE_SCOPES;
      config.teacherGoogleCallbackUrl = `${requestOrigin}/auth/google/callback`;
      config.teacherGrantValidator = isExactV2TeacherGrant;
      if (config.saasFlags.teacherDraftWrites) config.teacherWriteGrantValidator = isExactV2TeacherWriteGrant;
      config.googleGrantValidator = betaGrant;
      config.googleStoredGrantValidator = betaStoredGrant;
      const database = new D1SqlDatabase(bindings.DB);
      const saasStore = new SaaSStore(database, {
        referralRewardsEnabled: config.saasFlags?.referralRewards === true,
        profileEncryptionKeyBase64: bindings.V2_PUBLIC_AUTH_ENCRYPTION_KEY_B64,
        requireProfileEncryption: true,
      });
      if (bindings.V2_PROFILE_BACKFILL_ENABLED?.trim().toLowerCase() === "true") {
        try {
          const migrated = await saasStore.backfillLegacyProfiles(1_000, bindings.V2_PROFILE_BACKFILL_SUBJECT_PREFIX);
          console.info(JSON.stringify({ event: "legacy_profile_backfill", result: "ok", migrated }));
        } catch (error) {
          const message = error instanceof Error ? error.message : "profile_backfill_failed";
          const category = /^[a-z0-9_]+$/.test(message) ? message : "profile_backfill_failed";
          console.warn(JSON.stringify({ event: "legacy_profile_backfill", result: "failed", category }));
          return Response.json({ error: "profile_migration_unavailable" }, { status: 503 });
        }
      }
      const store = new PostgresPublicAuthStore(database, config.encryptionKeyBase64, bindings.V2_AUTH_TABLE?.trim() || "classroom_desk_auth_records");
      if (path === "/internal/account/access") {
        if (!internalTokenMatches(request.headers.get("x-classroom-access-policy-token") ?? "", bindings.MCP_ACCESS_POLICY_SECRET)) return new Response(null, { status: 404 });
        let payload: { subject?: unknown };
        try { payload = await request.json() as { subject?: unknown }; } catch { return Response.json({ allowed: false, reason: "policy_identity_invalid" }, { status: 400, headers: { "x-classroom-policy-stage": "identity_validation" } }); }
        const result = await evaluateInternalPolicy(saasStore, payload.subject, bindings.MCP_GRANDFATHERED_SUBJECT_HASHES);
        return Response.json(result.body, { status: result.status, headers: { "x-classroom-policy-stage": result.stage } });
      }
      const publicProvider = new PublicOAuthProvider(store, {
        ...config,
        googleAuthorizationGrantValidator: isValidV2AuthorizationGrant,
        googleIdentityResolver: identity => saasStore.resolveGoogleIdentityBinding({ ...identity, now: new Date() }),
      });
      const attachmentAuthorizations = new DurableAttachmentAuthorizationStore(store);
      const pickerCallback = `${requestOrigin}/picker/callback`;
      // A reachable database is insufficient: OAuth needs the beta schema.
      const { app } = createPublicApp({ ...config, workerClientIp: true }, store, publicProvider, () => store.ready(), createClients, {
        internalDelegationSecret: bindings.INTERNAL_DELEGATION_SECRET,
        resourceName: "Classroom Desk",
        loadPricingReferral: (cookieHeader) => loadPricingReferralView(saasStore, cookieHeader, config.saasFlags?.referralRewards === true),
        stagingSubjectFingerprint: stagingDiagnosticsEnabled,
        entitlementCheck: (userId) => resolveMcpAccess(saasStore,userId,bindings.MCP_GRANDFATHERED_SUBJECT_HASHES,stagingTestEntitlement),
        mcpFactory: async (auth, userId) => {
          const clients = createClients(auth);
          const grantedScopes = await publicProvider.googleGrantScopes(userId);
          const teacherEntitled = await hasTeacherMcpEntitlement(saasStore, userId, config.saasFlags?.teacherFeatures === true);
          const reader = { read: async (attachment: Parameters<GoogleDriveAttachmentReader["read"]>[0]) => {
            if (!attachment.driveFileId) throw new Error("picker_authorization_required");
            const tokens = await attachmentAuthorizations.getPickerGrant<Record<string, unknown>>(userId, attachment.driveFileId);
            if (!tokens || typeof tokens.access_token !== "string") throw new Error("picker_authorization_required");
            const oauth = new OAuth2Client(bindings.V2_GOOGLE_OAUTH_CLIENT_ID, bindings.V2_GOOGLE_OAUTH_CLIENT_SECRET, pickerCallback);
            oauth.setCredentials(tokens as never);
            return new GoogleDriveAttachmentReader(createClients(oauth).drive).read(attachment);
          } } as GoogleDriveAttachmentReader;
          return createV2CombinedServer({ ...clients, subject: userId, grantedScopes, teacherEntitled, diagnostic: (event) => console.warn("final_classroom_diagnostic", event), uploadPdf: async (context, name, bytes) => {
            const work = (await clients.classroom.courses.courseWork.get({ courseId: context.courseId, id: context.courseWorkId })).data;
            const driveIds = discoverAttachments(work.materials).filter((item) => item.kind === "drive_file" && item.driveFileId).map((item) => item.driveFileId!);
            let accessToken: string | undefined;
            for (const fileId of driveIds) { const tokens = await attachmentAuthorizations.getPickerGrant<Record<string, unknown>>(userId, fileId); if (tokens && typeof tokens.access_token === "string") { accessToken = tokens.access_token; break; } }
            if (!accessToken) throw new Error("picker_authorization_required");
            const form = new FormData();
            form.append("metadata", new Blob([JSON.stringify({ name, mimeType: "application/pdf" })], { type: "application/json" }));
            const payload = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
            form.append("file", new Blob([payload], { type: "application/pdf" }), name);
            const response = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType,webViewLink", { method: "POST", headers: { Authorization: `Bearer ${accessToken}` }, body: form });
            if (!response.ok) { const error = new Error("Google Drive upload failed"); (error as { response?: { status?: number } }).response = { status: response.status }; throw error; }
            return await response.json() as { id?: string | null; name?: string | null; mimeType?: string | null; webViewLink?: string | null };
          }, driveForUpload: async (context) => {
            const work = (await clients.classroom.courses.courseWork.get({ courseId: context.courseId, id: context.courseWorkId })).data;
            const driveIds = discoverAttachments(work.materials).filter((item) => item.kind === "drive_file" && item.driveFileId).map((item) => item.driveFileId!);
            for (const fileId of driveIds) {
              const tokens = await attachmentAuthorizations.getPickerGrant<Record<string, unknown>>(userId, fileId);
              if (tokens && typeof tokens.access_token === "string") {
                const oauth = new OAuth2Client(bindings.V2_GOOGLE_OAUTH_CLIENT_ID, bindings.V2_GOOGLE_OAUTH_CLIENT_SECRET, pickerCallback);
                oauth.setCredentials(tokens as never);
                return createClients(oauth).drive;
              }
            }
            return undefined;
          }, attachmentAccess: { authorizations: attachmentAuthorizations, reader, pickerUrl: (id) => pickerUrl(config.origin.toString(), id) } }, { name: "classroom-desk", version: "2.0.0", linkWebsiteAccount: (code, mcpId) => saasStore.linking.consume(code, mcpId), accountStatus: (mcpId) => saasStore.accountStatusForMcpUser(mcpId, requestOrigin), teacherAuthorizationUrl: new URL("/app/teacher", requestOrigin).toString(), teacherWriteAuthorizationUrl: new URL("/app/teacher", requestOrigin).toString(), teacherDraftWritesEnabled: config.saasFlags?.teacherDraftWrites === true });
        },
        registerRoutes: (routeApp) => {
          registerInternalLink(routeApp,saasStore,bindings.INTERNAL_DELEGATION_SECRET,bindings.MCP_GRANDFATHERED_SUBJECT_HASHES,bindings.MCP_ACCESS_POLICY_SECRET);
          registerInternalConnectionStatus(routeApp, publicProvider, bindings.INTERNAL_DELEGATION_SECRET);
          registerWebsiteRoutes(routeApp, {
            store: saasStore,
            oauthStateStore: store,
            secureCookies: requestOrigin.startsWith("https://"),
            oauth: bindings.V2_GOOGLE_OAUTH_CLIENT_ID && bindings.V2_GOOGLE_OAUTH_CLIENT_SECRET ? {
              clientId: bindings.V2_GOOGLE_OAUTH_CLIENT_ID,
              clientSecret: bindings.V2_GOOGLE_OAUTH_CLIENT_SECRET,
              callbackUrl: `${requestOrigin}/auth/google/callback`,
              origin: requestOrigin,
            } : undefined,
            razorpay: bindings.RAZORPAY_KEY_ID && bindings.RAZORPAY_KEY_SECRET ? new RazorpayClient(bindings.RAZORPAY_KEY_ID, bindings.RAZORPAY_KEY_SECRET) : undefined,
            razorpayKeyId: bindings.RAZORPAY_KEY_ID,
            razorpayKeySecret: bindings.RAZORPAY_KEY_SECRET,
            razorpayPlanIds: { student: bindings.RAZORPAY_STUDENT_PLAN_ID, teacher: bindings.RAZORPAY_TEACHER_PLAN_ID },
            billingEnabled: config.saasFlags?.billingUi === true,
            teacherFeaturesEnabled: config.saasFlags?.teacherFeatures === true,
            teacherDraftWritesEnabled: config.saasFlags?.teacherDraftWrites === true,
            referralRewardsEnabled: config.saasFlags?.referralRewards === true,
            loadConnectionStatus:async websiteUserId=>{
              const subject=await saasStore.getClassroomMcpUserId(websiteUserId);
              if(!subject)return 'not_linked';
              try{
                const auth=await publicProvider.googleAuthForUser(subject);
                const token=await auth.getAccessToken();
                return token.token?'authorized':'reauthorization_required';
              }catch(error){
                const message=error instanceof Error?error.message:'';
                return message==='Google grant unavailable'||message.includes('invalid_grant')?'reauthorization_required':'unavailable';
              }
            },
            loadClassroomDashboard: async (websiteUserId) => {
              const mcpUserId = await saasStore.getClassroomMcpUserId(websiteUserId);
              if (!mcpUserId) return { state: "not_connected" as const };
              try {
                const access = await resolveMcpAccess(saasStore, mcpUserId, bindings.MCP_GRANDFATHERED_SUBJECT_HASHES);
                if (!access.allowed) return { state: "access_required" as const };
                const auth = await publicProvider.googleAuthForUser(mcpUserId);
                const overview = await getStudentOverview({ ...createClients(auth), subject: mcpUserId }, { limit: 50 });
                return { state: "connected" as const, overview };
              } catch (error) {
                return { state: classifyGoogleReadFailure(error) };
              }
            },
            loadTeacherDashboard: async (websiteUserId, coursePageToken) => {
              if (config.saasFlags?.teacherFeatures !== true) return { state: "unavailable" as const };
              const mcpUserId = await saasStore.getClassroomMcpUserId(websiteUserId);
              if (!mcpUserId) return { state: "not_connected" as const };
              const access = await resolveMcpAccess(saasStore, mcpUserId, bindings.MCP_GRANDFATHERED_SUBJECT_HASHES);
              if (!access.allowed) return { state: "access_required" as const };
              const entitlement = await saasStore.entitlement(websiteUserId);
              if (!entitlement.allowed || entitlement.plan !== "teacher") return { state: "teacher_entitlement_required" as const };
              const scopes = await publicProvider.googleGrantScopes(mcpUserId);
              if (!V2_TEACHER_REQUIRED_SCOPES.every(scope => scopes.includes(scope))) return { state: "authorization_required" as const };
              try {
                const auth = await publicProvider.googleAuthForUser(mcpUserId);
                const overview = await getTeacherOverview({ ...createClients(auth), subject: mcpUserId, grantedScopes: scopes, teacherEntitled: true }, coursePageToken);
                return { state: "connected" as const, courses: overview.courses, nextCoursePageToken: overview.nextCoursePageToken, previousPageAvailable: Boolean(coursePageToken) };
              } catch (error) {
                return { state: classifyGoogleReadFailure(error) };
              }
            },
            loadTeacherCourse: async (websiteUserId, courseId) => {
              if (config.saasFlags?.teacherFeatures !== true) throw new Error("teacher_features_disabled");
              const mcpUserId = await saasStore.getClassroomMcpUserId(websiteUserId);
              if (!mcpUserId) throw new Error("teacher_account_binding_required");
              const access = await resolveMcpAccess(saasStore, mcpUserId, bindings.MCP_GRANDFATHERED_SUBJECT_HASHES);
              if (!access.allowed) throw new Error("account_access_required");
              const entitlement = await saasStore.entitlement(websiteUserId);
              if (!entitlement.allowed || entitlement.plan !== "teacher") throw new Error("teacher_entitlement_required");
              const scopes = await publicProvider.googleGrantScopes(mcpUserId);
              const auth = await publicProvider.googleAuthForUser(mcpUserId);
              const clients = { ...createClients(auth), subject: mcpUserId, grantedScopes: scopes, teacherEntitled: true };
              const detail = await getTeacherCourseDetail(clients, courseId);
              const courseworkDraftsEnabled = config.saasFlags?.teacherDraftWrites === true && isExactV2TeacherWriteGrant(scopes);
              const draftResult = courseworkDraftsEnabled ? await getTeacherCourseworkDrafts(clients, courseId) : { drafts: [], moreAvailable: false };
              return { ...detail, drafts: draftResult.drafts, draftsMoreAvailable: draftResult.moreAvailable, courseworkDraftsEnabled, writeAuthorizationAvailable: config.saasFlags?.teacherDraftWrites === true };
            },
            loadTeacherSubmissions: async (websiteUserId, courseId, courseWorkId) => {
              if (config.saasFlags?.teacherFeatures !== true) throw new Error("teacher_features_disabled");
              const mcpUserId = await saasStore.getClassroomMcpUserId(websiteUserId);
              if (!mcpUserId) throw new Error("teacher_account_binding_required");
              const access = await resolveMcpAccess(saasStore, mcpUserId, bindings.MCP_GRANDFATHERED_SUBJECT_HASHES);
              if (!access.allowed) throw new Error("account_access_required");
              const entitlement = await saasStore.entitlement(websiteUserId);
              if (!entitlement.allowed || entitlement.plan !== "teacher") throw new Error("teacher_entitlement_required");
              const scopes = await publicProvider.googleGrantScopes(mcpUserId);
              const auth = await publicProvider.googleAuthForUser(mcpUserId);
              return getTeacherSubmissions({ ...createClients(auth), subject: mcpUserId, grantedScopes: scopes, teacherEntitled: true }, courseId, courseWorkId);
            },
            beginTeacherAuthorization: async input => publicProvider.beginTeacherConsent({ userId: input.mcpUserId, state: input.state, verifier: input.verifier, nonce: input.nonce }),
            completeTeacherAuthorization: async input => publicProvider.completeTeacherConsent({ userId: input.mcpUserId, expectedGoogleSubject: input.expectedGoogleSubject, code: input.code, verifier: input.verifier, nonce: input.nonce }),
            beginTeacherWriteAuthorization: async input => publicProvider.beginTeacherWriteConsent({ userId: input.mcpUserId, state: input.state, verifier: input.verifier, nonce: input.nonce }),
            completeTeacherWriteAuthorization: async input => publicProvider.completeTeacherWriteConsent({ userId: input.mcpUserId, expectedGoogleSubject: input.expectedGoogleSubject, code: input.code, verifier: input.verifier, nonce: input.nonce }),
            createTeacherCourseworkDraft: async (websiteUserId, courseId, input) => {
              if (config.saasFlags?.teacherFeatures !== true) throw new Error("teacher_features_disabled");
              const mcpUserId = await saasStore.getClassroomMcpUserId(websiteUserId);
              if (!mcpUserId) throw new Error("teacher_account_binding_required");
              const access = await resolveMcpAccess(saasStore, mcpUserId, bindings.MCP_GRANDFATHERED_SUBJECT_HASHES);
              if (!access.allowed) throw new Error("account_access_required");
              const entitlement = await saasStore.entitlement(websiteUserId);
              if (!entitlement.allowed || entitlement.plan !== "teacher") throw new Error("teacher_entitlement_required");
              const scopes = await publicProvider.googleGrantScopes(mcpUserId);
              const auth = await publicProvider.googleAuthForUser(mcpUserId);
              return createTeacherCourseworkDraft({ ...createClients(auth), subject: mcpUserId, grantedScopes: scopes, teacherEntitled: true }, courseId, input, "CREATE_UNPUBLISHED_DRAFT");
            },
          });
          registerAdminRoutes(routeApp, saasStore);
          routeApp.post("/webhooks/razorpay", async (req, res) => {
            const raw = (req as RawBodyRequest).rawBody;
            const signature = req.get("x-razorpay-signature") ?? "";
            const eventId = req.get("x-razorpay-event-id") ?? "";
            if (!raw || !/^[A-Za-z0-9_]{1,128}$/.test(eventId) || !bindings.RAZORPAY_WEBHOOK_SECRET || !verifyRazorpaySignature(raw.toString("utf8"), signature, bindings.RAZORPAY_WEBHOOK_SECRET)) return res.status(401).json({ error: "invalid_webhook" });
            const payloadHash = createHash("sha256").update(raw).digest("hex");
            const eventType = typeof req.body?.event === "string" ? req.body.event : "unknown";
            let accepted:boolean;
            try {
              const paymentId=req.body?.payload?.payment?.entity?.id;
              const payment=req.body?.payload?.payment?.entity;
              const orderId = typeof payment?.order_id === "string" ? payment.order_id : undefined;
              let owner=(eventType==='refund.processed'||eventType==='payment.refunded')&&typeof paymentId==='string'?await saasStore.paymentOwner(paymentId,orderId,typeof payment?.subscription_id==='string'?payment.subscription_id:undefined):undefined;
              let webhookBody = req.body;
              const webhookOrder = req.body?.payload?.order?.entity;
              if (eventType === "payment.captured" && !webhookOrder && typeof paymentId === "string" && orderId) {
                owner = await saasStore.paymentOwner(paymentId, orderId);
              }
              if (eventType === "payment.captured" && owner && !webhookOrder && orderId) {
                if (!bindings.RAZORPAY_KEY_ID || !bindings.RAZORPAY_KEY_SECRET) throw new Error("billing_provider_unavailable");
                const order = await new RazorpayClient(bindings.RAZORPAY_KEY_ID, bindings.RAZORPAY_KEY_SECRET).getOrder(orderId);
                webhookBody = { ...req.body, payload: { ...req.body.payload, order: { entity: order } } };
              }
              accepted = await saasStore.processWebhook(eventId,eventType,payloadHash,parseRazorpayEvent(webhookBody,new Date(),owner,{student:bindings.RAZORPAY_STUDENT_PLAN_ID,teacher:bindings.RAZORPAY_TEACHER_PLAN_ID}));
            }
            catch { console.error("razorpay_webhook_processing_failed"); return res.status(500).json({ error: "webhook_processing_failed" }); }
            return res.status(200).json({ received: true, duplicate: !accepted });
          });
          routeApp.get(/^\/picker\/([A-Za-z0-9_-]{20,})$/, async (req, res) => {
        const id = String(req.params[0] ?? ""); const pending = await attachmentAuthorizations.lookup(id);
        if (!pending || pending.status !== "pending" || !pending.attachment.driveFileId) return res.status(400).type("text").send("This file authorization expired or is unavailable.");
        const verifier = randomBytes(48).toString("base64url"); const challenge = createHash("sha256").update(verifier).digest("base64url");
        await attachmentAuthorizations.putPickerSession(id, verifier, pending.attachment.driveFileId);
        const url = buildOnePickAuthorizationUrl({ clientId: bindings.V2_GOOGLE_OAUTH_CLIENT_ID, redirectUri: pickerCallback, state: id, codeChallenge: challenge, fileId: pending.attachment.driveFileId });
            return res.redirect(302, url);
          });
          routeApp.get(new URL(pickerCallback).pathname, async (req, res) => {
        const id = typeof req.query.state === "string" ? req.query.state : ""; const session = await attachmentAuthorizations.takePickerSession(id); const pending = await attachmentAuthorizations.lookup(id);
        try {
          if (!session || !pending || pending.status !== "pending") throw new Error("picker_state_invalid");
          const callbackUrl = new URL(req.originalUrl, config.origin).toString(); const parsed = parseOnePickCallback({ callbackUrl, redirectUri: pickerCallback, expectedState: id, expectedFileId: session.expectedFileId });
          const oauth = new OAuth2Client(bindings.V2_GOOGLE_OAUTH_CLIENT_ID, bindings.V2_GOOGLE_OAUTH_CLIENT_SECRET, pickerCallback);
          const { tokens } = await oauth.getToken({ code: parsed.code, codeVerifier: session.verifier });
          const granted = new Set((tokens.scope ?? "").split(/\s+/).filter(Boolean));
          if (!tokens.access_token || granted.size !== 1 || !granted.has(DRIVE_FILE_SCOPE)) throw new Error("picker_scope_invalid");
          oauth.setCredentials(tokens);
          const tokenExpiry = typeof tokens.expiry_date === "number" && Number.isFinite(tokens.expiry_date) ? tokens.expiry_date : Date.now() + 3600000;
          const grantExpiry = Math.min(Date.now() + 3600000, tokenExpiry);
          if (grantExpiry <= Date.now()) throw new Error("picker_token_expired");
          await attachmentAuthorizations.putPickerGrant(pending.subject, session.expectedFileId, tokens, grantExpiry);
          await attachmentAuthorizations.complete(id, pending.subject, session.expectedFileId);
          res.setHeader("Cache-Control", "no-store"); return res.type("text").send("Attachment authorized. Return to ChatGPT and ask Classroom Desk to read it.");
        } catch { return res.status(400).type("text").send("Attachment authorization was not completed. You can try again from Classroom Desk."); }
          });
        },
      });
      app.listen(nextPort);
      handler = httpServerHandler({ port: nextPort });
      nextPort += 1;
      handlers.set(requestOrigin, handler);
    }
    return handler.fetch(request, bindings, context);
  },
  async scheduled(_event: unknown, bindings: Bindings) {
    try {
      const database = new D1SqlDatabase(bindings.DB);
      if (bindings.RAZORPAY_KEY_ID && bindings.RAZORPAY_KEY_SECRET && isSaaSReconciliationEnabled(bindings)) {
        const billingStore = new SaaSStore(database, { referralRewardsEnabled: loadSaaSFeatureFlags(bindings).referralRewards });
        const result = await reconcileRecentPayments(database, billingStore, new RazorpayClient(bindings.RAZORPAY_KEY_ID, bindings.RAZORPAY_KEY_SECRET),new Date(),{student:bindings.RAZORPAY_STUDENT_PLAN_ID,teacher:bindings.RAZORPAY_TEACHER_PLAN_ID});
        console[result.failed > 0 ? "warn" : "log"](JSON.stringify({ event: "billing_reconciliation", ...result }));
      }
      const store = new PostgresPublicAuthStore(database, bindings.V2_PUBLIC_AUTH_ENCRYPTION_KEY_B64, bindings.V2_AUTH_TABLE?.trim() || "classroom_desk_auth_records");
      await store.pruneExpired();
    } catch {
      console.error(JSON.stringify({event:"scheduled_maintenance_failed",retry:"next_schedule"}));
    }
  },
};
