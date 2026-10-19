import { randomBytes } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { PostgresPublicAuthStore, type SqlConnection, type SqlDatabase } from "./postgres.js";
import { PUBLIC_CLASSROOM_SCOPES } from "../config.js";

async function setup() {
  const pg = new PGlite();
  const db: SqlDatabase = {
    query: (sql, values) => pg.query(sql, values),
    transaction: (run) => pg.transaction((tx) => run(tx as SqlConnection)),
  };
  const store = new PostgresPublicAuthStore(db, randomBytes(32).toString("base64"));
  await store.migrate();
  return { pg, store };
}

describe("encrypted PostgreSQL public authorization store", () => {
  it("refuses missing or malformed encryption keys", async () => {
    const pg = new PGlite();
    const db = { query: (sql: string, values?: unknown[]) => pg.query(sql, values), transaction: <T>(run: (tx: SqlConnection) => Promise<T>) => pg.transaction((tx) => run(tx as SqlConnection)) };
    expect(() => new PostgresPublicAuthStore(db, undefined)).toThrow("PUBLIC_AUTH_ENCRYPTION_KEY_B64");
    expect(() => new PostgresPublicAuthStore(db, "short")).toThrow("PUBLIC_AUTH_ENCRYPTION_KEY_B64");
    await pg.close();
  }, 15_000);
  it("encrypts grants and MCP tokens, isolates two users, refreshes and deletes only the owner", async () => {
    const { pg, store } = await setup();
    try {
      const now = Date.now();
      await store.putGrant({ userId: "user-a", refreshToken: "google-refresh-secret-a", scopes: [...PUBLIC_CLASSROOM_SCOPES], createdAt: now, updatedAt: now });
      await store.putGrant({ userId: "user-b", refreshToken: "google-refresh-secret-b", scopes: [...PUBLIC_CLASSROOM_SCOPES], createdAt: now, updatedAt: now });
      await store.putAccess({ token: "mcp-access-secret-a", clientId: "client-a", userId: "user-a", scopes: ["mcp:tools"], expiresAt: now + 60000 });
      await store.putAccess({ token: "client-bound-token", clientId: "client-a", userId: "user-a", scopes: ["mcp:tools"], expiresAt: now + 60000 });
      await store.deleteClientToken("client-bound-token", "client-b");
      expect(await store.getAccess("client-bound-token")).toBeDefined();
      await store.deleteClientToken("client-bound-token", "client-a");
      expect(await store.getAccess("client-bound-token")).toBeUndefined();
      await store.putRefresh({ token: "mcp-refresh-secret-a", clientId: "client-a", userId: "user-a", scopes: ["mcp:tools"], expiresAt: now + 60000 });
      const raw = await pg.query<{ payload: string; key_hash: string }>("SELECT payload,key_hash FROM public_auth_records");
      const serialized = JSON.stringify(raw.rows);
      for (const secret of ["google-refresh-secret-a", "google-refresh-secret-b", "mcp-access-secret-a", "mcp-refresh-secret-a"]) expect(serialized).not.toContain(secret);
      expect((await store.getGrant("user-a"))?.refreshToken).toBe("google-refresh-secret-a");
      expect((await store.getGrant("user-b"))?.refreshToken).toBe("google-refresh-secret-b");
      await store.updateGrantRefreshToken("user-a", "rotated-google-secret-a");
      expect((await store.getGrant("user-a"))?.refreshToken).toBe("rotated-google-secret-a");
      expect((await store.getGrant("user-b"))?.refreshToken).toBe("google-refresh-secret-b");
      await store.deleteUserAuthorization("user-a");
      expect(await store.getGrant("user-a")).toBeUndefined();
      expect(await store.getAccess("mcp-access-secret-a")).toBeUndefined();
      expect(await store.getRefresh("mcp-refresh-secret-a")).toBeUndefined();
      expect((await store.getGrant("user-b"))?.refreshToken).toBe("google-refresh-secret-b");
    } finally { await pg.close(); }
  }, 15_000);
  it("rejects tampered ciphertext without revealing a token or SQL detail", async () => {
    const { pg, store } = await setup();
    try {
      await store.putGrant({ userId: "user-a", refreshToken: "private-token", scopes: [...PUBLIC_CLASSROOM_SCOPES], createdAt: Date.now(), updatedAt: Date.now() });
      await pg.query("UPDATE public_auth_records SET payload='v1.bad.bad.bad' WHERE kind='grant'");
      await expect(store.getGrant("user-a")).rejects.toThrow("Stored authorization is unavailable.");
    } finally { await pg.close(); }
  }, 15_000);
  it("consumes authorization state, codes and refresh tokens once across concurrent requests", async () => {
    const { pg, store } = await setup();
    try {
      const expiresAt = Date.now() + 60000;
      const flow = { id: "flow-1", userId: "user-a", client: { client_id: "client-a" } as never, params: { redirectUri: "http://127.0.0.1/cb", codeChallenge: "challenge", scopes: ["mcp:tools"] }, googleState: "state-1", googleVerifier: "verifier-1", expiresAt, started: false };
      await store.putFlow(flow);
      expect(await store.setFlowStarted(flow.id)).toBe(true);
      expect(await store.setFlowStarted(flow.id)).toBe(false);
      const states = await Promise.all([store.takeFlowByGoogleState(flow.googleState), store.takeFlowByGoogleState(flow.googleState)]);
      expect(states.filter(Boolean)).toHaveLength(1);
      await store.putCode({ code: "code-1", clientId: "client-a", userId: "user-a", redirectUri: "http://127.0.0.1/cb", challenge: "challenge", scopes: ["mcp:tools"], expiresAt });
      const codes = await Promise.all([store.takeCode("code-1"), store.takeCode("code-1")]);
      expect(codes.filter(Boolean)).toHaveLength(1);
      await store.putRefresh({ token: "refresh-1", clientId: "client-a", userId: "user-a", scopes: ["mcp:tools"], expiresAt });
      const refreshes = await Promise.all([store.takeRefresh("refresh-1"), store.takeRefresh("refresh-1")]);
      expect(refreshes.filter(Boolean)).toHaveLength(1);
      await store.putRefresh({ token: "refresh-2", clientId: "client-a", userId: "user-a", scopes: ["mcp:tools"], expiresAt });
      const access = { token: "access-2", clientId: "client-a", userId: "user-a", scopes: ["mcp:tools"], expiresAt };
      const fresh = { token: "refresh-3", clientId: "client-a", userId: "user-a", scopes: ["mcp:tools"], expiresAt };
      expect(await store.rotateTokenPair("refresh-2", "client-a", access, fresh)).toBe(true);
      expect(await store.rotateTokenPair("refresh-2", "client-a", { ...access, token: "access-replay" }, { ...fresh, token: "refresh-replay" })).toBe(false);
      expect(await store.getAccess("access-replay")).toBeUndefined();
      expect(await store.getRefresh("refresh-3")).toBeDefined();
    } finally { await pg.close(); }
  });
});
