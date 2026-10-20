import { describe, expect, it } from "vitest";
import { renderAdminAudit, renderAdminBilling, renderAdminSubscriptionReconciliation } from "./admin.js";

describe("admin billing pages", () => {
  it("links payment records to the read-only subscription reconciliation queue", () => {
    const html = renderAdminBilling([]);
    expect(html).toContain('href="/admin/billing/reconciliation"');
  });

  it("escapes provider request references and exposes no resolution controls", () => {
    const html = renderAdminSubscriptionReconciliation([{
      userId: "11111111-2222-4333-8444-555555555555",
      requestId: "<script>synthetic</script>",
      plan: "student",
      state: "unknown",
      createdAt: new Date("2026-10-18T00:00:00.000Z"),
      updatedAt: new Date("2026-10-18T00:01:00.000Z"),
    }]);
    expect(html).toContain("&lt;script&gt;synthetic&lt;/script&gt;");
    expect(html).not.toContain("<script>synthetic</script>");
    expect(html).toContain("Needs provider verification");
    expect(html).not.toContain("<form");
    expect(html).toContain("do not retry it");
  });
});

describe("admin audit page", () => {
  it("shows actor, target, before and after states with escaped audit values", () => {
    const html = renderAdminAudit([{
      actorUserId: "actor-123",
      targetUserId: "target-456",
      action: "suspend_user",
      reason: "<script>synthetic reason</script>",
      previousState: JSON.stringify({ status: "active" }),
      newState: { status: "suspended", note: "<script>synthetic state</script>" },
      createdAt: new Date("2026-10-18T00:00:00.000Z"),
    }]);

    expect(html).toContain("Actor ID");
    expect(html).toContain("Target ID");
    expect(html).toContain("Before");
    expect(html).toContain("After");
    expect(html).toContain("actor-123");
    expect(html).toContain("target-456");
    expect(html).toContain("active");
    expect(html).toContain("suspended");
    expect(html).toContain("&lt;script&gt;synthetic reason&lt;/script&gt;");
    expect(html).toContain("&lt;script&gt;synthetic state&lt;/script&gt;");
    expect(html).not.toContain("<script>synthetic");
  });
});
