import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { SaaSMigration } from "./schema.js";
import { SaaSStore } from "./store.js";
import { SaaSProfileCipher } from "./privacy.js";
import type { SqlConnection, SqlDatabase } from "../public/postgres.js";

function database(pg: PGlite): SqlDatabase {
  const query: SqlConnection["query"] = async (sql, values = []) => ({ rows: (await pg.query(sql, values)).rows as never });
  return { query, transaction: async work => pg.transaction(async tx => work({ query: async (sql, values = []) => ({ rows: (await tx.query(sql, values)).rows as never }) })) };
}

describe("encrypted profile storage", () => {
  let pg: PGlite;
  let db: SqlDatabase;
  beforeEach(async () => { pg = new PGlite(); await pg.exec(SaaSMigration); db = database(pg); }, 30_000);
  afterEach(async () => pg.close());

  const identity = (subject: string, email = `${subject}@example.invalid`, displayName = `Synthetic ${subject}`) => ({ googleSubject: subject, email, displayName, now: new Date("2026-10-20T00:00:00Z") });

  it("stores new profiles as v1 ciphertext and returns the verified profile only through the keyed reader", async () => {
    const key = randomBytes(32).toString("base64");
    const store = new SaaSStore(db, { profileEncryptionKeyBase64: key, requireProfileEncryption: true });
    const user = await store.upsertGoogleIdentity(identity("synthetic-encrypted-user"));
    const row = (await db.query<{ google_subject: string; email: string; display_name: string; profile_ciphertext: string }>(
      "SELECT google_subject,email,display_name,profile_ciphertext FROM classroom_desk_users WHERE id=$1", [user.id],
    )).rows[0]!;
    expect(row.google_subject).toBeNull();
    expect(row.email).toMatch(/^enc:[a-f0-9]{64}$/);
    expect(row.display_name).toMatch(/^enc:[a-f0-9]{64}$/);
    expect(row.profile_ciphertext).toMatch(/^v1\./);
    const verifier = new SaaSStore(db, { profileEncryptionKeyBase64: key, requireProfileEncryption: true });
    expect(await verifier.inspectProfileStorageCompatibility()).toMatchObject({
      profilesChecked: 1, markerMatches: 0, markerMismatches: 0, missingMarkers: 1,
      missingSubjectHashes: 0, decryptionFailures: 0, identityConsistencyFailures: 0,
    });
    expect(await verifier.verifyProfileStorageCompatibility()).toBe(1);
    expect(await store.getUser(user.id)).toMatchObject({
      googleSubject: "synthetic-encrypted-user",
      email: "synthetic-encrypted-user@example.invalid",
      displayName: "Synthetic synthetic-encrypted-user",
    });
  });

  it("fails closed with an incorrect key and leaves existing ciphertext unchanged", async () => {
    const key = randomBytes(32).toString("base64");
    const wrongKey = randomBytes(32).toString("base64");
    const writer = new SaaSStore(db, { profileEncryptionKeyBase64: key, requireProfileEncryption: true });
    const user = await writer.upsertGoogleIdentity(identity("synthetic-key-mismatch"));
    const before = (await db.query<{ profile_ciphertext: string; google_subject_hash: string }>(
      "SELECT profile_ciphertext,google_subject_hash FROM classroom_desk_users WHERE id=$1", [user.id],
    )).rows[0]!;
    const incompatible = new SaaSStore(db, { profileEncryptionKeyBase64: wrongKey, requireProfileEncryption: true });
    await expect(incompatible.verifyProfileStorageCompatibility()).rejects.toThrow("stored_profile_unavailable");
    const after = (await db.query<{ profile_ciphertext: string; google_subject_hash: string }>(
      "SELECT profile_ciphertext,google_subject_hash FROM classroom_desk_users WHERE id=$1", [user.id],
    )).rows[0]!;
    expect(after).toEqual(before);
  });

  it("validates a legacy encrypted subject marker when its redundant subject hash is absent", async () => {
    const key = randomBytes(32).toString("base64");
    const cipher = new SaaSProfileCipher(key);
    const writer = new SaaSStore(db, { profileEncryptionKeyBase64: key, requireProfileEncryption: true });
    const user = await writer.upsertGoogleIdentity(identity("synthetic-null-subject-hash"));
    await db.query("UPDATE classroom_desk_users SET google_subject=$2,google_subject_hash=NULL WHERE id=$1", [
      user.id,
      `enc:${cipher.digest("synthetic-null-subject-hash")}`,
    ]);

    expect(await new SaaSStore(db, { profileEncryptionKeyBase64: key, requireProfileEncryption: true }).verifyProfileStorageCompatibility()).toBe(1);
  });

  it("rejects a mismatched legacy subject marker when the subject hash is absent", async () => {
    const key = randomBytes(32).toString("base64");
    const cipher = new SaaSProfileCipher(key);
    const writer = new SaaSStore(db, { profileEncryptionKeyBase64: key, requireProfileEncryption: true });
    const user = await writer.upsertGoogleIdentity(identity("synthetic-null-subject-hash-mismatch"));
    await db.query("UPDATE classroom_desk_users SET google_subject=$2,google_subject_hash=NULL WHERE id=$1", [
      user.id,
      `enc:${cipher.digest("different-synthetic-subject")}`,
    ]);

    const verifier = new SaaSStore(db, { profileEncryptionKeyBase64: key, requireProfileEncryption: true });
    expect(await verifier.inspectProfileStorageCompatibility()).toMatchObject({
      profilesChecked: 1, markerMatches: 0, markerMismatches: 1, missingMarkers: 0,
      missingSubjectHashes: 1, decryptionFailures: 0, identityConsistencyFailures: 1,
    });
    await expect(verifier.verifyProfileStorageCompatibility())
      .rejects.toThrow("profile_storage_compatibility_failed");
  });

  it("validates a fully detached encrypted profile only against its archived subject binding", async () => {
    const key = randomBytes(32).toString("base64");
    const cipher = new SaaSProfileCipher(key);
    const writer = new SaaSStore(db, { profileEncryptionKeyBase64: key, requireProfileEncryption: true });
    const subject = "synthetic-detached-subject-marker";
    const user = await writer.upsertGoogleIdentity(identity(subject));
    await db.query(`INSERT INTO classroom_desk_detached_google_identities
      (account_id,google_subject,google_subject_hash,detached_at,reason)
      VALUES ($1,$2,NULL,$3,'owner_authorized_auth_reset')`, [user.id, `enc:${cipher.digest(subject)}`, new Date()]);
    await db.query("UPDATE classroom_desk_users SET google_subject=NULL,google_subject_hash=NULL WHERE id=$1", [user.id]);

    expect(await new SaaSStore(db, { profileEncryptionKeyBase64: key, requireProfileEncryption: true }).verifyProfileStorageCompatibility()).toBe(1);
  });

  it("fails closed for a detached encrypted profile with no matching archived identity", async () => {
    const key = randomBytes(32).toString("base64");
    const writer = new SaaSStore(db, { profileEncryptionKeyBase64: key, requireProfileEncryption: true });
    const user = await writer.upsertGoogleIdentity(identity("synthetic-detached-archive-missing"));
    await db.query("UPDATE classroom_desk_users SET google_subject=NULL,google_subject_hash=NULL WHERE id=$1", [user.id]);

    await expect(new SaaSStore(db, { profileEncryptionKeyBase64: key, requireProfileEncryption: true }).verifyProfileStorageCompatibility())
      .rejects.toThrow("profile_storage_compatibility_failed");
  });
});
