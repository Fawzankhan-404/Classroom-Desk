import { randomBytes } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { expect, it } from "vitest";
import { PUBLIC_CLASSROOM_SCOPES } from "../scopes.js";
import { HyperdriveDatabase } from "./hyperdrive.js";
import { PostgresPublicAuthStore } from "./postgres.js";

it("uses the Worker database adapter for encrypted, owner-isolated grants", async () => {
  const embedded = new PGlite();
  const socket = new PGLiteSocketServer({ db: embedded, host: "127.0.0.1", port: 0, maxConnections: 5 });
  await socket.start();
  const database = new HyperdriveDatabase(`postgresql://postgres:postgres@${socket.getServerConn()}/postgres`);
  try {
    const store = new PostgresPublicAuthStore(database, randomBytes(32).toString("base64"));
    await store.migrate();
    await store.ready();
    const now = Date.now();
    await store.putGrant({ userId: "a", refreshToken: "test-refresh-a", scopes: [...PUBLIC_CLASSROOM_SCOPES], createdAt: now, updatedAt: now });
    await store.putGrant({ userId: "b", refreshToken: "test-refresh-b", scopes: [...PUBLIC_CLASSROOM_SCOPES], createdAt: now, updatedAt: now });
    const result = await database.query<{ payload: string }>("SELECT payload FROM public_auth_records WHERE kind='grant'");
    expect(JSON.stringify(result.rows)).not.toContain("test-refresh-a");
    expect(JSON.stringify(result.rows)).not.toContain("test-refresh-b");
    await store.updateGrantRefreshToken("a", "test-refresh-a-rotated");
    expect((await store.getGrant("a"))?.refreshToken).toBe("test-refresh-a-rotated");
    expect((await store.getGrant("b"))?.refreshToken).toBe("test-refresh-b");
    await store.deleteUserAuthorization("a");
    expect(await store.getGrant("a")).toBeUndefined();
    expect((await store.getGrant("b"))?.refreshToken).toBe("test-refresh-b");
  } finally {
    await socket.stop();
    await embedded.close();
  }
}, 30_000);
