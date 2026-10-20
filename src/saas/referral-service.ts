import { randomBytes } from "node:crypto";
import type { SqlDatabase } from "../public/postgres.js";

export interface ReferralSummary { code: string; total: number; pending: number; qualified: number; rewards: number; extraDays: number; history?:Array<{createdAt:Date;startsAt:Date;expiresAt:Date;revoked:boolean}>; }

export function newReferralCode(): string { return `CD-${randomBytes(5).toString("hex").toUpperCase()}`; }

export class ReferralService {
  constructor(private readonly db: SqlDatabase) {}

  async ensureCode(userId: string): Promise<string> {
    const existing = await this.db.query<{ code: string }>(`SELECT code FROM classroom_desk_referral_codes WHERE user_id=$1`, [userId]);
    if (existing.rows[0]) return existing.rows[0].code;
    for (let attempt = 0; attempt < 3; attempt++) {
      const code = newReferralCode();
      const result = await this.db.query<{ code: string }>(`INSERT INTO classroom_desk_referral_codes (user_id,code) VALUES ($1,$2) ON CONFLICT (user_id) DO NOTHING RETURNING code`, [userId, code]);
      if (result.rows[0]) return result.rows[0].code;
      const raced=await this.db.query<{code:string}>(`SELECT code FROM classroom_desk_referral_codes WHERE user_id=$1`,[userId]);
      if(raced.rows[0])return raced.rows[0].code;
    }
    throw new Error("referral_code_unavailable");
  }

  async attribute(code: string, referredUserId: string): Promise<string> {
    if (this.db.batch) {
      const normalizedCode = code.trim().toUpperCase();
      const result = await this.db.query<{ id: string }>(`INSERT INTO classroom_desk_referrals (referrer_user_id,referred_user_id,code)
        SELECT owner.user_id,customer.id,$3 FROM classroom_desk_referral_codes owner
        JOIN classroom_desk_users customer ON customer.id=$2
        WHERE owner.code=$1 AND owner.user_id<>customer.id
          AND NOT EXISTS (SELECT 1 FROM classroom_desk_payments p WHERE p.user_id=customer.id AND p.kind='subscription' AND p.status IN ('paid','captured','partially_refunded','refunded'))
        ON CONFLICT (referred_user_id) DO NOTHING RETURNING id`, [normalizedCode, referredUserId, normalizedCode]);
      if (result.rows[0]) return String(result.rows[0].id);
      const owner = await this.db.query<{ user_id: string }>(`SELECT user_id FROM classroom_desk_referral_codes WHERE code=$1`, [normalizedCode]);
      if (!owner.rows[0] || owner.rows[0].user_id === referredUserId) throw new Error("invalid_referral");
      const paid = await this.db.query(`SELECT 1 FROM classroom_desk_payments WHERE user_id=$1 AND kind='subscription' AND status IN ('paid','captured','partially_refunded','refunded') LIMIT 1`, [referredUserId]);
      if (paid.rows.length) throw new Error("referral_requires_new_customer");
      throw new Error("referral_already_attributed");
    }
    return this.db.transaction(async (tx) => {
      await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`,[`billing:${referredUserId}`]);
      const owner = await tx.query<{ user_id: string }>(`SELECT user_id FROM classroom_desk_referral_codes WHERE code=$1`, [code.trim().toUpperCase()]);
      const referrer = owner.rows[0]?.user_id;
      if (!referrer || referrer === referredUserId) throw new Error("invalid_referral");
      const paid = await tx.query(`SELECT 1 FROM classroom_desk_payments WHERE user_id=$1 AND kind='subscription' AND status IN ('paid','captured','partially_refunded','refunded') LIMIT 1`,[referredUserId]);
      if (paid.rows.length) throw new Error("referral_requires_new_customer");
      const result = await tx.query<{ id: string }>(`INSERT INTO classroom_desk_referrals (referrer_user_id,referred_user_id,code) VALUES ($1,$2,$3) ON CONFLICT (referred_user_id) DO NOTHING RETURNING id`, [referrer, referredUserId, code.trim().toUpperCase()]);
      if (!result.rows[0]) throw new Error("referral_already_attributed");
      return String(result.rows[0].id);
    });
  }

  async summary(userId: string, options: { createCode?: boolean } = {}): Promise<ReferralSummary> {
    const [code, counts, rewards] = await Promise.all([
      options.createCode === false ? Promise.resolve("") : this.ensureCode(userId),
      this.db.query<{ total: string; pending: string; qualified: string }>(`SELECT count(*) total, count(*) FILTER (WHERE qualified_at IS NULL) pending, count(*) FILTER (WHERE counted_at IS NOT NULL) qualified FROM classroom_desk_referrals WHERE referrer_user_id=$1`, [userId]),
      this.db.query<{created_at:Date;starts_at:Date;expires_at:Date;revoked_at:Date|null}>(`SELECT r.created_at,g.starts_at,g.expires_at,g.revoked_at FROM classroom_desk_referral_rewards r JOIN classroom_desk_entitlement_grants g ON g.id=r.grant_id WHERE r.user_id=$1 ORDER BY r.created_at DESC`, [userId]),
    ]);
    const row = counts.rows[0]; const qualified = Number(row?.qualified ?? 0); const rewardCount = rewards.rows.length;
    return { code, total: Number(row?.total ?? 0), pending: Number(row?.pending ?? 0), qualified, rewards: rewardCount, extraDays: rewards.rows.filter(r=>!r.revoked_at).length * 30, history:rewards.rows.map(r=>({createdAt:new Date(r.created_at),startsAt:new Date(r.starts_at),expiresAt:new Date(r.expires_at),revoked:Boolean(r.revoked_at)})) };
  }
}
