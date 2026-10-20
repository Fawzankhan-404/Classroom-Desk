import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { SaaSMigration } from "./schema.js";
import { SaaSStore } from "./store.js";
import type { SqlConnection, SqlDatabase } from "../public/postgres.js";

describe("last active super-admin invariant", () => {
  const pg = new PGlite();
  let store: SaaSStore;

  beforeAll(async () => {
    await pg.exec(SaaSMigration);
    const query: SqlConnection["query"] = async (sql, values = []) => ({ rows: (await pg.query(sql, values)).rows as never });
    const db: SqlDatabase = {
      query,
      transaction: (work) => pg.transaction((tx) => work({ query: async (sql, values = []) => ({ rows: (await tx.query(sql, values)).rows as never }) })),
    };
    store = new SaaSStore(db);
  });

  afterAll(async () => { await pg.close(); });

  const createAdmin = async (subject: string) => (await pg.query<{ id: string }>(
    `INSERT INTO classroom_desk_users (google_subject,email,display_name,role) VALUES ($1,$2,$3,'SUPER_ADMIN') RETURNING id`,
    [subject, `${subject}@example.invalid`, subject],
  )).rows[0]!.id;

  it("rejects the last-admin demotion and serializes concurrent self-demotions", async () => {
    const first = await createAdmin("synthetic-admin-one");
    await expect(store.adminChangeRole(first, first, "STUDENT", "synthetic sole-admin check"))
      .rejects.toThrow("last_super_admin_required");
    expect((await store.getUser(first))?.role).toBe("SUPER_ADMIN");

    const second = await createAdmin("synthetic-admin-two");
    const changes = await Promise.allSettled([
      store.adminChangeRole(first, first, "STUDENT", "synthetic concurrent admin check"),
      store.adminChangeRole(second, second, "STUDENT", "synthetic concurrent admin check"),
    ]);
    expect(changes.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(changes.filter((item) => item.status === "rejected" && (item.reason as Error).message === "last_super_admin_required")).toHaveLength(1);

    const remaining = await pg.query<{ count: string }>(`SELECT count(*) AS count FROM classroom_desk_users WHERE role='SUPER_ADMIN' AND status='active'`);
    expect(Number(remaining.rows[0]?.count)).toBe(1);
    const audit = await pg.query<{ count: string }>(`SELECT count(*) AS count FROM classroom_desk_admin_audit WHERE action='change_role'`);
    expect(Number(audit.rows[0]?.count)).toBe(1);
  });

  it("keeps one active super admin after reciprocal concurrent suspensions", async () => {
    const first = await createAdmin("synthetic-admin-suspend-one");
    const second = await createAdmin("synthetic-admin-suspend-two");
    const attempts = await Promise.allSettled([
      store.adminSetStatus(first, second, "suspended", "synthetic reciprocal suspension"),
      store.adminSetStatus(second, first, "suspended", "synthetic reciprocal suspension"),
    ]);

    expect(attempts.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((item) => item.status === "rejected")).toHaveLength(1);
    const remainingPair = await pg.query<{ count: string }>(`SELECT count(*) AS count FROM classroom_desk_users WHERE id IN ($1,$2) AND role='SUPER_ADMIN' AND status='active'`, [first, second]);
    expect(Number(remainingPair.rows[0]?.count)).toBe(1);
    const remainingGlobal = await pg.query<{ count: string }>(`SELECT count(*) AS count FROM classroom_desk_users WHERE role='SUPER_ADMIN' AND status='active'`);
    expect(Number(remainingGlobal.rows[0]?.count)).toBeGreaterThanOrEqual(1);
    const audit = await pg.query<{ count: string }>(`SELECT count(*) AS count FROM classroom_desk_admin_audit WHERE action='suspend_user' AND target_user_id IN ($1,$2)`, [first, second]);
    expect(Number(audit.rows[0]?.count)).toBe(1);
  });
});
