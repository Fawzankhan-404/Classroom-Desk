import { createHash, timingSafeEqual } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SaaSStore } from "./store.js";

export type McpAccess = { allowed: boolean; reason: string; plan?: string | null; expiresAt?: Date | string | null };
export const MCP_ONBOARDING_TOOLS = new Set(["classroom_desk_status", "classroom_desk_help", "link_website_account"]);
export const STAGING_TEST_ORIGIN = "https://classroom-desk-unified-staging.jarvis404-dev.workers.dev";
const MAX_STAGING_TEST_ACCESS_MS = 7 * 24 * 60 * 60 * 1000;

export type StagingTestEntitlementPolicy = {
  enabled: boolean;
  origin: string;
  subjectHashes?: string;
  expiresAt?: string;
  now?: Date;
};

export function isStagingTestOrigin(origin: string): boolean {
  try { return new URL(origin).origin === STAGING_TEST_ORIGIN; }
  catch { return false; }
}

export function stagingSubjectFingerprint(subject: string): string {
  return createHash("sha256").update(subject, "utf8").digest("hex");
}

export function accessGuidance(access: McpAccess, origin: string) {
  const restricted = access.reason === "suspended" || access.reason === "deleted";
  const setup = access.reason === "none" || access.reason === "account_setup_required";
  const google = access.reason === "google_authorization_required";
  const unavailable = access.reason === "temporarily_unavailable";
  const policy = access.reason.startsWith("policy_") || access.reason === "database_unavailable";
  const stagingExpired = isStagingTestOrigin(origin) && access.reason === "expired";
  return {
    allowed: access.allowed,
    status: access.reason,
    message: access.reason === "staging_test" ? `Temporary staging-only student access is active until ${new Date(access.expiresAt ?? 0).toISOString()}. Google permissions still apply to every operation.`
      : access.allowed ? "Classroom Desk access is active. Google permissions still apply to every operation."
      : restricted ? "This account is restricted. Contact Classroom Desk support."
      : google ? "Your Google Classroom connection is missing or expired. Reconnect in ChatGPT and choose the Google account that contains your courses."
      : policy ? "We could not check whether this connection can access Classroom. No Classroom data was accessed. Try again shortly or contact support with the time of the error."
      : unavailable ? "Access could not be verified temporarily. No Classroom data was accessed. Try again shortly."
      : setup ? "Sign in to Classroom Desk and authorize the Google account that contains your courses. New connections link automatically when Google confirms the same account. Older connections may need a one-time link from Account settings. An active trial or subscription may be required."
      : stagingExpired ? "This test account is connected, but temporary test access is not active. Check which Google account is linked on the website. No Classroom data was accessed."
      : "Classroom Desk is connected, but account access is not active. Review your account status and available options, then try again.",
    actionUrl: new URL(access.reason === "staging_test" ? "/app" : restricted ? "/support" : setup || stagingExpired ? "/app/connection" : google ? "/connect" : "/app/subscription", origin).toString(),
  };
}

/** Frozen pre-enforcement subjects only; never infer legacy status from a request or email. */
export async function resolveMcpAccess(store: SaaSStore, subject: string, grandfatheredHashes = "", stagingTest?: StagingTestEntitlementPolicy): Promise<McpAccess> {
  const entitlement = await store.entitlementForMcpUser(subject);
  if (entitlement.allowed || entitlement.reason === "suspended" || entitlement.reason === "deleted") return entitlement;
  const digest = stagingSubjectFingerprint(subject);
  if (grandfatheredHashes.split(",").filter(value => /^[a-f0-9]{64}$/.test(value)).includes(digest)) {
    return { allowed: true, reason: "grandfathered", plan: null, expiresAt: null };
  }
  if (entitlement.reason === "expired" && stagingTest?.enabled === true && isStagingTestOrigin(stagingTest.origin)) {
    const now = stagingTest.now ?? new Date();
    const expiryText = stagingTest.expiresAt ?? "";
    const expiry = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(expiryText) ? new Date(expiryText) : new Date(Number.NaN);
    const validExpiry = Number.isFinite(expiry.getTime()) && expiry.getTime() > now.getTime() && expiry.getTime() <= now.getTime() + MAX_STAGING_TEST_ACCESS_MS;
    const digestBytes = new TextEncoder().encode(digest);
    const matches = (stagingTest.subjectHashes ?? "").split(",").some(candidate => {
      if (!/^[a-f0-9]{64}$/.test(candidate)) return false;
      return timingSafeEqual(digestBytes, new TextEncoder().encode(candidate));
    });
    if (validExpiry && matches) return { allowed: true, reason: "staging_test", plan: "student", expiresAt: expiry };
  }
  return entitlement;
}

/** Resolve the teacher plan through the canonical website account mapped to an MCP identity. */
export async function hasTeacherMcpEntitlement(
  store: Pick<SaaSStore, "entitlementForMcpUser">,
  mcpUserId: string,
  teacherFeaturesEnabled: boolean,
): Promise<boolean> {
  if (!teacherFeaturesEnabled) return false;
  const entitlement = await store.entitlementForMcpUser(mcpUserId);
  return entitlement.allowed && entitlement.plan === "teacher";
}

export function registerMcpOnboarding(server: McpServer, check: () => Promise<McpAccess>, origin: string, stagingSubject?: string) {
  const meta = { securitySchemes: [{ type: "oauth2", scopes: ["mcp:tools"] }] };
  const annotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
  server.registerTool("classroom_desk_status", { description: "Check whether this connection can use Classroom Desk and get setup help. This does not read Classroom or show account or payment details.", inputSchema: {}, _meta: meta, annotations }, async () => {
    const guidance = accessGuidance(await check().catch(() => ({ allowed: false, reason: "temporarily_unavailable" })), origin);
    const result = stagingSubject ? { ...guidance, stagingSubjectFingerprint: stagingSubjectFingerprint(stagingSubject) } : guidance;
    return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
  });
  server.registerTool("classroom_desk_help", { description: "Explain supported Classroom Desk features and safe setup. No Classroom data is read.", inputSchema: {}, _meta: meta, annotations }, async () => ({ content: [{ type: "text", text: JSON.stringify({ features: ["Authorized courses", "Assignments and deadlines", "Announcements", "Your own submission status"], setupUrl: new URL("/connect", origin).toString(), accountUrl: new URL("/app/connection", origin).toString(), supportUrl: new URL("/support", origin).toString(), message: "Sign in to Classroom Desk with the Google account you use for Classroom, then authorize that account in ChatGPT. New connections link automatically when Google confirms the same account. Older connections may need a one-time link from Account settings. Never share Google passwords. File access is available only when supported and specifically authorized." }) }] }));
}
