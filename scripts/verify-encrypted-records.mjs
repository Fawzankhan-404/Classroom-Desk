#!/usr/bin/env node
import { createDecipheriv, hkdfSync } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;
const MAX_RECORDS = 10_000;
const PROFILE_ENCRYPTION_INFO = "classroom-saas-profile-v1";
const PROFILE_LOOKUP_INFO = "classroom-saas-profile-lookups-v1";
const AUTH_ENCRYPTION_INFO = "classroom-auth-records-v1";
const AUTH_LOOKUP_INFO = "classroom-auth-lookups-v1";
const AUTH_KINDS = new Set(["client", "flow", "grant", "code", "access", "refresh"]);
const CREDENTIAL_TARGET_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$/;

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

function hasOnlyKeys(value, allowed) {
  return isPlainObject(value) && Object.keys(value).every((key) => allowed.includes(key));
}

/** Validate encrypted records without returning or logging decoded content. */
export function verifyEncryptedSnapshot(snapshot, keyBase64) {
  const root = decodeKey(keyBase64);
  const result = { profiles: { valid: 0, invalid: 0 }, oauthRecords: { valid: 0, invalid: 0 }, passed: false };
  if (!root || !hasOnlyKeys(snapshot, ["profiles", "oauthRecords"])
    || !Array.isArray(snapshot.profiles) || !Array.isArray(snapshot.oauthRecords)
    || snapshot.profiles.length === 0 || snapshot.oauthRecords.length === 0
    || snapshot.profiles.length + snapshot.oauthRecords.length > MAX_RECORDS) {
    if (root) root.fill(0);
    return result;
  }

  const profileKey = Buffer.from(hkdfSync("sha256", root, Buffer.alloc(0), PROFILE_ENCRYPTION_INFO, 32));
  const authKey = Buffer.from(hkdfSync("sha256", root, Buffer.alloc(0), AUTH_ENCRYPTION_INFO, 32));
  try {
    for (const row of snapshot.profiles) {
      const value = hasOnlyKeys(row, ["ciphertext"]) ? decryptJson(row.ciphertext, profileKey) : undefined;
      if (isProfile(value)) result.profiles.valid += 1;
      else result.profiles.invalid += 1;
    }
    for (const row of snapshot.oauthRecords) {
      const validRow = hasOnlyKeys(row, ["kind", "key_hash", "payload"])
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
    const metadata = await lstat(filePath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_SNAPSHOT_BYTES) return { profiles: { valid: 0, invalid: 0 }, oauthRecords: { valid: 0, invalid: 0 }, passed: false };
    contents = await readFile(filePath);
    if (contents.length > MAX_SNAPSHOT_BYTES) return { profiles: { valid: 0, invalid: 0 }, oauthRecords: { valid: 0, invalid: 0 }, passed: false };
    return verifyEncryptedSnapshot(JSON.parse(contents.toString("utf8")), keyBase64);
  } catch {
    return { profiles: { valid: 0, invalid: 0 }, oauthRecords: { valid: 0, invalid: 0 }, passed: false };
  } finally {
    contents?.fill(0);
  }
}

/**
 * Read a named Generic Credential from the current Windows user's Credential
 * Manager. The key crosses only a captured child-process pipe; it is never
 * placed in process arguments, environment variables, or terminal output.
 */
export function readWindowsCredentialKey(targetName, {
  platform = process.platform,
  spawn = spawnSync,
} = {}) {
  if (platform !== "win32" || typeof targetName !== "string" || !CREDENTIAL_TARGET_PATTERN.test(targetName)) return undefined;

  const source = String.raw`
$ErrorActionPreference = 'Stop'
$WarningPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::ASCII
$credentialSource = @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class ClassroomDeskCredentialReader {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  private struct Credential {
    public UInt32 Flags; public UInt32 Type; public IntPtr TargetName; public IntPtr Comment;
    public Int64 LastWritten; public UInt32 CredentialBlobSize; public IntPtr CredentialBlob;
    public UInt32 Persist; public UInt32 AttributeCount; public IntPtr Attributes;
    public IntPtr TargetAlias; public IntPtr UserName;
  }
  [DllImport("Advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool CredRead(string target, UInt32 type, UInt32 flags, out IntPtr credential);
  [DllImport("Advapi32.dll", EntryPoint = "CredFree")]
  private static extern void CredFree(IntPtr credential);
  public static string Read(string target) {
    IntPtr pointer = IntPtr.Zero;
    if (!CredRead(target, 1, 0, out pointer) || pointer == IntPtr.Zero) throw new InvalidOperationException();
    try {
      Credential credential = (Credential)Marshal.PtrToStructure(pointer, typeof(Credential));
      int length = checked((int)credential.CredentialBlobSize);
      if (length <= 0 || length > 512 || credential.CredentialBlob == IntPtr.Zero) throw new InvalidOperationException();
      byte[] bytes = new byte[length];
      Marshal.Copy(credential.CredentialBlob, bytes, 0, length);
      try {
        if (length == 44) return Encoding.ASCII.GetString(bytes);
        if (length % 2 == 0) return Encoding.Unicode.GetString(bytes).TrimEnd((char)0);
        throw new InvalidOperationException();
      } finally { Array.Clear(bytes, 0, bytes.Length); }
    } finally { CredFree(pointer); }
  }
}
'@
try {
  Add-Type -TypeDefinition $credentialSource -ErrorAction Stop
  [Console]::Out.Write([ClassroomDeskCredentialReader]::Read('${targetName}'))
} catch {
  [Console]::Error.WriteLine('Credential unavailable')
  exit 1
}
`;

  let result;
  try {
    result = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", source], {
      encoding: "buffer",
      windowsHide: true,
      maxBuffer: 4096,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return undefined;
  }
  if (result.error || result.status !== 0 || !Buffer.isBuffer(result.stdout)
    || result.stdout.length === 0 || result.stdout.length > 256
    || [...result.stdout].some((byte) => byte > 0x7f)) return undefined;
  const value = result.stdout.toString("ascii");
  const key = decodeKey(value);
  if (!key) return undefined;
  key.fill(0);
  return value;
}

export async function runVerifierCli(args, {
  credentialReader = readWindowsCredentialKey,
  stdout = process.stdout,
} = {}) {
  if (args.length !== 3 || args[1] !== "--windows-credential-target" || args.includes("--help") || args.includes("-h")) {
    stdout.write("Usage: node scripts/verify-encrypted-records.mjs <protected-snapshot.json> --windows-credential-target <credential-target>\n");
    stdout.write("The key is read from the current Windows user's Credential Manager and is never printed.\n");
    return args.includes("--help") || args.includes("-h") ? 0 : 2;
  }
  let keyBase64;
  try {
    keyBase64 = await credentialReader(args[2]);
  } catch {
    keyBase64 = undefined;
  }
  const decodedKey = decodeKey(keyBase64);
  if (!decodedKey) {
    stdout.write("FAIL credential_unavailable_or_invalid\n");
    return 2;
  }
  decodedKey.fill(0);
  const result = await verifyEncryptedSnapshotFile(args[0], keyBase64);
  keyBase64 = undefined;
  stdout.write(`${result.passed ? "PASS" : "FAIL"} profiles=${result.profiles.valid}/${result.profiles.valid + result.profiles.invalid} oauth_records=${result.oauthRecords.valid}/${result.oauthRecords.valid + result.oauthRecords.invalid}\n`);
  return result.passed ? 0 : 1;
}

function isCli() {
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isCli()) process.exitCode = await runVerifierCli(process.argv.slice(2));
