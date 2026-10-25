import { createHash, randomBytes } from "node:crypto";
import { createServer as createNetServer } from "node:net";
import { OAuth2Client } from "googleapis-common";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PUBLIC_CLASSROOM_SCOPES } from "./config.js";
import { GOOGLE_CANONICAL_CLASSROOM_SCOPES } from "./scopes.js";
import { createPublicApp } from "./public/http.js";
import { MemoryPublicAuthStore } from "./public/store.js";
import { MCP_OFFLINE_SCOPE, MCP_SCOPE } from "./public/oauth.js";
import type { ClassroomClients } from "./classroom.js";

async function freePort() {
  const server = createNetServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
const mockClients = () => ({ classroom: { courses: { list: async () => ({ data: { courses: [{ id: "course-a", name: "Synthetic course", etag: "must-not-leak" }] } }) } } } as unknown as ClassroomClients);
afterEach(() => vi.restoreAllMocks());

describe("complete mocked public authorization path", () => {
  it("serves public pages without a database and does not expose protected routes", async () => {
    const port = await freePort(); const origin = `http://127.0.0.1:${port}`;
    const config = { origin: new URL(origin), mcpResource: new URL(`${origin}/mcp`), googleCallbackUrl: `${origin}/oauth/google/callback`, googleClientId: "mock", googleClientSecret: "mock", port, production: false };
    const { app } = createPublicApp(config, new MemoryPublicAuthStore(), undefined, undefined, mockClients, { publicOnly: true });
    const server = app.listen(port, "127.0.0.1"); await new Promise<void>((resolve) => server.once("listening", resolve));
    try {
      for (const path of ["/", "/pricing", "/connect", "/refunds", "/assets/connect.js"]) expect((await fetch(`${origin}${path}`)).status).toBe(200);
      expect((await fetch(`${origin}/app`)).status).toBe(404);
      expect((await fetch(`${origin}/admin`)).status).toBe(404);
      expect((await fetch(`${origin}/api/billing/subscription`, { method: "POST" })).status).toBe(404);
      expect((await fetch(`${origin}/mcp`)).status).toBe(404);
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  });

  it("serves the canonical conversion landing page and MCP installation guide", async () => {
    const port = await freePort(); const origin = `http://127.0.0.1:${port}`;
    const config = { origin: new URL(origin), mcpResource: new URL(`${origin}/mcp`), googleCallbackUrl: `${origin}/oauth/google/callback`, googleClientId: "mock", googleClientSecret: "mock", port, production: false };
    const { app } = createPublicApp(config, new MemoryPublicAuthStore());
    const server = app.listen(port, "127.0.0.1"); await new Promise<void>((resolve) => server.once("listening", resolve));
    try {
      const landing = await fetch(`${origin}/`); const landingHtml = await landing.text();
      expect(landing.status).toBe(200); expect(landingHtml).toContain("Built for "); expect(landingHtml).toContain("Classroom clarity"); expect(landingHtml).toContain("data-home-stage"); expect(landingHtml).toContain("data-stage-src"); expect(landingHtml).toContain("What deadlines are coming up?"); expect(landingHtml).toContain("Example conversation"); expect(landingHtml).not.toContain("Illustrative response"); expect(landingHtml).not.toContain("data-connect-modal"); expect(landingHtml).toContain('href="/connect"'); expect(landingHtml).toContain("data-connection-card"); expect(landingHtml).toContain("data-copy-mcp-card"); expect(landingHtml).toContain("Connect to ChatGPT"); expect(landingHtml).toContain("How it works"); expect(landingHtml).toContain("₹99"); expect(landingHtml).toContain("Questions, answered.");
      const guide = await fetch(`${origin}/connect`); const guideHtml = await guide.text();
      expect(guide.status).toBe(200); expect(guideHtml).toContain("https://classroom.jarvis404.com/mcp"); expect(guideHtml).toContain("data-copy-mcp"); expect(guideHtml).toContain("data-guide-step"); expect(guideHtml).toContain("Open ChatGPT"); expect(guideHtml).toContain("choose OAuth"); expect(guideHtml).toContain("Button names vary"); expect(guide.headers.get("content-security-policy")).toContain("script-src 'self'");
      const script = await fetch(`${origin}/assets/connect.js`); expect(script.status).toBe(200); expect(script.headers.get("content-type")).toContain("javascript"); expect(await script.text()).toContain("navigator.clipboard.writeText");
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  });

  it("connects through DCR, Google callback and MCP code exchange, then invokes a projected Classroom tool", async () => {
    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    const store = new MemoryPublicAuthStore();
    const config = { origin: new URL(origin), mcpResource: new URL(`${origin}/mcp`), googleCallbackUrl: `${origin}/oauth/google/callback`, googleClientId: "mock-google-client", googleClientSecret: "mock-google-secret", port, production: false };
    const { app } = createPublicApp(config, store, undefined, undefined, mockClients);
    const server = app.listen(port, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const redirectUri = `${origin}/client/callback`;
    vi.spyOn(OAuth2Client.prototype, "getToken").mockResolvedValue({ tokens: { refresh_token: "mock-google-refresh", access_token: "mock-google-access", scope: GOOGLE_CANONICAL_CLASSROOM_SCOPES.join(" ") } } as never);
    try {
      const register = await fetch(`${origin}/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Integration test", redirect_uris: [redirectUri], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }) });
      expect(register.status).toBe(201);
      const client = await register.json() as { client_id: string };
      const authorize = new URL(`${origin}/authorize`);
      for (const [key, value] of Object.entries({ response_type: "code", client_id: client.client_id, redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: "S256", state: "mcp-state", resource: `${origin}/mcp`, scope: `${MCP_SCOPE} ${MCP_OFFLINE_SCOPE}` })) authorize.searchParams.set(key, value);
      const authResponse = await fetch(authorize, { redirect: "manual" });
      expect(authResponse.status).toBe(302);
      const connectionUrl = authResponse.headers.get("location")!;
      expect(connectionUrl).toContain("/connect/google");
      const flow = new URL(connectionUrl).searchParams.get("flow")!;
      const connectPage = await fetch(connectionUrl);
      expect(connectPage.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
      expect(await connectPage.text()).toContain("No Google Drive access");
      const connect = await fetch(`${origin}/connect/google`, { method: "POST", redirect: "manual", headers: { origin, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ flow }) });
      expect(connect.status).toBe(303);
      const google = new URL(connect.headers.get("location")!);
      expect(google.searchParams.get("scope")?.split(" ").sort()).toEqual([...PUBLIC_CLASSROOM_SCOPES].sort());
      const userId = (await store.getFlow(flow))?.userId;
      expect(userId).toBeTruthy();
      const callback = await fetch(`${origin}/oauth/google/callback?state=${encodeURIComponent(google.searchParams.get("state")!)}&code=mock-code`, { redirect: "manual" });
      expect(callback.status).toBe(303);
      expect((await store.getGrant(userId!))?.scopes).toEqual(GOOGLE_CANONICAL_CLASSROOM_SCOPES);
      const clientCallback = new URL(callback.headers.get("location")!);
      expect(`${clientCallback.origin}${clientCallback.pathname}`).toBe(redirectUri);
      expect(clientCallback.searchParams.has("code")).toBe(true);
      expect(clientCallback.searchParams.get("state")).toBe("mcp-state");
      const wrongPkce = await fetch(`${origin}/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code: clientCallback.searchParams.get("code")!, redirect_uri: redirectUri, code_verifier: randomBytes(32).toString("base64url"), client_id: client.client_id, resource: `${origin}/mcp` }) });
      expect(wrongPkce.status).toBeGreaterThanOrEqual(400);
      const token = await fetch(`${origin}/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code: clientCallback.searchParams.get("code")!, redirect_uri: redirectUri, code_verifier: verifier, client_id: client.client_id, resource: `${origin}/mcp` }) });
      expect(token.status).toBe(200);
      const credentials = await token.json() as { access_token: string; refresh_token: string };
      const authorizationCodeReplay = await fetch(`${origin}/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code: clientCallback.searchParams.get("code")!, redirect_uri: redirectUri, code_verifier: verifier, client_id: client.client_id, resource: `${origin}/mcp` }) });
      expect(authorizationCodeReplay.status).toBeGreaterThanOrEqual(400);
      expect(credentials.access_token).not.toBe("mock-google-access");
      const headers = { authorization: `Bearer ${credentials.access_token}`, "content-type": "application/json", accept: "application/json, text/event-stream" };
      const init = await fetch(`${origin}/mcp`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "integration", version: "1" } } }) });
      expect(init.status).toBe(200);
      const session = init.headers.get("mcp-session-id")!;
      const call = await fetch(`${origin}/mcp`, { method: "POST", headers: { ...headers, "mcp-session-id": session }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_courses", arguments: {} } }) });
      expect(call.status).toBe(200);
      const answer = await call.text();
      expect(answer).toContain("Synthetic course");
      expect(answer).not.toContain("must-not-leak");
      expect(answer).not.toContain("mock-google-refresh");
      const refresh = await fetch(`${origin}/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: credentials.refresh_token, client_id: client.client_id, resource: `${origin}/mcp` }) });
      expect(refresh.status).toBe(200);
      const rotated = await refresh.json() as { access_token: string; refresh_token: string };
      expect(rotated.refresh_token).not.toBe(credentials.refresh_token);
      const replay = await fetch(`${origin}/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: credentials.refresh_token, client_id: client.client_id, resource: `${origin}/mcp` }) });
      expect(replay.status).toBeGreaterThanOrEqual(400);
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
  it("handles production stateless MCP requests without a process-local session", async () => {
    const port = await freePort(); const origin = `http://127.0.0.1:${port}`;
    const store = new MemoryPublicAuthStore();
    const config = { origin: new URL(origin), mcpResource: new URL(`${origin}/mcp`), googleCallbackUrl: `${origin}/oauth/google/callback`, googleClientId: "mock", googleClientSecret: "mock", port, production: true };
    const now = Date.now();
    await store.putGrant({ userId: "user-a", refreshToken: "mock-refresh", scopes: [...PUBLIC_CLASSROOM_SCOPES], createdAt: now, updatedAt: now });
    await store.putAccess({ token: "mcp-token", clientId: "client-a", userId: "user-a", scopes: [MCP_SCOPE], resource: config.mcpResource, expiresAt: now + 60000 });
    const { app } = createPublicApp(config, store, undefined, undefined, mockClients);
    const server = app.listen(port, "127.0.0.1"); await new Promise<void>((resolve) => server.once("listening", resolve));
    const headers = { authorization: "Bearer mcp-token", "content-type": "application/json", accept: "application/json, text/event-stream" };
    try {
      const init = await fetch(`${origin}/mcp`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } }) });
      expect(init.status).toBe(200);
      expect(init.headers.get("mcp-session-id")).toBeNull();
      const list = await fetch(`${origin}/mcp`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) });
      expect(list.status).toBe(200);
      expect(await list.text()).toContain("list_courses");
      const call = await fetch(`${origin}/mcp`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_courses", arguments: {} } }) });
      expect(call.status).toBe(200);
      expect(await call.text()).toContain("Synthetic course");
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
});
