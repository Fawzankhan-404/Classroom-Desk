import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { SaaSMigration } from "./schema.js";
import { SaaSStore } from "./store.js";
import type { SqlConnection, SqlDatabase } from "../public/postgres.js";

function database(pg: PGlite): SqlDatabase {
  const query: SqlConnection["query"] = async (sql, values = []) => ({ rows: (await pg.query(sql, values)).rows as never });
  return { query, transaction: async (work) => pg.transaction(async (tx) => work({ query: async (sql, values = []) => ({ rows: (await tx.query(sql, values)).rows as never }) })) };
}

describe("release A profile compatibility bridge", () => {
  const pg = new PGlite();
  let db: SqlDatabase;
  beforeAll(async () => { await pg.exec(SaaSMigration); db = database(pg); }, 30_000);
  afterAll(async () => pg.close());

  const identity = (subject: string, email = `${subject}@example.invalid`, displayName = `Synthetic ${subject}`) => ({ googleSubject: subject, email, displayName, now: new Date("2026-10-16T00:00:00Z") });

  it("requires a valid 32-byte key when the Worker enables encrypted-profile reads", () => {
    const inert = { query: async () => ({ rows: [] }), transaction: async () => undefined } as unknown as SqlDatabase;
    expect(() => new SaaSStore(inert, { requireProfileEncryption: true })).toThrow("profile_encryption_configuration_unavailable");
    expect(() => new SaaSStore(inert, { requireProfileEncryption: true, profileEncryptionKeyBase64: "invalid" })).toThrow("invalid_profile_encryption_key");
  });

  it("reads existing v1 encrypted opaque-subject rows without changing their format", async () => {
    const key = randomBytes(32).toString("base64");
    const encryptedWriter = new SaaSStore(db, { profileEncryptionKeyBase64: key, requireProfileEncryption: true, encryptProfilesOnWrite: true });
    const created = await encryptedWriter.upsertGoogleIdentity(identity("synthetic-opaque"));
    const before = (await db.query<{ google_subject: string; profile_ciphertext: string; google_subject_hash: string; email_hash: string; display_name_hash: string }>("SELECT google_subject,profile_ciphertext,google_subject_hash,email_hash,display_name_hash FROM classroom_desk_users WHERE id=$1", [created.id])).rows[0]!;
    expect(before.google_subject).toMatch(/^enc:[0-9a-f]{64}$/);
    expect(before.profile_ciphertext).toMatch(/^v1\./);

    const bridge = new SaaSStore(db, { profileEncryptionKeyBase64: key, requireProfileEncryption: true, encryptProfilesOnWrite: false });
    expect(await bridge.verifyProfileStorageCompatibility()).toEqual({ encryptedProfiles: 1 });
    const read = await bridge.getUser(created.id);
    expect(read).toMatchObject({ id: created.id, googleSubject: "synthetic-opaque", email: "synthetic-opaque@example.invalid", displayName: "Synthetic synthetic-opaque" });
    await bridge.upsertGoogleIdentity(identity("synthetic-opaque", "updated@example.invalid", "Updated synthetic"));
    const after = (await db.query<{ google_subject: string; email: string; display_name: string; profile_ciphertext: string; google_subject_hash: string; email_hash: string; display_name_hash: string }>("SELECT google_subject,email,display_name,profile_ciphertext,google_subject_hash,email_hash,display_name_hash FROM classroom_desk_users WHERE id=$1", [created.id])).rows[0]!;
    expect(after.google_subject).toBe(before.google_subject);
    expect(after.profile_ciphertext).toBe(before.profile_ciphertext);
    expect(after.google_subject_hash).toBe(before.google_subject_hash);
    expect(after.email_hash).toBe(before.email_hash);
    expect(after.display_name_hash).toBe(before.display_name_hash);
    expect(await bridge.verifyProfileStorageCompatibility()).toEqual({ encryptedProfiles: 1 });
  });

  it("keeps new and legacy login writes readable by the prior plaintext reader", async () => {
    const key = randomBytes(32).toString("base64");
    const bridge = new SaaSStore(db, { profileEncryptionKeyBase64: key, requireProfileEncryption: true, encryptProfilesOnWrite: false });
    const user = await bridge.upsertGoogleIdentity(identity("synthetic-legacy"));
    const legacyReader = await db.query<{ id: string; email: string; display_name: string; profile_ciphertext: string | null }>("SELECT id,email,display_name,profile_ciphertext FROM classroom_desk_users WHERE google_subject=$1", ["synthetic-legacy"]);
    expect(legacyReader.rows).toEqual([{ id: user.id, email: "synthetic-legacy@example.invalid", display_name: "Synthetic synthetic-legacy", profile_ciphertext: null }]);
    await bridge.upsertGoogleIdentity(identity("synthetic-legacy", "updated@example.invalid", "Updated synthetic"));
    const updated = (await db.query<{ email: string; display_name: string; profile_ciphertext: string | null }>("SELECT email,display_name,profile_ciphertext FROM classroom_desk_users WHERE id=$1", [user.id])).rows[0]!;
    expect(updated).toEqual({ email: "updated@example.invalid", display_name: "Updated synthetic", profile_ciphertext: null });
  });

  it("fails closed on a valid-shaped key that cannot decrypt existing rows and makes no writes", async () => {
    const key = randomBytes(32).toString("base64");
    const wrongKey = randomBytes(32).toString("base64");
    const writer = new SaaSStore(db, { profileEncryptionKeyBase64: key, requireProfileEncryption: true, encryptProfilesOnWrite: true });
    const user = await writer.upsertGoogleIdentity(identity("synthetic-wrong-key"));
    const before = (await db.query<{ profile_ciphertext: string; google_subject_hash: string }>("SELECT profile_ciphertext,google_subject_hash FROM classroom_desk_users WHERE id=$1", [user.id])).rows[0]!;
    const incompatible = new SaaSStore(db, { profileEncryptionKeyBase64: wrongKey, requireProfileEncryption: true, encryptProfilesOnWrite: false });
    await expect(incompatible.verifyProfileStorageCompatibility()).rejects.toThrow("stored_profile_unavailable");
    const after = (await db.query<{ profile_ciphertext: string; google_subject_hash: string }>("SELECT profile_ciphertext,google_subject_hash FROM classroom_desk_users WHERE id=$1", [user.id])).rows[0]!;
    expect(after).toEqual(before);
  });
});
