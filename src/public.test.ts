import crypto from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { PUBLIC_CLASSROOM_SCOPES } from "./config.js";
import { createPublicApp } from "./public/http.js";
import { loadRuntimeConfig } from "./public/config.js";
import { MCP_OFFLINE_SCOPE, MCP_SCOPE, PublicOAuthProvider, type PublicOAuthConfig } from "./public/oauth.js";
import { MemoryPublicAuthStore } from "./public/store.js";
import { OAuth2Client } from "googleapis-common";
import { mapCourse, mapMaterial, publicError } from "./public/mappers.js";

const authConfig: PublicOAuthConfig = {
  origin: new URL("http://127.0.0.1"), mcpResource: new URL("http://127.0.0.1/mcp"),
  googleCallbackUrl: "http://127.0.0.1/oauth/google/callback", googleClientId: "client-test", googleClientSecret: "secret-test",
};
const runtimeConfig = { ...authConfig, port: 0, production: false };

async function setup(config: PublicOAuthConfig = authConfig) {
  const store = new MemoryPublicAuthStore();
  let revoked: string[] = [];
  const provider = new PublicOAuthProvider(store, config, async (token) => { revoked.push(token); });
  const { app } = createPublicApp({ ...runtimeConfig, ...config }, store, provider);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  async function seedUser(userId: string, accessToken: string) {
    await store.putGrant({ userId, refreshToken: `google-refresh-${userId}`, scopes: [...PUBLIC_CLASSROOM_SCOPES], createdAt: Date.now(), updatedAt: Date.now() });
    await store.putAccess({ token: accessToken, clientId: "test-client", userId, scopes: [MCP_SCOPE], resource: authConfig.mcpResource, expiresAt: Date.now() + 60_000 });
  }
  return { app, store, provider, origin, server, seedUser, get revoked() { return revoked; } };
}

async function close(server: Server) {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
const bearer = (token: string) => ({ authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" });
const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test-client", version: "1" } } };

describe("public V1 scopes and projections", () => {
  it("contains exactly the six Classroom read scopes and no Drive or write scope", () => {
    expect(PUBLIC_CLASSROOM_SCOPES).toHaveLength(6);
    expect(PUBLIC_CLASSROOM_SCOPES.every((scope) => scope.includes("classroom.") && scope.endsWith(".readonly"))).toBe(true);
    expect(PUBLIC_CLASSROOM_SCOPES.some((scope) => scope.includes("drive.") || !scope.endsWith(".readonly"))).toBe(false);
  });
  it("maps only useful course/material fields and advertises unavailable attachment bodies", () => {
    expect(mapCourse({ id: "course-1", name: "Biology", etag: "private", ownerId: "other-user", alternateLink: "https://private" })).toEqual({ id: "course-1", name: "Biology" });
    const mapped = mapMaterial({ materials: [{ driveFile: { driveFile: { id: "private-drive-id", title: "Teacher notes", alternateLink: "https://drive.google.com/file/d/private-drive-id" } } }] });
    expect(mapped.materials[0]).not.toHaveProperty("id");
    expect(mapped.materials[0]).toHaveProperty("url", "https://drive.google.com/file/d/private-drive-id");
    expect(mapped.materials[0]).toMatchObject({ title: "Teacher notes", type: "Drive attachment", attachment_content_available: false, reason: "Public V1 does not request Google Drive access." });
  });
  it("maps upstream failures without copying messages or response bodies", () => {
    expect(publicError({ response: { status: 403, data: { token: "secret", message: "private" } }, message: "private path C:\\" })).toMatch(/Permission not granted/);
    expect(publicError({ response: { status: 401 }, message: "Bearer secret" })).toMatch(/authorization expired/i);
  });
  it("rejects invalid public origin, callback, resource and port configuration", () => {
    const base = { GOOGLE_OAUTH_CLIENT_ID: "test-id", GOOGLE_OAUTH_CLIENT_SECRET: "test-secret", PUBLIC_APP_ORIGIN: "https://classroom.example" };
    expect(() => loadRuntimeConfig({ ...base, NODE_ENV: "production", PUBLIC_APP_ORIGIN: "http://classroom.example" })).toThrow("HTTPS");
    expect(() => loadRuntimeConfig({ ...base, MCP_RESOURCE_URL: "https://other.example/mcp" })).toThrow("MCP_RESOURCE_URL");
    expect(() => loadRuntimeConfig({ ...base, GOOGLE_OAUTH_CALLBACK_URL: "https://other.example/oauth/google/callback" })).toThrow("Google callback");
    expect(() => loadRuntimeConfig({ ...base, PORT: "0" })).toThrow("PORT");
    expect(() => loadRuntimeConfig({ ...base, NODE_ENV: "production", PUBLIC_AUTH_STORE: "memory" })).toThrow("encrypted persistent authorization store");
    expect(() => loadRuntimeConfig({ ...base, NODE_ENV: "production", PUBLIC_AUTH_STORE: "postgres" })).toThrow("DATABASE_URL");
    expect(loadRuntimeConfig({ ...base, NODE_ENV: "production", PUBLIC_AUTH_STORE: "d1", PUBLIC_AUTH_ENCRYPTION_KEY_B64: Buffer.alloc(32).toString("base64"), PUBLIC_OPERATOR_NAME: "Classroom Desk", PUBLIC_SUPPORT_EMAIL: "support@example.com" }).storeKind).toBe("d1");
  });
});

describe("public OAuth and HTTP authorization boundary", () => {
  it("limits unauthenticated readiness probes", async () => {
    const ctx = await setup();
    try {
      for (let i = 0; i < 30; i++) expect((await fetch(`${ctx.origin}/ready`)).status).toBe(200);
      expect((await fetch(`${ctx.origin}/ready`)).status).toBe(429);
    } finally { await close(ctx.server); }
  });
  it("issues no MCP refresh token without offline_access", async () => {
    const store = new MemoryPublicAuthStore();
    const provider = new PublicOAuthProvider(store, authConfig);
    const client = { client_id: "client-a" } as never;
    const now = Date.now();
    await store.putGrant({ userId: "user-a", refreshToken: "google-test-token", scopes: [...PUBLIC_CLASSROOM_SCOPES], createdAt: now, updatedAt: now });
    await store.putCode({ code: "code-a", clientId: "client-a", userId: "user-a", redirectUri: "http://127.0.0.1/client", challenge: "challenge", resource: authConfig.mcpResource, scopes: [MCP_SCOPE], expiresAt: now + 60_000 });
    const issued = await provider.exchangeAuthorizationCode(client, "code-a", undefined, "http://127.0.0.1/client", authConfig.mcpResource);
    expect(issued.access_token).toBeTruthy();
    expect(issued.refresh_token).toBeUndefined();
    expect((await store.getAccess(issued.access_token))?.scopes).toEqual([MCP_SCOPE]);
  });
  it("does not let one MCP client revoke another client's token", async () => {
    const store = new MemoryPublicAuthStore();
    const provider = new PublicOAuthProvider(store, authConfig);
    await store.putAccess({ token: "client-a-token", clientId: "client-a", userId: "user-a", scopes: [MCP_SCOPE], resource: authConfig.mcpResource, expiresAt: Date.now() + 60_000 });
    await provider.revokeToken({ client_id: "client-b" } as never, { token: "client-a-token" });
    expect(await store.getAccess("client-a-token")).toBeDefined();
    await provider.revokeToken({ client_id: "client-a" } as never, { token: "client-a-token" });
    expect(await store.getAccess("client-a-token")).toBeUndefined();
  });
  it("exposes a safe health route and standard OAuth discovery without Google Drive scopes", async () => {
    const ctx = await setup();
    try {
      const health = await fetch(`${ctx.origin}/health`);
      expect(await health.json()).toEqual({ status: "ok" });
      const metadata = await fetch(`${ctx.origin}/.well-known/oauth-authorization-server`);
      expect(metadata.status).toBe(200);
      const body = await metadata.json() as { scopes_supported?: string[]; authorization_endpoint?: string; token_endpoint?: string };
      expect(body.scopes_supported).toEqual([MCP_SCOPE, MCP_OFFLINE_SCOPE]);
      expect(body.authorization_endpoint).toContain("/authorize");
      expect(body.token_endpoint).toContain("/token");
    } finally { await close(ctx.server); }
  });
  it("uses the SVG brand as the primary site logo while retaining the legacy favicon endpoint", async () => {
    const ctx = await setup();
    try {
      const home = await fetch(`${ctx.origin}/`);
      const html = await home.text();
      expect(html).toContain('rel="icon" type="image/svg+xml"');
      expect(html).toContain('/assets/classroom-desk-favicon.svg');
      expect(html).not.toContain('/assets/classroom-desk.jpg');
      const vector = await fetch(`${ctx.origin}/assets/classroom-desk-favicon.svg`);
      expect(vector.status).toBe(200);
      expect(vector.headers.get("content-type")).toContain("image/svg+xml");
      const svg = await vector.text();
      expect(svg).toContain('viewBox="0 0 32 32"');
      expect(svg).toContain('aria-label="Classroom Desk logo"');
      expect(svg).toContain("#087a52");
      expect(svg).not.toContain("classroom-desk.jpg");
      const logo = await fetch(`${ctx.origin}/assets/classroom-desk-logo.svg`);
      expect(logo.status).toBe(200);
      expect(await logo.text()).toContain('viewBox="0 0 96 96"');
      const social = await fetch(`${ctx.origin}/assets/classroom-desk-social-card.png`);
      expect(social.status).toBe(200);
      expect(social.headers.get("content-type")).toContain("image/png");
      const png = new Uint8Array(await social.arrayBuffer());
      expect(Array.from(png.slice(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
      expect(new DataView(png.buffer, png.byteOffset, png.byteLength).getUint32(16)).toBe(1200);
      expect(new DataView(png.buffer, png.byteOffset, png.byteLength).getUint32(20)).toBe(630);
    } finally { await close(ctx.server); }
  });
  it("keeps homepage SEO metadata inside a valid head without CSS leakage", async () => {
    const ctx = await setup();
    try {
      const response = await fetch(`${ctx.origin}/`);
      const html = await response.text();
      expect(response.status).toBe(200);
      expect(html).toMatch(/<head>[\s\S]*<title>Classroom Desk \| Google Classroom Meets ChatGPT<\/title>[\s\S]*<\/head>/);
      expect(html.match(/<title>/g)?.length).toBe(1);
      expect(html).toContain('<meta name="description" content="Connect Google Classroom with ChatGPT. Access coursework, manage assignments, and stay organized.">');
      expect(html).toContain('<meta property="og:title" content="Classroom Desk | Google Classroom Meets ChatGPT">');
      expect(html).toContain('<meta property="og:type" content="website">');
      expect(html).toContain('<meta property="og:url"');
      expect(html).toContain('<meta property="og:image" content="http://127.0.0.1/assets/classroom-desk-social-card.png?v=20261012-layout2">');
      expect(html).toContain('<meta property="og:image:width" content="1200">');
      expect(html).toContain('<meta property="og:image:height" content="630">');
      expect(html).toContain('<meta property="og:image:alt" content="Classroom Desk — Google Classroom Meets ChatGPT">');
      expect(html).toContain('<meta name="twitter:card" content="summary_large_image">');
      expect(html).toContain('<meta name="twitter:image" content="http://127.0.0.1/assets/classroom-desk-social-card.png?v=20261012-layout2">');
      const title = html.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? "";
      expect(title).not.toMatch(/color-scheme|--[a-z-]+:|background:|font-size:/i);
    } finally { await close(ctx.server); }
  });
  it("registers exactly one homepage route", async () => {
    const ctx = await setup();
    try {
      const layers = (ctx.app as unknown as { router: { stack: Array<{ route?: { path?: string; methods?: Record<string, boolean> } }> } }).router.stack;
      const homepageRoutes = layers.filter((layer) => layer.route?.path === "/" && layer.route.methods?.get === true);
      expect(homepageRoutes).toHaveLength(1);
      const response = await fetch(`${ctx.origin}/`);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("<title>Classroom Desk | Google Classroom Meets ChatGPT</title>");
    } finally { await close(ctx.server); }
  });
  it.each(["https://attacker.example/callback", "https://chatgpt.com.attacker.example/callback", "https://chatgpt.com@attacker.example/callback", "https://chatgpt.com/other/callback", "https://chatgpt.com/connector/oauth/app?next=attacker"])("rejects an MCP authorization response destination outside the ChatGPT callback pattern (%s)", async redirectUri => {
    const store = new MemoryPublicAuthStore();
    const provider = new PublicOAuthProvider(store, {
      ...authConfig,
      origin: new URL("https://classroom.example"),
      mcpResource: new URL("https://classroom.example/mcp"),
      googleCallbackUrl: "https://classroom.example/oauth/google/callback",
    });
    const putFlow = vi.spyOn(store, "putFlow");
    const response = { setHeader: vi.fn(), redirect: vi.fn() } as never;
    const client = { client_id: "dynamically-registered", redirect_uris: [redirectUri] } as never;
    await expect(provider.authorize(client, {
      clientId: "dynamically-registered", redirectUri, scopes: [MCP_SCOPE], codeChallenge: "pkce-challenge",
    } as never, response)).rejects.toThrow("Unsupported MCP redirect origin");
    expect(putFlow).not.toHaveBeenCalled();
  });
  it.each([
    "https://attacker.example/callback",
    "https://chatgpt.com/connector/oauth/app?next=https://attacker.example",
    "http://127.0.0.1/callback?next=attacker",
    "http://127.0.0.1/callback#fragment",
  ])("rejects dynamic registration with a callback that cannot be safely disclosed (%s)", async redirectUri => {
    const store = new MemoryPublicAuthStore();
    const provider = new PublicOAuthProvider(store, authConfig);
    const persist = vi.spyOn(store, "registerClient");
    await expect(provider.clientsStore.registerClient!({
      redirect_uris: [redirectUri], token_endpoint_auth_method: "none",
    } as never)).rejects.toThrow("Unsupported redirect URI");
    expect(persist).not.toHaveBeenCalled();
  });
  it("rejects unsafe DCR metadata at the HTTP registration endpoint", async () => {
    const ctx = await setup();
    try {
      const response = await fetch(`${ctx.origin}/register`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ redirect_uris: ["https://attacker.example/callback"], token_endpoint_auth_method: "none" }),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: "invalid_client_metadata" });
      expect(await ctx.store.getClient("https://attacker.example/callback")).toBeUndefined();
    } finally { await close(ctx.server); }
  });
  it("allows the ChatGPT callback origin for production authorization", async () => {
    const store = new MemoryPublicAuthStore();
    const provider = new PublicOAuthProvider(store, {
      ...authConfig,
      origin: new URL("https://classroom.example"),
      mcpResource: new URL("https://classroom.example/mcp"),
      googleCallbackUrl: "https://classroom.example/oauth/google/callback",
    });
    const redirect = vi.fn();
    const response = { setHeader: vi.fn(), redirect } as never;
    const redirectUri = "https://chatgpt.com/connector/oauth/verified-app";
    await provider.authorize({ client_id: "chatgpt-client", redirect_uris: [redirectUri] } as never, {
      clientId: "chatgpt-client", redirectUri, scopes: [MCP_SCOPE], codeChallenge: "pkce-challenge",
    } as never, response);
    expect(redirect).toHaveBeenCalledWith(302, expect.stringContaining("/connect/google?flow="));
  });
  it("rejects a previously registered unsafe callback directly without redirecting to it", async () => {
    const ctx = await setup();
    const registered = await ctx.store.registerClient({ redirect_uris: ["https://attacker.example/callback"], token_endpoint_auth_method: "none" } as never);
    try {
      const response = await fetch(`${ctx.origin}/authorize?response_type=code&client_id=${encodeURIComponent(registered.client_id)}&redirect_uri=${encodeURIComponent(registered.redirect_uris[0])}&code_challenge=synthetic-challenge&code_challenge_method=S256&scope=${encodeURIComponent(MCP_SCOPE)}`, { redirect: "manual" });
      expect(response.status).toBe(400);
      expect(response.headers.get("location")).toBeNull();
      expect(await response.json()).toMatchObject({ error: "invalid_request" });
    } finally { await close(ctx.server); }
  });
  it("rejects an unsafe callback in a POST authorization request without redirecting to it", async () => {
    const ctx = await setup();
    const registered = await ctx.store.registerClient({ redirect_uris: ["https://attacker.example/callback"], token_endpoint_auth_method: "none" } as never);
    try {
      const response = await fetch(`${ctx.origin}/authorize`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          response_type: "code", client_id: registered.client_id,
          redirect_uri: "https://attacker.example/callback", code_challenge: "synthetic-challenge",
          code_challenge_method: "S256", scope: MCP_SCOPE,
        }),
        redirect: "manual",
      });
      expect(response.status).toBe(400);
      expect(response.headers.get("location")).toBeNull();
      expect(await response.json()).toMatchObject({ error: "invalid_request" });
    } finally { await close(ctx.server); }
  });
  it("allows a valid loopback callback through the preflight and SDK authorization handler", async () => {
    const ctx = await setup();
    try {
      const registration = await fetch(`${ctx.origin}/register`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ redirect_uris: ["http://127.0.0.1/callback"], token_endpoint_auth_method: "none" }),
      });
      expect(registration.status).toBe(201);
      const client = await registration.json() as { client_id: string };
      const challenge = crypto.createHash("sha256").update("synthetic-verifier").digest("base64url");
      const params = new URLSearchParams({
        response_type: "code", client_id: client.client_id, redirect_uri: "http://127.0.0.1/callback",
        code_challenge: challenge, code_challenge_method: "S256", scope: MCP_SCOPE,
      });
      const response = await fetch(`${ctx.origin}/authorize?${params}`, { redirect: "manual" });
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toContain("/connect/google?flow=");
    } finally { await close(ctx.server); }
  });
  it("rejects persisted unsafe flows before Google consent and before issuing callback errors", async () => {
    const store = new MemoryPublicAuthStore();
    const provider = new PublicOAuthProvider(store, authConfig);
    const flow = {
      id: "old-policy-flow", userId: "user-old-flow",
      client: { client_id: "old-client", redirect_uris: ["https://attacker.example/callback"] } as never,
      params: { state: "state", scopes: [MCP_SCOPE], codeChallenge: "challenge", redirectUri: "https://attacker.example/callback" },
      googleState: "old-policy-state", googleVerifier: "verifier", expiresAt: Date.now() + 60_000, started: false,
    };
    await store.putFlow(flow);
    const markStarted = vi.spyOn(store, "setFlowStarted");
    await expect(provider.beginGoogle(flow.id)).rejects.toThrow("Authorization expired, invalid, or already started");
    expect(markStarted).not.toHaveBeenCalled();
    await store.putFlow({ ...flow, started: true });
    const exchange = vi.spyOn(OAuth2Client.prototype, "getToken");
    try {
      await expect(provider.completeGoogle(flow.googleState, "synthetic-google-code", undefined)).rejects.toThrow("Invalid authorization callback");
      expect(exchange).not.toHaveBeenCalled();
    } finally { exchange.mockRestore(); }
  });
  it("returns a direct 400 for a Google callback backed by a persisted unsafe redirect", async () => {
    const ctx = await setup();
    const flow = {
      id: "old-callback-flow", userId: "user-old-callback",
      client: { client_id: "old-client", redirect_uris: ["https://attacker.example/callback"] } as never,
      params: { state: "state", scopes: [MCP_SCOPE], codeChallenge: "challenge", redirectUri: "https://attacker.example/callback" },
      googleState: "old-callback-state", googleVerifier: "verifier", expiresAt: Date.now() + 60_000, started: true,
    };
    await ctx.store.putFlow(flow);
    try {
      const response = await fetch(`${ctx.origin}/oauth/google/callback?state=${flow.googleState}&error=access_denied`, { redirect: "manual" });
      expect(response.status).toBe(400);
      expect(response.headers.get("location")).toBeNull();
      expect(await response.text()).toContain("could not be completed");
    } finally { await close(ctx.server); }
  });
  it("publishes the refund and cancellation policy page", async () => {
    const ctx = await setup();
    try {
      const response = await fetch(`${ctx.origin}/refunds`);
      const html = await response.text();
      expect(response.status).toBe(200);
      expect(html).toContain("Refund and cancellation policy");
      expect(html).toContain("168 hours");
      expect(html).toContain("Refunds and disputes");
    } finally { await close(ctx.server); }
  });
  it("uses the shared site design for support and keeps unverified checkout disabled", async () => {
    const ctx = await setup();
    try {
      const response = await fetch(`${ctx.origin}/support`);
      const html = await response.text();
      expect(response.status).toBe(200);
      expect(html).toContain('<article class="doc support-card" id="project-support"');
      expect(html).toContain("Support Classroom Desk");
      expect(html).toContain("₹99");
      expect(html).toContain("₹299");
      expect(html).toContain("₹999");
      expect(html).toContain('id="support-custom-amount" type="number"');
      expect(html).toContain('disabled aria-disabled="true" aria-describedby="support-custom-amount-status"');
      expect(html).toContain("Razorpay’s Donation Payment Button supports a supporter-chosen amount");
      expect(html).toContain("maintenance, hosting, infrastructure, documentation, and future development");
      expect(html).toContain("it does not unlock features, change account permissions, or purchase a hosted plan");
      expect(html).toContain('class="button secondary" type="button" disabled aria-disabled="true"');
      expect(html).toContain("No payment will be collected from this page");
      expect(html).not.toContain("buymeacoffee.com");
      expect(html).not.toContain("github.com/sponsors/");
      expect(html).not.toContain("href=\"https://rzp.io/");
      expect(html).not.toContain("name=\"support-amount\"");
      expect(html).toContain("--paper:");
      expect(html).toContain(".doc{");
      expect(html).toContain(".price-strip");
      expect(html).not.toContain("--support-bg:");
      expect(html).not.toContain("class=\"support-page\"");
      expect(html).not.toContain("sponsorship-hero");
      expect(html).toContain("Do not send OAuth tokens, passwords, authorization codes");
      const homeResponse = await fetch(ctx.origin);
      const homeHtml = await homeResponse.text();
      expect(homeResponse.status).toBe(200);
      expect(homeHtml).toContain('href="/support#project-support">Support the Project</a>');
      expect(homeHtml.match(/class="support-heart"/g) ?? []).toHaveLength(2);
      expect(homeHtml).toContain('<span class="support-heart" aria-hidden="true">♡</span> Support</a>');
      expect(homeHtml).toContain('aria-label="Primary"');
      expect(homeHtml).toContain('aria-label="Mobile navigation"');
      expect(html.match(/class="support-heart"/g) ?? []).toHaveLength(2);
      expect(html).toContain('<a aria-current="page" href="/support"><span class="support-heart" aria-hidden="true">♡</span> Support</a>');
      const connectResponse = await fetch(`${ctx.origin}/connect`);
      const connectHtml = await connectResponse.text();
      expect(connectResponse.status).toBe(200);
      expect(connectHtml).not.toContain('href="/support#project-support">Support the Project</a>');
      expect(connectHtml).not.toContain("Support Classroom Desk</h1>");
    } finally { await close(ctx.server); }
  });
  it("rejects unauthenticated, malformed, and expired bearer tokens", async () => {
    const ctx = await setup();
    try {
      expect((await fetch(`${ctx.origin}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(initialize) })).status).toBe(401);
      expect((await fetch(`${ctx.origin}/mcp`, { method: "POST", headers: bearer("bad token"), body: JSON.stringify(initialize) })).status).toBe(401);
      await ctx.seedUser("expired-user", "expired-token");
      await ctx.store.putAccess({ token: "expired-token", clientId: "test-client", userId: "expired-user", scopes: [MCP_SCOPE], resource: authConfig.mcpResource, expiresAt: Date.now() - 1 });
      expect((await fetch(`${ctx.origin}/mcp`, { method: "POST", headers: bearer("expired-token"), body: JSON.stringify(initialize) })).status).toBe(401);
    } finally { await close(ctx.server); }
  });
  it("rejects a foreign Origin and malformed MCP input", async () => {
    const ctx = await setup(); await ctx.seedUser("user-a", "token-a");
    try {
      const foreign = await fetch(`${ctx.origin}/mcp`, { method: "POST", headers: { ...bearer("token-a"), origin: "https://attacker.example" }, body: JSON.stringify(initialize) });
      expect(foreign.status).toBe(403);
      const malformed = await fetch(`${ctx.origin}/mcp`, { method: "POST", headers: bearer("token-a"), body: "{invalid" });
      expect(malformed.status).toBeGreaterThanOrEqual(400);
      expect(await malformed.text()).not.toContain("token-a");
    } finally { await close(ctx.server); }
  });
  it("serves public MCP inventory to an authenticated user and excludes the local Drive tool", async () => {
    const ctx = await setup(); await ctx.seedUser("user-a", "token-a");
    try {
      const initResponse = await fetch(`${ctx.origin}/mcp`, { method: "POST", headers: bearer("token-a"), body: JSON.stringify(initialize) });
      expect(initResponse.status).toBe(200);
      const sessionId = initResponse.headers.get("mcp-session-id");
      expect(sessionId).toBeTruthy();
      const inventory = await fetch(`${ctx.origin}/mcp`, { method: "POST", headers: { ...bearer("token-a"), "mcp-session-id": sessionId! }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) });
      const data = await inventory.json() as { result: { tools: Array<{ name: string; annotations?: Record<string, unknown>; inputSchema?: { properties?: Record<string, { description?: string }> }; securitySchemes?: unknown[]; _meta?: { securitySchemes?: unknown[] } }> } };
      const names = data.result.tools.map((tool) => tool.name);
      expect(names).toHaveLength(13);
      expect(names).toContain("classroom_desk_status");
      expect(names).toContain("classroom_desk_help");
      expect(names).not.toContain("read_drive_attachment");
      for (const tool of data.result.tools) {
        expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: !["classroom_desk_help","classroom_desk_status"].includes(tool.name) });
        for (const property of Object.values(tool.inputSchema?.properties ?? {})) expect(property.description).toBeTruthy();
        expect(tool.securitySchemes).toEqual([{ type: "oauth2", scopes: ["mcp:tools"] }]);
        expect(tool._meta?.securitySchemes).toEqual([{ type: "oauth2", scopes: ["mcp:tools"] }]);
      }
    } finally { await close(ctx.server); }
  });
  it("does not let either synthetic user use the other's MCP session or Google grant", async () => {
    const ctx = await setup(); await ctx.seedUser("user-a", "token-a"); await ctx.seedUser("user-b", "token-b");
    try {
      const init = await fetch(`${ctx.origin}/mcp`, { method: "POST", headers: bearer("token-a"), body: JSON.stringify(initialize) });
      const session = init.headers.get("mcp-session-id")!;
      const cross = await fetch(`${ctx.origin}/mcp`, { method: "POST", headers: { ...bearer("token-b"), "mcp-session-id": session }, body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" }) });
      expect(cross.status).toBe(404);
      const own = await fetch(`${ctx.origin}/mcp`, { method: "POST", headers: bearer("token-b"), body: JSON.stringify(initialize) });
      expect(own.status).toBe(200);
      expect(await ctx.provider.googleAuthForUser("user-a")).toBeDefined();
      expect(await ctx.provider.googleAuthForUser("user-b")).toBeDefined();
      expect(await ctx.provider.verifyAccessToken("token-a")).toMatchObject({ extra: { userId: "user-a" } });
      expect(await ctx.provider.verifyAccessToken("token-b")).toMatchObject({ extra: { userId: "user-b" } });
    } finally { await close(ctx.server); }
  });
  it("disconnects only the authenticated user and is idempotent", async () => {
    const ctx = await setup(); await ctx.seedUser("user-a", "token-a"); await ctx.seedUser("user-b", "token-b");
    try {
      const response = await fetch(`${ctx.origin}/disconnect/google`, { method: "POST", headers: bearer("token-a"), body: JSON.stringify({ userId: "user-b" }) });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ disconnected: true, googleRevocationConfirmed: true });
      expect(ctx.revoked).toEqual(["google-refresh-user-a"]);
      await expect(ctx.store.getGrant("user-a")).resolves.toBeUndefined();
      await expect(ctx.store.getGrant("user-b")).resolves.toBeDefined();
      await expect(ctx.provider.verifyAccessToken("token-a")).rejects.toThrow();
      await expect(ctx.provider.verifyAccessToken("token-b")).resolves.toMatchObject({ extra: { userId: "user-b" } });
    } finally { await close(ctx.server); }
  });
  it("does not claim disconnection when authorization deletion fails", async () => {
    const ctx = await setup(); await ctx.seedUser("user-a", "token-a");
    const failure = vi.spyOn(ctx.store, "deleteUserAuthorization").mockRejectedValue(new Error("private database detail"));
    try {
      const response = await fetch(`${ctx.origin}/disconnect/google`, { method: "POST", headers: bearer("token-a") });
      expect(response.status).toBe(503);
      const body = await response.text();
      expect(body).toContain("disconnect_failed");
      expect(body).not.toContain("private database detail");
      await expect(ctx.store.getGrant("user-a")).resolves.toBeDefined();
    } finally { failure.mockRestore(); await close(ctx.server); }
  });
  it("validates Google callback state, rejects missing/replayed state, and emits only the six scopes", async () => {
    const store = new MemoryPublicAuthStore(); const provider = new PublicOAuthProvider(store, authConfig);
    await expect(provider.completeGoogle(undefined, undefined, undefined)).rejects.toThrow("Invalid authorization callback");
    await expect(provider.completeGoogle("unrecognized", "code", undefined)).rejects.toThrow("Invalid authorization callback");
    const flowId = crypto.randomBytes(32).toString("base64url");
    const flow = { id: flowId, userId: crypto.randomUUID(), client: { client_id: "client", redirect_uris: ["http://127.0.0.1/cb"] } as never,
      params: { state: "client-state", scopes: [MCP_SCOPE], codeChallenge: "challenge", redirectUri: "http://127.0.0.1/cb" },
      googleState: crypto.randomBytes(32).toString("base64url"), googleVerifier: crypto.randomBytes(32).toString("base64url"), expiresAt: Date.now() + 60_000, started: false };
    await store.putFlow(flow);
    const url = new URL(await provider.beginGoogle(flowId));
    expect(url.searchParams.get("scope")?.split(" ").sort()).toEqual([...PUBLIC_CLASSROOM_SCOPES].sort());
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("include_granted_scopes")).toBe("true");
    const denied = await provider.completeGoogle(flow.googleState, undefined, "access_denied");
    expect(new URL(denied).searchParams.get("error")).toBe("access_denied");
    await expect(provider.completeGoogle(flow.googleState, "replay", undefined)).rejects.toThrow("Invalid authorization callback");
    await store.putFlow({ ...flow, id: "expired-flow", googleState: "expired-state", expiresAt: Date.now() - 1, started: true });
    await expect(provider.completeGoogle("expired-state", "code", undefined)).rejects.toThrow("Invalid authorization callback");
  });
  it.each([
    ["server_error", "server_error"],
    ["temporarily_unavailable", "temporarily_unavailable"],
    ["provider_private_detail", "server_error"],
  ])("keeps provider OAuth failures distinct from local failures (%s)", async (providerError, expectedError) => {
    const store = new MemoryPublicAuthStore(); const provider = new PublicOAuthProvider(store, authConfig);
    const flowId = crypto.randomBytes(32).toString("base64url");
    const flow = { id: flowId, userId: crypto.randomUUID(), client: { client_id: "client", redirect_uris: ["http://127.0.0.1/cb"] } as never,
      params: { state: "client-state", scopes: [MCP_SCOPE], codeChallenge: "challenge", redirectUri: "http://127.0.0.1/cb" },
      googleState: crypto.randomBytes(32).toString("base64url"), googleVerifier: crypto.randomBytes(32).toString("base64url"), expiresAt: Date.now() + 60_000, started: false };
    await store.putFlow(flow); await provider.beginGoogle(flowId);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const redirect = new URL(await provider.completeGoogle(flow.googleState, undefined, providerError));
      expect(redirect.searchParams.get("error")).toBe(expectedError);
      expect(redirect.searchParams.get("state")).toBe("client-state");
      expect(log).toHaveBeenCalledWith(expect.objectContaining({ event: "google_authorization_failed", source: "provider", reason: "google_denied" }));
      if (providerError === "provider_private_detail") {
        expect(log).toHaveBeenCalledWith(expect.objectContaining({ providerErrorCategory: "other" }));
        expect(JSON.stringify(log.mock.calls)).not.toContain(providerError);
      }
      expect(await store.getGrant(flow.userId)).toBeUndefined();
    } finally { log.mockRestore(); }
  });
  it("reports a missing callback code as a local server failure and retains state", async () => {
    const store = new MemoryPublicAuthStore(); const provider = new PublicOAuthProvider(store, authConfig);
    const flowId = crypto.randomBytes(32).toString("base64url");
    const flow = { id: flowId, userId: crypto.randomUUID(), client: { client_id: "client", redirect_uris: ["http://127.0.0.1/cb"] } as never,
      params: { state: "client-state", scopes: [MCP_SCOPE], codeChallenge: "challenge", redirectUri: "http://127.0.0.1/cb" },
      googleState: crypto.randomBytes(32).toString("base64url"), googleVerifier: crypto.randomBytes(32).toString("base64url"), expiresAt: Date.now() + 60_000, started: false };
    await store.putFlow(flow); await provider.beginGoogle(flowId);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const redirect = new URL(await provider.completeGoogle(flow.googleState, undefined, undefined));
      expect(redirect.searchParams.get("error")).toBe("server_error");
      expect(redirect.searchParams.get("state")).toBe("client-state");
      expect(log).toHaveBeenCalledWith(expect.objectContaining({ event: "google_authorization_failed", source: "worker", reason: "callback_missing_code" }));
      expect(await store.getGrant(flow.userId)).toBeUndefined();
    } finally { log.mockRestore(); }
  });
  it.each(["scope_mismatch", "missing_refresh_token"] as const)("returns the right OAuth error for %s", async failure => {
    const store = new MemoryPublicAuthStore(); const provider = new PublicOAuthProvider(store, authConfig);
    const flowId = crypto.randomBytes(32).toString("base64url");
    const flow = { id: flowId, userId: crypto.randomUUID(), client: { client_id: "client", redirect_uris: ["http://127.0.0.1/cb"] } as never,
      params: { state: "client-state", scopes: [MCP_SCOPE], codeChallenge: "challenge", redirectUri: "http://127.0.0.1/cb" },
      googleState: crypto.randomBytes(32).toString("base64url"), googleVerifier: crypto.randomBytes(32).toString("base64url"), expiresAt: Date.now() + 60_000, started: false };
    await store.putFlow(flow); await provider.beginGoogle(flowId);
    const scopes = [...PUBLIC_CLASSROOM_SCOPES];
    if (failure === "scope_mismatch") scopes.pop();
    const tokens = failure === "scope_mismatch"
      ? { access_token: "synthetic-access", refresh_token: "synthetic-refresh", scope: scopes.join(" ") }
      : { access_token: "synthetic-access", scope: scopes.join(" ") };
    const getToken = vi.spyOn(OAuth2Client.prototype, "getToken").mockResolvedValue({ tokens } as never);
    const putGrantAndCode = vi.spyOn(store, "putGrantAndCode");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const redirect = new URL(await provider.completeGoogle(flow.googleState, "synthetic-google-code", undefined));
      expect(redirect.searchParams.get("error")).toBe(failure === "scope_mismatch" ? "access_denied" : "server_error");
      expect(redirect.searchParams.get("state")).toBe("client-state");
      expect(log).toHaveBeenCalledWith(expect.objectContaining({ event: "google_authorization_failed", source: "worker", reason: failure }));
      expect(putGrantAndCode).not.toHaveBeenCalled();
      expect(await store.getGrant(flow.userId)).toBeUndefined();
    } finally { getToken.mockRestore(); putGrantAndCode.mockRestore(); log.mockRestore(); }
  });
  it("keeps the Google grant bound to its MCP subject until explicit account pairing", async () => {
    const store = new MemoryPublicAuthStore();
    const provider = new PublicOAuthProvider(store, authConfig);
    const flow = { id: "auto-link-flow", userId: "temporary-flow-user", client: { client_id: "client", redirect_uris: ["http://127.0.0.1/cb"] } as never,
      params: { state: "client-state", scopes: [MCP_SCOPE, MCP_OFFLINE_SCOPE], codeChallenge: "challenge", redirectUri: "http://127.0.0.1/cb" },
      googleState: "auto-link-google-state", googleVerifier: "auto-link-verifier", expiresAt: Date.now() + 60_000, started: false };
    await store.putFlow(flow);
    await provider.beginGoogle(flow.id);
    const getToken = vi.spyOn(OAuth2Client.prototype, "getToken").mockResolvedValue({ tokens: {
      access_token: "google-access-token", refresh_token: "google-refresh-token", scope: PUBLIC_CLASSROOM_SCOPES.join(" "),
    } } as never);
    try {
      const redirect = await provider.completeGoogle(flow.googleState, "google-code", undefined);
      const code = new URL(redirect).searchParams.get("code");
      expect(code).toBeTruthy();
      expect(await store.getGrant(flow.userId)).toMatchObject({ refreshToken: "google-refresh-token" });
      const tokens = await provider.exchangeAuthorizationCode({ client_id: "client" } as never, code!, undefined, flow.params.redirectUri, authConfig.mcpResource);
      await expect(provider.verifyAccessToken(tokens.access_token)).resolves.toMatchObject({ extra: { userId: flow.userId } });
      expect(getToken).toHaveBeenCalledTimes(1);
    } finally { getToken.mockRestore(); }
  });
  it("binds a verified Google subject to its canonical account and preserves its refresh token on reconnect", async () => {
    const userId = "00000000-0000-4000-8000-000000000001";
    const identityScopes = [...PUBLIC_CLASSROOM_SCOPES, "openid", "email"];
    const scopeValidator = (scopes: string[]) => scopes.length === identityScopes.length && identityScopes.every((scope) => scopes.includes(scope));
    const store = new MemoryPublicAuthStore();
    const resolver = vi.fn(async (identity: { googleSubject: string; email: string; displayName: string }) => {
      expect(identity).toEqual({ googleSubject: "google-subject-stable-001", email: "reviewer@example.invalid", displayName: "Reviewer" });
      return userId;
    });
    const provider = new PublicOAuthProvider(store, { ...authConfig, googleScopes: identityScopes, googleGrantValidator: scopeValidator, googleStoredGrantValidator: scopeValidator, googleIdentityResolver: resolver });
    const client = { client_id: "client-unified" } as never;
    const beginFlow = async (id: string, state: string, nonce: string) => {
      const flow = { id, userId: `temporary-${id}`, client: { client_id: "client-unified", redirect_uris: ["http://127.0.0.1/callback"] } as never, params: { state: `client-${state}`, scopes: [MCP_SCOPE, MCP_OFFLINE_SCOPE], codeChallenge: "challenge", redirectUri: "http://127.0.0.1/callback" }, googleState: state, googleVerifier: `verifier-${id}`, googleNonce: nonce, expiresAt: Date.now() + 60_000, started: false };
      await store.putFlow(flow);
      const googleUrl = new URL(await provider.beginGoogle(id));
      expect(googleUrl.searchParams.get("nonce")).toBe(nonce);
      return flow;
    };
    const payload = (nonce: string) => ({ iss: "https://accounts.google.com", aud: "client-test", exp: Math.floor(Date.now() / 1000) + 300, iat: Math.floor(Date.now() / 1000), nonce, sub: "google-subject-stable-001", email: "reviewer@example.invalid", email_verified: true, name: "Reviewer" });
    const tokenMock = vi.spyOn(OAuth2Client.prototype, "getToken");
    const identityMock = vi.spyOn(OAuth2Client.prototype, "verifyIdToken");
    try {
      const first = await beginFlow("first-unified", "google-state-one", "nonce-one");
      tokenMock.mockResolvedValueOnce({ tokens: { access_token: "access-one", refresh_token: "refresh-one", id_token: "id-one", scope: identityScopes.join(" ") } } as never);
      identityMock.mockResolvedValueOnce({ getPayload: () => payload(first.googleNonce!) } as never);
      const redirect = new URL(await provider.completeGoogle(first.googleState, "google-code-one", undefined));
      expect(redirect.searchParams.get("state")).toBe("client-google-state-one");
      const code = redirect.searchParams.get("code")!;
      const issued = await provider.exchangeAuthorizationCode(client, code, undefined, first.params.redirectUri, authConfig.mcpResource);
      expect(await provider.verifyAccessToken(issued.access_token)).toMatchObject({ extra: { userId } });
      expect(await store.getGrant(userId)).toMatchObject({ refreshToken: "refresh-one" });

      const reconnect = await beginFlow("reconnect-unified", "google-state-two", "nonce-two");
      tokenMock.mockResolvedValueOnce({ tokens: { access_token: "access-two", id_token: "id-two", scope: identityScopes.join(" ") } } as never);
      identityMock.mockResolvedValueOnce({ getPayload: () => payload(reconnect.googleNonce!) } as never);
      const reconnectRedirect = new URL(await provider.completeGoogle(reconnect.googleState, "google-code-two", undefined));
      const reconnectCode = reconnectRedirect.searchParams.get("code")!;
      await provider.exchangeAuthorizationCode(client, reconnectCode, undefined, reconnect.params.redirectUri, authConfig.mcpResource);
      expect(await store.getGrant(userId)).toMatchObject({ refreshToken: "refresh-one", scopes: identityScopes });
      expect(resolver).toHaveBeenCalledTimes(2);
    } finally { tokenMock.mockRestore(); identityMock.mockRestore(); }
  });
  it("rejects a mismatched Google OIDC nonce without replacing an existing account grant", async () => {
    const userId = "00000000-0000-4000-8000-000000000002";
    const identityScopes = [...PUBLIC_CLASSROOM_SCOPES, "openid", "email"];
    const store = new MemoryPublicAuthStore();
    await store.putGrant({ userId, refreshToken: "preserve-this-grant", scopes: identityScopes, createdAt: Date.now() - 1000, updatedAt: Date.now() - 1000 });
    const provider = new PublicOAuthProvider(store, { ...authConfig, googleScopes: identityScopes, googleGrantValidator: () => true, googleStoredGrantValidator: () => true, googleIdentityResolver: async () => userId });
    const flow = { id: "nonce-replay", userId: "temporary-flow", client: { client_id: "client-unified", redirect_uris: ["http://127.0.0.1/callback"] } as never, params: { state: "client-state", scopes: [MCP_SCOPE], codeChallenge: "challenge", redirectUri: "http://127.0.0.1/callback" }, googleState: "google-state-replay", googleVerifier: "verifier", googleNonce: "expected-nonce", expiresAt: Date.now() + 60_000, started: false };
    await store.putFlow(flow); await provider.beginGoogle(flow.id);
    const tokenMock = vi.spyOn(OAuth2Client.prototype, "getToken").mockResolvedValue({ tokens: { access_token: "access", refresh_token: "replacement", id_token: "id", scope: identityScopes.join(" ") } } as never);
    const identityMock = vi.spyOn(OAuth2Client.prototype, "verifyIdToken").mockResolvedValue({ getPayload: () => ({ iss: "https://accounts.google.com", aud: "client-test", exp: Math.floor(Date.now() / 1000) + 300, iat: Math.floor(Date.now() / 1000), nonce: "wrong-nonce", sub: "google-subject-stable-002", email: "other@example.invalid", email_verified: true }) } as never);
    try {
      const redirect = new URL(await provider.completeGoogle(flow.googleState, "google-code", undefined));
      expect(redirect.searchParams.get("error")).toBe("server_error");
      expect(await store.getGrant(userId)).toMatchObject({ refreshToken: "preserve-this-grant" });
    } finally { tokenMock.mockRestore(); identityMock.mockRestore(); }
  });
  it("shows a minimal connection page and enforces same-origin form submission", async () => {
    const ctx = await setup();
    const flow = { id: "one-time-flow", userId: "internal-user", client: { client_id: "client", client_name: "<img src=x>", redirect_uris: ["http://127.0.0.1/cb"] } as never,
      params: { state: "state", scopes: [MCP_SCOPE], codeChallenge: "challenge", redirectUri: "http://127.0.0.1/cb" }, googleState: "google-state", googleVerifier: "verifier", expiresAt: Date.now() + 60_000, started: false };
    await ctx.store.putFlow(flow);
    try {
      const page = await fetch(`${ctx.origin}/connect/google?flow=${flow.id}`);
      const html = await page.text();
      expect(html).toContain("Continue with Google"); expect(html).toContain("read-only access to supported Google Classroom data");
      expect(html).toContain("&lt;img src=x&gt;"); expect(html).toContain("http://127.0.0.1");
      expect(html).toContain("client name is supplied by the connecting MCP client and is not verified");
      expect(html).toContain("After Google authorization, the response will be returned to <code>http://127.0.0.1/cb</code>");
      expect(html).toContain("We never ask for your Google password."); expect(html).toContain("This consent does not request Google Drive access.");
      expect(html).toContain("Disconnect is available");
      const rejected = await fetch(`${ctx.origin}/connect/google`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://attacker.example" }, body: `flow=${flow.id}`, redirect: "manual" });
      expect(rejected.status).toBe(403);
    } finally { await close(ctx.server); }
  });
  it("does not display Google consent for a persisted callback with a query string", async () => {
    const ctx = await setup();
    const flow = { id: "old-query-flow", userId: "internal-user", client: { client_id: "old-client", client_name: "MCP client", redirect_uris: ["http://127.0.0.1/cb?next=elsewhere"] } as never,
      params: { state: "state", scopes: [MCP_SCOPE], codeChallenge: "challenge", redirectUri: "http://127.0.0.1/cb?next=elsewhere" }, googleState: "old-query-state", googleVerifier: "verifier", expiresAt: Date.now() + 60_000, started: false };
    await ctx.store.putFlow(flow);
    try {
      const response = await fetch(`${ctx.origin}/connect/google?flow=${flow.id}`);
      expect(response.status).toBe(400);
      expect(await response.text()).not.toContain("Continue with Google");
    } finally { await close(ctx.server); }
  });
  it("accurately discloses creation and update of unpublished drafts when that permission is configured", async () => {
    const teacherWriteScope = "https://www.googleapis.com/auth/classroom.coursework.students";
    const ctx = await setup({ ...authConfig, teacherWriteScopes: [teacherWriteScope] });
    const flow = { id: "write-disclosure-flow", userId: "internal-user", client: { client_id: "registered-client", client_name: "MCP client", redirect_uris: ["https://chatgpt.com/connector/oauth/test-app"] } as never,
      params: { state: "state", scopes: [MCP_SCOPE], codeChallenge: "challenge", redirectUri: "https://chatgpt.com/connector/oauth/test-app" }, googleState: "google-state", googleVerifier: "verifier", expiresAt: Date.now() + 60_000, started: false };
    await ctx.store.putFlow(flow);
    try {
      const response = await fetch(`${ctx.origin}/connect/google?flow=${flow.id}`);
      const html = await response.text();
      expect(response.status).toBe(200);
      expect(html).toContain("create an unpublished draft or update an existing unpublished draft");
      expect(html).toContain("does not change published coursework, submit student work, publish drafts, or write grades");
      expect(html).not.toContain("does not edit existing coursework");
    } finally { await close(ctx.server); }
  });
  it("rejects a bearer whose Google grant is missing without leaking stored credentials", async () => {
    const ctx = await setup();
    await ctx.store.putAccess({ token: "orphan-token", clientId: "test-client", userId: "no-grant", scopes: [MCP_SCOPE], resource: authConfig.mcpResource, expiresAt: Date.now() + 60_000 });
    try {
      const response = await fetch(`${ctx.origin}/mcp`, { method: "POST", headers: bearer("orphan-token"), body: JSON.stringify({jsonrpc:"2.0",id:2,method:"tools/call",params:{name:"list_courses",arguments:{}}}) });
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).toContain("google_authorization_required");
      expect(body).toContain('"isError":true');
      expect(body).not.toContain("orphan-token");
    } finally { await close(ctx.server); }
  });
});
