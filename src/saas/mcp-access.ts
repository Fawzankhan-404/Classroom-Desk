import { createHash } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SaaSStore } from "./store.js";

export type McpAccess = { allowed: boolean; reason: string; plan?: string | null; expiresAt?: Date | string | null };
export const MCP_ONBOARDING_TOOLS = new Set(["classroom_desk_status", "classroom_desk_help"]);

export function accessGuidance(access: McpAccess, origin: string) {
  const restricted = access.reason === "suspended" || access.reason === "deleted";
  const setup = access.reason === "none" || access.reason === "account_setup_required";
  const google = access.reason === "google_authorization_required";
  const unavailable = access.reason === "temporarily_unavailable";
  const policy = access.reason.startsWith("policy_") || access.reason === "database_unavailable";
  return {
    allowed: access.allowed,
    status: access.reason,
    message: access.allowed ? "Classroom Desk access is active. Google permissions still apply to every operation."
      : restricted ? "This account is restricted. Contact Classroom Desk support."
      : google ? "Google Classroom authorization is missing or expired. Reconnect in ChatGPT and select the Google account containing your courses."
      : policy ? "Classroom Desk could not verify this connection's access policy. No Classroom data was accessed; retry shortly or contact support with the time of the error."
      : unavailable ? "Access could not be verified temporarily. No Classroom data was accessed. Try again shortly."
      : setup ? "Sign in to Classroom Desk, choose Student or Teacher, and authorize Google Classroom. Product access is free."
      : "Classroom Desk access could not be verified. Retry or contact support.",
    actionUrl: new URL(restricted ? "/support" : setup ? "/start" : google ? "/connect" : "/app/connection", origin).toString(),
  };
}

/** Frozen pre-enforcement subjects only; never infer legacy status from a request or email. */
export async function resolveMcpAccess(store: SaaSStore, subject: string, grandfatheredHashes = ""): Promise<McpAccess> {
  const entitlement = await store.entitlementForMcpUser(subject);
  if (entitlement.allowed || entitlement.reason === "suspended" || entitlement.reason === "deleted") return entitlement;
  const digest = createHash("sha256").update(subject).digest("hex");
  if (grandfatheredHashes.split(",").filter(value => /^[a-f0-9]{64}$/.test(value)).includes(digest)) {
    return { allowed: true, reason: "grandfathered", plan: null, expiresAt: null };
  }
  return entitlement;
}

export function registerMcpOnboarding(server: McpServer, check: () => Promise<McpAccess>, origin: string, identity?: () => Promise<{ id: string; displayName: string } | null>) {
  const meta = { securitySchemes: [{ type: "oauth2", scopes: ["mcp:tools"] }] };
  const annotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
  server.registerTool("classroom_desk_status", { description: "Check this authenticated connection's server-verified account authorization and Google grant status. Classroom Desk is free. Does not read Classroom or expose identity/payment details.", inputSchema: {}, _meta: meta, annotations }, async () => {
    const account = await identity?.().catch(() => null);
    const result = { ...accessGuidance(await check().catch(() => ({ allowed: false, reason: "temporarily_unavailable" })), origin), ...(identity ? { account: account ?? null } : {}) };
    return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
  });
  server.registerTool("classroom_desk_help", { description: "Explain supported Classroom Desk features and safe setup. No Classroom data is read.", inputSchema: {}, _meta: meta, annotations }, async () => ({ content: [{ type: "text", text: JSON.stringify({ features: ["Authorized courses", "Assignments and deadlines", "Announcements", "Your own submission status"], setupUrl: new URL("/start", origin).toString(), accountUrl: new URL("/app/connection", origin).toString(), supportUrl: new URL("/support", origin).toString(), message: "Classroom Desk is free. Sign in, choose Student or Teacher, then authorize Google Classroom. Returning users reuse valid Google access. Refresh preserves the authenticated identity. Use another Google account during authorization to explicitly select a different account. File tools require explicit authorization." }) }] }));
}
