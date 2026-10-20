import { describe, expect, it } from "vitest";
import { safeWebsiteReturnPath } from "./website-routes.js";

describe("safeWebsiteReturnPath", () => {
  it("allows the Pricing page and only a single valid referral code", () => {
    expect(safeWebsiteReturnPath("/pricing")).toBe("/pricing");
    expect(safeWebsiteReturnPath("/pricing?ref=CD-a1b2c3d4e5")).toBe("/pricing?ref=CD-A1B2C3D4E5");
    expect(safeWebsiteReturnPath("/pricing#refer-and-earn")).toBe("/pricing#refer-and-earn");
    expect(safeWebsiteReturnPath("/pricing?ref=CD-a1b2c3d4e5#refer-and-earn")).toBe("/pricing?ref=CD-A1B2C3D4E5#refer-and-earn");
    expect(safeWebsiteReturnPath("/app/connection?tab=google")).toBe("/app/connection?tab=google");
  });

  it.each([
    "https://attacker.invalid/",
    "//attacker.invalid/",
    "/pricing?ref=CD-A1B2C3D4E5&next=https://attacker.invalid",
    "/pricing?ref=CD-A1B2C3D4E5&ref=CD-112233AABB",
    "/pricing?ref=invalid",
    "/pricing#external",
    "/%2fattacker.invalid",
    "/pricing\\\\attacker.invalid",
  ])("rejects unsafe or malformed return destinations (%s)", (value) => {
    expect(safeWebsiteReturnPath(value)).toBe("/app");
  });
});
