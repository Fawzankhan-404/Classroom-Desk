import { afterAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { SaaSMigration, SAAS_SCHEMA_VERSION } from "./schema.js";

describe("SaaS schema upgrade compatibility", () => {
  const pg = new PGlite();

  afterAll(async () => { await pg.close(); });

  it("adds privacy storage to an existing user table and is safe to reapply", async () => {
    await pg.exec(`CREATE TABLE classroom_desk_users (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      google_subject text NOT NULL UNIQUE,
      email text NOT NULL,
      display_name text NOT NULL,
      role text NOT NULL DEFAULT 'STUDENT' CHECK (role IN ('SUPER_ADMIN','SUPPORT_ADMIN','STUDENT','TEACHER')),
      status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','deleted')),
      created_at timestamptz NOT NULL DEFAULT now(),
      last_login_at timestamptz
    );
    INSERT INTO classroom_desk_users (google_subject,email,display_name)
      VALUES ('synthetic-legacy-subject','legacy@example.invalid','Synthetic legacy');`);

    await pg.exec(SaaSMigration);
    const columns = await pg.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns
      WHERE table_name='classroom_desk_users' AND column_name IN ('profile_ciphertext','google_subject_hash','email_hash','display_name_hash')`);
    expect(columns.rows.map((row) => row.column_name).sort()).toEqual([
      "display_name_hash", "email_hash", "google_subject_hash", "profile_ciphertext",
    ]);

    const oldRow = await pg.query<{ google_subject: string; email: string; display_name: string; profile_ciphertext: string | null }>(
      `SELECT google_subject,email,display_name,profile_ciphertext FROM classroom_desk_users`);
    expect(oldRow.rows).toEqual([{
      google_subject: "synthetic-legacy-subject", email: "legacy@example.invalid",
      display_name: "Synthetic legacy", profile_ciphertext: null,
    }]);

    const indexes = await pg.query<{ indexname: string }>(`SELECT indexname FROM pg_indexes
      WHERE tablename='classroom_desk_users' AND indexname IN (
        'classroom_desk_users_google_subject_hash_idx',
        'classroom_desk_users_email_hash_idx',
        'classroom_desk_users_display_name_hash_idx'
      )`);
    expect(indexes.rows.map((row) => row.indexname).sort()).toEqual([
      "classroom_desk_users_display_name_hash_idx",
      "classroom_desk_users_email_hash_idx",
      "classroom_desk_users_google_subject_hash_idx",
    ]);

    await pg.exec(SaaSMigration);
    expect(SAAS_SCHEMA_VERSION).toBe(5);
    expect((await pg.query(`SELECT google_subject FROM classroom_desk_users`)).rows).toEqual([{ google_subject: "synthetic-legacy-subject" }]);
    expect((await pg.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_name='classroom_desk_payments' AND column_name='amount_refunded_paise'`)).rows).toEqual([{ column_name: "amount_refunded_paise" }]);
    const operationColumns=await pg.query<{table_name:string;column_name:string}>(`SELECT table_name,column_name FROM information_schema.columns WHERE (table_name,column_name) IN (('classroom_desk_entitlement_grants','last_operation_id'),('classroom_desk_payments','last_operation_id'),('classroom_desk_referrals','qualified_operation_id')) ORDER BY table_name,column_name`);
    expect(operationColumns.rows).toEqual([
      {table_name:"classroom_desk_entitlement_grants",column_name:"last_operation_id"},
      {table_name:"classroom_desk_payments",column_name:"last_operation_id"},
      {table_name:"classroom_desk_referrals",column_name:"qualified_operation_id"},
    ]);
  });
});
