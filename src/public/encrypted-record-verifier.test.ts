import { createCipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyEncryptedSnapshot } from "../../scripts/verify-encrypted-records.mjs";

const TEST_KEY = Buffer.from(Array.from({ length: 32 }, (_, i) => i)).toString("base64");

function seal(value: unknown, key: Buffer, aad?: string, iv = Buffer.alloc(12, 0x2a)): string {
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  if (aad !== undefined) cipher.setAAD(Buffer.from(aad, "utf8"));
  const body = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return `v1.${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${body.toString("base64url")}`;
}

function fixture() {
  const root = Buffer.from(TEST_KEY, "base64");
  const profileKey = Buffer.from(hkdfSync("sha256", root, Buffer.alloc(0), "classroom-saas-profile-v1", 32));
  const authKey = Buffer.from(hkdfSync("sha256", root, Buffer.alloc(0), "classroom-auth-records-v1", 32));
  const lookupKey = Buffer.from(hkdfSync("sha256", root, Buffer.alloc(0), "classroom-auth-lookups-v1", 32));
  const mcpUser = "synthetic-mcp-user";
  const keyHash = createHmac("sha256", lookupKey).update(mcpUser).digest("hex");
  const profile = seal({ googleSubject: "synthetic-subject", email: "synthetic@example.invalid", displayName: "Synthetic Student" }, profileKey);
  const grant = seal({ userId: mcpUser, refreshToken: "synthetic-only", scopes: ["openid", "email"] }, authKey, `grant:${keyHash}`);
  for (const key of [root, profileKey, authKey, lookupKey]) key.fill(0);
  return {
    profile,
    grant: { kind: "grant", key_hash: keyHash, payload: grant },
  };
}

function tamperTag(envelope: string): string {
  const parts = envelope.split(".");
  const tag = Buffer.from(parts[2]!, "base64url");
  tag[0] ^= 0x01;
  parts[2] = tag.toString("base64url");
  return parts.join(".");
}

describe("encrypted record compatibility verifier", () => {
  it("verifies v1 AES-GCM profile and OAuth envelopes with the production HKDF labels", () => {
    const sample = fixture();
    expect(verifyEncryptedSnapshot({ profiles: [{ ciphertext: sample.profile }], oauthRecords: [sample.grant] }, TEST_KEY))
      .toEqual({ profiles: { valid: 1, invalid: 0 }, oauthRecords: { valid: 1, invalid: 0 }, passed: true });
  });

  it("fails closed for altered ciphertext and mismatched OAuth AAD", () => {
    const sample = fixture();
    const result = verifyEncryptedSnapshot({
      profiles: [{ ciphertext: sample.profile }],
      oauthRecords: [{ ...sample.grant, payload: tamperTag(sample.grant.payload) }, { ...sample.grant, kind: "flow" }],
    }, TEST_KEY);
    expect(result).toEqual({ profiles: { valid: 1, invalid: 0 }, oauthRecords: { valid: 0, invalid: 2 }, passed: false });
  });

  it("fails closed when the supplied master key does not match", () => {
    const sample = fixture();
    const result = verifyEncryptedSnapshot({ profiles: [{ ciphertext: sample.profile }], oauthRecords: [sample.grant] }, Buffer.alloc(32, 0x7f).toString("base64"));
    expect(result).toEqual({ profiles: { valid: 0, invalid: 1 }, oauthRecords: { valid: 0, invalid: 1 }, passed: false });
  });

  it("returns only aggregate counts and rejects malformed snapshots", () => {
    const result = verifyEncryptedSnapshot({ profiles: [{ ciphertext: "not-a-record" }], oauthRecords: [] }, TEST_KEY);
    expect(Object.keys(result).sort()).toEqual(["oauthRecords", "passed", "profiles"]);
    expect(result).toEqual({ profiles: { valid: 0, invalid: 1 }, oauthRecords: { valid: 0, invalid: 0 }, passed: false });
    expect(verifyEncryptedSnapshot({}, TEST_KEY).passed).toBe(false);
  });
});
