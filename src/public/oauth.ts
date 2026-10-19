import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Response } from "express";
import { OAuth2Client } from "googleapis-common";
import type { OAuthServerProvider, AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import { InvalidClientMetadataError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { GoogleAccountBinding, GoogleFlow, PublicAuthStore } from "./store.js";
import { isExactPublicGoogleGrant, PUBLIC_CLASSROOM_SCOPES } from "../scopes.js";
import { logGrantRefreshFailure, logGoogleAuthorizationFailure, logMcpTokenFailure } from "./log.js";

export const MCP_SCOPE = "mcp:tools";
export const MCP_OFFLINE_SCOPE = "offline_access";
const FLOW_TTL = 10 * 60 * 1000;
const CODE_TTL = 2 * 60 * 1000;
const ACCESS_TTL = 60 * 60;
const REFRESH_TTL = 30 * 24 * 60 * 60 * 1000;
const randomToken = () => randomBytes(32).toString("base64url");
const CHATGPT_MCP_REDIRECT_ORIGIN = "https://chatgpt.com";
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const GOOGLE_OAUTH_ERRORS = new Set([
  "access_denied", "invalid_request", "unauthorized_client", "unsupported_response_type",
  "invalid_scope", "server_error", "temporarily_unavailable", "interaction_required",
  "login_required", "consent_required",
]);

function safeGoogleOAuthError(error: string): string {
  return GOOGLE_OAUTH_ERRORS.has(error) ? error : "server_error";
}

function googleFailureCategory(error: unknown): "invalid_grant" | "invalid_client" | "invalid_request" | "identity_invalid" | "account_binding_conflict" | "storage_failure" | "other" {
  const value = error as { code?: unknown; message?: unknown; response?: { data?: { error?: unknown } } } | null;
  const code = typeof value?.response?.data?.error === "string" ? value.response.data.error : typeof value?.code === "string" ? value.code : value?.message;
  if (code === "invalid_grant" || code === "invalid_client" || code === "invalid_request") return code;
  if (code === "verified_google_identity_required" || code === "canonical_account_invalid") return "identity_invalid";
  if (code === "google_subject_account_conflict") return "account_binding_conflict";
  if (code === "database_unavailable" || code === "storage_unavailable") return "storage_failure";
  return "other";
}

export type PublicOAuthConfig = {
  origin: URL;
  googleClientId: string;
  googleClientSecret: string;
  googleCallbackUrl: string;
  /** Browser callback used by the authenticated incremental Teacher consent flow. */
  teacherGoogleCallbackUrl?: string;
  mcpResource: URL;
  googleScopes?: readonly string[];
  teacherScopes?: readonly string[];
  teacherGrantValidator?: (scopes: string[]) => boolean;
  teacherWriteScopes?: readonly string[];
  teacherWriteGrantValidator?: (scopes: string[]) => boolean;
  googleGrantValidator?: (scopes: string[]) => boolean;
  /** Validates the complete grant Google returns when incremental scopes are included. */
  googleAuthorizationGrantValidator?: (scopes: string[]) => boolean;
  googleStoredGrantValidator?: (scopes: string[]) => boolean;
  googleIdentityResolver?: (identity: VerifiedGoogleIdentity) => Promise<string | GoogleAccountBinding>;
};

export type VerifiedGoogleIdentity = { googleSubject: string; email: string; displayName: string };

export class PublicOAuthProvider implements OAuthServerProvider {
  readonly clientsStore: OAuthRegisteredClientsStore;
  readonly skipLocalPkceValidation = false;
  constructor(readonly store: PublicAuthStore, readonly config: PublicOAuthConfig, readonly revokeGoogleToken?: (token: string) => Promise<void>) {
    this.clientsStore = {
      getClient: (clientId) => store.getClient(clientId),
      ...(store.registerClient ? {
        registerClient: async (client) => {
          if (!client.redirect_uris.length || client.redirect_uris.some((uri) => !this.isAllowedMcpRedirectUri(uri))) {
            throw new InvalidClientMetadataError("Unsupported redirect URI");
          }
          return store.registerClient!(client);
        },
      } : {}),
    };
  }
  private get googleScopes() { return this.config.googleScopes ?? PUBLIC_CLASSROOM_SCOPES; }

  private isAllowedMcpRedirectUri(value: string | undefined): boolean {
    if (!value) return false;
    try {
      const redirect = new URL(value);
      if (redirect.username || redirect.password || redirect.search || redirect.hash || !["https:", "http:"].includes(redirect.protocol)) return false;
      const isChatGPTCallback = redirect.origin === CHATGPT_MCP_REDIRECT_ORIGIN
        && /^\/connector\/oauth\/[A-Za-z0-9_-]{1,128}$/.test(redirect.pathname)
        && !redirect.search && !redirect.hash;
      if (isChatGPTCallback) return true;
      return LOOPBACK_HOSTS.has(this.config.origin.hostname.toLowerCase())
        && redirect.protocol === "http:"
        && LOOPBACK_HOSTS.has(redirect.hostname.toLowerCase());
    } catch { return false; }
  }

  /** Applies the server callback policy and the SDK's loopback-port exception to a requested redirect. */
  isAllowedAuthorizationRedirect(client: OAuthClientInformationFull, requestedUri: string | undefined): boolean {
    if (!requestedUri || !this.isAllowedMcpRedirectUri(requestedUri)) return false;
    return client.redirect_uris.some((registeredUri) => {
      if (!this.isAllowedMcpRedirectUri(registeredUri)) return false;
      if (requestedUri === registeredUri) return true;
      try {
        const requested = new URL(requestedUri);
        const registered = new URL(registeredUri);
        return LOOPBACK_HOSTS.has(requested.hostname.toLowerCase())
          && LOOPBACK_HOSTS.has(registered.hostname.toLowerCase())
          && requested.protocol === registered.protocol
          && requested.hostname === registered.hostname
          && requested.pathname === registered.pathname
          && requested.search === registered.search;
      } catch { return false; }
    });
  }

  isAllowedFlowRedirect(flow: GoogleFlow): boolean {
    return this.isAllowedAuthorizationRedirect(flow.client, flow.params.redirectUri);
  }

  private googleClient(redirectUri = this.config.googleCallbackUrl) {
    return new OAuth2Client(this.config.googleClientId, this.config.googleClientSecret, redirectUri);
  }

  private teacherGoogleClient() {
    const redirectUri = this.config.teacherGoogleCallbackUrl;
    if (!redirectUri) throw new Error("teacher_consent_unavailable");
    const callback = new URL(redirectUri);
    if (callback.origin !== this.config.origin.origin || callback.pathname !== "/auth/google/callback" || callback.search || callback.hash) {
      throw new Error("teacher_callback_invalid");
    }
    return this.googleClient(callback.toString());
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    if (!this.isAllowedAuthorizationRedirect(client, params.redirectUri)) throw new Error("Unsupported MCP redirect origin");
    if (params.resource && params.resource.href !== this.config.mcpResource.href) throw new Error("Invalid resource");
    const requested = params.scopes ?? [];
    if (requested.some((scope) => scope !== MCP_SCOPE && scope !== MCP_OFFLINE_SCOPE) || (requested.length && !requested.includes(MCP_SCOPE))) throw new Error("Unsupported scope");
    const flow: GoogleFlow = {
      id: randomToken(), userId: randomUUID(), client, params, googleState: randomToken(), googleVerifier: randomToken(), googleNonce: randomToken(),
      expiresAt: Date.now() + FLOW_TTL, started: false,
    };
    await this.store.putFlow(flow);
    const connect = new URL("/connect/google", this.config.origin);
    connect.searchParams.set("flow", flow.id);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.redirect(302, connect.toString());
  }

  async googleGrantScopes(userId: string): Promise<string[]> {
    const grant = await this.store.getGrant(userId);
    return grant ? [...grant.scopes] : [];
  }

  async beginTeacherConsent(input: { userId: string; state: string; verifier: string; nonce: string }): Promise<string> {
    const grant = await this.store.getGrant(input.userId);
    const storedValidator = this.config.googleStoredGrantValidator ?? this.config.googleGrantValidator ?? isExactPublicGoogleGrant;
    if (!grant || !storedValidator(grant.scopes) || !this.config.teacherScopes?.length || !this.config.teacherGrantValidator) throw new Error("teacher_consent_unavailable");
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(input.state) || !/^[A-Za-z0-9_-]{32,128}$/.test(input.verifier) || !/^[A-Za-z0-9_-]{32,128}$/.test(input.nonce)) throw new Error("teacher_consent_state_invalid");
    return this.teacherGoogleClient().generateAuthUrl({
      access_type: "offline",
      prompt: "consent select_account",
      include_granted_scopes: true,
      scope: [...this.config.teacherScopes],
      state: input.state,
      nonce: input.nonce,
      code_challenge: createPkceChallenge(input.verifier),
      code_challenge_method: "S256",
    } as never);
  }

  /** Incrementally request the broader Google coursework-management grant only after a teacher explicitly starts this flow. */
  async beginTeacherWriteConsent(input: { userId: string; state: string; verifier: string; nonce: string }): Promise<string> {
    const grant = await this.store.getGrant(input.userId);
    const storedValidator = this.config.googleStoredGrantValidator ?? this.config.googleGrantValidator ?? isExactPublicGoogleGrant;
    if (!grant || !storedValidator(grant.scopes) || !this.config.teacherGrantValidator?.(grant.scopes)
      || !this.config.teacherWriteScopes?.length || !this.config.teacherWriteGrantValidator) throw new Error("teacher_write_consent_unavailable");
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(input.state) || !/^[A-Za-z0-9_-]{32,128}$/.test(input.verifier) || !/^[A-Za-z0-9_-]{32,128}$/.test(input.nonce)) throw new Error("teacher_consent_state_invalid");
    return this.teacherGoogleClient().generateAuthUrl({
      access_type: "offline",
      prompt: "consent select_account",
      include_granted_scopes: true,
      scope: [...this.config.teacherWriteScopes],
      state: input.state,
      nonce: input.nonce,
      code_challenge: createPkceChallenge(input.verifier),
      code_challenge_method: "S256",
    } as never);
  }

  /** Incrementally add teacher read scopes to the same verified Google subject. */
  async completeTeacherConsent(input: { userId: string; expectedGoogleSubject: string; code: string; verifier: string; nonce: string }): Promise<void> {
    const existing = await this.store.getGrant(input.userId);
    const storedValidator = this.config.googleStoredGrantValidator ?? this.config.googleGrantValidator ?? isExactPublicGoogleGrant;
    if (!existing || !storedValidator(existing.scopes) || !this.config.teacherGrantValidator) throw new Error("teacher_grant_unavailable");
    const client = this.teacherGoogleClient();
    const { tokens } = await client.getToken({ code: input.code, codeVerifier: input.verifier });
    const claims = await this.verifiedGoogleClaims(tokens.id_token, input.nonce);
    if (claims.sub !== input.expectedGoogleSubject) throw new Error("teacher_google_account_mismatch");
    const grantedScopes = (tokens.scope ?? "").split(/\s+/).filter(Boolean);
    if (!this.config.teacherGrantValidator(grantedScopes) || !storedValidator(grantedScopes)) throw new Error("teacher_scope_mismatch");
    const refreshToken = tokens.refresh_token ?? existing.refreshToken;
    if (!refreshToken) throw new Error("teacher_refresh_token_unavailable");
    await this.store.putGrant({ ...existing, refreshToken, scopes: grantedScopes, updatedAt: Date.now() });
  }

  /** Store the expanded grant only when Google confirms the same stable subject and the full required scope set. */
  async completeTeacherWriteConsent(input: { userId: string; expectedGoogleSubject: string; code: string; verifier: string; nonce: string }): Promise<void> {
    const existing = await this.store.getGrant(input.userId);
    const storedValidator = this.config.googleStoredGrantValidator ?? this.config.googleGrantValidator ?? isExactPublicGoogleGrant;
    if (!existing || !storedValidator(existing.scopes) || !this.config.teacherGrantValidator?.(existing.scopes) || !this.config.teacherWriteGrantValidator) throw new Error("teacher_write_grant_unavailable");
    const client = this.teacherGoogleClient();
    const { tokens } = await client.getToken({ code: input.code, codeVerifier: input.verifier });
    const claims = await this.verifiedGoogleClaims(tokens.id_token, input.nonce);
    if (claims.sub !== input.expectedGoogleSubject) throw new Error("teacher_write_google_account_mismatch");
    const grantedScopes = (tokens.scope ?? "").split(/\s+/).filter(Boolean);
    if (!this.config.teacherWriteGrantValidator(grantedScopes) || !storedValidator(grantedScopes)) throw new Error("teacher_write_scope_mismatch");
    const refreshToken = tokens.refresh_token ?? existing.refreshToken;
    if (!refreshToken) throw new Error("teacher_refresh_token_unavailable");
    await this.store.putGrant({ ...existing, refreshToken, scopes: grantedScopes, updatedAt: Date.now() });
  }

  async beginGoogle(flowId: string): Promise<string> {
    const flow = await this.store.getFlow(flowId);
    if (!flow || !this.isAllowedFlowRedirect(flow) || !(await this.store.setFlowStarted(flowId))) throw new Error("Authorization expired, invalid, or already started");
    const client = this.googleClient();
    const url = client.generateAuthUrl({
      access_type: "offline", prompt: "consent", include_granted_scopes: true,
      scope: [...this.googleScopes], state: flow.googleState,
      ...(this.config.googleIdentityResolver ? { nonce: flow.googleNonce ?? flow.googleState } : {}),
      code_challenge: createPkceChallenge(flow.googleVerifier), code_challenge_method: "S256",
    } as never);
    return url;
  }

  async completeGoogle(state: string | undefined, code: string | undefined, error: string | undefined): Promise<string> {
    if (!state) throw new Error("Invalid authorization callback");
    const flow = await this.store.takeFlowByGoogleState(state);
    if (!flow || !flow.started || !this.isAllowedFlowRedirect(flow)) throw new Error("Invalid authorization callback");
    if (error) {
      logGoogleAuthorizationFailure("google_denied", { source: "provider", providerErrorCategory: error });
      return this.clientErrorRedirect(flow, safeGoogleOAuthError(error));
    }
    if (!code) {
      logGoogleAuthorizationFailure("callback_missing_code", { source: "worker", providerErrorCategory: "missing_code" });
      return this.clientErrorRedirect(flow, "server_error");
    }
    const client = this.googleClient();
    let failureStage: "google_token_exchange" | "google_identity_binding" | "grant_persistence" = "google_token_exchange";
    try {
      const { tokens } = await client.getToken({ code, codeVerifier: flow.googleVerifier });
      client.setCredentials(tokens);
      const grantedScopes = (tokens.scope ?? "").split(/\s+/).filter(Boolean);
      const granted = new Set(grantedScopes);
      const expected = new Set<string>(this.googleScopes);
      const validator = this.config.googleGrantValidator ?? isExactPublicGoogleGrant;
      const authorizationGrantValidator = this.config.googleAuthorizationGrantValidator ?? validator;
      if (!authorizationGrantValidator(grantedScopes)) {
        logGoogleAuthorizationFailure("scope_mismatch", {
          missingScopes: [...expected].filter((scope) => !granted.has(scope)).length,
          extraScopes: [...granted].filter((scope) => !expected.has(scope)).length,
          missingScopeNames: [...expected].filter((scope) => !granted.has(scope)).map((scope) => scope.replace("https://www.googleapis.com/auth/", "")),
        });
        return this.clientErrorRedirect(flow, "access_denied");
      }
      let grantUserId = flow.userId;
      let accountBinding: GoogleAccountBinding | undefined;
      if (this.config.googleIdentityResolver) {
        failureStage = "google_identity_binding";
        const resolved = await this.resolveGoogleIdentity(client, tokens.id_token, flow.googleNonce ?? "");
        grantUserId = resolved.mcpUserId;
        accountBinding = resolved;
      }
      const existingGrant = this.config.googleIdentityResolver ? await this.store.getGrant(grantUserId) : undefined;
      const refreshToken = tokens.refresh_token ?? existingGrant?.refreshToken;
      if (!refreshToken) {
        logGoogleAuthorizationFailure("missing_refresh_token");
        return this.clientErrorRedirect(flow, "server_error");
      }
      // Google returns the scopes represented by this combined authorization.
      // Never union an old grant into a new response: the user may have revoked
      // an incremental permission since the previous connection.
      const storedScopes = [...granted];
      const storedValidator = this.config.googleStoredGrantValidator ?? validator;
      if (!storedValidator(storedScopes)) {
        logGoogleAuthorizationFailure("stored_grant_scope_mismatch");
        return this.clientErrorRedirect(flow, "server_error");
      }
      const mcpCode = randomToken();
      const authorizationCode = {
        code: mcpCode, clientId: flow.client.client_id, userId: grantUserId,
        redirectUri: flow.params.redirectUri, state: flow.params.state,
        challenge: flow.params.codeChallenge, resource: flow.params.resource ?? this.config.mcpResource,
        scopes: flow.params.scopes?.length ? flow.params.scopes : [MCP_SCOPE], expiresAt: Date.now() + CODE_TTL,
      };
      failureStage = "grant_persistence";
      await this.store.putGrantAndCode({
        userId: grantUserId,
        refreshToken,
        scopes: storedScopes,
        createdAt: existingGrant?.createdAt ?? Date.now(),
        updatedAt: Date.now(),
      }, authorizationCode, accountBinding);
      const target = new URL(flow.params.redirectUri);
      target.searchParams.set("code", mcpCode);
      if (flow.params.state !== undefined) target.searchParams.set("state", flow.params.state);
      return target.toString();
    } catch (error) {
      logGoogleAuthorizationFailure("callback_processing_failed", { stage: failureStage, failureCategory: googleFailureCategory(error) });
      return this.clientErrorRedirect(flow, "server_error");
    }
  }

  private async resolveGoogleIdentity(client: OAuth2Client, idToken: string | null | undefined, expectedNonce: string): Promise<GoogleAccountBinding> {
    const payload = await this.verifiedGoogleClaims(idToken, expectedNonce, client);
    const resolved = await this.config.googleIdentityResolver!({
      googleSubject: payload.sub,
      email: payload.email,
      displayName: payload.name ?? payload.email,
    });
    const binding = typeof resolved === "string" ? { accountId: resolved, mcpUserId: resolved } : resolved;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(binding.accountId)
      || typeof binding.mcpUserId !== "string" || binding.mcpUserId.length < 1 || binding.mcpUserId.length > 256 || /[\u0000-\u001f\u007f]/.test(binding.mcpUserId)) throw new Error("canonical_account_invalid");
    return binding;
  }

  private async verifiedGoogleClaims(idToken: string | null | undefined, expectedNonce: string, client = this.googleClient()): Promise<{ sub: string; email: string; name?: string }> {
    if (!idToken || !expectedNonce) throw new Error("verified_google_identity_required");
    const ticket = await client.verifyIdToken({ idToken, audience: this.config.googleClientId });
    const payload = ticket.getPayload();
    const audience = payload?.aud;
    const audienceMatches = audience === this.config.googleClientId
      || (Array.isArray(audience) && audience.includes(this.config.googleClientId)
        && (audience.length === 1 || payload?.azp === this.config.googleClientId));
    const now = Math.floor(Date.now() / 1000);
    if (!payload
      || (payload.iss !== "accounts.google.com" && payload.iss !== "https://accounts.google.com")
      || !audienceMatches
      || (payload.azp !== undefined && payload.azp !== this.config.googleClientId)
      || typeof payload.exp !== "number" || payload.exp <= now
      || typeof payload.iat !== "number" || payload.iat > now + 60
      || payload.nonce !== expectedNonce
      || typeof payload.sub !== "string" || !/^[A-Za-z0-9_-]{8,256}$/.test(payload.sub)
      || typeof payload.email !== "string" || payload.email.length > 320
      || !/^[^\s@]+@[^\s@]+$/.test(payload.email)
      || payload.email_verified !== true) throw new Error("verified_google_identity_required");
    return { sub: payload.sub, email: payload.email, ...(typeof payload.name === "string" && payload.name.trim() ? { name: payload.name.trim().slice(0, 256) } : {}) };
  }

  private clientErrorRedirect(flow: GoogleFlow, code: string) {
    if (!this.isAllowedFlowRedirect(flow)) throw new Error("Invalid authorization callback destination");
    const target = new URL(flow.params.redirectUri);
    target.searchParams.set("error", code);
    if (flow.params.state !== undefined) target.searchParams.set("state", flow.params.state);
    return target.toString();
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string) {
    const code = await this.store.getCode(authorizationCode);
    if (!code || code.clientId !== client.client_id) throw new Error("Invalid authorization code");
    return code.challenge;
  }

  async exchangeAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string, _codeVerifier?: string, redirectUri?: string, resource?: URL): Promise<OAuthTokens> {
    const row = await this.store.getCode(authorizationCode);
    if (!row) { logMcpTokenFailure("authorization_code", "missing"); throw new Error("Invalid authorization code"); }
    if (row.clientId !== client.client_id) { logMcpTokenFailure("authorization_code", "client_mismatch"); throw new Error("Invalid authorization code"); }
    if (row.redirectUri !== redirectUri) { logMcpTokenFailure("authorization_code", "redirect_mismatch"); throw new Error("Invalid authorization code"); }
    if (!sameResource(row.resource, resource ?? this.config.mcpResource)) { logMcpTokenFailure("authorization_code", "resource_mismatch"); throw new Error("Invalid authorization code"); }
    const grant = await this.store.getGrant(row.userId);
    if (!grant) { logMcpTokenFailure("authorization_code", "grant_missing"); throw new Error("Google grant unavailable"); }
    if (!(await this.store.takeCode(authorizationCode))) { logMcpTokenFailure("authorization_code", "already_used"); throw new Error("Invalid authorization code"); }
    return this.issueTokens(client.client_id, row.userId, row.scopes, row.resource);
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string, scopes?: string[], resource?: URL): Promise<OAuthTokens> {
    const row = await this.store.getRefresh(refreshToken);
    const invalidScopes = scopes !== undefined && (!scopes.includes(MCP_OFFLINE_SCOPE) || scopes.some((scope) => !row?.scopes.includes(scope)));
    if (!row) { logMcpTokenFailure("refresh_token", "missing"); throw new Error("Invalid refresh token"); }
    if (row.clientId !== client.client_id) { logMcpTokenFailure("refresh_token", "client_mismatch"); throw new Error("Invalid refresh token"); }
    if (!row.scopes.includes(MCP_OFFLINE_SCOPE) || invalidScopes) { logMcpTokenFailure("refresh_token", "scope_mismatch"); throw new Error("Invalid refresh token"); }
    if (!sameResource(row.resource, resource ?? this.config.mcpResource)) { logMcpTokenFailure("refresh_token", "resource_mismatch"); throw new Error("Invalid refresh token"); }
    if (!(await this.store.getGrant(row.userId))) { logMcpTokenFailure("refresh_token", "grant_missing"); throw new Error("Google grant unavailable"); }
    return this.issueTokens(row.clientId, row.userId, scopes?.length ? scopes : row.scopes, row.resource, refreshToken);
  }

  private async issueTokens(clientId: string, userId: string, scopes: string[], resource?: URL, oldRefreshToken?: string): Promise<OAuthTokens> {
    const access = randomToken(); const expiresAt = Math.floor(Date.now() / 1000) + ACCESS_TTL;
    const accessRecord = { token: access, clientId, userId, scopes, resource, expiresAt: expiresAt * 1000 };
    if (!scopes.includes(MCP_OFFLINE_SCOPE)) {
      await this.store.putAccess(accessRecord);
      return { access_token: access, token_type: "bearer", expires_in: ACCESS_TTL, scope: scopes.join(" ") };
    }
    const refresh = randomToken();
    const refreshRecord = { token: refresh, clientId, userId, scopes, resource, expiresAt: Date.now() + REFRESH_TTL };
    if (oldRefreshToken) {
      if (!(await this.store.rotateTokenPair(oldRefreshToken, clientId, accessRecord, refreshRecord))) { logMcpTokenFailure("refresh_token", "rotation_rejected"); throw new Error("Invalid refresh token"); }
    } else await this.store.putTokenPair(accessRecord, refreshRecord);
    return { access_token: access, refresh_token: refresh, token_type: "bearer", expires_in: ACCESS_TTL, scope: scopes.join(" ") };
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const row = await this.store.getAccess(token);
    if (!row || row.expiresAt <= Date.now()) throw new Error("Invalid access token");
    return { token, clientId: row.clientId, scopes: row.scopes, expiresAt: Math.floor(row.expiresAt / 1000), resource: row.resource, extra: { userId: row.userId } };
  }

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    await this.store.deleteClientToken(request.token, client.client_id);
  }

  async googleAuthForUser(userId: string): Promise<OAuth2Client> {
    const grant = await this.store.getGrant(userId);
    const validator = this.config.googleStoredGrantValidator ?? this.config.googleGrantValidator ?? isExactPublicGoogleGrant;
    if (!grant || !validator(grant.scopes)) throw new Error("Google grant unavailable");
    const auth = this.googleClient();
    auth.setCredentials({ refresh_token: grant.refreshToken });
    auth.on("tokens", (tokens) => { if (tokens.refresh_token) void this.store.updateGrantRefreshToken(userId, tokens.refresh_token).catch(logGrantRefreshFailure); });
    return auth;
  }

  async disconnectGoogle(userId: string): Promise<{ revoked: boolean }> {
    const grant = await this.store.getGrant(userId);
    if (!grant) { await this.store.deleteUserAuthorization(userId); return { revoked: true }; }
    let revoked = false;
    try { if (this.revokeGoogleToken) await this.revokeGoogleToken(grant.refreshToken); else await this.googleClient().revokeToken(grant.refreshToken); revoked = true; }
    catch { /* Local deletion still disconnects this app's access; report revocation status. */ }
    await this.store.deleteUserAuthorization(userId);
    return { revoked };
  }
}

function sameResource(a?: URL, b?: URL) { return (a?.href ?? "") === (b?.href ?? ""); }
function createPkceChallenge(verifier: string) {
  return createHash("sha256").update(verifier).digest("base64url");
}
