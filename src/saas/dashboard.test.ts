import { describe, expect, it } from "vitest";
import { renderDashboardSection } from "./dashboard.js";

describe("unified Classroom connection dashboard", () => {
  it("makes ChatGPT OAuth the default path and collapses legacy pairing", () => {
    const html = renderDashboardSection({
      user: { displayName: "Synthetic Student", email: "student@example.test", role: "STUDENT" },
      entitlement: { allowed: false, reason: "none", plan: null, expiresAt: null },
      courses: null,
      upcomingAssignments: null,
      missingAssignments: null,
      sync: "not_connected",
    }, "connection");

    expect(html).toContain('href="/connect">Open ChatGPT connection guide');
    expect(html).toContain("New OAuth connections bind through a verified Google identity.");
    expect(html).toMatch(/<details><summary>Using an older MCP connection\?<\/summary><form/);
    expect(html).toContain("Create legacy pairing code");
    expect(html).not.toContain("Start the one-time pairing flow");
    expect(html).not.toContain(">Start pairing<");
  });
});
