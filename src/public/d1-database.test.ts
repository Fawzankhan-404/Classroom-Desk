import { describe, expect, it, vi } from "vitest";
import { D1SqlDatabase, translatePostgresSql } from "./d1-database.js";

function mockD1() {
  const all = vi.fn(async () => ({ success: true, results: [{ value: 7 }] }));
  const bind = vi.fn(() => ({ all }));
  const prepare = vi.fn(() => ({ bind }));
  const batch = vi.fn(async () => [{ success: true, results: [{ value: 8 }] }]);
  return { database: new D1SqlDatabase({ prepare, batch }), all, bind, prepare, batch };
}

describe("D1SqlDatabase", () => {
  it("translates the repository's PostgreSQL syntax to SQLite syntax", () => {
    expect(translatePostgresSql("SELECT NULL::text, now() - interval '30 days' WHERE id=$1"))
      .toBe("SELECT NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 days') WHERE id=?1");
    expect(() => translatePostgresSql("SELECT id FROM x FOR UPDATE")).toThrow("d1_row_locks_require_atomic_refactor");
    expect(() => translatePostgresSql("SELECT pg_advisory_xact_lock(hashtext($1))")).toThrow("d1_advisory_locks_require_atomic_refactor");
  });

  it("binds dates as UTC text and returns D1 rows", async () => {
    const d1 = mockD1();
    const result = await d1.database.query("SELECT $1", [new Date("2026-10-14T00:00:00.000Z")]);
    expect(d1.prepare).toHaveBeenCalledWith("SELECT ?1");
    expect(d1.bind).toHaveBeenCalledWith("2026-10-14T00:00:00.000Z");
    expect(result.rows).toEqual([{ value: 7 }]);
  });

  it("uses D1 batch for explicit atomic statement groups", async () => {
    const d1 = mockD1();
    const result = await d1.database.batch([{ sql: "INSERT INTO x (id) VALUES ($1)", values: ["x"] }]);
    expect(d1.batch).toHaveBeenCalledTimes(1);
    expect(result).toEqual([{ rows: [{ value: 8 }] }]);
  });

  it("fails closed when code requests an interactive transaction", async () => {
    const { database } = mockD1();
    await expect(database.transaction(async () => undefined)).rejects.toThrow("d1_interactive_transactions_unsupported");
  });
});
