import { httpServerHandler } from "cloudflare:node";
import { isIP } from "node:net";
import { ipKeyGenerator } from "express-rate-limit";
import { loadRuntimeConfig } from "./public/config.js";
import { createPublicApp } from "./public/http.js";
import { PostgresPublicAuthStore } from "./public/postgres.js";
import { HyperdriveDatabase } from "./public/hyperdrive.js";
import { createClients } from "./classroom.js";
import { createServer } from "./server.js";
import {PublicOAuthProvider} from "./public/oauth.js";
import {registerInternalConnectionStatus} from "./saas/connection-status.js";
import {classifyPolicyFailure, internalTokenMatches} from "./saas/internal-link.js";
import type { McpAccess } from "./saas/mcp-access.js";

type WorkerBindings = {
  HYPERDRIVE: { connectionString: string };
  PUBLIC_RATE_LIMIT: { limit(input: { key: string }): Promise<{ success: boolean }> };
  AUTH_RATE_LIMIT: { limit(input: { key: string }): Promise<{ success: boolean }> };
  PUBLIC_APP_ORIGIN: string;
  PUBLIC_OPERATOR_NAME: string;
  PUBLIC_SUPPORT_EMAIL: string;
  PUBLIC_AUTH_ENCRYPTION_KEY_B64: string;
  GOOGLE_OAUTH_CLIENT_ID: string;
  GOOGLE_OAUTH_CLIENT_SECRET: string;
  OPENAI_DOMAIN_CHALLENGE?: string;
  INTERNAL_DELEGATION_SECRET?: string;
  MCP_ACCESS_POLICY_SECRET?: string;
  ACCOUNT_PORTAL?: {fetch(request:Request):Promise<Response>};
  SAAS_ENFORCE_ENTITLEMENTS?: string;
};

// The Node HTTP bridge keeps the existing Express and MCP route behavior.
// Hyperdrive supplies the database URL inside the Worker; it is never logged.
let handler: ReturnType<typeof httpServerHandler> | undefined;

export default {
  async fetch(request: Request, bindings: WorkerBindings, context: unknown) {
    const path = new URL(request.url).pathname;
    if (path === "/.well-known/openai-apps-challenge" && bindings.OPENAI_DOMAIN_CHALLENGE) {
      return new Response(bindings.OPENAI_DOMAIN_CHALLENGE, {
        headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
      });
    }
    const clientIp = request.headers.get("cf-connecting-ip") ?? "";
    const isProbe = path === "/health";
    const trustedStatus=path==='/internal/account/connection'&&internalTokenMatches(request.headers.get('x-classroom-internal-token')??'',bindings.INTERNAL_DELEGATION_SECRET);
    if(path==='/internal/account/connection'&&!trustedStatus)return new Response(null,{status:404});
    if (!isProbe && !trustedStatus && !isIP(clientIp)) {
      return Response.json({ error: "invalid_client_address" }, { status: 400 });
    }
    if (!isProbe) {
      try {
        const key = trustedStatus ? 'internal-account-status' : ipKeyGenerator(clientIp, 56);
        if (!(await bindings.PUBLIC_RATE_LIMIT.limit({ key })).success) {
          return Response.json({ error: "rate_limited" }, { status: 429 });
        }
        if (/^\/(?:ready|register|authorize|token|revoke|connect\/google|oauth\/google\/callback|disconnect\/google)$/.test(path)
          && !(await bindings.AUTH_RATE_LIMIT.limit({ key })).success) {
          return Response.json({ error: "rate_limited" }, { status: 429 });
        }
      } catch {
        return Response.json({ error: "rate_limit_unavailable" }, { status: 503 });
      }
    }
    if (!handler) {
      const config = loadRuntimeConfig({
        NODE_ENV: "production",
        PUBLIC_AUTH_STORE: "postgres",
        DATABASE_URL: bindings.HYPERDRIVE.connectionString,
        PUBLIC_APP_ORIGIN: bindings.PUBLIC_APP_ORIGIN,
        PUBLIC_OPERATOR_NAME: bindings.PUBLIC_OPERATOR_NAME,
        PUBLIC_SUPPORT_EMAIL: bindings.PUBLIC_SUPPORT_EMAIL,
        PUBLIC_AUTH_ENCRYPTION_KEY_B64: bindings.PUBLIC_AUTH_ENCRYPTION_KEY_B64,
        GOOGLE_OAUTH_CLIENT_ID: bindings.GOOGLE_OAUTH_CLIENT_ID,
        GOOGLE_OAUTH_CLIENT_SECRET: bindings.GOOGLE_OAUTH_CLIENT_SECRET,
      });
      config.saasFlags = { billingUi: false, teacherFeatures: false, teacherDraftWrites: false, referralRewards: false, enforceEntitlements: bindings.SAAS_ENFORCE_ENTITLEMENTS === "true" };
      const database = new HyperdriveDatabase(config.databaseUrl!);
      const store = new PostgresPublicAuthStore(database, config.encryptionKeyBase64);
      const provider=new PublicOAuthProvider(store,config);
      const { app } = createPublicApp({ ...config, workerClientIp: true }, store, provider, () => store.ready(), createClients, {
        internalDelegationSecret: bindings.INTERNAL_DELEGATION_SECRET,
        entitlementCheck: async subject => {
          if (!bindings.ACCOUNT_PORTAL || !bindings.MCP_ACCESS_POLICY_SECRET) return { allowed: false, reason: "temporarily_unavailable" };
          const requestId = crypto.randomUUID();
          const pingBody = '{}';
          const ping = await bindings.ACCOUNT_PORTAL.fetch(new Request(new URL('/internal/transport/ping',bindings.PUBLIC_APP_ORIGIN), { method:'POST',headers:{'content-type':'application/json','content-length':String(new TextEncoder().encode(pingBody).byteLength),'x-classroom-access-policy-token':bindings.MCP_ACCESS_POLICY_SECRET,'x-classroom-policy-request-id':requestId},body:pingBody,signal:AbortSignal.timeout(8000) }));
          if (!ping.ok) { console.log(JSON.stringify({ event: 'mcp_policy_transport_failed', requestId, status: ping.status })); return { allowed: false, reason: 'policy_transport_failed' }; }
          const policyBody = JSON.stringify({subject});
          const shape = await bindings.ACCOUNT_PORTAL.fetch(new Request(new URL('/internal/transport/policy-shape',bindings.PUBLIC_APP_ORIGIN), { method:'POST',headers:{'content-type':'application/json','content-length':String(new TextEncoder().encode(policyBody).byteLength),'x-classroom-access-policy-token':bindings.MCP_ACCESS_POLICY_SECRET,'x-classroom-policy-request-id':requestId},body:policyBody,signal:AbortSignal.timeout(8000) }));
          if (!shape.ok) { console.log(JSON.stringify({ event: 'mcp_policy_shape_failed', requestId, status: shape.status })); return { allowed: false, reason: 'policy_shape_transport_failed' }; }
          const response = await bindings.ACCOUNT_PORTAL.fetch(new Request(new URL('/internal/account/access',bindings.PUBLIC_APP_ORIGIN), { method:'POST',headers:{'content-type':'application/json','content-length':String(new TextEncoder().encode(policyBody).byteLength),'x-classroom-access-policy-token':bindings.MCP_ACCESS_POLICY_SECRET,'x-classroom-policy-request-id':requestId},body:policyBody,signal:AbortSignal.timeout(8000) }));
          const result = response.headers.get('content-type')?.includes('application/json') ? await response.json() as Partial<McpAccess> : {};
          if (!response.ok) {
            const policyStage = response.headers.get('x-classroom-policy-stage');
            const reason = response.status === 400 && !policyStage && !result.reason
              ? 'policy_route_rejected_after_transport_ping'
              : classifyPolicyFailure(response.status, result.reason, (result as {error?:unknown}).error, policyStage);
            console.log(JSON.stringify({ event: 'mcp_policy_check_failed', requestId, status: response.status, reason }));
            return { allowed: false, reason };
          }
          return { allowed: result.allowed === true, reason: typeof result.reason === 'string' ? result.reason : 'temporarily_unavailable' };
        },
        registerRoutes:app=>registerInternalConnectionStatus(app,provider,bindings.INTERNAL_DELEGATION_SECRET??''),
        mcpFactory:async(auth,subject)=>createServer(createClients(auth),{publicV1:true,linkWebsiteAccount:bindings.ACCOUNT_PORTAL&&bindings.INTERNAL_DELEGATION_SECRET?async code=>{
          try{
            const response=await bindings.ACCOUNT_PORTAL!.fetch(new Request(new URL('/internal/account/link',bindings.PUBLIC_APP_ORIGIN),{method:'POST',headers:{'content-type':'application/json','x-classroom-internal-token':bindings.INTERNAL_DELEGATION_SECRET!},body:JSON.stringify({code,subject})}));
            if(!response.ok)return false;
            return (await response.json() as {linked?:boolean}).linked===true;
          }catch{return false;}
        }:undefined}),
      });
      app.listen(3000);
      handler = httpServerHandler({ port: 3000 });
    }
    return handler.fetch(request, bindings, context);
  },
  async scheduled(_event: unknown, bindings: WorkerBindings) {
    try {
      const store = new PostgresPublicAuthStore(
        new HyperdriveDatabase(bindings.HYPERDRIVE.connectionString),
        bindings.PUBLIC_AUTH_ENCRYPTION_KEY_B64,
      );
      await store.pruneExpired();
    } catch {
      process.stderr.write('{"event":"authorization_prune_failed"}\n');
    }
  },
};
