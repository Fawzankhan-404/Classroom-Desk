import { describe, expect, it } from "vitest";
import { GOOGLE_CANONICAL_CLASSROOM_SCOPES, isExactPublicGoogleGrant, PUBLIC_CLASSROOM_SCOPES } from "./scopes.js";

describe("public Google grant validation", () => {
  it("accepts only the requested six or Google's observed canonical five", () => {
    expect(isExactPublicGoogleGrant(PUBLIC_CLASSROOM_SCOPES)).toBe(true);
    expect(isExactPublicGoogleGrant(GOOGLE_CANONICAL_CLASSROOM_SCOPES)).toBe(true);
    for (const scope of GOOGLE_CANONICAL_CLASSROOM_SCOPES) {
      expect(isExactPublicGoogleGrant(GOOGLE_CANONICAL_CLASSROOM_SCOPES.filter((candidate) => candidate !== scope))).toBe(false);
    }
    expect(isExactPublicGoogleGrant([...GOOGLE_CANONICAL_CLASSROOM_SCOPES, "https://www.googleapis.com/auth/drive.readonly"])).toBe(false);
    expect(isExactPublicGoogleGrant([...GOOGLE_CANONICAL_CLASSROOM_SCOPES, GOOGLE_CANONICAL_CLASSROOM_SCOPES[0]])).toBe(false);
  });
});
