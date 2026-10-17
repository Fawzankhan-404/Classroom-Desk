import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { SaaSProfileCipher } from "./privacy.js";

describe("SaaS profile privacy", () => {
  it("round-trips identity fields without storing plaintext in the envelope", () => {
    const key = randomBytes(32).toString("base64");
    const cipher = new SaaSProfileCipher(key);
    const profile = { googleSubject: "google-subject", email: "person@example.com", displayName: "Person" };
    const sealed = cipher.seal(profile);
    expect(sealed).not.toContain(profile.email);
    expect(sealed).not.toContain(profile.googleSubject);
    expect(cipher.open(sealed)).toEqual(profile);
    expect(cipher.digest(profile.googleSubject)).toHaveLength(64);
    expect(cipher.digest(profile.googleSubject)).toBe(cipher.digest(profile.googleSubject));
  });

  it("rejects a ciphertext produced with another key", async () => {
    const first = new SaaSProfileCipher(randomBytes(32).toString("base64"));
    const second = new SaaSProfileCipher(randomBytes(32).toString("base64"));
    await expect(Promise.resolve().then(() => second.open(first.seal({ googleSubject: "s", email: "e@example.com", displayName: "E" })))).rejects.toThrow("stored_profile_unavailable");
  });
});
