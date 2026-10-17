import { Client, type QueryResultRow } from "pg";
import type { SqlConnection, SqlDatabase } from "./postgres.js";

/** Worker-safe pg adapter: no TCP connection survives a request operation. */
export class HyperdriveDatabase implements SqlDatabase {
  constructor(private readonly connectionString: string) {}

  private async withClient<T>(run: (client: Client) => Promise<T>): Promise<T> {
    const client = new Client({ connectionString: this.connectionString, connectionTimeoutMillis: 5000 });
    await client.connect();
    try { return await run(client); }
    finally { await client.end(); }
  }

  query<T extends QueryResultRow = Record<string, unknown>>(sql: string, values?: unknown[]) {
    return this.withClient(async (client) => client.query<T>(sql, values));
  }

  transaction<T>(run: (tx: SqlConnection) => Promise<T>): Promise<T> {
    return this.withClient(async (client) => {
      await client.query("BEGIN");
      try {
        const result = await run({ query: (sql, values) => client.query(sql, values) });
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    });
  }
}
