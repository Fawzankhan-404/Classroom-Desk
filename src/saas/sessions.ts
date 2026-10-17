import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { SqlConnection } from "../public/postgres.js";

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface WebsiteSession { id: string; userId: string; expiresAt: Date; }

export function createSessionToken(): string { return randomBytes(32).toString("base64url"); }
export function hashSessionToken(token: string): string { return createHash("sha256").update(token, "utf8").digest("hex"); }
export function sessionExpiry(now = new Date()): Date { return new Date(now.getTime() + SESSION_TTL_MS); }
export function sessionCookie(token: string, secure = true): string { return `cd_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}${secure ? "; Secure" : ""}`; }
export const clearSessionCookie = "cd_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0";

export class WebsiteSessionStore {
  constructor(private readonly db: SqlConnection) {}

  async create(userId: string, now = new Date()): Promise<{ token: string; session: WebsiteSession }> {
    const token = createSessionToken();
    const session = { id: randomUUID(), userId, expiresAt: sessionExpiry(now) };
    await this.db.query(`INSERT INTO classroom_desk_sessions (id,user_id,token_hash,expires_at,last_seen_at) VALUES ($1,$2,$3,$4,$5)`, [session.id, session.userId, hashSessionToken(token), session.expiresAt, now]);
    return { token, session };
  }

  async find(token: string, now = new Date()): Promise<WebsiteSession | null> {
    const result = await this.db.query<{ id: string; user_id: string; expires_at: Date }>(`SELECT id,user_id,expires_at FROM classroom_desk_sessions WHERE token_hash=$1 AND expires_at>$2`, [hashSessionToken(token), now]);
    const row = result.rows[0];
    if (!row) return null;
    await this.db.query(`UPDATE classroom_desk_sessions SET last_seen_at=$2 WHERE id=$1`, [row.id, now]);
    return { id: row.id, userId: row.user_id, expiresAt: new Date(row.expires_at) };
  }

  async revoke(token: string): Promise<void> { await this.db.query(`DELETE FROM classroom_desk_sessions WHERE token_hash=$1`, [hashSessionToken(token)]); }
}

export function readSessionCookie(header: string | undefined): string | null {
  const value = header?.split(";").map((part) => part.trim()).find((part) => part.startsWith("cd_session="));
  const token = value?.slice("cd_session=".length);
  return token && /^[A-Za-z0-9_-]{40,}$/.test(token) ? token : null;
}
