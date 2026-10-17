#!/usr/bin/env node
import { loadRuntimeConfig } from "./public/config.js";
import { PgPoolDatabase, PostgresPublicAuthStore } from "./public/postgres.js";

async function main() {
  const config = loadRuntimeConfig();
  if (config.storeKind !== "postgres") throw new Error("Migration requires PUBLIC_AUTH_STORE=postgres.");
  const database = new PgPoolDatabase(config.databaseUrl!);
  try {
    await new PostgresPublicAuthStore(database, config.encryptionKeyBase64).migrate();
    process.stdout.write("Public authorization schema is ready.\n");
  } finally { await database.close(); }
}
main().catch(() => { process.stderr.write("Public authorization migration failed. Check configuration and database access.\n"); process.exitCode = 1; });
