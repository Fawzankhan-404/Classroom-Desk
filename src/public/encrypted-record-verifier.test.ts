import { createCipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readWindowsCredentialKey, runVerifierCli, verifyEncryptedSnapshot, verifyEncryptedSnapshotFile } from "../../scripts/verify-encrypted-records.mjs";

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
    expect(result).toEqual({ profiles: { valid: 0, invalid: 0 }, oauthRecords: { valid: 0, invalid: 0 }, passed: false });
    expect(verifyEncryptedSnapshot({}, TEST_KEY).passed).toBe(false);
  });

  it("fails closed when either encrypted record class is empty", () => {
    expect(verifyEncryptedSnapshot({ profiles: [], oauthRecords: [fixture().grant] }, TEST_KEY).passed).toBe(false);
    expect(verifyEncryptedSnapshot({ profiles: [{ ciphertext: fixture().profile }], oauthRecords: [] }, TEST_KEY).passed).toBe(false);
  });

  it("rejects snapshots containing unencrypted account or token fields", () => {
    const sample = fixture();
    expect(verifyEncryptedSnapshot({
      profiles: [{ ciphertext: sample.profile, email: "synthetic@example.invalid" }],
      oauthRecords: [sample.grant],
    }, TEST_KEY).passed).toBe(false);
    expect(verifyEncryptedSnapshot({
      profiles: [{ ciphertext: sample.profile }],
      oauthRecords: [{ ...sample.grant, access_token: "synthetic-only" }],
    }, TEST_KEY).passed).toBe(false);
  });

  it("rejects symlink snapshot paths without reading their target", async () => {
    const directory = await mkdtemp(join(tmpdir(), "classroom-desk-encrypted-snapshot-"));
    const target = join(directory, "snapshot.json");
    const link = join(directory, "snapshot-link.json");
    try {
      const sample = fixture();
      await writeFile(target, JSON.stringify({ profiles: [{ ciphertext: sample.profile }], oauthRecords: [sample.grant] }));
      try {
        await symlink(target, link);
      } catch (error) {
        if (process.platform === "win32" && ["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) return;
        throw error;
      }
      await expect(verifyEncryptedSnapshotFile(link, TEST_KEY)).resolves.toEqual({
        profiles: { valid: 0, invalid: 0 }, oauthRecords: { valid: 0, invalid: 0 }, passed: false,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("prints only aggregate verification results from the owner-invoked CLI", async () => {
    const directory = await mkdtemp(join(tmpdir(), "classroom-desk-encrypted-snapshot-"));
    const snapshotPath = join(directory, "synthetic-snapshot.json");
    const sample = fixture();
    try {
      await writeFile(snapshotPath, JSON.stringify({ profiles: [{ ciphertext: sample.profile }], oauthRecords: [sample.grant] }));
      let stdout = "";
      const exitCode = await runVerifierCli([snapshotPath, "--windows-credential-target", "synthetic-test-key"], {
        credentialReader: (target) => target === "synthetic-test-key" ? TEST_KEY : undefined,
        stdout: { write: (value: string) => { stdout += value; return true; } } as NodeJS.WriteStream,
      });
      expect(exitCode).toBe(0);
      expect(stdout).toBe("PASS profiles=1/1 oauth_records=1/1\n");
      for (const sensitive of [TEST_KEY, "synthetic-subject", "synthetic@example.invalid", "synthetic-only", sample.profile, sample.grant.payload]) {
        expect(stdout).not.toContain(sensitive);
      }
      expect(await readFile(snapshotPath, "utf8")).toContain(sample.profile);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reads only a named Windows credential through a captured child-process pipe", () => {
    const calls: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = [];
    const value = readWindowsCredentialKey("synthetic-key-target", {
      platform: "win32",
      spawn: (command, args, options) => {
        calls.push({ command, args: [...args], options });
        return { status: 0, error: undefined, stdout: Buffer.from(TEST_KEY, "ascii"), stderr: Buffer.alloc(0) } as never;
      },
    });
    expect(value).toBe(TEST_KEY);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe("powershell.exe");
    expect(calls[0]!.args.join(" ")).toContain("synthetic-key-target");
    expect(calls[0]!.args.join(" ")).not.toContain(TEST_KEY);
    expect(calls[0]!.options).toMatchObject({ windowsHide: true, encoding: "buffer", stdio: ["ignore", "pipe", "ignore"] });
  });

  it("does not start a credential reader for non-Windows hosts or unsafe targets", () => {
    let calls = 0;
    const spawn = () => { calls += 1; return { status: 0, stdout: Buffer.from(TEST_KEY) } as never; };
    expect(readWindowsCredentialKey("safe-target", { platform: "linux", spawn })).toBeUndefined();
    expect(readWindowsCredentialKey("bad'; Write-Output 'injected", { platform: "win32", spawn })).toBeUndefined();
    expect(calls).toBe(0);
  });

  it("does not accept an environment-only key source", async () => {
    let output = "";
    let calls = 0;
    const exitCode = await runVerifierCli(["snapshot.json"], {
      credentialReader: () => { calls += 1; return TEST_KEY; },
      stdout: { write: (value: string) => { output += value; return true; } } as NodeJS.WriteStream,
    });
    expect(exitCode).toBe(2);
    expect(calls).toBe(0);
    expect(output).toContain("--windows-credential-target");
    expect(output).not.toContain(TEST_KEY);
  });
});
