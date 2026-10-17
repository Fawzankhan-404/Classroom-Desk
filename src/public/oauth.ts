import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Response } from "express";
import { OAuth2Client } from "googleapis-common";
import type { OAuthServerProvider, AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { GoogleFlow, GoogleGrant, InternalCode, PublicAuthStore } from "./store.js";
import { hasTeacherClassroomScopes, isExactPublicGoogleGrant, isExactPublicTeacherGoogleGrant, PUBLIC_CLASSROOM_SCOPES, TEACHER_CLASSROOM_SCOPES } from "../scopes.js";
import { logGrantRefreshFailure, logGoogleAuthorizationFailure, logMcpTokenFailure } from "./log.js";

export const MCP_SCOPE = "mcp:tools";
export const MCP_OFFLINE_SCOPE = "offline_access";
const FLOW_TTL = 10 * 60 * 1000;
const CODE_TTL = 2 * 60 * 1000;
const ACCESS_TTL = 60 * 60;
const REFRESH_TTL = 30 * 24 * 60 * 60 * 1000;
const randomToken = () => randomBytes(32).toString("base64url");

export type PublicOAuthConfig = {
  origin: URL;
  googleClientId: string;
  googleClientSecret: string;
  googleCallbackUrl: string;
  mcpResource: URL;
  googleScopes?: readonly string[];
  googleGrantValidator?: (scopes: string[]) => boolean;
};

export type OAuthAccountSession = NonNullable<GoogleFlow["account"]> & { mcpUserId: string; displayName: string; legacyMcpUserId?: string };
export interface OAuthAccountBinding {
  session(cookie: string | undefined): Promise<OAuthAccountSession | null>;
  identify(identity: { googleSubject: string; email: string; displayName: string }): Promise<{ account: OAuthAccountSession; token: string }>;
  complete(flow: GoogleFlow, code: InternalCode, grant?: GoogleGrant): Promise<void>;
}

export class PublicOAuthProvider implements OAuthServerProvider {
  readonly clientsStore: PublicAuthStore;
  readonly skipLocalPkceValidation = false;
  constructor(readonly store: PublicAuthStore, readonly config: PublicOAuthConfig, readonly revokeGoogleToken?: (token: string) => Promise<void>, readonly accounts?: OAuthAccountBinding) { this.clientsStore = store; }
  private get googleScopes() { return this.config.googleScopes ?? PUBLIC_CLASSROOM_SCOPES; }

  private googleClient(redirectUri = this.config.googleCallbackUrl) {
    return new OAuth2Client(this.config.googleClientId, this.config.googleClientSecret, redirectUri);
  }

  async beginTeacherAuthorization(userId: string, state: string, verifier: string, callbackUrl: string): Promise<string> {
    if (!/^[A-Za-z0-9_-]{32}$/.test(state) || !/^[A-Za-z0-9_-]{40,64}$/.test(verifier)) throw new Error("teacher_authorization_state_invalid");
    const grant = await this.store.getGrant(userId);
    if (!grant?.googleSubject || !(this.config.googleGrantValidator ? this.config.googleGrantValidator(grant.scopes) : isExactPublicGoogleGrant(grant.scopes))) throw new Error("google_account_reconnect_required");
    const client = this.googleClient(callbackUrl);
    return client.generateAuthUrl({
      access_type: "offline", prompt: "consent", include_granted_scopes: true,
      scope: [...new Set([...grant.scopes, ...TEACHER_CLASSROOM_SCOPES, "openid", "email", "profile"])],
      state, nonce: state, code_challenge: createPkceChallenge(verifier), code_challenge_method: "S256",
    } as never);
  }

  async completeTeacherAuthorization(userId: string, state: string, code: string, verifier: string, callbackUrl: string): Promise<void> {
    if (!/^[A-Za-z0-9_-]{32}$/.test(state) || !/^[A-Za-z0-9_-]{40,64}$/.test(verifier) || code.length < 1 || code.length > 2048) throw new Error("teacher_authorization_state_invalid");
    const existing = await this.store.getGrant(userId);
    if (!existing?.googleSubject || !(this.config.googleGrantValidator ? this.config.googleGrantValidator(existing.scopes) : isExactPublicGoogleGrant(existing.scopes))) throw new Error("google_account_reconnect_required");
    const client = this.googleClient(callbackUrl);
    const { tokens } = await client.getToken({ code, codeVerifier: verifier });
    if (!tokens.id_token) throw new Error("google_identity_missing");
    const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: this.config.googleClientId });
    const identity = ticket.getPayload();
    if (!identity?.sub || identity.sub !== existing.googleSubject || identity.nonce !== state) throw new Error("google_identity_mismatch");
    const identityScopes = new Set(["openid", "email", "profile", "https://www.googleapis.com/auth/userinfo.email", "https://www.googleapis.com/auth/userinfo.profile"]);
    const granted = new Set((tokens.scope ?? "").split(/\s+/).filter((scope) => scope && !identityScopes.has(scope)));
    const validTeacherGrant = this.config.googleGrantValidator
      ? this.config.googleGrantValidator([...granted])
      : isExactPublicTeacherGoogleGrant([...granted]);
    if (!hasTeacherClassroomScopes([...granted]) || !validTeacherGrant) throw new Error("teacher_scope_mismatch");
    const current = await this.store.getGrant(userId);
    if (!current || current.googleSubject !== existing.googleSubject) throw new Error("google_identity_changed");
    await this.store.putGrant({ ...current, refreshToken: tokens.refresh_token ?? current.refreshToken, scopes: [...granted], updatedAt: Date.now() });
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    if (params.resource && params.resource.href !== this.config.mcpResource.href) throw new Error("Invalid resource");
    const requested = params.scopes ?? [];
    if (requested.some((scope) => scope !== MCP_SCOPE && scope !== MCP_OFFLINE_SCOPE) || (requested.length && !requested.includes(MCP_SCOPE))) throw new Error("Unsupported scope");
    const flow: GoogleFlow = {
      id: randomToken(), userId: randomUUID(), client, params, googleState: randomToken(), googleVerifier: randomToken(),
      expiresAt: Date.now() + FLOW_TTL, started: false,
    };
    if (this.accounts) {
      const browserToken = randomToken();
      flow.browserProof = createHash("sha256").update(browserToken).digest("hex");
      res.append("Set-Cookie", this.flowCookie(flow.id, browserToken));
    }
    await this.store.putFlow(flow);
    const connect = new URL("/connect/google", this.config.origin);
    connect.searchParams.set("flow", flow.id);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.redirect(302, connect.toString());
  }

  private flowCookie(id: string, token = "") {
    return `cd_oauth_${id}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${token ? 600 : 0}${this.config.origin.protocol === "https:" ? "; Secure" : ""}`;
  }

  private browserMatches(flow: GoogleFlow, cookie?: string) {
    const value = cookie?.split(";").map(value => value.trim()).find(value => value.startsWith(`cd_oauth_${flow.id}=`))?.split("=")[1];
    if (!value || !flow.browserProof) return false;
    const supplied = createHash("sha256").update(value).digest();
    const expected = Buffer.from(flow.browserProof, "hex");
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  }

  clearFlowCookie(id: string) { return this.flowCookie(id); }

  async beginGoogle(flowId: string, cookie?: string, selectAccount = false): Promise<string> {
    let flow = await this.store.getFlow(flowId);
    if (this.accounts) {
      if (!flow || !this.browserMatches(flow, cookie)) throw new Error("oauth_browser_mismatch");
      const account = selectAccount ? null : await this.accounts.session(cookie);
      if (account) {
        flow = await this.store.startAccountFlow(flowId, account.mcpUserId, { userId: account.userId, sessionId: account.sessionId, googleSubject: account.googleSubject });
        if (!flow) throw new Error("Authorization expired or already started");
      } else if (!(await this.store.setFlowStarted(flowId))) throw new Error("Authorization expired or already started");
      const grant = account ? await this.store.getGrant(flow.userId) ?? (account.legacyMcpUserId ? await this.store.getGrant(account.legacyMcpUserId) : undefined) : undefined;
      // Legacy grants without verified OIDC ownership are retained but require
      // one secure consent recovery before automatic reuse is permitted.
      if (grant && grant.googleSubject === account?.googleSubject) {
        try {
          const auth = await this.googleAuthForUser(grant.userId);
          if (!(await auth.getAccessToken()).token) throw new Error("Google grant unavailable");
          const claimed = await this.store.takeFlowByGoogleState(flow.googleState);
          if (!claimed) throw new Error("Authorization expired or already completed");
          return await this.finishAuthorization(claimed, grant.userId === flow.userId ? undefined : { ...grant, userId: flow.userId, updatedAt: Date.now() });
        } catch (error) {
          const reason = error instanceof Error ? error.message : "";
          // A temporary upstream failure must not silently request new consent.
          if (reason !== "Google grant unavailable" && !reason.includes("invalid_grant")) throw error;
        }
      }
    } else if (!flow || !(await this.store.setFlowStarted(flowId))) throw new Error("Authorization expired or already started");
    const client = this.googleClient();
    const url = client.generateAuthUrl({
      access_type: "offline", prompt: "consent", include_granted_scopes: false,
      scope: [...this.googleScopes, ...(this.accounts ? ["openid", "email", "profile"] : [])], state: flow.googleState,
      ...(this.accounts ? { nonce: flow.googleState, prompt: "select_account consent" } : {}),
      code_challenge: createPkceChallenge(flow.googleVerifier), code_challenge_method: "S256",
    } as never);
    return url;
  }

  async completeGoogle(state: string | undefined, code: string | undefined, error: string | undefined, cookie?: string, setSession?: (token: string) => void): Promise<string> {
    if (!state) throw new Error("Invalid authorization callback");
    const flow = await this.store.takeFlowByGoogleState(state);
    if (!flow || !flow.started) throw new Error("Invalid authorization callback");
    if (this.accounts && !this.browserMatches(flow, cookie)) throw new Error("oauth_browser_mismatch");
    if (flow.account) {
      const session = await this.accounts?.session(cookie);
      if (!session || session.userId !== flow.account.userId || session.sessionId !== flow.account.sessionId || session.googleSubject !== flow.account.googleSubject || session.mcpUserId !== flow.userId) throw new Error("website_session_changed_or_expired");
    }
    if (error || !code) {
      logGoogleAuthorizationFailure("google_denied");
      return this.clientErrorRedirect(flow, "access_denied");
    }
    const client = this.googleClient();
    let storedGrant = false;
    try {
      const { tokens } = await client.getToken({ code, codeVerifier: flow.googleVerifier });
      client.setCredentials(tokens);
      let websiteToken: string | undefined;
      let verifiedIdentity: { googleSubject: string; email: string; displayName: string } | undefined;
      if (this.accounts) {
        if (!tokens.id_token) throw new Error("google_identity_missing");
        const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: this.config.googleClientId });
        const identity = ticket.getPayload();
        if (!identity?.sub || identity.nonce !== flow.googleState || !identity.email || identity.email_verified !== true) throw new Error("google_identity_mismatch");
        if (flow.account && identity.sub !== flow.account.googleSubject) throw new Error("google_identity_mismatch");
        verifiedIdentity = { googleSubject: identity.sub, email: identity.email, displayName: identity.name || identity.email };
      }
      const identityScopes = new Set(["openid", "email", "profile", "https://www.googleapis.com/auth/userinfo.email", "https://www.googleapis.com/auth/userinfo.profile"]);
      const granted = new Set((tokens.scope ?? "").split(/\s+/).filter(scope => scope && !(this.accounts && identityScopes.has(scope))));
      const expected = new Set<string>(this.googleScopes);
      if (!tokens.refresh_token) {
        logGoogleAuthorizationFailure("missing_refresh_token");
        const revoke = tokens.access_token;
        if (revoke && !this.accounts) await client.revokeToken(revoke).catch(() => undefined);
        return this.clientErrorRedirect(flow, "access_denied");
      }
      if (!(this.config.googleGrantValidator ? this.config.googleGrantValidator([...granted]) : isExactPublicGoogleGrant([...granted]))) {
        logGoogleAuthorizationFailure("scope_mismatch", {
          missingScopes: [...expected].filter((scope) => !granted.has(scope)).length,
          extraScopes: [...granted].filter((scope) => !expected.has(scope)).length,
          missingScopeNames: [...expected].filter((scope) => !granted.has(scope)).map((scope) => scope.replace("https://www.googleapis.com/auth/", "")),
        });
        const revoke = tokens.refresh_token ?? tokens.access_token;
        if (revoke && !this.accounts) await client.revokeToken(revoke).catch(() => undefined);
        return this.clientErrorRedirect(flow, "access_denied");
      }
      if (this.accounts && !flow.account && verifiedIdentity) {
        const identified = await this.accounts.identify(verifiedIdentity);
        flow.account = { userId: identified.account.userId, sessionId: identified.account.sessionId, googleSubject: identified.account.googleSubject };
        flow.userId = identified.account.mcpUserId;
        websiteToken = identified.token;
      }
      const grant = { userId: flow.userId, refreshToken: tokens.refresh_token, scopes: [...granted], createdAt: Date.now(), updatedAt: Date.now(), ...(flow.account ? { googleSubject: flow.account.googleSubject } : {}) };
      if (!flow.account) { await this.store.putGrant(grant); storedGrant = true; }
      const redirect = await this.finishAuthorization(flow, flow.account ? grant : undefined);
      if (websiteToken) setSession?.(websiteToken);
      return redirect;
    } catch (error) {
      const reason = error instanceof Error ? error.message : "";
      logGoogleAuthorizationFailure(reason === "google_identity_missing" || reason === "google_identity_mismatch" || reason === "account_binding_conflict_or_session_expired" ? reason : "token_exchange_failed");
      if (storedGrant) await this.store.deleteUserAuthorization(flow.userId).catch(() => undefined);
      return this.clientErrorRedirect(flow, "server_error");
    }
  }

  private async finishAuthorization(flow: GoogleFlow, grant?: GoogleGrant): Promise<string> {
    const code: InternalCode = {
      code: randomToken(), clientId: flow.client.client_id, userId: flow.userId,
      redirectUri: flow.params.redirectUri, state: flow.params.state, challenge: flow.params.codeChallenge,
      resource: flow.params.resource ?? this.config.mcpResource, scopes: flow.params.scopes?.length ? flow.params.scopes : [MCP_SCOPE], expiresAt: Date.now() + CODE_TTL,
    };
    if (flow.account) {
      if (!this.accounts) throw new Error("account_binding_unavailable");
      await this.accounts.complete(flow, code, grant);
    } else await this.store.putCode(code);
    const target = new URL(flow.params.redirectUri);
    target.searchParams.set("code", code.code);
    if (flow.params.state !== undefined) target.searchParams.set("state", flow.params.state);
    console.log(JSON.stringify({ event: "mcp_oauth_callback_ready", codePresent: true, statePresent: flow.params.state !== undefined, unified: Boolean(flow.account) }));
    return target.toString();
  }

  private clientErrorRedirect(flow: GoogleFlow, code: string) {
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
    console.log(JSON.stringify({ event: "mcp_oauth_token_issued", refreshRotation: Boolean(oldRefreshToken) }));
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
    if (!grant || !(this.config.googleGrantValidator ? this.config.googleGrantValidator(grant.scopes) : isExactPublicGoogleGrant(grant.scopes))) throw new Error("Google grant unavailable");
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
