import { afterEach, describe, expect, it, vi } from "vitest";
import { OAuth2Client } from "googleapis-common";
import { MemoryPublicAuthStore } from "./store.js";
import { PublicOAuthProvider } from "./oauth.js";
import { V2_TEACHER_SCOPES, V2_TEACHER_WRITE_SCOPES, isExactV2TeacherGrant, isExactV2TeacherWriteGrant, isSupportedV2StoredGrant, V2_UNIFIED_SCOPES } from "../v2/scopes.js";

afterEach(() => vi.restoreAllMocks());

function providerFixture() {
  const store = new MemoryPublicAuthStore();
  const provider = new PublicOAuthProvider(store, {
    origin: new URL("https://classroom.example"),
    googleClientId: "synthetic-google-client",
    googleClientSecret: "synthetic-google-secret",
    googleCallbackUrl: "https://classroom.example/oauth/google/callback",
    teacherGoogleCallbackUrl: "https://classroom.example/auth/google/callback",
    mcpResource: new URL("https://classroom.example/mcp"),
    teacherScopes: V2_TEACHER_SCOPES,
    teacherGrantValidator: isExactV2TeacherGrant,
    teacherWriteScopes: V2_TEACHER_WRITE_SCOPES,
    teacherWriteGrantValidator: isExactV2TeacherWriteGrant,
    googleStoredGrantValidator: isSupportedV2StoredGrant,
  });
  return { store, provider };
}

describe("incremental teacher Google consent", () => {
  it("creates an explicit PKCE S256 request for read-only roster and submission scopes", async () => {
    const { store, provider } = providerFixture();
    await store.putGrant({ userId: "user-1", refreshToken: "synthetic-refresh", scopes: [...V2_UNIFIED_SCOPES], createdAt: 1, updatedAt: 1 });
    const request = { userId: "user-1", state: "s".repeat(32), verifier: "v".repeat(43), nonce: "n".repeat(32) };
    const url = new URL(await provider.beginTeacherConsent(request));
    expect(url.origin).toBe("https://accounts.google.com");
    expect(url.searchParams.get("redirect_uri")).toBe("https://classroom.example/auth/google/callback");
    expect(url.searchParams.get("state")).toBe(request.state);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("scope")?.split(" ")).toEqual([...V2_TEACHER_SCOPES]);
    expect(url.searchParams.get("include_granted_scopes")).toBe("true");
    expect(url.searchParams.get("prompt")).toContain("select_account");
  });

  it("rejects a teacher callback outside the canonical browser callback", async () => {
    const store = new MemoryPublicAuthStore();
    const provider = new PublicOAuthProvider(store, {
      origin: new URL("https://classroom.example"), googleClientId: "synthetic-google-client", googleClientSecret: "synthetic-google-secret",
      googleCallbackUrl: "https://classroom.example/oauth/google/callback", teacherGoogleCallbackUrl: "https://attacker.example/auth/google/callback",
      mcpResource: new URL("https://classroom.example/mcp"), teacherScopes: V2_TEACHER_SCOPES,
      teacherGrantValidator: isExactV2TeacherGrant, googleStoredGrantValidator: isSupportedV2StoredGrant,
    });
    await store.putGrant({ userId: "user-1", refreshToken: "synthetic-refresh", scopes: [...V2_UNIFIED_SCOPES], createdAt: 1, updatedAt: 1 });
    await expect(provider.beginTeacherConsent({ userId: "user-1", state: "s".repeat(32), verifier: "v".repeat(43), nonce: "n".repeat(32) })).rejects.toThrow("teacher_callback_invalid");
  });

  it("adds teacher scopes only for the same verified Google subject and preserves the refresh token", async () => {
    const { store, provider } = providerFixture();
    await store.putGrant({ userId: "user-1", refreshToken: "existing-refresh-token", scopes: [...V2_UNIFIED_SCOPES], createdAt: 10, updatedAt: 11 });
    const tokenExchange = vi.spyOn(OAuth2Client.prototype, "getToken").mockResolvedValue({ tokens: { scope: V2_TEACHER_SCOPES.join(" "), id_token: "synthetic-id-token" } } as never);
    vi.spyOn(OAuth2Client.prototype, "verifyIdToken").mockResolvedValue({ getPayload: () => ({
      iss: "https://accounts.google.com", aud: "synthetic-google-client", azp: "synthetic-google-client",
      exp: Math.floor(Date.now() / 1000) + 300, iat: Math.floor(Date.now() / 1000), nonce: "n".repeat(32),
      sub: "stable-google-subject", email: "verified@example.test", email_verified: true,
    }) } as never);
    await provider.completeTeacherConsent({ userId: "user-1", expectedGoogleSubject: "stable-google-subject", code: "synthetic-code", verifier: "v".repeat(43), nonce: "n".repeat(32) });
    expect((tokenExchange.mock.instances[0] as unknown as { redirectUri?: string }).redirectUri).toBe("https://classroom.example/auth/google/callback");
    expect(await store.getGrant("user-1")).toMatchObject({ refreshToken: "existing-refresh-token", scopes: expect.arrayContaining([...V2_TEACHER_SCOPES]) });
  });

  it("does not fill missing teacher-consent scopes from a previously stored grant", async () => {
    const { store, provider } = providerFixture();
    await store.putGrant({ userId: "user-1", refreshToken: "existing-refresh-token", scopes: [...V2_UNIFIED_SCOPES], createdAt: 10, updatedAt: 11 });
    const incompleteScopes = V2_TEACHER_SCOPES.filter(scope => scope !== V2_UNIFIED_SCOPES[0]);
    vi.spyOn(OAuth2Client.prototype, "getToken").mockResolvedValue({ tokens: { scope: incompleteScopes.join(" "), id_token: "synthetic-id-token" } } as never);
    vi.spyOn(OAuth2Client.prototype, "verifyIdToken").mockResolvedValue({ getPayload: () => ({
      iss: "https://accounts.google.com", aud: "synthetic-google-client", azp: "synthetic-google-client",
      exp: Math.floor(Date.now() / 1000) + 300, iat: Math.floor(Date.now() / 1000), nonce: "n".repeat(32),
      sub: "stable-google-subject", email: "verified@example.test", email_verified: true,
    }) } as never);
    await expect(provider.completeTeacherConsent({ userId: "user-1", expectedGoogleSubject: "stable-google-subject", code: "synthetic-code", verifier: "v".repeat(43), nonce: "n".repeat(32) })).rejects.toThrow("teacher_scope_mismatch");
    expect(await store.getGrant("user-1")).toMatchObject({ refreshToken: "existing-refresh-token", scopes: [...V2_UNIFIED_SCOPES] });
  });

  it("rejects account switching even when the presented email is the same", async () => {
    const { store, provider } = providerFixture();
    await store.putGrant({ userId: "user-1", refreshToken: "existing-refresh-token", scopes: [...V2_UNIFIED_SCOPES], createdAt: 10, updatedAt: 11 });
    vi.spyOn(OAuth2Client.prototype, "getToken").mockResolvedValue({ tokens: { scope: V2_TEACHER_SCOPES.join(" "), id_token: "synthetic-id-token" } } as never);
    vi.spyOn(OAuth2Client.prototype, "verifyIdToken").mockResolvedValue({ getPayload: () => ({
      iss: "https://accounts.google.com", aud: "synthetic-google-client", azp: "synthetic-google-client",
      exp: Math.floor(Date.now() / 1000) + 300, iat: Math.floor(Date.now() / 1000), nonce: "n".repeat(32),
      sub: "different-google-subject", email: "verified@example.test", email_verified: true,
    }) } as never);
    await expect(provider.completeTeacherConsent({ userId: "user-1", expectedGoogleSubject: "stable-google-subject", code: "synthetic-code", verifier: "v".repeat(43), nonce: "n".repeat(32) })).rejects.toThrow("teacher_google_account_mismatch");
    expect(await store.getGrant("user-1")).toMatchObject({ refreshToken: "existing-refresh-token", scopes: [...V2_UNIFIED_SCOPES] });
  });
});

describe("incremental teacher draft-write consent", () => {
  it("uses the same canonical callback with state, PKCE S256, and an explicit coursework write scope", async () => {
    const { store, provider } = providerFixture();
    await store.putGrant({ userId: "user-1", refreshToken: "synthetic-refresh", scopes: [...V2_TEACHER_SCOPES], createdAt: 1, updatedAt: 2 });
    const request = { userId: "user-1", state: "s".repeat(32), verifier: "v".repeat(43), nonce: "n".repeat(32) };
    const url = new URL(await provider.beginTeacherWriteConsent(request));
    expect(url.origin).toBe("https://accounts.google.com");
    expect(url.searchParams.get("redirect_uri")).toBe("https://classroom.example/auth/google/callback");
    expect(url.searchParams.get("state")).toBe(request.state);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("scope")?.split(" ")).toEqual([...V2_TEACHER_WRITE_SCOPES]);
    expect(url.searchParams.get("include_granted_scopes")).toBe("true");
  });

  it("requires an existing verified teacher read grant before starting write consent", async () => {
    const { store, provider } = providerFixture();
    await store.putGrant({ userId: "user-1", refreshToken: "synthetic-refresh", scopes: [...V2_UNIFIED_SCOPES], createdAt: 1, updatedAt: 2 });
    await expect(provider.beginTeacherWriteConsent({ userId: "user-1", state: "s".repeat(32), verifier: "v".repeat(43), nonce: "n".repeat(32) })).rejects.toThrow("teacher_write_consent_unavailable");
  });

  it("adds the write scope only for the same verified Google subject and preserves the refresh token", async () => {
    const { store, provider } = providerFixture();
    await store.putGrant({ userId: "user-1", refreshToken: "existing-refresh-token", scopes: [...V2_TEACHER_SCOPES], createdAt: 10, updatedAt: 11 });
    const tokenExchange = vi.spyOn(OAuth2Client.prototype, "getToken").mockResolvedValue({ tokens: { scope: V2_TEACHER_WRITE_SCOPES.join(" "), id_token: "synthetic-id-token" } } as never);
    vi.spyOn(OAuth2Client.prototype, "verifyIdToken").mockResolvedValue({ getPayload: () => ({
      iss: "https://accounts.google.com", aud: "synthetic-google-client", azp: "synthetic-google-client",
      exp: Math.floor(Date.now() / 1000) + 300, iat: Math.floor(Date.now() / 1000), nonce: "n".repeat(32),
      sub: "stable-google-subject", email: "verified@example.test", email_verified: true,
    }) } as never);
    await provider.completeTeacherWriteConsent({ userId: "user-1", expectedGoogleSubject: "stable-google-subject", code: "synthetic-code", verifier: "v".repeat(43), nonce: "n".repeat(32) });
    expect((tokenExchange.mock.instances[0] as unknown as { redirectUri?: string }).redirectUri).toBe("https://classroom.example/auth/google/callback");
    expect(await store.getGrant("user-1")).toMatchObject({ refreshToken: "existing-refresh-token", scopes: expect.arrayContaining([...V2_TEACHER_WRITE_SCOPES]) });
  });

  it("does not fill missing coursework-write scopes from a previously stored grant", async () => {
    const { store, provider } = providerFixture();
    await store.putGrant({ userId: "user-1", refreshToken: "existing-refresh-token", scopes: [...V2_TEACHER_SCOPES], createdAt: 10, updatedAt: 11 });
    const incompleteScopes = V2_TEACHER_WRITE_SCOPES.filter(scope => scope !== V2_TEACHER_SCOPES[0]);
    vi.spyOn(OAuth2Client.prototype, "getToken").mockResolvedValue({ tokens: { scope: incompleteScopes.join(" "), id_token: "synthetic-id-token" } } as never);
    vi.spyOn(OAuth2Client.prototype, "verifyIdToken").mockResolvedValue({ getPayload: () => ({
      iss: "https://accounts.google.com", aud: "synthetic-google-client", azp: "synthetic-google-client",
      exp: Math.floor(Date.now() / 1000) + 300, iat: Math.floor(Date.now() / 1000), nonce: "n".repeat(32),
      sub: "stable-google-subject", email: "verified@example.test", email_verified: true,
    }) } as never);
    await expect(provider.completeTeacherWriteConsent({ userId: "user-1", expectedGoogleSubject: "stable-google-subject", code: "synthetic-code", verifier: "v".repeat(43), nonce: "n".repeat(32) })).rejects.toThrow("teacher_write_scope_mismatch");
    expect(await store.getGrant("user-1")).toMatchObject({ refreshToken: "existing-refresh-token", scopes: [...V2_TEACHER_SCOPES] });
  });

  it("does not replace the existing grant if identity or returned scopes do not match", async () => {
    const { store, provider } = providerFixture();
    await store.putGrant({ userId: "user-1", refreshToken: "existing-refresh-token", scopes: [...V2_TEACHER_SCOPES], createdAt: 10, updatedAt: 11 });
    vi.spyOn(OAuth2Client.prototype, "getToken").mockResolvedValue({ tokens: { scope: V2_TEACHER_WRITE_SCOPES.join(" "), id_token: "synthetic-id-token" } } as never);
    vi.spyOn(OAuth2Client.prototype, "verifyIdToken").mockResolvedValue({ getPayload: () => ({
      iss: "https://accounts.google.com", aud: "synthetic-google-client", azp: "synthetic-google-client",
      exp: Math.floor(Date.now() / 1000) + 300, iat: Math.floor(Date.now() / 1000), nonce: "n".repeat(32),
      sub: "different-google-subject", email: "verified@example.test", email_verified: true,
    }) } as never);
    await expect(provider.completeTeacherWriteConsent({ userId: "user-1", expectedGoogleSubject: "stable-google-subject", code: "synthetic-code", verifier: "v".repeat(43), nonce: "n".repeat(32) })).rejects.toThrow("teacher_write_google_account_mismatch");
    expect(await store.getGrant("user-1")).toMatchObject({ refreshToken: "existing-refresh-token", scopes: [...V2_TEACHER_SCOPES] });
  });
});
