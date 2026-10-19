import { createHash, randomBytes } from "node:crypto";
import type { SqlDatabase } from "../public/postgres.js";

const TTL = 10 * 60 * 1000;
const hash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

export class AccountLinkService {
  constructor(private readonly db: SqlDatabase) {}
  async start(userId: string, now = new Date()): Promise<{ code: string; expiresAt: Date }> {
    const code = randomBytes(18).toString("base64url"); const expiresAt = new Date(now.getTime() + TTL);
    await this.db.query(`INSERT INTO classroom_desk_link_tokens (token_hash,user_id,expires_at) VALUES ($1,$2,$3)`, [hash(code), userId, expiresAt]);
    return { code, expiresAt };
  }
  async consume(code: string, mcpUserId: string, now = new Date()): Promise<boolean> {
    if (!/^[A-Za-z0-9_-]{20,}$/.test(code) || !mcpUserId) return false;
    const tokenHash = hash(code);
    if (this.db.batch) {
      const row = await this.db.query<{ user_id: string }>(`SELECT user_id FROM classroom_desk_link_tokens WHERE token_hash=$1 AND used_at IS NULL AND expires_at>$2`, [tokenHash, now]);
      const userId = row.rows[0]?.user_id; if (!userId) return false;
      const claim = randomBytes(16).toString("hex");
      const results = await this.db.batch([
        { sql: `UPDATE classroom_desk_link_tokens SET used_at=$2,consumed_by=$3 WHERE token_hash=$1 AND user_id=$4 AND used_at IS NULL AND expires_at>$2 AND EXISTS (SELECT 1 FROM classroom_desk_users WHERE id=$4 AND status='active') AND NOT EXISTS (SELECT 1 FROM classroom_desk_connections WHERE mcp_user_id=$5 AND website_user_id<>$4) RETURNING token_hash`, values: [tokenHash, now, claim, userId, mcpUserId] },
        { sql: `INSERT INTO classroom_desk_connections (website_user_id,mcp_user_id,connected_at) SELECT user_id,$2,$3 FROM classroom_desk_link_tokens WHERE token_hash=$1 AND consumed_by=$4 AND EXISTS (SELECT 1 FROM classroom_desk_users WHERE id=$5 AND status='active') AND NOT EXISTS (SELECT 1 FROM classroom_desk_connections WHERE mcp_user_id=$2 AND website_user_id<>$5) ON CONFLICT (website_user_id) DO UPDATE SET mcp_user_id=EXCLUDED.mcp_user_id,connected_at=EXCLUDED.connected_at WHERE NOT EXISTS (SELECT 1 FROM classroom_desk_connections WHERE mcp_user_id=EXCLUDED.mcp_user_id AND website_user_id<>EXCLUDED.website_user_id) RETURNING website_user_id`, values: [tokenHash, mcpUserId, now, claim, userId] },
      ]);
      return results[0]?.rows.length === 1 && results[1]?.rows.length === 1;
    }
    return this.db.transaction(async (tx) => {
      const row = await tx.query<{ user_id: string }>(`SELECT user_id FROM classroom_desk_link_tokens WHERE token_hash=$1 AND used_at IS NULL AND expires_at>$2 FOR UPDATE`, [tokenHash, now]);
      const userId = row.rows[0]?.user_id; if (!userId) return false;
      const user = await tx.query(`SELECT id FROM classroom_desk_users WHERE id=$1 AND status='active'`,[userId]);
      if(!user.rows.length)return false;
      const conflict = await tx.query(`SELECT website_user_id FROM classroom_desk_connections WHERE mcp_user_id=$1 AND website_user_id<>$2`,[mcpUserId,userId]);
      if(conflict.rows.length)return false;
      await tx.query(`UPDATE classroom_desk_link_tokens SET used_at=$2 WHERE token_hash=$1`, [hash(code), now]);
      await tx.query(`INSERT INTO classroom_desk_connections (website_user_id,mcp_user_id,connected_at) VALUES ($1,$2,$3) ON CONFLICT (website_user_id) DO UPDATE SET mcp_user_id=EXCLUDED.mcp_user_id,connected_at=EXCLUDED.connected_at`, [userId, mcpUserId, now]);
      return true;
    });
  }
}
