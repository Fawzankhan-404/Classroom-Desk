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

async function setup() {
  const store = new MemoryPublicAuthStore();
  let revoked: string[] = [];
  const provider = new PublicOAuthProvider(store, authConfig, async (token) => { revoked.push(token); });
  const { app } = createPublicApp(runtimeConfig, store, provider);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  async function seedUser(userId: string, accessToken: string) {
    await store.putGrant({ userId, refreshToken: `google-refresh-${userId}`, scopes: [...PUBLIC_CLASSROOM_SCOPES], createdAt: Date.now(), updatedAt: Date.now() });
    await store.putAccess({ token: accessToken, clientId: "test-client", userId, scopes: [MCP_SCOPE], resource: authConfig.mcpResource, expiresAt: Date.now() + 60_000 });
  }
  return { store, provider, origin, server, seedUser, get revoked() { return revoked; } };
}

async function close(server: Server) {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

it("keeps unified onboarding on the configured MCP origin without a second website login", async () => {
  const ctx = await setup();
  try {
    const html = await (await fetch(`${ctx.origin}/connect`)).text();
    expect(html).toContain('data-copy-mcp="http://127.0.0.1/mcp"');
    expect(html).not.toContain('data-copy-mcp="https://classroom.jarvis404.com/mcp"');
    expect(html).toContain("connect your account automatically");
    expect(html).toContain("Back to app");
    const script = await (await fetch(`${ctx.origin}/assets/connect.js`)).text();
    expect(script).not.toContain("are separate steps");
    expect(/Generate pairing code|link_website_account/.test(html + script)).toBe(false);
  } finally { await close(ctx.server); }
});
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
    expect(() => loadRuntimeConfig({ ...base, PUBLIC_STAGE_WIDE_VIDEO_URL: "http://media.example/video.mp4" })).toThrow("HTTPS CloudFront");
    expect(loadRuntimeConfig({ ...base, PUBLIC_STAGE_WIDE_VIDEO_URL: "https://media.example.cloudfront.net/video.mp4" }).stageMedia?.wideVideo).toContain("cloudfront.net");
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
  it("publishes the refund and cancellation policy page", async () => {
    const ctx = await setup();
    try {
      const response = await fetch(`${ctx.origin}/refunds`);
      const html = await response.text();
      expect(response.status).toBe(200);
      expect(html).toContain("Refund and cancellation policy");
      expect(html).toContain("historical transactions");
      expect(html).toContain("new payment enrollment is disabled");
      expect(html).toContain("Refunds and disputes");
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
    expect(url.searchParams.get("include_granted_scopes")).toBe("false");
    const denied = await provider.completeGoogle(flow.googleState, undefined, "access_denied");
    expect(new URL(denied).searchParams.get("error")).toBe("access_denied");
    await expect(provider.completeGoogle(flow.googleState, "replay", undefined)).rejects.toThrow("Invalid authorization callback");
    await store.putFlow({ ...flow, id: "expired-flow", googleState: "expired-state", expiresAt: Date.now() - 1, started: true });
    await expect(provider.completeGoogle("expired-state", "code", undefined)).rejects.toThrow("Invalid authorization callback");
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
  it("shows a minimal connection page and enforces same-origin form submission", async () => {
    const ctx = await setup();
    const flow = { id: "one-time-flow", userId: "internal-user", client: { client_id: "client", redirect_uris: ["http://127.0.0.1/cb"] } as never,
      params: { state: "state", scopes: [MCP_SCOPE], codeChallenge: "challenge", redirectUri: "http://127.0.0.1/cb" }, googleState: "google-state", googleVerifier: "verifier", expiresAt: Date.now() + 60_000, started: false };
    await ctx.store.putFlow(flow);
    try {
      const page = await fetch(`${ctx.origin}/connect/google?flow=${flow.id}`);
      const html = await page.text();
      expect(html).toContain("Continue with Google"); expect(html).toContain("Read-only access");
      expect(html).toContain("We never ask for your Google password."); expect(html).toContain("No arbitrary Drive access");
      expect(html).toContain("Disconnect is available");
      const rejected = await fetch(`${ctx.origin}/connect/google`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://attacker.example" }, body: `flow=${flow.id}`, redirect: "manual" });
      expect(rejected.status).toBe(403);
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
