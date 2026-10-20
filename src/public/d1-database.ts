import type { QueryResultRow } from "pg";
import type { SqlConnection, SqlDatabase } from "./postgres.js";

type D1Result<T> = { results?: T[]; success: boolean; error?: string };
type D1Statement = {
  all<T>(): Promise<D1Result<T>>;
};
type D1Binding = {
  prepare(sql: string): { bind(...values: unknown[]): D1Statement };
  batch<T = Record<string, unknown>>(statements: D1Statement[]): Promise<D1Result<T>[]>;
};
type QueryResult<T> = { rows: T[] };

/** A statement and its positional values, suitable for one atomic D1 batch. */
export type D1BatchQuery = { sql: string; values?: unknown[] };

/**
 * PostgreSQL-shaped query adapter for D1 during the storage migration.
 * Ordinary statements and explicit batches are supported. Interactive
 * transactions fail closed: D1 has no connection-scoped BEGIN/COMMIT API, so
 * callers must be converted to a single statement or an explicit D1 batch.
 */
export class D1SqlDatabase implements SqlDatabase {
  constructor(private readonly binding: D1Binding) {}

  private prepare(sql: string, values: unknown[] = []): D1Statement {
    const translated = translatePostgresSql(sql);
    return this.binding.prepare(translated).bind(...values.map(bindValue));
  }

  async query<T extends QueryResultRow = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<QueryResult<T>> {
    const result = await this.prepare(sql, values).all<T>();
    if (!result.success) throw new Error("d1_query_failed", { cause: result.error });
    return { rows: result.results ?? [] };
  }

  async batch<T extends QueryResultRow = Record<string, unknown>>(queries: D1BatchQuery[]): Promise<QueryResult<T>[]> {
    if (queries.length === 0) return [];
    const results = await this.binding.batch<T>(queries.map(({ sql, values }) => this.prepare(sql, values)));
    return results.map((result) => {
      if (!result.success) throw new Error("d1_batch_failed", { cause: result.error });
      return { rows: result.results ?? [] };
    });
  }

  async transaction<T>(_run: (tx: SqlConnection) => Promise<T>): Promise<T> {
    throw new Error("d1_interactive_transactions_unsupported");
  }
}

function bindValue(value: unknown): unknown {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw new Error("invalid_database_date");
    return value.toISOString();
  }
  if (typeof value === "boolean") return value ? 1 : 0;
  return value;
}

/** Translate only the PostgreSQL constructs used by this repository. */
export function translatePostgresSql(sql: string): string {
  if (/\bFOR\s+UPDATE\b/i.test(sql)) throw new Error("d1_row_locks_require_atomic_refactor");
  if (/\bpg_advisory_xact_lock\b/i.test(sql)) throw new Error("d1_advisory_locks_require_atomic_refactor");
  return sql
    .replace(/\bnow\(\)\s*([+-])\s*interval\s+'(\d+) days'/gi, (_match, sign: string, days: string) =>
      `strftime('%Y-%m-%dT%H:%M:%fZ','now','${sign}${days} days')`)
    .replace(/\bnow\(\)/gi, "strftime('%Y-%m-%dT%H:%M:%fZ','now')")
    .replace(/\bGREATEST\s*\(/gi, "max(")
    .replace(/\bILIKE\b/gi, "LIKE")
    .replace(/::\s*(?:uuid|text|timestamptz|timestamp|jsonb|json|integer|int|boolean|bigint)\b/gi, "")
    .replace(/\$(\d+)/g, "?$1");
}
