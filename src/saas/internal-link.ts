import { timingSafeEqual } from "node:crypto";
import type express from "express";
import type { SaaSStore } from "./store.js";
import { resolveMcpAccess } from "./mcp-access.js";

export function internalTokenMatches(supplied: string, expected: string | undefined): boolean {
  const a=Buffer.from(supplied), b=Buffer.from(expected??"");
  return b.length>=32 && a.length===b.length && timingSafeEqual(a,b);
}
export const classifyPolicyFailure = (status: number, reason: unknown, error: unknown = undefined, stage: unknown = undefined): string => {
  if (status === 404) return "policy_authentication_failed";
  if (error === "invalid_origin") return "policy_origin_invalid";
  if (error === "invalid_client_address") return "policy_network_invalid";
  if (stage === "network_admission") return "policy_network_invalid";
  if (stage === "origin_validation") return "policy_origin_invalid";
  if (stage === "identity_validation") return "policy_identity_invalid";
  if (status === 400 && reason === "policy_identity_invalid") return "policy_identity_invalid";
  if (reason === "database_unavailable" || reason === "database_account_lookup_failed" || reason === "database_entitlement_failed" || reason === "policy_unexpected_exception") return String(reason);
  return `policy_http_${status}`;
};
// MCP OAuth subjects are opaque provider identifiers. Keep a bounded allowlist
// for safe internal transport; identity still comes exclusively from the
// verified bearer token and database ownership checks.
export const isMcpSubject = (value: unknown): value is string => typeof value === "string" && /^[\x21-\x7E]{1,256}$/.test(value);
export async function evaluateInternalPolicy(store:SaaSStore,subject:unknown,grandfatheredHashes="") {
  if (!isMcpSubject(subject)) return { status: 400, stage: "identity_validation", body: { allowed: false, reason: "policy_identity_invalid" } } as const;
  try {
    const result = await resolveMcpAccess(store,subject,grandfatheredHashes);
    return { status: 200, stage: "entitlement_evaluation", body: result } as const;
  } catch (error) {
    const stage = error && typeof error === "object" && "policyStage" in error && typeof (error as {policyStage?:unknown}).policyStage === "string" ? (error as {policyStage:string}).policyStage : "unexpected_exception";
    const reason = stage === "account_lookup" ? "database_account_lookup_failed" : stage === "entitlement_evaluation" ? "database_entitlement_failed" : "policy_unexpected_exception";
    return { status: 503, stage, body: { allowed: false, reason } } as const;
  }
}
/** The legacy Worker supplies the authenticated MCP subject, never a tool argument. */
export function registerInternalLink(app:express.Express,store:SaaSStore,secret:string,grandfatheredHashes = "",policySecret = ""):void {
  app.post("/internal/account/access",async(req,res)=>{
    const requestId = req.get("x-classroom-policy-request-id");
    if(!internalTokenMatches(req.get("x-classroom-access-policy-token")??"",policySecret)) {
      if (requestId) console.log(JSON.stringify({event:"mcp_policy_request",requestId,status:404,stage:"service_auth",reason:"policy_authentication_failed"}));
      res.set("x-classroom-policy-stage", "service_auth");
      return res.status(404).end();
    }
    const subject=req.body?.subject;
    try {
      const result = await evaluateInternalPolicy(store,subject,grandfatheredHashes);
      if (requestId) console.log(JSON.stringify({event:"mcp_policy_request",requestId,status:result.status,stage:result.stage,reason:(result.body as {reason?:string}).reason ?? "allowed"}));
      res.set("x-classroom-policy-stage", result.stage);
      return res.status(result.status).json(result.body);
    }
    catch (error) {
      const code = error && typeof error === "object" && "code" in error && typeof (error as {code?:unknown}).code === "string" ? (error as {code:string}).code : "unknown";
      const stage = error && typeof error === "object" && "policyStage" in error && typeof (error as {policyStage?:unknown}).policyStage === "string" ? (error as {policyStage:string}).policyStage : "unexpected_exception";
      const sqlState = error && typeof error === "object" && "sqlState" in error && typeof (error as {sqlState?:unknown}).sqlState === "string" ? (error as {sqlState:string}).sqlState : "unknown";
      const reason = stage === "account_lookup" ? "database_account_lookup_failed" : stage === "entitlement_evaluation" ? "database_entitlement_failed" : "policy_unexpected_exception";
      if (requestId) console.log(JSON.stringify({event:"mcp_policy_request",requestId,status:503,stage,reason,sqlState,errorCode:/^[A-Z0-9_]+$/.test(code)?code:"unknown"}));
      res.set("x-classroom-policy-stage", stage);
      return res.status(503).json({allowed:false,reason});
    }
  });
  app.post("/internal/account/link",async(req,res)=>{
    if(!internalTokenMatches(req.get("x-classroom-internal-token")??"",secret))return res.status(404).end();
    const code=req.body?.code, subject=req.body?.subject;
    if(typeof code!=="string"||!isMcpSubject(subject))return res.status(400).json({linked:false});
    try{return res.json({linked:await store.linking.consume(code,subject)});}
    catch{return res.status(503).json({linked:false});}
  });
}
