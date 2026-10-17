import { PgPoolDatabase } from "../public/postgres.js";
import { SaaSMigration } from "./schema.js";

/** Run only against an explicitly supplied migration database URL. Never invoked by a request handler. */
const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.SAAS_MIGRATION_DATABASE_URL;
if (!url) throw new Error("Set DATABASE_URL_UNPOOLED or SAAS_MIGRATION_DATABASE_URL before running the SaaS migration.");
const db = new PgPoolDatabase(url);
try {
  await db.transaction(async (tx) => {
    for (const statement of SaaSMigration.split(";").map((item) => item.trim()).filter(Boolean)) await tx.query(statement);
  });
  process.stdout.write("Classroom Desk SaaS migration applied.\n");
} finally {
  await db.close();
}
