import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { createServer as createNetServer } from "node:net";
import { OAuth2Client } from "googleapis-common";
import { afterEach, describe, expect, it, vi } from "vitest";
import { D1SqlDatabase } from "../public/d1-database.js";
import { PostgresPublicAuthStore } from "../public/postgres.js";
import { PublicOAuthProvider } from "../public/oauth.js";
import { createPublicApp } from "../public/http.js";
import { GOOGLE_CANONICAL_CLASSROOM_SCOPES } from "../scopes.js";
import { SaaSStore } from "./store.js";
import { unifiedOAuthAccounts } from "./unified-oauth.js";
import { registerWebsiteRoutes } from "./website-routes.js";

async function harness() {
  vi.spyOn(OAuth2Client.prototype, "getAccessToken").mockRejectedValue(new Error("invalid_grant"));
  const sqlite = new DatabaseSync(":memory:");
  for (const file of ["0001_classroom_desk", "0002_d1_link_claims", "0003_d1_admin_operation_markers", "0004_d1_unique_trial_orders", "0005_d1_billing_operation_markers", "0006_d1_reconciliation_claims", "0007_saas_profile_privacy", "0008_unified_oauth_accounts"]) sqlite.exec(readFileSync(new URL(`../../migrations/${file}.sql`, import.meta.url), "utf8"));
  const statement = (sql: string, values: unknown[] = []) => ({ all: async <T>() => {
    const query = sqlite.prepare(sql); const rows = query.columns().length ? query.all(...values) : (query.run(...values), []);
    return { success: true, results: rows as T[] };
  } });
  let tail = Promise.resolve();
  const db = new D1SqlDatabase({ prepare: sql => ({ bind: (...values) => statement(sql, values) }), batch: statements => {
    const run = tail.then(async () => { sqlite.exec("BEGIN"); try { const results = []; for (const s of statements) results.push(await s.all()); sqlite.exec("COMMIT"); return results; } catch (e) { sqlite.exec("ROLLBACK"); throw e; } });
    tail = run.then(() => undefined, () => undefined); return run;
  } });
  const auth = new PostgresPublicAuthStore(db, randomBytes(32).toString("base64"), "classroom_desk_auth_records");
  await auth.migrate();
  const saas = new SaaSStore(db);
  const net = createNetServer(); await new Promise<void>(resolve => net.listen(0, "127.0.0.1", resolve));
  const port = (net.address() as { port: number }).port; await new Promise<void>(resolve => net.close(() => resolve()));
  const origin = `http://127.0.0.1:${port}`;
  const config = { origin: new URL(origin), mcpResource: new URL(`${origin}/mcp`), googleCallbackUrl: `${origin}/oauth/google/callback`, googleClientId: "synthetic-client", googleClientSecret: "synthetic-secret", port, production: true, saasFlags: { billingUi:false, teacherFeatures:false, referralRewards:false, enforceEntitlements:true } };
  const provider = new PublicOAuthProvider(auth, config, undefined, unifiedOAuthAccounts(saas, auth));
  const clientsFactory = (google: OAuth2Client) => ({ classroom: { courses: { list: async () => ({ data: { courses: [{ id: google.credentials.refresh_token?.endsWith("google-b") ? "course-b" : "course-a", name: "Synthetic course" }] } }) } }, drive: {} });
  const { app } = createPublicApp(config, auth, provider, undefined, clientsFactory as never, { registerRoutes: app => registerWebsiteRoutes(app, { store: saas, secureCookies: false }), entitlementCheck: id => saas.entitlementForMcpUser(id), accountIdentity: id => saas.accountIdentityForMcpUser(id) });
  const server = app.listen(port, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve));
  const client = await auth.registerClient({ redirect_uris: ["https://chatgpt.com/connector/oauth_callback"], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" });
  async function begin(session = "", select = false) {
    const verifier = randomBytes(32).toString("base64url");
    const params = new URLSearchParams({ client_id: client.client_id, redirect_uri: client.redirect_uris[0]!, response_type: "code", code_challenge_method: "S256", code_challenge: createHash("sha256").update(verifier).digest("base64url"), state: randomBytes(16).toString("hex"), scope: "mcp:tools offline_access", resource: `${origin}/mcp` });
    const response = await fetch(`${origin}/authorize?${params}`, { redirect: "manual", headers: { cookie: session } });
    expect(response.status).toBe(302);
    const cookie = [session, response.headers.get("set-cookie")!.split(";")[0]].filter(Boolean).join("; ");
    const flow = new URL(response.headers.get("location")!).searchParams.get("flow")!;
    const view = await fetch(`${origin}/connect/google?flow=${flow}`, { headers: { cookie } });
    expect(/pairing|link_website_account/i.test(await view.text())).toBe(false);
    const started = await fetch(`${origin}/connect/google`, { method: "POST", redirect: "manual", headers: { cookie, origin, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ flow, ...(select ? { account: "select" } : {}) }) });
    expect(started.status).toBe(303);
    return { verifier, params, flow, cookie, target: new URL(started.headers.get("location")!) };
  }
  async function consent(flow: Awaited<ReturnType<typeof begin>>, subject = "google-a", cookie = flow.cookie) {
    vi.spyOn(OAuth2Client.prototype, "getToken").mockResolvedValue({ tokens: { refresh_token: `synthetic-grant-${subject}`, access_token: "synthetic-access", id_token: "synthetic-id-token", scope: [...GOOGLE_CANONICAL_CLASSROOM_SCOPES, "openid", "email", "profile"].join(" ") } } as never);
    vi.spyOn(OAuth2Client.prototype, "verifyIdToken").mockResolvedValue({ getPayload: () => ({ sub: subject, email: `${subject}@example.invalid`, name: subject, email_verified: true, nonce: flow.target.searchParams.get("state") }) } as never);
    return fetch(`${origin}/oauth/google/callback?${new URLSearchParams({ state: flow.target.searchParams.get("state")!, code: "synthetic-google-code" })}`, { redirect: "manual", headers: { cookie } });
  }
  async function exchange(flow: Awaited<ReturnType<typeof begin>>, target: URL) {
    const response = await fetch(`${origin}/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", client_id: client.client_id, code: target.searchParams.get("code")!, code_verifier: flow.verifier, redirect_uri: client.redirect_uris[0]!, resource: `${origin}/mcp` }) });
    expect(response.status).toBe(200); return response.json() as Promise<{ access_token: string; refresh_token: string }>;
  }
  async function call(token: string, method: string, params: Record<string, unknown> = {}) {
    const response = await fetch(`${origin}/mcp`, { method:"POST", headers:{ authorization:`Bearer ${token}`, "content-type":"application/json", accept:"application/json, text/event-stream" }, body:JSON.stringify({jsonrpc:"2.0",id:1,method,params}) });
    return response.json() as Promise<{result: {structuredContent?:Record<string,unknown>;content:Array<{text:string}>;tools?:Array<{name:string}>}}>;
  }
  return { sqlite, db, auth, saas, provider, client, origin, begin, consent, exchange, call, close: async () => { await new Promise<void>(resolve => server.close(() => resolve())); sqlite.close(); } };
}
afterEach(() => vi.restoreAllMocks());

describe("unified MCP OAuth ownership", () => {
  it("connects a first-time user in one Google flow, creates the website session and binds the grant/code atomically", async () => {
    const h = await harness(); try {
      const flow = await h.begin(); expect(flow.target.searchParams.get("scope")).toContain("openid");
      const callback = await h.consent(flow); expect(callback.status).toBe(303);
      const redirect = new URL(callback.headers.get("location")!);
      expect(redirect.searchParams.get("state")).toBe(flow.params.get("state"));
      const session = callback.headers.get("set-cookie")!.split(";")[0]!;
      const user = (await h.provider.accounts!.session(session))!;
      const wrongPkce = await fetch(`${h.origin}/token`, {method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams({grant_type:"authorization_code",client_id:h.client.client_id,code:redirect.searchParams.get("code")!,code_verifier:"incorrect-verifier-with-sufficient-length-123456789",redirect_uri:h.client.redirect_uris[0]!,resource:`${h.origin}/mcp`})});
      expect(wrongPkce.status).toBeGreaterThanOrEqual(400);
      const tokens = await h.exchange(flow, redirect);
      expect((await h.provider.verifyAccessToken(tokens.access_token)).extra?.userId).toBe(user.mcpUserId);
      expect(await h.saas.getLinkedMcpUserId(user.userId)).toBe(user.mcpUserId);
      expect(await h.auth.getGrant(user.mcpUserId)).toMatchObject({ refreshToken: "synthetic-grant-google-a" });
      expect((await h.db.query(`SELECT COUNT(*) AS count FROM classroom_desk_link_tokens`)).rows[0]?.count).toBe(0);
      const duplicate = await h.consent(flow); expect(duplicate.status).toBe(400);
      const codeReplay = await fetch(`${h.origin}/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", client_id: h.client.client_id, code: redirect.searchParams.get("code")!, code_verifier: flow.verifier, redirect_uri: h.client.redirect_uris[0]! }) });
      expect(codeReplay.status).toBeGreaterThanOrEqual(400);
    } finally { await h.close(); }
  });

  it("copies a verified legacy grant without changing the legacy alias, preserves refresh identity and rejects refresh replay", async () => {
    const h = await harness(); try {
      const user = await h.saas.upsertGoogleIdentity({ googleSubject: "google-a", email: "a@example.invalid", displayName: "A", now: new Date() });
      await h.db.query(`INSERT INTO classroom_desk_connections (website_user_id,mcp_user_id,connected_at) VALUES ($1,$2,$3)`, [user.id, "legacy-opaque-subject", new Date()]);
      const session = await h.saas.sessions.create(user.id);
      await h.auth.putGrant({ userId: "legacy-opaque-subject", googleSubject: "google-a", refreshToken: "existing-google-refresh", scopes: [...GOOGLE_CANONICAL_CLASSROOM_SCOPES], createdAt: Date.now(), updatedAt: Date.now() });
      vi.spyOn(OAuth2Client.prototype, "getAccessToken").mockResolvedValue({ token: "valid-existing-google-access" });
      const flow = await h.begin(`cd_session=${session.token}`);
      expect(flow.target.origin).toBe("https://chatgpt.com");
      const token = await h.exchange(flow, flow.target);
      expect((await h.provider.verifyAccessToken(token.access_token)).extra?.userId).toBe(`cd-account:${user.id}`);
      const refreshed = await h.provider.exchangeRefreshToken(h.client, token.refresh_token);
      expect((await h.provider.verifyAccessToken(refreshed.access_token)).extra?.userId).toBe(`cd-account:${user.id}`);
      await expect(h.provider.exchangeRefreshToken(h.client, token.refresh_token)).rejects.toThrow();
      expect(await h.saas.getLinkedMcpUserId(user.id)).toBe(`cd-account:${user.id}`);expect(await h.saas.getLegacyMcpUserId(user.id)).toBe("legacy-opaque-subject");expect(await h.auth.getGrant("legacy-opaque-subject")).toMatchObject({refreshToken:"existing-google-refresh"});
    } finally { await h.close(); }
  });

  it("requires explicit account selection to authorize a different Google identity and never reassigns the first account", async () => {
    const h = await harness(); try {
      const first = await h.begin(); const done = await h.consent(first); const cookie = done.headers.get("set-cookie")!.split(";")[0]!;
      const owner = (await h.provider.accounts!.session(cookie))!;
      const wrong = await h.begin(cookie); const denied = await h.consent(wrong, "google-b");
      expect(new URL(denied.headers.get("location")!).searchParams.get("error")).toBe("server_error");
      expect(await h.auth.getGrant(owner.mcpUserId)).toMatchObject({ refreshToken: "synthetic-grant-google-a" });
      const selected = await h.begin(cookie, true); const switched = await h.consent(selected, "google-b");
      expect(switched.status).toBe(303);
      const other = (await h.provider.accounts!.session(switched.headers.get("set-cookie")!.split(";")[0]!))!;
      expect(other.userId).not.toBe(owner.userId);
      expect(await h.saas.getLinkedMcpUserId(owner.userId)).toBe(owner.mcpUserId);
      expect(await h.saas.getLinkedMcpUserId(other.userId)).toBe(other.mcpUserId);
    } finally { await h.close(); }
  });

  it("recovers an expired website session through Google without a second login and rejects a session expiring during consent", async () => {
    const h = await harness(); try {
      const first = await h.begin(); const done = await h.consent(first); const cookie = done.headers.get("set-cookie")!.split(";")[0]!;
      const account = (await h.provider.accounts!.session(cookie))!;
      await h.db.query(`UPDATE classroom_desk_sessions SET expires_at=$2 WHERE id=$1`, [account.sessionId, new Date(0)]);
      const recovery = await h.begin(cookie); expect(recovery.target.hostname).toBe("accounts.google.com");
      const recovered = await h.consent(recovery); expect(recovered.status).toBe(303);
      const newCookie = recovered.headers.get("set-cookie")!.split(";")[0]!;
      const current = (await h.provider.accounts!.session(newCookie))!;
      const pending = await h.begin(newCookie);
      await h.db.query(`UPDATE classroom_desk_sessions SET expires_at=$2 WHERE id=$1`, [current.sessionId, new Date(0)]);
      const denied = await h.consent(pending); expect(denied.status).toBe(400);
    } finally { await h.close(); }
  });

  it("rejects missing browser proof, failed consent and concurrent replay without creating links", async () => {
    const h = await harness(); try {
      const flow = await h.begin(); const denied = await h.consent(flow, "google-a", ""); expect(denied.status).toBe(400);
      const failed = await h.begin(); const denial = await fetch(`${h.origin}/oauth/google/callback?${new URLSearchParams({ state: failed.target.searchParams.get("state")!, error: "access_denied" })}`, { redirect: "manual", headers: { cookie: failed.cookie } });
      expect(new URL(denial.headers.get("location")!).searchParams.get("error")).toBe("access_denied");
      const concurrent = await h.begin(); const callbacks = await Promise.all([h.consent(concurrent), h.consent(concurrent)]);
      expect(callbacks.filter(r => r.status === 303)).toHaveLength(1);
      expect(callbacks.filter(r => r.status === 400)).toHaveLength(1);
      expect((await h.db.query(`SELECT COUNT(*) AS count FROM classroom_desk_oauth_accounts`)).rows[0]?.count).toBe(1);
    } finally { await h.close(); }
  });

  it("fails a binding conflict without storing a code or replacing a grant", async () => {
    const h = await harness(); try {
      const user = await h.saas.upsertGoogleIdentity({ googleSubject: "google-a", email: "a@example.invalid", displayName: "A", now: new Date() });
      const session = await h.saas.sessions.create(user.id);
      const flow = await h.begin(`cd_session=${session.token}`);
      await h.db.query(`INSERT INTO classroom_desk_oauth_accounts (website_user_id,mcp_user_id,connected_at) VALUES ($1,$2,$3)`, [user.id, "other-existing-subject", new Date()]);
      const response = await h.consent(flow); expect(response.status).toBe(400);
      expect(await h.saas.getLinkedMcpUserId(user.id)).toBe("other-existing-subject");
      expect(await h.auth.getGrant(`cd-account:${user.id}`)).toBeUndefined();
      expect((await h.db.query(`SELECT COUNT(*) AS count FROM classroom_desk_auth_records WHERE kind='code'`)).rows[0]?.count).toBe(0);
    } finally { await h.close(); }
  });

  it("returns the canonical authenticated account and permits only its entitled Classroom grant, with no linking tool or endpoints", async () => {
    const h = await harness(); try {
      const flow = await h.begin(); const done = await h.consent(flow); const tokens = await h.exchange(flow, new URL(done.headers.get("location")!));
      const account = (await h.provider.accounts!.session(done.headers.get("set-cookie")!.split(";")[0]!))!;
      await h.saas.activateTrial(account.userId,"pay_synthetic_unified",new Date(),900);
      const status = await h.call(tokens.access_token,"tools/call",{name:"classroom_desk_status",arguments:{}});
      expect(status.result.structuredContent).toMatchObject({allowed:true,account:{id:account.userId,displayName:"google-a"}});
      const courses = await h.call(tokens.access_token,"tools/call",{name:"list_courses",arguments:{}});
      expect(courses.result.content[0]!.text).toContain("course-a"); expect(courses.result.content[0]!.text).not.toContain("course-b");
      const tools = await h.call(tokens.access_token,"tools/list");
      expect(tools.result.tools?.some(tool => tool.name === "link_website_account")).toBe(false);
      for (const path of ["/api/classroom/link/start","/api/classroom/link/switch","/internal/account/link"]) {
        expect((await fetch(h.origin+path,{method:"POST",headers:{origin:h.origin}})).status).toBe(404);
      }
    } finally { await h.close(); }
  });

  it("retains legacy grants and entitlements until secure OIDC recovery succeeds", async () => {
    const h = await harness(); try {
      const user = await h.saas.upsertGoogleIdentity({googleSubject:"google-a",email:"a@example.invalid",displayName:"A",now:new Date()});
      await h.db.query(`INSERT INTO classroom_desk_connections (website_user_id,mcp_user_id) VALUES ($1,$2)`,[user.id,"legacy-subject"]);
      await h.auth.putGrant({userId:"legacy-subject",refreshToken:"legacy-refresh-preserved",scopes:[...GOOGLE_CANONICAL_CLASSROOM_SCOPES],createdAt:Date.now(),updatedAt:Date.now()});
      await h.saas.activateTrial(user.id,"pay_legacy_unified",new Date(),900);
      const session = await h.saas.sessions.create(user.id);
      vi.spyOn(OAuth2Client.prototype,"getAccessToken").mockResolvedValue({token:"valid"});
      const flow = await h.begin(`cd_session=${session.token}`); expect(flow.target.hostname).toBe("accounts.google.com");
      const failed = await h.consent(flow,"google-b"); expect(new URL(failed.headers.get("location")!).searchParams.has("error")).toBe(true);
      expect(await h.auth.getGrant("legacy-subject")).toMatchObject({refreshToken:"legacy-refresh-preserved"});
      expect((await h.saas.entitlement(user.id)).allowed).toBe(true);
      const retry = await h.begin(`cd_session=${session.token}`); const recovered = await h.consent(retry);
      expect(recovered.status).toBe(303); expect(await h.saas.getLinkedMcpUserId(user.id)).toBe(`cd-account:${user.id}`);expect(await h.saas.getLegacyMcpUserId(user.id)).toBe("legacy-subject");
      expect(await h.auth.getGrant(`cd-account:${user.id}`)).toMatchObject({googleSubject:"google-a"});expect(await h.auth.getGrant("legacy-subject")).toMatchObject({refreshToken:"legacy-refresh-preserved"});
      expect((await h.saas.entitlement(user.id)).allowed).toBe(true);
      expect((await h.saas.entitlementForMcpUser("legacy-subject")).allowed).toBe(true);
      expect((await h.saas.entitlementForMcpUser(`cd-account:${user.id}`)).allowed).toBe(true);
    } finally { await h.close(); }
  });

  it("rolls back link and grant writes if code persistence fails", async () => {
    const h = await harness(); try {
      h.sqlite.exec(`CREATE TRIGGER reject_code BEFORE INSERT ON classroom_desk_auth_records WHEN NEW.kind='code' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END`);
      const flow=await h.begin(); const failed=await h.consent(flow);
      expect(new URL(failed.headers.get("location")!).searchParams.get("error")).toBe("server_error");
      expect((await h.db.query(`SELECT COUNT(*) AS count FROM classroom_desk_oauth_accounts`)).rows[0]?.count).toBe(0);
      expect((await h.db.query(`SELECT COUNT(*) AS count FROM classroom_desk_auth_records WHERE kind IN ('grant','code')`)).rows[0]?.count).toBe(0);
    } finally { await h.close(); }
  });

  it("keeps independent concurrent OAuth flows isolated and rejects a subject owned by another account", async () => {
    const h=await harness();try{
      const first=await h.begin(),second=await h.begin();
      const b=await h.consent(second,"google-b"),a=await h.consent(first,"google-a");
      const aa=(await h.provider.accounts!.session(a.headers.get("set-cookie")!.split(";")[0]!))!,bb=(await h.provider.accounts!.session(b.headers.get("set-cookie")!.split(";")[0]!))!;
      expect(aa.userId).not.toBe(bb.userId);
      expect((await h.provider.verifyAccessToken((await h.exchange(first,new URL(a.headers.get("location")!))).access_token)).extra?.userId).toBe(aa.mcpUserId);
      expect((await h.provider.verifyAccessToken((await h.exchange(second,new URL(b.headers.get("location")!))).access_token)).extra?.userId).toBe(bb.mcpUserId);
      const session=await h.saas.sessions.create(aa.userId);
      const flow=await h.begin(`cd_session=${session.token}`);
      const stored=(await h.auth.getFlow(flow.flow))!;
      // Directly exercise the transactional ownership guard with a forged
      // binding attempt. Existing ownership must remain unchanged.
      await expect(h.auth.completeAccountAuthorization({...stored,userId:bb.mcpUserId},{code:"synthetic-conflicting-code",clientId:h.client.client_id,userId:bb.mcpUserId,redirectUri:h.client.redirect_uris[0]!,challenge:"synthetic",scopes:["mcp:tools"],expiresAt:Date.now()+60000})).rejects.toThrow("account_binding_invalid");
      expect(await h.saas.getLinkedMcpUserId(aa.userId)).toBe(aa.mcpUserId);expect(await h.saas.getLinkedMcpUserId(bb.userId)).toBe(bb.mcpUserId);
      expect(await h.auth.getCode("synthetic-conflicting-code")).toBeUndefined();
    }finally{await h.close();}
  });
});
