#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import https from "node:https";
import { pathToFileURL } from "node:url";

const DEFAULT_ORIGIN = "https://127.0.0.1:8799";
const origin = new URL(process.env.CLASSROOM_DESK_LOCAL_ORIGIN ?? DEFAULT_ORIGIN);
if (!(["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname)) || !["http:", "https:"].includes(origin.protocol)) {
  throw new Error("Local HTTP checks accept loopback origins only.");
}
if (origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/") {
  throw new Error("Local HTTP check origin must be a bare loopback origin.");
}

function request(path, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, origin);
    if (url.origin !== origin.origin) return reject(new Error("Local HTTP check refused a non-loopback destination."));
    const options = { method, headers, timeout: 8_000 };
    if (url.protocol === "https:") options.agent = new https.Agent({ rejectUnauthorized: false });
    const req = (url.protocol === "https:" ? https : http).request(url, options, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("timeout", () => req.destroy(new Error("Local request timed out.")));
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function assert(condition, name, detail = "") {
  if (!condition) throw new Error(`FAIL ${name}${detail ? ` (${detail})` : ""}`);
  process.stdout.write(`PASS ${name}\n`);
}
function locationPath(response) {
  const raw = response.headers.location;
  if (!raw) return "";
  try { return new URL(raw, origin).pathname; } catch { return "invalid"; }
}
function hasSafeOAuthErrorRedirect(response, expectedRedirect, expectedError = "invalid_request") {
  const raw = response.headers.location;
  if (!raw) return false;
  try {
    const actual = new URL(raw, origin);
    const expected = new URL(expectedRedirect);
    return response.status === 302 && actual.origin === expected.origin && actual.pathname === expected.pathname
      && actual.searchParams.get("error") === expectedError && !actual.searchParams.has("code");
  } catch { return false; }
}

async function run() {
  const health = await request("/health");
  assert(health.status === 200 && JSON.parse(health.body).status === "ok", "health");
  const home = await request("/");
  assert(home.status === 200 && home.body.includes("Classroom Desk"), "public homepage");
  const oauthMetadata = await request("/.well-known/oauth-authorization-server");
  const oauthJson = JSON.parse(oauthMetadata.body);
  assert(oauthMetadata.status === 200 && oauthJson.code_challenge_methods_supported?.includes("S256"), "OAuth discovery and PKCE S256");
  const protectedResource = await request("/.well-known/oauth-protected-resource/mcp");
  assert(protectedResource.status === 200, "protected resource metadata");
  const mcp = await request("/mcp");
  assert(mcp.status === 401, "MCP rejects anonymous request");
  const app = await request("/app");
  assert(app.status === 303 && locationPath(app) === "/login", "account route requires session");
  const syntheticSession = process.env.CLASSROOM_DESK_SYNTHETIC_SESSION_TOKEN;
  if (syntheticSession !== undefined) {
    if (!/^[A-Za-z0-9_-]{40,}$/.test(syntheticSession)) throw new Error("Synthetic session token format is invalid.");
    const signedIn = await request("/app", { headers: { cookie: `cd_session=${syntheticSession}` } });
    assert(signedIn.status === 200 && signedIn.body.includes("Account"), "synthetic signed-in dashboard renders");
    const settings = await request("/app/settings", { headers: { cookie: `cd_session=${syntheticSession}` } });
    assert(settings.status === 200, "synthetic signed-in account settings render");
  }
  const callback = await request("/oauth/google/callback?state=synthetic-invalid&code=synthetic-invalid");
  assert(callback.status === 400, "invalid Google callback fails closed");
  const picker = await request("/picker/callback?state=synthetic-invalid&code=synthetic-invalid");
  assert(picker.status === 400, "invalid Picker callback fails closed");
  const order = await request("/api/billing/trial/order", { method: "POST", headers: { "content-type": "application/json", origin: origin.origin }, body: "{}" });
  assert(order.status === 401, "trial order requires authenticated session");
  const subscription = await request("/api/billing/subscription", { method: "POST", headers: { "content-type": "application/json", origin: origin.origin }, body: JSON.stringify({ plan: "student" }) });
  assert(subscription.status === 401, "subscription creation requires authenticated session");
  const webhook = await request("/webhooks/razorpay", { method: "POST", headers: { "content-type": "application/json", "x-razorpay-signature": "synthetic-invalid" }, body: "{}" });
  assert(webhook.status === 401, "invalid billing webhook signature rejected");

  const redirectUri = "https://chatgpt.com/connector/oauth/synthetic-local-test";
  const registration = await request("/register", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Synthetic loopback acceptance", redirect_uris: [redirectUri], token_endpoint_auth_method: "none" }),
  });
  assert(registration.status === 201, "dynamic client registration");
  const client = JSON.parse(registration.body);
  if (typeof client.client_id !== "string" || !client.client_id) throw new Error("FAIL dynamic registration response shape");
  assert(true, "dynamic registration response shape");

  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authorize = new URL("/authorize", origin);
  for (const [key, value] of Object.entries({
    response_type: "code", client_id: client.client_id, redirect_uri: redirectUri,
    scope: "mcp:tools offline_access", code_challenge: challenge, code_challenge_method: "S256",
    resource: new URL("/mcp", origin).toString(), state: "synthetic-local-state",
  })) authorize.searchParams.set(key, value);
  const authorizeResponse = await request(`${authorize.pathname}${authorize.search}`);
  assert(authorizeResponse.status === 302 && locationPath(authorizeResponse) === "/connect/google", "valid PKCE request enters Google consent page");
  const consentPage = await request(authorizeResponse.headers.location);
  assert(consentPage.status === 200 && consentPage.body.includes("Continue with Google"), "Google consent page renders without being submitted");

  const badRedirect = new URL(authorize);
  badRedirect.searchParams.set("redirect_uri", "https://attacker.example.invalid/callback");
  const redirectResponse = await request(`${badRedirect.pathname}${badRedirect.search}`);
  assert(redirectResponse.status === 400, "unregistered redirect rejected");
  const badPkce = new URL(authorize);
  badPkce.searchParams.delete("code_challenge");
  badPkce.searchParams.delete("code_challenge_method");
  const pkceResponse = await request(`${badPkce.pathname}${badPkce.search}`);
  assert(hasSafeOAuthErrorRedirect(pkceResponse, redirectUri), "missing PKCE receives OAuth error without a code");
  const badResource = new URL(authorize);
  badResource.searchParams.set("resource", "https://attacker.example.invalid/mcp");
  const resourceResponse = await request(`${badResource.pathname}${badResource.search}`);
  const resourceLocation = resourceResponse.headers.location ? new URL(resourceResponse.headers.location, origin) : undefined;
  const resourceError = resourceLocation?.searchParams.get("error") ?? "none";
  assert(hasSafeOAuthErrorRedirect(resourceResponse, redirectUri, "server_error"), "wrong resource receives fail-closed OAuth error without a code", `HTTP ${resourceResponse.status}, category ${resourceError}`);
  process.stdout.write("Local Worker HTTP checks passed. No Google consent or payment API was invoked.\n");
}

run().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Local Worker HTTP checks failed."}\n`);
  process.exitCode = 1;
});
