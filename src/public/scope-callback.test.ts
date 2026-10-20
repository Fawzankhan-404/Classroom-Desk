import { OAuth2Client } from "googleapis-common";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GOOGLE_CANONICAL_CLASSROOM_SCOPES } from "../scopes.js";
import { V2_DRIVE_SCOPE, V2_TEACHER_ROSTER_SCOPE, V2_TEACHER_SUBMISSIONS_SCOPE, V2_UNIFIED_SCOPES, isExactV2UnifiedGrant, isSupportedV2StoredGrant, isValidV2AuthorizationGrant } from "../v2/scopes.js";
import { MCP_SCOPE, PublicOAuthProvider } from "./oauth.js";
import { MemoryPublicAuthStore } from "./store.js";

// Synthetic Google token responses reproduce the staging callback's canonical
// scope shape; these tests do not establish live Google/ChatGPT acceptance.
const canonicalScopes = [...GOOGLE_CANONICAL_CLASSROOM_SCOPES, V2_DRIVE_SCOPE, "openid", "https://www.googleapis.com/auth/userinfo.email"];
const userId = "00000000-0000-4000-8000-000000000003";
afterEach(() => vi.restoreAllMocks());

async function callback(scopes: string[], claimOverrides: Record<string, unknown> = {}, options: { existingScopes?: string[]; existingGoogleSubject?: string | null; refreshToken?: string | null } = {}) {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const store = new MemoryPublicAuthStore();
  const resolver = vi.fn(async () => userId);
  const provider = new PublicOAuthProvider(store, {
    origin: new URL("https://staging.example.invalid"),
    mcpResource: new URL("https://staging.example.invalid/mcp"),
    googleCallbackUrl: "https://staging.example.invalid/oauth/google/callback",
    googleClientId: "synthetic-google-client", googleClientSecret: "synthetic-secret",
    googleScopes: V2_UNIFIED_SCOPES,
    googleGrantValidator: isExactV2UnifiedGrant,
    googleAuthorizationGrantValidator: isValidV2AuthorizationGrant,
    googleStoredGrantValidator: isSupportedV2StoredGrant,
    googleIdentityResolver: resolver,
  });
  if (options.existingScopes) await store.putGrant({
    userId, refreshToken: "existing-synthetic-refresh", scopes: options.existingScopes, createdAt: 1, updatedAt: 2,
    ...((options.existingGoogleSubject === undefined ? "synthetic-google-subject" : options.existingGoogleSubject)
      ? { googleSubject: options.existingGoogleSubject ?? "synthetic-google-subject" } : {}),
  });
  await store.putFlow({
    id: "synthetic-flow", userId: "temporary-flow-owner", client: { client_id: "synthetic-mcp-client", redirect_uris: ["https://chatgpt.com/connector/oauth/synthetic"] } as never,
    params: { state: "synthetic-client-state", scopes: [MCP_SCOPE], codeChallenge: "synthetic-challenge", redirectUri: "https://chatgpt.com/connector/oauth/synthetic" },
    googleState: "synthetic-google-state", googleVerifier: "synthetic-verifier", googleNonce: "synthetic-nonce",
    expiresAt: Date.now() + 60_000, started: false,
  });
  const googleUrl = new URL(await provider.beginGoogle("synthetic-flow"));
  vi.spyOn(OAuth2Client.prototype, "getToken").mockResolvedValue({ tokens: {
    access_token: "synthetic-access", ...(options.refreshToken === null ? {} : { refresh_token: options.refreshToken ?? "synthetic-refresh" }), id_token: "synthetic-id", scope: scopes.join(" "),
  } } as never);
  const verifyIdentity = vi.spyOn(OAuth2Client.prototype, "verifyIdToken").mockResolvedValue({ getPayload: () => ({
    iss: "https://accounts.google.com", aud: "synthetic-google-client", exp: Math.floor(Date.now() / 1000) + 300,
    iat: Math.floor(Date.now() / 1000), nonce: "synthetic-nonce", sub: "synthetic-google-subject",
    email: "synthetic@example.invalid", email_verified: true,
    ...claimOverrides,
  }) } as never);
  const redirect = new URL(await provider.completeGoogle("synthetic-google-state", "synthetic-google-code", undefined));
  return { redirect, googleUrl, store, resolver, verifyIdentity, provider, log };
}

describe("unified OAuth callback scope validation", () => {
  it("requests incremental Google authorization so a reconnect can retain still-granted teacher scopes", async () => {
    const { googleUrl } = await callback(canonicalScopes);
    expect(googleUrl.searchParams.get("include_granted_scopes")).toBe("true");
  });

  it("issues an account-bound code for Google's canonical Classroom and email scopes", async () => {
    const { redirect, store, resolver, provider } = await callback(canonicalScopes);
    expect(redirect.origin + redirect.pathname).toBe("https://chatgpt.com/connector/oauth/synthetic");
    expect(redirect.searchParams.get("state")).toBe("synthetic-client-state");
    expect(redirect.searchParams.has("code")).toBe(true);
    expect(redirect.searchParams.has("error")).toBe(false);
    expect(resolver).toHaveBeenCalledOnce();
    expect(await store.getGrant(userId)).toMatchObject({ refreshToken: "synthetic-refresh", scopes: canonicalScopes, googleSubject: "synthetic-google-subject" });
    expect(await store.getGrant("temporary-flow-owner")).toBeUndefined();
    await expect(provider.completeGoogle("synthetic-google-state", "replay", undefined)).rejects.toThrow("Invalid authorization callback");
  });

  it("accepts a complete previously approved teacher grant returned during reconnect", async () => {
    const teacherScopes = [...canonicalScopes, V2_TEACHER_ROSTER_SCOPE, V2_TEACHER_SUBMISSIONS_SCOPE];
    const { redirect, store } = await callback(teacherScopes, {}, { existingScopes: teacherScopes, refreshToken: null });
    expect(redirect.searchParams.has("code")).toBe(true);
    expect(await store.getGrant(userId)).toMatchObject({ refreshToken: "existing-synthetic-refresh", scopes: teacherScopes });
  });

  it("records Google's current scopes on reconnect when an incremental teacher grant has been revoked", async () => {
    const teacherScopes = [...canonicalScopes, V2_TEACHER_ROSTER_SCOPE, V2_TEACHER_SUBMISSIONS_SCOPE];
    const { redirect, store } = await callback(canonicalScopes, {}, { existingScopes: teacherScopes, refreshToken: null });
    expect(redirect.searchParams.has("code")).toBe(true);
    expect(await store.getGrant(userId)).toMatchObject({ refreshToken: "existing-synthetic-refresh", scopes: canonicalScopes });
  });

  it.each([
    { label: "a legacy grant without a recorded subject", existingGoogleSubject: null },
    { label: "a grant recorded for a different Google subject", existingGoogleSubject: "another-google-subject" },
  ])("does not reuse $label when Google omits a new refresh token", async ({ existingGoogleSubject }) => {
    const { redirect, store } = await callback(canonicalScopes, {}, {
      existingScopes: canonicalScopes, existingGoogleSubject, refreshToken: null,
    });
    expect(redirect.searchParams.get("error")).toBe("server_error");
    expect(redirect.searchParams.has("code")).toBe(false);
    expect(await store.getGrant(userId)).toMatchObject({
      refreshToken: "existing-synthetic-refresh", scopes: canonicalScopes,
      ...(existingGoogleSubject ? { googleSubject: existingGoogleSubject } : {}),
    });
  });

  it("reuses an existing Google refresh token only for the same verified subject", async () => {
    const { redirect, store } = await callback(canonicalScopes, {}, {
      existingScopes: canonicalScopes, existingGoogleSubject: "synthetic-google-subject", refreshToken: null,
    });
    expect(redirect.searchParams.has("code")).toBe(true);
    expect(await store.getGrant(userId)).toMatchObject({
      refreshToken: "existing-synthetic-refresh", googleSubject: "synthetic-google-subject",
    });
  });

  it("preserves the prior grant when Google's reconnect response omits a required scope", async () => {
    const teacherScopes = [...canonicalScopes, V2_TEACHER_ROSTER_SCOPE, V2_TEACHER_SUBMISSIONS_SCOPE];
    const incomplete = canonicalScopes.filter((scope) => scope !== "openid");
    const { redirect, store, resolver } = await callback(incomplete, {}, { existingScopes: teacherScopes });
    expect(redirect.searchParams.get("error")).toBe("access_denied");
    expect(resolver).not.toHaveBeenCalled();
    expect(await store.getGrant(userId)).toMatchObject({ refreshToken: "existing-synthetic-refresh", scopes: teacherScopes });
  });

  const denied = [
    ...canonicalScopes.map(scope => ({ name: `missing ${scope.split("/").at(-1)}`, scopes: canonicalScopes.filter(item => item !== scope) })),
    { name: "duplicate scope", scopes: [...canonicalScopes, canonicalScopes[0]!] },
    { name: "unexpected profile permission", scopes: [...canonicalScopes, "profile"] },
    { name: "both email aliases", scopes: [...canonicalScopes, "email"] },
    { name: "teacher permission substitution", scopes: [...canonicalScopes.filter(scope => !scope.endsWith("student-submissions.me.readonly")), "https://www.googleapis.com/auth/classroom.coursework.students.readonly"] },
  ];
  it.each(denied)("rejects $name before resolving or replacing an account grant", async ({ scopes }) => {
    const { redirect, store, resolver, verifyIdentity } = await callback(scopes);
    expect(redirect.searchParams.get("error")).toBe("access_denied");
    expect(redirect.searchParams.get("state")).toBe("synthetic-client-state");
    expect(redirect.searchParams.has("code")).toBe(false);
    expect(resolver).not.toHaveBeenCalled();
    expect(verifyIdentity).not.toHaveBeenCalled();
    expect(await store.getGrant(userId)).toBeUndefined();
  });

  const invalidClaims = [
    { name: "issuer", claims: { iss: "https://attacker.example.invalid" } },
    { name: "audience", claims: { aud: "another-client" } },
    { name: "authorized party", claims: { aud: ["synthetic-google-client", "another-client"], azp: "another-client" } },
    { name: "expired token", claims: { exp: Math.floor(Date.now() / 1000) - 1 } },
    { name: "future issued-at", claims: { iat: Math.floor(Date.now() / 1000) + 120 } },
    { name: "nonce", claims: { nonce: "another-flow" } },
    { name: "subject", claims: { sub: "" } },
    { name: "unverified email", claims: { email_verified: false } },
    { name: "email format", claims: { email: "not-an-email" } },
  ];
  it.each(invalidClaims)("rejects invalid Google identity $name before account resolution", async ({ claims }) => {
    const { redirect, store, resolver, log } = await callback(canonicalScopes, claims);
    expect(redirect.searchParams.get("error")).toBe("server_error");
    expect(redirect.searchParams.get("state")).toBe("synthetic-client-state");
    expect(redirect.searchParams.has("code")).toBe(false);
    expect(resolver).not.toHaveBeenCalled();
    expect(await store.getGrant(userId)).toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.objectContaining({
      event: "google_authorization_failed", reason: "callback_processing_failed",
      stage: "google_identity_binding", failureCategory: "identity_invalid",
    }));
    expect(JSON.stringify(log.mock.calls)).not.toContain("synthetic-google-subject");
    expect(JSON.stringify(log.mock.calls)).not.toContain("synthetic@example.invalid");
  });
});
