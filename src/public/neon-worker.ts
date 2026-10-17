import { Client, neonConfig, type QueryResultRow } from "@neondatabase/serverless";
import type { SqlConnection, SqlDatabase } from "./postgres.js";

/**
 * Direct Neon adapter for isolated Cloudflare Worker environments.
 *
 * A client is deliberately created, used, and closed inside each operation.
 * This is required because a Worker request cannot safely retain a WebSocket
 * connection for a later request. Unlike the HTTP query helper, this adapter
 * preserves interactive transaction semantics used by SaaSStore.
 */
export class NeonWorkerDatabase implements SqlDatabase {
  constructor(private readonly connectionString: string) {
    neonConfig.webSocketConstructor = WebSocket;
  }

  private async withClient<T>(run: (client: Client) => Promise<T>): Promise<T> {
    const client = new Client(this.connectionString);
    await client.connect();
    try {
      return await run(client);
    } finally {
      await client.end();
    }
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
