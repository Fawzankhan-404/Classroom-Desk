const routes = new Set(["/mcp", "/health", "/ready", "/authorize", "/token", "/register", "/revoke", "/connect/google", "/oauth/google/callback", "/disconnect/google"]);

/** No request URL/query, identity, headers, bodies or upstream error strings enter logs. */
export function logHttp(method: string, path: string, status: number, durationMs: number) {
  if (process.env.NODE_ENV === "test" || path === "/health" || path === "/ready") return;
  process.stdout.write(`${JSON.stringify({ event: "http_request", method: ["GET", "POST", "DELETE", "OPTIONS"].includes(method) ? method : "OTHER", route: routes.has(path) ? path : "other", status, durationMs: Math.min(durationMs, 60_000) })}\n`);
}
export function logGrantRefreshFailure() {
  process.stderr.write('{"event":"grant_refresh_persist_failed"}\n');
}

/** Token diagnostics are reason-only; never include tokens, client IDs, URLs, or bodies. */
export function logMcpTokenFailure(flow: "authorization_code" | "refresh_token", reason: "missing" | "client_mismatch" | "redirect_mismatch" | "resource_mismatch" | "scope_mismatch" | "grant_missing" | "already_used" | "expired" | "rotation_rejected") {
  process.stderr.write(`${JSON.stringify({ event: "mcp_token_rejected", flow, reason })}\n`);
}

export function logGoogleAuthorizationFailure(reason: "google_denied" | "missing_refresh_token" | "scope_mismatch" | "token_exchange_failed" | "google_identity_missing" | "google_identity_mismatch" | "account_binding_conflict_or_session_expired", details?: { missingScopes?: number; extraScopes?: number; missingScopeNames?: string[] }) {
  process.stderr.write(`${JSON.stringify({ event: "google_authorization_failed", reason, ...details })}\n`);
}
