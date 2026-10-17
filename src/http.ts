#!/usr/bin/env node
import { loadRuntimeConfig } from "./public/config.js";
import { createPublicApp } from "./public/http.js";
import { MemoryPublicAuthStore, type PublicAuthStore } from "./public/store.js";
import { PgPoolDatabase, PostgresPublicAuthStore } from "./public/postgres.js";

async function main() {
  const config = loadRuntimeConfig();
  let database: PgPoolDatabase | undefined;
  let pruneTimer: NodeJS.Timeout | undefined;
  let store: PublicAuthStore;
  if (config.storeKind === "postgres") {
    database = new PgPoolDatabase(config.databaseUrl!);
    const durable = new PostgresPublicAuthStore(database, config.encryptionKeyBase64);
    await durable.ready();
    store = durable;
    pruneTimer = setInterval(() => { void durable.pruneExpired().catch(() => process.stderr.write('{"event":"authorization_prune_failed"}\n')); }, 60 * 60 * 1000);
    pruneTimer.unref();
  } else {
    if (config.production) throw new Error("Production requires durable encrypted authorization storage.");
    store = new MemoryPublicAuthStore();
  }
  const { app, closeSessions } = createPublicApp(config, store, undefined, async () => { if (database) await database.query("SELECT 1"); });
  const server = app.listen(config.port, config.bindHost ?? "127.0.0.1", () => process.stdout.write(`Public V1 server listening on port ${config.port}.\n`));
  const stop = () => {
    if (pruneTimer) clearInterval(pruneTimer);
    server.close(async () => { await closeSessions(); await database?.close(); process.exit(0); });
    setTimeout(() => { server.closeAllConnections(); }, 10_000).unref();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

main().catch((error: unknown) => {
  const known = error instanceof Error && /^(Missing required configuration:|Invalid .* configuration|.*must .*|Production requires|relation .* does not exist)/.test(error.message);
  process.stderr.write(`Public V1: ${known ? error.message.replace(/[\r\n]/g, " ") : "Startup failed. Check database connectivity and migration."}\n`);
  process.exitCode = 1;
});
