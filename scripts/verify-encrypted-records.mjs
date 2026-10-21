#!/usr/bin/env node
import { createDecipheriv, hkdfSync } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;
const MAX_RECORDS = 10_000;
const PROFILE_ENCRYPTION_INFO = "classroom-saas-profile-v1";
const PROFILE_LOOKUP_INFO = "classroom-saas-profile-lookups-v1";
const AUTH_ENCRYPTION_INFO = "classroom-auth-records-v1";
const AUTH_LOOKUP_INFO = "classroom-auth-lookups-v1";
const AUTH_KINDS = new Set(["client", "flow", "grant", "code", "access", "refresh"]);

function decodeKey(keyBase64) {
  if (typeof keyBase64 !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(keyBase64)) return undefined;
  const key = Buffer.from(keyBase64, "base64");
  return key.length === 32 && key.toString("base64") === keyBase64 ? key : undefined;
}

function decodeEnvelope(value) {
  if (typeof value !== "string") return undefined;
  const parts = value.split(".");
  if (parts.length !== 4 || parts[0] !== "v1" || parts.slice(1).some(part => !part)) return undefined;
  if (parts.slice(1).some(part => !/^[A-Za-z0-9_-]+$/.test(part))) return undefined;
  const iv = Buffer.from(parts[1], "base64url");
  const tag = Buffer.from(parts[2], "base64url");
  const body = Buffer.from(parts[3], "base64url");
  if (iv.length !== 12 || tag.length !== 16 || body.length === 0) return undefined;
  if (iv.toString("base64url") !== parts[1] || tag.toString("base64url") !== parts[2] || body.toString("base64url") !== parts[3]) return undefined;
  return { iv, tag, body };
}

function decryptJson(envelope, key, aad) {
  const parts = decodeEnvelope(envelope);
  if (!parts) return undefined;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, parts.iv);
    if (aad !== undefined) decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(parts.tag);
    const plaintext = Buffer.concat([decipher.update(parts.body), decipher.final()]);
    try {
      return JSON.parse(plaintext.toString("utf8"));
    } finally {
      plaintext.fill(0);
    }
  } catch {
    return undefined;
  }
}

function isProfile(value) {
  return value !== null && typeof value === "object"
    && typeof value.googleSubject === "string"
    && typeof value.email === "string"
    && typeof value.displayName === "string";
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Validate encrypted records without returning or logging decoded content. */
export function verifyEncryptedSnapshot(snapshot, keyBase64) {
  const root = decodeKey(keyBase64);
  const result = { profiles: { valid: 0, invalid: 0 }, oauthRecords: { valid: 0, invalid: 0 }, passed: false };
  if (!root || !isPlainObject(snapshot) || !Array.isArray(snapshot.profiles) || !Array.isArray(snapshot.oauthRecords)
    || snapshot.profiles.length + snapshot.oauthRecords.length > MAX_RECORDS) {
    if (root) root.fill(0);
    return result;
  }

  const profileKey = Buffer.from(hkdfSync("sha256", root, Buffer.alloc(0), PROFILE_ENCRYPTION_INFO, 32));
  const authKey = Buffer.from(hkdfSync("sha256", root, Buffer.alloc(0), AUTH_ENCRYPTION_INFO, 32));
  try {
    for (const row of snapshot.profiles) {
      const value = row && isPlainObject(row) ? decryptJson(row.ciphertext, profileKey) : undefined;
      if (isProfile(value)) result.profiles.valid += 1;
      else result.profiles.invalid += 1;
    }
    for (const row of snapshot.oauthRecords) {
      const validRow = row && isPlainObject(row)
        && typeof row.kind === "string" && AUTH_KINDS.has(row.kind)
        && typeof row.key_hash === "string" && /^[a-f0-9]{64}$/.test(row.key_hash);
      const value = validRow ? decryptJson(row.payload, authKey, `${row.kind}:${row.key_hash}`) : undefined;
      if (isPlainObject(value)) result.oauthRecords.valid += 1;
      else result.oauthRecords.invalid += 1;
    }
  } finally {
    root.fill(0);
    profileKey.fill(0);
    authKey.fill(0);
  }
  result.passed = result.profiles.invalid === 0 && result.oauthRecords.invalid === 0;
  return result;
}

export async function verifyEncryptedSnapshotFile(filePath, keyBase64) {
  let contents;
  try {
    const metadata = await stat(filePath);
    if (!metadata.isFile() || metadata.size > MAX_SNAPSHOT_BYTES) return { profiles: { valid: 0, invalid: 0 }, oauthRecords: { valid: 0, invalid: 0 }, passed: false };
    contents = await readFile(filePath);
    if (contents.length > MAX_SNAPSHOT_BYTES) return { profiles: { valid: 0, invalid: 0 }, oauthRecords: { valid: 0, invalid: 0 }, passed: false };
    return verifyEncryptedSnapshot(JSON.parse(contents.toString("utf8")), keyBase64);
  } catch {
    return { profiles: { valid: 0, invalid: 0 }, oauthRecords: { valid: 0, invalid: 0 }, passed: false };
  } finally {
    contents?.fill(0);
  }
}

function isCli() {
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isCli()) {
  const filePath = process.argv[2];
  if (!filePath || filePath === "--help" || filePath === "-h") {
    process.stdout.write("Usage: V2_PUBLIC_AUTH_ENCRYPTION_KEY_B64=<securely supplied> node scripts/verify-encrypted-records.mjs <protected-snapshot.json>\n");
    process.exit(filePath ? 0 : 2);
  }
  const result = await verifyEncryptedSnapshotFile(filePath, process.env.V2_PUBLIC_AUTH_ENCRYPTION_KEY_B64);
  process.stdout.write(`${result.passed ? "PASS" : "FAIL"} profiles=${result.profiles.valid}/${result.profiles.valid + result.profiles.invalid} oauth_records=${result.oauthRecords.valid}/${result.oauthRecords.valid + result.oauthRecords.invalid}\n`);
  process.exit(result.passed ? 0 : 1);
}
