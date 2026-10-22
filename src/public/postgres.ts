import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, randomUUID } from "node:crypto";
import { Pool, type QueryResultRow } from "pg";
import { SaaSProfileCipher } from "../saas/privacy.js";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { PublicAuthStore, GoogleAccountBinding, GoogleFlow, GoogleGrant, InternalCode, AccessRecord, RefreshRecord } from "./store.js";

type SqlResult<T> = { rows: T[] };
export type SqlConnection = { query<T extends QueryResultRow = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<SqlResult<T>> };
export type SqlDatabase = SqlConnection & {
  transaction<T>(run: (tx: SqlConnection) => Promise<T>): Promise<T>;
  batch?<T extends QueryResultRow = Record<string, unknown>>(queries: Array<{ sql: string; values?: unknown[] }>): Promise<SqlResult<T>[]>;
};
type StoredRow = { payload: string; expires_at: string | number | null; started: boolean };
type RecordKind = "client" | "flow" | "grant" | "code" | "access" | "refresh";
type AccountMappingTable = "classroom_desk_connections" | "classroom_desk_oauth_accounts";

function isMissingOAuthAccountTable(error: unknown): boolean {
  let current: unknown = error;
  const parts: string[] = [];
  let code = "";
  for (let depth = 0; depth < 3 && current; depth += 1) {
    if (typeof current === "string") { parts.push(current); break; }
    if (typeof current !== "object") break;
    const value = current as { code?: unknown; message?: unknown; cause?: unknown };
    if (typeof value.code === "string") code = value.code;
    if (typeof value.message === "string") parts.push(value.message);
    current = value.cause;
  }
  const message = parts.join(" ").toLowerCase();
  return message.includes("classroom_desk_oauth_accounts")
    && (code === "42P01" || message.includes("no such table") || (message.includes("relation") && message.includes("does not exist")));
}

const schema = [
  `CREATE TABLE IF NOT EXISTS public_auth_records (
    kind text NOT NULL,
    key_hash text NOT NULL,
    state_hash text,
    owner_id text,
    payload text NOT NULL,
    expires_at bigint,
    started boolean NOT NULL DEFAULT false,
    updated_at bigint NOT NULL,
    PRIMARY KEY (kind, key_hash)
  )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS public_auth_state_idx ON public_auth_records (kind, state_hash) WHERE state_hash IS NOT NULL",
  "CREATE INDEX IF NOT EXISTS public_auth_owner_idx ON public_auth_records (owner_id) WHERE owner_id IS NOT NULL",
  "CREATE INDEX IF NOT EXISTS public_auth_expiry_idx ON public_auth_records (expires_at) WHERE expires_at IS NOT NULL",
];

/** A one-table PostgreSQL store. Every payload is AEAD-encrypted; lookup keys are HMACs. */
export class PostgresPublicAuthStore implements PublicAuthStore {
  private readonly encryptionKey: Buffer;
  private readonly lookupKey: Buffer;
  private readonly profileCipher: SaaSProfileCipher;

  constructor(readonly db: SqlDatabase, keyBase64: string | undefined, readonly tableName = "public_auth_records") {
    if (!keyBase64 || !/^[A-Za-z0-9+/]{43}=$/.test(keyBase64)) throw new Error("PUBLIC_AUTH_ENCRYPTION_KEY_B64 must be a base64-encoded 32-byte key.");
    const master = Buffer.from(keyBase64, "base64");
    if (master.length !== 32 || master.toString("base64") !== keyBase64) throw new Error("PUBLIC_AUTH_ENCRYPTION_KEY_B64 must be a base64-encoded 32-byte key.");
    this.encryptionKey = Buffer.from(hkdfSync("sha256", master, Buffer.alloc(0), "classroom-auth-records-v1", 32));
    this.lookupKey = Buffer.from(hkdfSync("sha256", master, Buffer.alloc(0), "classroom-auth-lookups-v1", 32));
    this.profileCipher = new SaaSProfileCipher(keyBase64);
    master.fill(0);
  }

  private table() { if (!/^[a-z_][a-z0-9_]*$/.test(this.tableName)) throw new Error("Invalid authorization table name."); return this.tableName; }
  async migrate() { const t = this.table(); for (const statement of schema.map((s) => s.replaceAll("public_auth_records", t).replaceAll("public_auth_state_idx", `${t}_state_idx`).replaceAll("public_auth_owner_idx", `${t}_owner_idx`).replaceAll("public_auth_expiry_idx", `${t}_expiry_idx`))) await this.db.query(statement); }
  async ready() { await this.db.query(`SELECT 1 FROM ${this.table()} LIMIT 1`); }
  async pruneExpired() { await this.db.query(`DELETE FROM ${this.table()} WHERE expires_at IS NOT NULL AND expires_at <= $1`, [Date.now()]); }

  private hash(value: string) { return createHmac("sha256", this.lookupKey).update(value).digest("hex"); }
  private seal(kind: RecordKind, hash: string, value: unknown) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.encryptionKey, iv);
    cipher.setAAD(Buffer.from(`${kind}:${hash}`));
    const bytes = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    return `v1.${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${bytes.toString("base64url")}`;
  }
  private open<T>(kind: RecordKind, hash: string, sealed: string): T {
    try {
      const [version, ivText, tagText, bodyText] = sealed.split(".");
      if (version !== "v1" || !ivText || !tagText || !bodyText) throw new Error("invalid envelope");
      const iv = Buffer.from(ivText, "base64url"); const tag = Buffer.from(tagText, "base64url");
      if (iv.length !== 12 || tag.length !== 16) throw new Error("invalid envelope");
      const decipher = createDecipheriv("aes-256-gcm", this.encryptionKey, iv);
      decipher.setAAD(Buffer.from(`${kind}:${hash}`)); decipher.setAuthTag(tag);
      const plain = Buffer.concat([decipher.update(Buffer.from(bodyText, "base64url")), decipher.final()]);
      return JSON.parse(plain.toString("utf8")) as T;
    } catch { throw new Error("Stored authorization is unavailable."); }
  }
  private putStatement(kind: RecordKind, key: string, value: unknown, options: {
    owner?: string; state?: string; expiresAt?: number; binding?: GoogleAccountBinding;
    bindingTables?: readonly AccountMappingTable[]; conflictTables?: readonly AccountMappingTable[];
  } = {}) {
    const hash = this.hash(key);
    const binding = options.binding;
    const bindingTables = options.bindingTables ?? ["classroom_desk_connections"];
    const conflictTables = options.conflictTables ?? bindingTables;
    const bindingGuard = binding ? [
      `EXISTS (SELECT 1 FROM classroom_desk_users WHERE id=$8 AND status='active')`,
      ...bindingTables.map(table => `EXISTS (SELECT 1 FROM ${table} WHERE website_user_id=$8 AND mcp_user_id=$9)`),
      ...conflictTables.map(table => `NOT EXISTS (SELECT 1 FROM ${table} WHERE mcp_user_id=$9 AND website_user_id<>$8)`),
    ].join(" AND ") : "";
    return { sql: `INSERT INTO ${this.table()} (kind, key_hash, state_hash, owner_id, payload, expires_at, updated_at)
      ${binding ? `SELECT $1,$2,$3,$4,$5,$6,$7 WHERE ${bindingGuard}` : "VALUES ($1,$2,$3,$4,$5,$6,$7)"}
      ON CONFLICT (kind, key_hash) DO UPDATE SET state_hash=EXCLUDED.state_hash, owner_id=EXCLUDED.owner_id,
        payload=EXCLUDED.payload, expires_at=EXCLUDED.expires_at, updated_at=EXCLUDED.updated_at`,
      values: [kind, hash, options.state ? this.hash(options.state) : null, options.owner ?? null, this.seal(kind, hash, value), options.expiresAt ?? null, Date.now(), ...(binding ? [binding.accountId, binding.mcpUserId] : [])] };
  }
  private async put(kind: RecordKind, key: string, value: unknown, options: {
    owner?: string; state?: string; expiresAt?: number; binding?: GoogleAccountBinding;
    bindingTables?: readonly AccountMappingTable[]; conflictTables?: readonly AccountMappingTable[];
  } = {}, db: SqlConnection = this.db) {
    const statement = this.putStatement(kind, key, value, options);
    await db.query(statement.sql, statement.values);
  }
  private async get<T>(kind: RecordKind, key: string, db: SqlConnection = this.db): Promise<(T & { started?: boolean }) | undefined> {
    const hash = this.hash(key);
    const result = await db.query<StoredRow>(`SELECT payload, expires_at, started FROM ${this.table()} WHERE kind=$1 AND key_hash=$2`, [kind, hash]);
    const row = result.rows[0];
    if (!row || (row.expires_at !== null && Number(row.expires_at) <= Date.now())) return undefined;
    return { ...this.open<T>(kind, hash, row.payload), ...(kind === "flow" ? { started: row.started } : {}) };
  }
  private async take<T>(kind: RecordKind, key: string, db: SqlConnection = this.db): Promise<T | undefined> {
    const hash = this.hash(key);
    const result = await db.query<StoredRow>(`DELETE FROM ${this.table()} WHERE kind=$1 AND key_hash=$2 AND (expires_at IS NULL OR expires_at > $3) RETURNING payload, expires_at, started`, [kind, hash, Date.now()]);
    const row = result.rows[0];
    return row ? this.open<T>(kind, hash, row.payload) : undefined;
  }

  async getClient(clientId: string) {
    const client = await this.get<OAuthClientInformationFull>("client", clientId);
    console.log(JSON.stringify({ event: "mcp_client_lookup", found: Boolean(client), hasSecret: typeof client?.client_secret === "string" && client.client_secret.length > 0 }));
    return client;
  }
  async registerClient(client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">) {
    const value: OAuthClientInformationFull = { ...client, client_id: randomUUID(), client_id_issued_at: Math.floor(Date.now() / 1000) };
    await this.put("client", value.client_id, value);
    return value;
  }
  async putFlow(flow: GoogleFlow) { await this.put("flow", flow.id, flow, { owner: flow.userId, state: flow.googleState, expiresAt: flow.expiresAt }); }
  async getFlow(id: string) { return reviveFlow(await this.get<GoogleFlow>("flow", id)); }
  async setFlowStarted(id: string) {
    const result = await this.db.query<{ key_hash: string }>(`UPDATE ${this.table()} SET started=true, updated_at=$3 WHERE kind='flow' AND key_hash=$1 AND started=false AND expires_at>$2 RETURNING key_hash`, [this.hash(id), Date.now(), Date.now()]);
    return result.rows.length === 1;
  }
  async takeFlowByGoogleState(state: string) {
    const result = await this.db.query<StoredRow & { key_hash: string }>(`DELETE FROM ${this.table()} WHERE kind='flow' AND state_hash=$1 AND started=true AND expires_at>$2 RETURNING key_hash, payload, expires_at, started`, [this.hash(state), Date.now()]);
    const row = result.rows[0];
    return row ? reviveFlow({ ...this.open<GoogleFlow>("flow", row.key_hash, row.payload), started: row.started }) : undefined;
  }
  async putGrant(grant: GoogleGrant) { await this.put("grant", grant.userId, grant, { owner: grant.userId }); }
  async putGrantAndCode(grant: GoogleGrant, code: InternalCode, binding?: GoogleAccountBinding) {
    if (grant.userId !== code.userId) throw new Error("authorization_owner_mismatch");
    if (binding && binding.mcpUserId !== grant.userId) throw new Error("authorization_owner_mismatch");
    const mappingTables: AccountMappingTable[] = ["classroom_desk_connections"];
    try {
      await this.db.query(`SELECT website_user_id,mcp_user_id FROM classroom_desk_oauth_accounts LIMIT 0`);
      mappingTables.push("classroom_desk_oauth_accounts");
    } catch (error) {
      if (!isMissingOAuthAccountTable(error)) throw error;
    }
    let bindingTables: readonly AccountMappingTable[] = mappingTables;
    if (binding) {
      const legacy = (await this.db.query<{ mcp_user_id: string }>(`SELECT mcp_user_id FROM classroom_desk_connections WHERE website_user_id=$1`, [binding.accountId])).rows[0]?.mcp_user_id;
      const unified = mappingTables.includes("classroom_desk_oauth_accounts")
        ? (await this.db.query<{ mcp_user_id: string }>(`SELECT mcp_user_id FROM classroom_desk_oauth_accounts WHERE website_user_id=$1`, [binding.accountId])).rows[0]?.mcp_user_id
        : undefined;
      if (unified && unified !== binding.mcpUserId) throw new Error("oauth_account_binding_conflict");
      if (!unified && legacy && legacy !== binding.mcpUserId) throw new Error("oauth_account_binding_conflict");
      if (unified) bindingTables = ["classroom_desk_oauth_accounts"];
      for (const table of mappingTables) {
        const owners = await this.db.query<{ website_user_id: string }>(`SELECT website_user_id FROM ${table} WHERE mcp_user_id=$1`, [binding.mcpUserId]);
        if (owners.rows.some(row => String(row.website_user_id) !== binding.accountId)) throw new Error("oauth_account_binding_conflict");
      }
    }
    const bindingOptions = binding ? { binding, bindingTables, conflictTables: mappingTables } : {};
    const grantOptions = { owner: grant.userId, ...bindingOptions };
    const codeOptions = { owner: code.userId, expiresAt: code.expiresAt, ...bindingOptions };
    const recoveryPlan = binding?.recovery ? this.legacyRecoveryStatements(binding, grant, code, mappingTables, bindingTables) : undefined;
    const linkStatements = binding ? bindingTables.map(table => {
      const sameAccountGuard = bindingTables.map(candidate => `NOT EXISTS (SELECT 1 FROM ${candidate} WHERE website_user_id=$1 AND mcp_user_id<>$2)`).join(" AND ");
      const otherOwnerGuard = mappingTables.map(candidate => `NOT EXISTS (SELECT 1 FROM ${candidate} WHERE mcp_user_id=$2 AND website_user_id<>$1)`).join(" AND ");
      return {
        sql: `INSERT INTO ${table} (website_user_id,mcp_user_id,connected_at)
          SELECT $1,$2,$3 WHERE EXISTS (SELECT 1 FROM classroom_desk_users WHERE id=$1 AND status='active')
          AND ${sameAccountGuard} AND ${otherOwnerGuard}
          ON CONFLICT (website_user_id) DO NOTHING RETURNING website_user_id`,
        values: [binding.accountId, binding.mcpUserId, new Date()],
      };
    }) : [];
    if (this.db.batch) {
      await this.db.batch([...(recoveryPlan?.before ?? []), ...linkStatements,
        this.putStatement("grant", grant.userId, grant, grantOptions),
        this.putStatement("code", code.code, code, codeOptions),
        ...(recoveryPlan ? [recoveryPlan.commit] : [])]);
      if (binding) await this.assertBindingPersisted(binding, bindingTables, mappingTables);
      if (!(await this.getCode(code.code)) || !(await this.getGrant(grant.userId))) throw new Error("oauth_grant_or_code_persistence_failed");
      return;
    }
    await this.db.transaction(async (tx) => {
      for (const statement of recoveryPlan?.before ?? []) await tx.query(statement.sql, statement.values);
      for (const statement of linkStatements) await tx.query(statement.sql, statement.values);
      if (binding) await this.assertBindingPersisted(binding, bindingTables, mappingTables, tx);
      await this.put("grant", grant.userId, grant, grantOptions, tx);
      await this.put("code", code.code, code, codeOptions, tx);
      if (recoveryPlan) await tx.query(recoveryPlan.commit.sql, recoveryPlan.commit.values);
    });
  }

  /**
   * Re-encrypt a legacy account only in the same atomic unit that stores the
   * freshly authorized Google grant and MCP code. The final constrained claim
   * forces the D1 batch/SQL transaction to roll back if any guard fails.
   */
  private legacyRecoveryStatements(
    binding: GoogleAccountBinding,
    grant: GoogleGrant,
    code: InternalCode,
    mappingTables: readonly AccountMappingTable[],
    bindingTables: readonly AccountMappingTable[],
  ) {
    const recovery = binding.recovery!;
    const now = new Date();
    const grantHash = this.hash(grant.userId);
    const codeHash = this.hash(code.code);
    const profileCiphertext = this.profileCipher.seal(recovery.profile);
    const markerEmail = `enc:${recovery.emailHash}`;
    const markerDisplayName = `enc:${recovery.displayNameHash}`;
    const values = [binding.accountId, recovery.requestId, binding.mcpUserId, now,
      recovery.googleSubjectHash, recovery.profile.googleSubject, profileCiphertext,
      recovery.emailHash, recovery.displayNameHash, grantHash, codeHash,
      recovery.expectedLegacyCiphertext, null, markerEmail, markerDisplayName,
      recovery.expectedLegacyCiphertextHash];
    const duplicateIdentity = `EXISTS (SELECT 1 FROM classroom_desk_users WHERE id<>$1 AND (google_subject_hash=$5 OR google_subject=$6))`;
    const updateProfile = {
      sql: `UPDATE classroom_desk_users SET google_subject=NULL,email=$14,display_name=$15,
        google_subject_hash=$5,email_hash=$8,display_name_hash=$9,profile_ciphertext=$7,profile_recovery_status='ready'
        WHERE id=$1 AND status='active' AND profile_recovery_status='recovery_pending'
          AND profile_ciphertext=$12 AND NOT ${duplicateIdentity} RETURNING id`,
      values: values.slice(0, 15),
    };
    const completeRequest = {
      sql: `UPDATE classroom_desk_account_recovery_requests SET status='completed',completed_at=$4
        WHERE id=$2 AND account_id=$1 AND google_subject_hash=$5 AND expected_legacy_ciphertext_hash=$16 AND status='pending' AND expires_at>$4
          AND EXISTS (SELECT 1 FROM classroom_desk_users WHERE id=$1 AND profile_recovery_status='ready' AND profile_ciphertext=$7)
        RETURNING id`,
      values,
    };
    const guards = [
      `EXISTS (SELECT 1 FROM classroom_desk_users WHERE id=$1 AND status='active' AND profile_recovery_status='ready' AND profile_ciphertext=$7 AND google_subject_hash=$5 AND email_hash=$8 AND display_name_hash=$9)`,
      `EXISTS (SELECT 1 FROM classroom_desk_account_recovery_requests WHERE id=$2 AND account_id=$1 AND google_subject_hash=$5 AND expected_legacy_ciphertext_hash=$16 AND status='completed')`,
      `NOT ${duplicateIdentity}`,
      ...bindingTables.map(table => `EXISTS (SELECT 1 FROM ${table} WHERE website_user_id=$1 AND mcp_user_id=$3)`),
      ...mappingTables.map(table => `NOT EXISTS (SELECT 1 FROM ${table} WHERE mcp_user_id=$3 AND website_user_id<>$1)`),
      `EXISTS (SELECT 1 FROM ${this.table()} WHERE kind='grant' AND key_hash=$10 AND owner_id=$3)`,
      `EXISTS (SELECT 1 FROM ${this.table()} WHERE kind='code' AND key_hash=$11 AND owner_id=$3)`,
    ].join(" AND ");
    const commit = {
      sql: `INSERT INTO classroom_desk_account_recovery_claims (recovery_id,account_id,completed_at)
        SELECT $2,$1,$4 WHERE ${guards}
        UNION ALL SELECT NULL,NULL,NULL WHERE NOT (${guards}) RETURNING recovery_id`,
      values,
    };
    return { before: [updateProfile, completeRequest], commit };
  }

  private async assertBindingPersisted(binding: GoogleAccountBinding, bindingTables: readonly AccountMappingTable[], conflictTables: readonly AccountMappingTable[], db: SqlConnection = this.db): Promise<void> {
    for (const table of bindingTables) {
      const result = await db.query<{ mcp_user_id: string }>(`SELECT mcp_user_id FROM ${table} WHERE website_user_id=$1`, [binding.accountId]);
      if (result.rows[0]?.mcp_user_id !== binding.mcpUserId) throw new Error("oauth_account_binding_conflict");
    }
    for (const table of conflictTables) {
      const result = await db.query<{ website_user_id: string }>(`SELECT website_user_id FROM ${table} WHERE mcp_user_id=$1`, [binding.mcpUserId]);
      if (result.rows.some(row => String(row.website_user_id) !== binding.accountId)) throw new Error("oauth_account_binding_conflict");
    }
  }
  async getGrant(userId: string) { return this.get<GoogleGrant>("grant", userId); }
  async updateGrantRefreshToken(userId: string, refreshToken: string) {
    if (this.db.batch) {
      const hash = this.hash(userId);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const selected = await this.db.query<StoredRow>(`SELECT payload, expires_at, started FROM ${this.table()} WHERE kind='grant' AND key_hash=$1`, [hash]);
        const row = selected.rows[0]; if (!row) return;
        const grant = this.open<GoogleGrant>("grant", hash, row.payload);
        const payload = this.seal("grant", hash, { ...grant, refreshToken, updatedAt: Date.now() });
        const updated = await this.db.query(`UPDATE ${this.table()} SET payload=$3, updated_at=$4 WHERE kind='grant' AND key_hash=$1 AND payload=$2 RETURNING key_hash`, [hash, row.payload, payload, Date.now()]);
        if (updated.rows.length === 1) return;
      }
      throw new Error("authorization_update_contention");
    }
    await this.db.transaction(async (tx) => {
      const hash = this.hash(userId);
      const result = await tx.query<StoredRow>(`SELECT payload, expires_at, started FROM ${this.table()} WHERE kind='grant' AND key_hash=$1 FOR UPDATE`, [hash]);
      const row = result.rows[0]; if (!row) return;
      const grant = this.open<GoogleGrant>("grant", hash, row.payload);
      await tx.query(`UPDATE ${this.table()} SET payload=$3, updated_at=$4 WHERE kind=$1 AND key_hash=$2`, ["grant", hash, this.seal("grant", hash, { ...grant, refreshToken, updatedAt: Date.now() }), Date.now()]);
    });
  }
  async deleteUserAuthorization(userId: string) {
    if (this.db.batch) { await this.db.query(`DELETE FROM ${this.table()} WHERE owner_id=$1`, [userId]); return; }
    await this.db.transaction(async (tx) => {
      await tx.query(`DELETE FROM ${this.table()} WHERE owner_id=$1`, [userId]);
    });
  }
  async putCode(code: InternalCode) { await this.put("code", code.code, code, { owner: code.userId, expiresAt: code.expiresAt }); }
  async getCode(code: string) { return reviveResource(await this.get<InternalCode>("code", code)); }
  async takeCode(code: string) { return reviveResource(await this.take<InternalCode>("code", code)); }
  async putAccess(record: AccessRecord) { await this.put("access", record.token, record, { owner: record.userId, expiresAt: record.expiresAt }); }
  async putTokenPair(access: AccessRecord, refresh: RefreshRecord) {
    if (access.userId !== refresh.userId || access.clientId !== refresh.clientId) throw new Error("Invalid token pair");
    if (this.db.batch) {
      await this.db.batch([this.putStatement("access", access.token, access, { owner: access.userId, expiresAt: access.expiresAt }), this.putStatement("refresh", refresh.token, refresh, { owner: refresh.userId, expiresAt: refresh.expiresAt })]);
      return;
    }
    await this.db.transaction(async (tx) => {
      await this.put("access", access.token, access, { owner: access.userId, expiresAt: access.expiresAt }, tx);
      await this.put("refresh", refresh.token, refresh, { owner: refresh.userId, expiresAt: refresh.expiresAt }, tx);
    });
  }
  async rotateTokenPair(oldRefreshToken: string, clientId: string, access: AccessRecord, refresh: RefreshRecord) {
    if (access.userId !== refresh.userId || access.clientId !== refresh.clientId || access.clientId !== clientId) return false;
    if (this.db.batch) {
      const oldHash = this.hash(oldRefreshToken);
      const nextHash = this.hash(refresh.token);
      const accessHash = this.hash(access.token);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const selected = await this.db.query<StoredRow>(`SELECT payload, expires_at, started FROM ${this.table()} WHERE kind='refresh' AND key_hash=$1 AND expires_at>$2`, [oldHash, Date.now()]);
        const row = selected.rows[0]; if (!row) return false;
        const old = this.open<RefreshRecord>("refresh", oldHash, row.payload);
        if (old.clientId !== clientId || old.userId !== access.userId) throw new Error("Invalid refresh token");
        const refreshPayload = this.seal("refresh", nextHash, refresh);
        const accessPayload = this.seal("access", accessHash, access);
        const committed = await this.db.batch([
          { sql: `UPDATE ${this.table()} SET key_hash=$1,payload=$2,owner_id=$3,expires_at=$4,updated_at=$5 WHERE kind='refresh' AND key_hash=$6 AND payload=$7 AND expires_at>$8 AND NOT EXISTS (SELECT 1 FROM ${this.table()} WHERE kind='refresh' AND key_hash=$1) RETURNING key_hash`, values: [nextHash, refreshPayload, refresh.userId, refresh.expiresAt, Date.now(), oldHash, row.payload, Date.now()] },
          { sql: `INSERT INTO ${this.table()} (kind,key_hash,state_hash,owner_id,payload,expires_at,updated_at) SELECT 'access',$1,NULL,$2,$3,$4,$5 WHERE EXISTS (SELECT 1 FROM ${this.table()} WHERE kind='refresh' AND key_hash=$6 AND payload=$7) ON CONFLICT (kind,key_hash) DO UPDATE SET state_hash=EXCLUDED.state_hash,owner_id=EXCLUDED.owner_id,payload=EXCLUDED.payload,expires_at=EXCLUDED.expires_at,updated_at=EXCLUDED.updated_at`, values: [accessHash, access.userId, accessPayload, access.expiresAt, Date.now(), nextHash, refreshPayload] },
        ]);
        if (committed[0]?.rows.length === 1) return true;
        // A changed payload means another request already rotated the token.
        if (committed[0]?.rows.length === 0) return false;
      }
      throw new Error("authorization_rotation_contention");
    }
    return this.db.transaction(async (tx) => {
      const hash = this.hash(oldRefreshToken);
      const result = await tx.query<StoredRow>(`DELETE FROM ${this.table()} WHERE kind='refresh' AND key_hash=$1 AND expires_at>$2 RETURNING payload, expires_at, started`, [hash, Date.now()]);
      const row = result.rows[0]; if (!row) return false;
      const old = this.open<RefreshRecord>("refresh", hash, row.payload);
      if (old.clientId !== clientId || old.userId !== access.userId) throw new Error("Invalid refresh token");
      await this.put("access", access.token, access, { owner: access.userId, expiresAt: access.expiresAt }, tx);
      await this.put("refresh", refresh.token, refresh, { owner: refresh.userId, expiresAt: refresh.expiresAt }, tx);
      return true;
    });
  }
  async getAccess(token: string) { return reviveResource(await this.get<AccessRecord>("access", token)); }
  async putRefresh(record: RefreshRecord) { await this.put("refresh", record.token, record, { owner: record.userId, expiresAt: record.expiresAt }); }
  async getRefresh(token: string) { return reviveResource(await this.get<RefreshRecord>("refresh", token)); }
  async takeRefresh(token: string) { return reviveResource(await this.take<RefreshRecord>("refresh", token)); }
  async deleteToken(token: string) { await this.db.query(`DELETE FROM ${this.table()} WHERE key_hash=$1 AND kind IN ('access','refresh')`, [this.hash(token)]); }
  async deleteClientToken(token: string, clientId: string) {
    const access = await this.getAccess(token);
    const refresh = await this.getRefresh(token);
    if (access?.clientId === clientId || refresh?.clientId === clientId) await this.deleteToken(token);
  }
  async putEphemeral(kind: string, key: string, value: unknown, owner: string, expiresAt: number) {
    if (!/^[a-z_][a-z0-9_]*$/.test(kind)) throw new Error("Invalid ephemeral record kind.");
    await this.put(kind as RecordKind, key, value, { owner, expiresAt });
  }
  async getEphemeral<T>(kind: string, key: string) { return this.get<T>(kind as RecordKind, key); }
  async takeEphemeral<T>(kind: string, key: string) { return this.take<T>(kind as RecordKind, key); }
  async deleteUserTokens(userId: string) { await this.db.query(`DELETE FROM ${this.table()} WHERE owner_id=$1 AND kind IN ('access','refresh')`, [userId]); }
}

function reviveResource<T extends { resource?: URL }>(value: T | undefined): T | undefined {
  if (value && typeof value.resource === "string") value.resource = new URL(value.resource);
  return value;
}
function reviveFlow(value: GoogleFlow | undefined) {
  if (value && typeof value.params.resource === "string") value.params.resource = new URL(value.params.resource);
  return value;
}

/** Production database wrapper; transactions keep one acquired PostgreSQL connection. */
export class PgPoolDatabase implements SqlDatabase {
  readonly pool: Pool;
  constructor(connectionString: string) { this.pool = new Pool({ connectionString, max: 5, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000 }); }
  async query<T extends QueryResultRow = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<SqlResult<T>> { return this.pool.query<T>(sql, values); }
  async transaction<T>(run: (tx: SqlConnection) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await run({ query: async <R extends QueryResultRow = Record<string, unknown>>(sql: string, values?: unknown[]) => client.query<R>(sql, values) });
      await client.query("COMMIT"); return result;
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }
  async close() { await this.pool.end(); }
}
