import { describe, expect, it } from "vitest";
import { classifyPolicyFailure, isMcpSubject } from "./saas/internal-link.js";

describe("MCP policy failure classification", () => {
  it("distinguishes service authentication from identity and infrastructure failures", () => {
    expect(classifyPolicyFailure(404, undefined)).toBe("policy_authentication_failed");
    expect(classifyPolicyFailure(400, "policy_identity_invalid")).toBe("policy_identity_invalid");
    expect(classifyPolicyFailure(400, undefined, "invalid_origin")).toBe("policy_origin_invalid");
    expect(classifyPolicyFailure(429, undefined)).toBe("policy_http_429");
    expect(classifyPolicyFailure(503, "database_unavailable")).toBe("database_unavailable");
    expect(classifyPolicyFailure(500, "unexpected")).toBe("policy_http_500");
  });

  it("accepts bounded opaque MCP subjects but rejects unsafe or empty values", () => {
    expect(isMcpSubject("chatgpt-client.subject:v2/opaque+id")).toBe(true);
    expect(isMcpSubject("22222222-2222-4222-8222-222222222222")).toBe(true);
    expect(isMcpSubject("bad subject")).toBe(false);
    expect(isMcpSubject("a".repeat(257))).toBe(false);
  });
});
