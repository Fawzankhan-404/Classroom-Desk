import { createHash, randomBytes } from "node:crypto";
import { createServer as createNetServer } from "node:net";
import { OAuth2Client } from "googleapis-common";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GOOGLE_CANONICAL_CLASSROOM_SCOPES } from "../scopes.js";
import { createPublicApp } from "./http.js";
import { MCP_OFFLINE_SCOPE, MCP_SCOPE } from "./oauth.js";
import { MemoryPublicAuthStore } from "./store.js";

async function freePort() {
  const server = createNetServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function startHarness() {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const store = new MemoryPublicAuthStore();
  const config = {
    origin: new URL(origin), mcpResource: new URL(`${origin}/mcp`),
    googleCallbackUrl: `${origin}/oauth/google/callback`, googleClientId: "mock-google-client",
    googleClientSecret: "mock-google-secret", port, production: false,
  };
  const { app } = createPublicApp(config, store);
  const server = app.listen(port, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  return { origin, store, server };
}

async function registerClient(origin: string, redirectUri: string) {
  const response = await fetch(`${origin}/register`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Callback regression", redirect_uris: [redirectUri], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }),
  });
  expect(response.status).toBe(201);
  return await response.json() as { client_id: string };
}

async function beginAuthorization(origin: string, clientId: string, redirectUri: string, state: string) {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authorization = new URL(`${origin}/authorize`);
  for (const [key, value] of Object.entries({
    response_type: "code", client_id: clientId, redirect_uri: redirectUri,
    code_challenge: challenge, code_challenge_method: "S256", state,
    resource: `${origin}/mcp`, scope: `${MCP_SCOPE} ${MCP_OFFLINE_SCOPE}`,
  })) authorization.searchParams.set(key, value);
  const response = await fetch(authorization, { redirect: "manual" });
  return { response, verifier, connectUrl: response.headers.get("location") };
}

async function beginGoogle(origin: string, connectUrl: string) {
  const flowId = new URL(connectUrl).searchParams.get("flow")!;
  const response = await fetch(`${origin}/connect/google`, {
    method: "POST", redirect: "manual", headers: { origin, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ flow: flowId }),
  });
  expect(response.status).toBe(303);
  return { flowId, googleUrl: new URL(response.headers.get("location")!) };
}

afterEach(() => vi.restoreAllMocks());

describe("public OAuth callback behavior", () => {
  it("claims in-memory authorization codes and refresh tokens only once under concurrent replay", async () => {
    const store = new MemoryPublicAuthStore();
    const expiresAt = Date.now() + 60_000;
    await store.putCode({ code: "one-use-code", clientId: "client-a", userId: "user-a", redirectUri: "http://127.0.0.1/callback", challenge: "pkce", scopes: [MCP_SCOPE], expiresAt });
    await store.putRefresh({ token: "one-use-refresh", clientId: "client-a", userId: "user-a", scopes: [MCP_SCOPE], expiresAt });

    const [codes, refreshes] = await Promise.all([
      Promise.all(Array.from({ length: 16 }, () => store.takeCode("one-use-code"))),
      Promise.all(Array.from({ length: 16 }, () => store.takeRefresh("one-use-refresh"))),
    ]);
    expect(codes.filter(Boolean)).toHaveLength(1);
    expect(refreshes.filter(Boolean)).toHaveLength(1);
  });

  it("keeps callback code and state on first authorization and isolates a same-client reconnection identity", async () => {
    const { origin, store, server } = await startHarness();
    const redirectUri = `${origin}/chatgpt/callback`;
    const client = await registerClient(origin, redirectUri);
    const tokenExchange = vi.spyOn(OAuth2Client.prototype, "getToken")
      .mockResolvedValueOnce({ tokens: { refresh_token: "grant-a", access_token: "mock-access", scope: GOOGLE_CANONICAL_CLASSROOM_SCOPES.join(" ") } } as never)
      .mockResolvedValueOnce({ tokens: { refresh_token: "grant-b", access_token: "mock-access", scope: GOOGLE_CANONICAL_CLASSROOM_SCOPES.join(" ") } } as never);
    try {
      const first = await beginAuthorization(origin, client.client_id, redirectUri, "first-state");
      expect(first.response.status).toBe(302);
      const firstGoogle = await beginGoogle(origin, first.connectUrl!);
      const firstUserId = (await store.getFlow(firstGoogle.flowId))?.userId;
      expect(firstUserId).toBeTruthy();

      const firstCallback = await fetch(`${origin}/oauth/google/callback?state=${encodeURIComponent(firstGoogle.googleUrl.searchParams.get("state")!)}&code=first-google-code`, { redirect: "manual" });
      expect(firstCallback.status).toBe(303);
      const firstClientCallback = new URL(firstCallback.headers.get("location")!);
      expect(firstClientCallback.origin + firstClientCallback.pathname).toBe(redirectUri);
      expect(firstClientCallback.searchParams.get("state")).toBe("first-state");
      expect(firstClientCallback.searchParams.get("code")).toBeTruthy();

      const token = await fetch(`${origin}/token`, {
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "authorization_code", code: firstClientCallback.searchParams.get("code")!, redirect_uri: redirectUri, code_verifier: first.verifier, client_id: client.client_id, resource: `${origin}/mcp` }),
      });
      expect(token.status).toBe(200);
      expect((await token.json() as { access_token: string }).access_token).toBeTruthy();
      expect(await store.getGrant(firstUserId!)).toMatchObject({ refreshToken: "grant-a" });

      // A browser reload/duplicate callback must not mint another client code.
      const duplicateCallback = await fetch(`${origin}/oauth/google/callback?state=${encodeURIComponent(firstGoogle.googleUrl.searchParams.get("state")!)}&code=first-google-code`, { redirect: "manual" });
      expect(duplicateCallback.status).toBe(400);
      expect(duplicateCallback.headers.get("location")).toBeNull();
      const duplicateExchange = await fetch(`${origin}/token`, {
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "authorization_code", code: firstClientCallback.searchParams.get("code")!, redirect_uri: redirectUri, code_verifier: first.verifier, client_id: client.client_id, resource: `${origin}/mcp` }),
      });
      expect(duplicateExchange.status).toBeGreaterThanOrEqual(400);

      // A second authorization from the same registered MCP client is a new
      // Google/MCP subject. It must not overwrite or inherit the first grant.
      const second = await beginAuthorization(origin, client.client_id, redirectUri, "second-state");
      expect(second.response.status).toBe(302);
      const secondGoogle = await beginGoogle(origin, second.connectUrl!);
      const secondUserId = (await store.getFlow(secondGoogle.flowId))?.userId;
      expect(secondUserId).toBeTruthy();
      expect(secondUserId).not.toBe(firstUserId);
      const secondCallback = await fetch(`${origin}/oauth/google/callback?state=${encodeURIComponent(secondGoogle.googleUrl.searchParams.get("state")!)}&code=second-google-code`, { redirect: "manual" });
      expect(secondCallback.status).toBe(303);
      expect(new URL(secondCallback.headers.get("location")!).searchParams.get("state")).toBe("second-state");
      expect(await store.getGrant(secondUserId!)).toMatchObject({ refreshToken: "grant-b" });
      expect(await store.getGrant(firstUserId!)).toMatchObject({ refreshToken: "grant-a" });
      expect(tokenExchange).toHaveBeenCalledTimes(2);
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  });

  it("rejects absent or expired callback state and returns OAuth errors with the original state", async () => {
    const { origin, store, server } = await startHarness();
    const redirectUri = `${origin}/chatgpt/callback`;
    const client = await registerClient(origin, redirectUri);
    try {
      const missingState = await fetch(`${origin}/oauth/google/callback?code=orphan-code`, { redirect: "manual" });
      expect(missingState.status).toBe(400);
      expect(missingState.headers.get("location")).toBeNull();

      const missingCodeFlow = await beginAuthorization(origin, client.client_id, redirectUri, "missing-code-state");
      expect(missingCodeFlow.response.status).toBe(302);
      const missingCodeGoogle = await beginGoogle(origin, missingCodeFlow.connectUrl!);
      const missingCodeState = missingCodeGoogle.googleUrl.searchParams.get("state")!;
      const missingCode = await fetch(`${origin}/oauth/google/callback?state=${encodeURIComponent(missingCodeState)}`, { redirect: "manual" });
      expect(missingCode.status).toBe(303);
      const errorRedirect = new URL(missingCode.headers.get("location")!);
      expect(errorRedirect.searchParams.get("error")).toBe("access_denied");
      expect(errorRedirect.searchParams.get("state")).toBe("missing-code-state");
      expect(errorRedirect.searchParams.has("code")).toBe(false);

      const expired = await beginAuthorization(origin, client.client_id, redirectUri, "expired-state");
      expect(expired.response.status).toBe(302);
      const expiredGoogle = await beginGoogle(origin, expired.connectUrl!);
      const flow = await store.getFlow(expiredGoogle.flowId);
      expect(flow).toBeTruthy();
      flow!.expiresAt = Date.now() - 1;
      const expiredCallback = await fetch(`${origin}/oauth/google/callback?state=${encodeURIComponent(expiredGoogle.googleUrl.searchParams.get("state")!)}&code=late-google-code`, { redirect: "manual" });
      expect(expiredCallback.status).toBe(400);
      expect(expiredCallback.headers.get("location")).toBeNull();
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  });

  it("rejects an authorization redirect URI that was not registered by the client", async () => {
    const { origin, server } = await startHarness();
    try {
      const client = await registerClient(origin, `${origin}/registered/callback`);
      const request = await beginAuthorization(origin, client.client_id, `${origin}/unregistered/callback`, "redirect-state");
      expect(request.response.status).toBeGreaterThanOrEqual(400);
      expect(request.connectUrl).toBeNull();
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
});
