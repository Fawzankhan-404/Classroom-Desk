import { describe, expect, it, vi } from "vitest";
import { checkRequestRateLimits, type RateLimitBinding } from "./rate-limit.js";

function limiter(success: boolean): RateLimitBinding {
  return { limit: vi.fn(async () => ({ success })) };
}

describe("request rate-limit policy", () => {
  it("rejects a public-bucket overflow without consulting the auth bucket", async () => {
    const publicLimiter = limiter(false);
    const authLimiter = limiter(true);
    await expect(checkRequestRateLimits("/mcp", "203.0.113.10", publicLimiter, authLimiter)).resolves.toEqual({ allowed: false, status: 429, error: "rate_limited" });
    expect(publicLimiter.limit).toHaveBeenCalledOnce();
    expect(authLimiter.limit).not.toHaveBeenCalled();
  });

  it.each(["/login", "/auth/google/callback", "/oauth/google/callback", "/oauth/token", "/authorize", "/connect/google", "/api/teacher/courses", "/admin/users"])(
    "applies the additional auth bucket to %s",
    async (path) => {
      const publicLimiter = limiter(true);
      const authLimiter = limiter(false);
      await expect(checkRequestRateLimits(path, "203.0.113.10", publicLimiter, authLimiter)).resolves.toEqual({ allowed: false, status: 429, error: "rate_limited" });
      expect(publicLimiter.limit).toHaveBeenCalledOnce();
      expect(authLimiter.limit).toHaveBeenCalledOnce();
    },
  );

  it("uses only the public bucket for ordinary MCP calls and fails closed if a binding errors", async () => {
    const publicLimiter = limiter(true);
    const authLimiter = limiter(true);
    await expect(checkRequestRateLimits("/mcp", "203.0.113.10", publicLimiter, authLimiter)).resolves.toEqual({ allowed: true });
    expect(authLimiter.limit).not.toHaveBeenCalled();
    const broken = { limit: vi.fn(async () => { throw new Error("binding unavailable"); }) };
    await expect(checkRequestRateLimits("/login", "203.0.113.10", broken, authLimiter)).resolves.toEqual({ allowed: false, status: 503, error: "rate_limit_unavailable" });
  });
});
