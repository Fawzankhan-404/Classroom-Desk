const routes = new Set(["/mcp", "/health", "/ready", "/authorize", "/token", "/register", "/revoke", "/connect/google", "/oauth/google/callback", "/disconnect/google"]);

/** No request URL/query, identity, headers, bodies or upstream error strings enter logs. */
export function logHttp(method: string, path: string, status: number, durationMs: number) {
  if (process.env.NODE_ENV === "test" || path === "/health" || path === "/ready") return;
  process.stdout.write(`${JSON.stringify({ event: "http_request", method: ["GET", "POST", "DELETE", "OPTIONS"].includes(method) ? method : "OTHER", route: routes.has(path) ? path : "other", status, durationMs: Math.min(durationMs, 60_000) })}\n`);
}
export function logGrantRefreshFailure() {
  console.log({ event: "grant_refresh_persist_failed" });
}

/** Token diagnostics are reason-only; never include tokens, client IDs, URLs, or bodies. */
export function logMcpTokenFailure(flow: "authorization_code" | "refresh_token", reason: "missing" | "client_mismatch" | "redirect_mismatch" | "resource_mismatch" | "scope_mismatch" | "grant_missing" | "already_used" | "expired" | "rotation_rejected") {
  console.log({ event: "mcp_token_rejected", flow, reason });
}

const safeOAuthErrorCategories = new Set([
  "access_denied", "invalid_request", "unauthorized_client", "unsupported_response_type",
  "invalid_scope", "server_error", "temporarily_unavailable", "interaction_required",
  "login_required", "consent_required", "invalid_grant", "missing_code",
]);

function oauthErrorCategory(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return safeOAuthErrorCategories.has(value) ? value : "other";
}

export function logGoogleAuthorizationFailure(reason: "google_denied" | "callback_missing_code" | "missing_refresh_token" | "scope_mismatch" | "stored_grant_scope_mismatch" | "callback_processing_failed", details?: { source?: "provider" | "worker"; missingScopes?: number; extraScopes?: number; missingScopeNames?: string[]; providerErrorCategory?: string; stage?: "google_token_exchange" | "google_identity_binding" | "grant_persistence"; failureCategory?: "invalid_grant" | "invalid_client" | "invalid_request" | "identity_invalid" | "account_binding_conflict" | "storage_failure" | "other" }) {
  const { source = "worker", providerErrorCategory, ...safeDetails } = details ?? {};
  console.log({
    event: "google_authorization_failed",
    source,
    reason,
    ...safeDetails,
    ...(providerErrorCategory !== undefined ? { providerErrorCategory: oauthErrorCategory(providerErrorCategory) } : {}),
  });
}

/** Safe handoff diagnostics: fixed categories only, never a client-provided URI. */
export function logOAuthCallbackRedirect(location: string, status: 303 | 400, providerError?: string) {
  let destination: "chatgpt_connector" | "registered_callback" | undefined;
  let hasCode = false;
  let hasState = false;
  let hasError = false;
  let handoffErrorCategory: string | undefined;
  try {
    const target = new URL(location);
    destination = target.origin === "https://chatgpt.com" && /^\/connector\/oauth\/[A-Za-z0-9_-]+$/.test(target.pathname)
      ? "chatgpt_connector" : "registered_callback";
    hasCode = target.searchParams.has("code");
    hasState = target.searchParams.has("state");
    hasError = target.searchParams.has("error");
    handoffErrorCategory = oauthErrorCategory(target.searchParams.get("error") ?? undefined);
  } catch {
    // Do not log an unparsed redirect value.
  }
  console.log({
    event: "oauth_callback_handoff",
    status,
    destination,
    hasCode,
    hasState,
    hasError,
    source: providerError ? "google" : hasError ? "worker" : hasCode ? "success" : "unknown",
    ...(providerError !== undefined ? { providerErrorCategory: oauthErrorCategory(providerError) } : {}),
    ...(handoffErrorCategory !== undefined ? { handoffErrorCategory } : {}),
  });
}

export function logOAuthCallbackRejected() {
  console.log({ event: "oauth_callback_handoff", status: 400, result: "rejected" });
}
