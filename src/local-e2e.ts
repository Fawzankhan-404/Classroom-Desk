#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const appOrigin = "http://127.0.0.1:8787";
const clientOrigin = "http://127.0.0.1:8790";
const callbackUrl = `${clientOrigin}/callback`;
const verifier = randomBytes(32).toString("base64url");
const challenge = createHash("sha256").update(verifier).digest("base64url");
const state = randomBytes(24).toString("base64url");
let authorizationUrl: URL;
let stage = "waiting_for_browser";
let finished = false;

const registration = await fetch(`${appOrigin}/register`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ client_name: "Classroom local verification", redirect_uris: [callbackUrl], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }),
});
if (registration.status !== 201) throw new Error(`Local MCP client registration failed (${registration.status}).`);
const client = await registration.json() as { client_id: string };
authorizationUrl = new URL("/authorize", appOrigin);
for (const [key, value] of Object.entries({ response_type: "code", client_id: client.client_id, redirect_uri: callbackUrl, code_challenge: challenge, code_challenge_method: "S256", state, resource: `${appOrigin}/mcp`, scope: "mcp:tools offline_access" })) authorizationUrl.searchParams.set(key, value);

async function rpc(accessToken: string, sessionId: string | undefined, id: number, method: string, params?: unknown) {
  const response = await fetch(`${appOrigin}/mcp`, { method: "POST", headers: {
    authorization: `Bearer ${accessToken}`, "content-type": "application/json", accept: "application/json, text/event-stream",
    ...(sessionId ? { "mcp-session-id": sessionId } : {}),
  }, body: JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }) });
  if (response.status !== 200) throw new Error(`${method} returned HTTP ${response.status}`);
  const body = await response.json() as { result?: { isError?: boolean; content?: Array<{ text?: string }> }; error?: unknown };
  if (!body.result || body.result.isError || body.error) throw new Error(`${method} returned a tool error`);
  return { result: body.result, sessionId: response.headers.get("mcp-session-id") ?? sessionId };
}

async function verify(code: string) {
  let activeToken: string | undefined;
  try {
  stage = "exchanging_mcp_code";
  const tokenResponse = await fetch(`${appOrigin}/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: callbackUrl, code_verifier: verifier, client_id: client.client_id, resource: `${appOrigin}/mcp` }) });
  if (tokenResponse.status !== 200) throw new Error(`MCP code exchange returned HTTP ${tokenResponse.status}`);
  const issued = await tokenResponse.json() as { access_token: string; refresh_token?: string };
  if (!issued.access_token || !issued.refresh_token) throw new Error("MCP access or refresh token missing");
  activeToken = issued.access_token;

  stage = "reading_classroom";
  const initialized = await rpc(issued.access_token, undefined, 1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "local-verification", version: "1" } });
  const sessionId = initialized.sessionId;
  const coursesResult = await rpc(issued.access_token, sessionId, 2, "tools/call", { name: "list_courses", arguments: {} });
  const courses = JSON.parse(coursesResult.result.content?.[0]?.text ?? "{}") as { courses?: Array<{ id?: string }> };
  const firstCourseId = courses.courses?.[0]?.id;
  if (!firstCourseId) throw new Error("No course available for coursework verification");
  await rpc(issued.access_token, sessionId, 3, "tools/call", { name: "list_coursework", arguments: { courseId: firstCourseId } });
  await rpc(issued.access_token, sessionId, 4, "tools/call", { name: "list_topics", arguments: { courseId: firstCourseId } });

  stage = "refreshing_mcp_token";
  const refreshResponse = await fetch(`${appOrigin}/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: issued.refresh_token, client_id: client.client_id, resource: `${appOrigin}/mcp` }) });
  if (refreshResponse.status !== 200) throw new Error(`MCP refresh returned HTTP ${refreshResponse.status}`);
  const rotated = await refreshResponse.json() as { access_token: string; refresh_token?: string };
  if (!rotated.access_token || !rotated.refresh_token || rotated.refresh_token === issued.refresh_token) throw new Error("MCP refresh did not rotate");
  activeToken = rotated.access_token;

  stage = "disconnecting";
  const disconnect = await fetch(`${appOrigin}/disconnect/google`, { method: "POST", headers: { authorization: `Bearer ${rotated.access_token}` } });
  if (disconnect.status !== 200) throw new Error(`Disconnect returned HTTP ${disconnect.status}`);
  const disconnectResult = await disconnect.json() as { disconnected?: boolean; googleRevocationConfirmed?: boolean };
  if (disconnectResult.disconnected) activeToken = undefined;
  const after = await fetch(`${appOrigin}/mcp`, { method: "POST", headers: { authorization: `Bearer ${rotated.access_token}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/list" }) });
  if (!disconnectResult.disconnected || after.status !== 401) throw new Error("MCP access persisted after disconnect");
  return { status: "passed", operations: ["MCP OAuth", "list_courses", "list_coursework", "list_topics", "MCP refresh", "disconnect", "post-disconnect 401"], googleRevocationConfirmed: disconnectResult.googleRevocationConfirmed === true };
  } catch (error) {
    if (activeToken) await fetch(`${appOrigin}/disconnect/google`, { method: "POST", headers: { authorization: `Bearer ${activeToken}` } }).catch(() => undefined);
    throw error;
  }
}

const listener = createServer(async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  if (req.url === "/start" && req.method === "GET" && !finished) {
    res.writeHead(302, { Location: authorizationUrl.toString() }); res.end(); return;
  }
  if (req.url?.startsWith("/callback?") && req.method === "GET" && !finished) {
    finished = true;
    const url = new URL(req.url, clientOrigin);
    if (url.searchParams.get("state") !== state || url.searchParams.get("error") || !url.searchParams.get("code")) {
      stage = "authorization_failed";
      res.writeHead(400, { "content-type": "text/plain" }); res.end("Authorization was not completed. Return to Codex.");
      return;
    }
    res.writeHead(200, { "content-type": "text/plain" }); res.end("Authorization received. Codex is checking the read-only connection and will disconnect it.");
    try {
      const result = await verify(url.searchParams.get("code")!);
      stage = "passed";
      await mkdir(resolve("verification"), { recursive: true });
      await writeFile(resolve("verification/public-local-e2e-result.json"), JSON.stringify(result, null, 2));
      process.stdout.write("Local end-to-end verification passed; sanitized result saved.\n");
    } catch {
      stage = "verification_failed";
      process.stdout.write("Local end-to-end verification failed; no tokens or Classroom contents logged.\n");
    }
    return;
  }
  if (req.url === "/status" && req.method === "GET") {
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ stage })); return;
  }
  res.writeHead(404); res.end();
});
listener.listen(8790, "127.0.0.1", () => process.stdout.write("Local E2E callback listener ready on port 8790.\n"));
