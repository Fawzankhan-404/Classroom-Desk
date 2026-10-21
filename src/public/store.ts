import { randomUUID } from "node:crypto";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";

export type GoogleGrant = { userId: string; refreshToken: string; scopes: string[]; createdAt: number; updatedAt: number; googleSubject?: string };
export type GoogleAccountBinding = {
  accountId: string;
  mcpUserId: string;
  /** Internal recovery payload; never exposed in OAuth responses or diagnostics. */
  recovery?: {
    requestId: string;
    googleSubjectHash: string;
    emailHash: string;
    displayNameHash: string;
    profile: { googleSubject: string; email: string; displayName: string };
    expectedLegacyCiphertext: string;
    expectedLegacyCiphertextHash: string;
  };
};
export type GoogleFlow = {
  id: string; client: OAuthClientInformationFull; params: AuthorizationParams; userId: string;
  googleState: string; googleVerifier: string; googleNonce?: string; expiresAt: number; started: boolean;
};
export type InternalCode = { code: string; clientId: string; userId: string; redirectUri: string; state?: string; challenge: string; resource?: URL; scopes: string[]; expiresAt: number };
export type AccessRecord = { token: string; clientId: string; userId: string; scopes: string[]; resource?: URL; expiresAt: number };
export type RefreshRecord = { token: string; clientId: string; userId: string; scopes: string[]; resource?: URL; expiresAt: number };

/** Production adapters must persist OAuth metadata and encrypt all credential-bearing records. */
export interface PublicAuthStore extends OAuthRegisteredClientsStore {
  putFlow(flow: GoogleFlow): Promise<void>;
  getFlow(id: string): Promise<GoogleFlow | undefined>;
  takeFlowByGoogleState(state: string): Promise<GoogleFlow | undefined>;
  setFlowStarted(id: string): Promise<boolean>;
  putGrant(grant: GoogleGrant): Promise<void>;
  /** Persist the Google grant and its MCP authorization code atomically where supported. */
  putGrantAndCode(grant: GoogleGrant, code: InternalCode, binding?: GoogleAccountBinding): Promise<void>;
  getGrant(userId: string): Promise<GoogleGrant | undefined>;
  deleteUserAuthorization(userId: string): Promise<void>;
  putCode(code: InternalCode): Promise<void>;
  getCode(code: string): Promise<InternalCode | undefined>;
  takeCode(code: string): Promise<InternalCode | undefined>;
  putAccess(record: AccessRecord): Promise<void>;
  putTokenPair(access: AccessRecord, refresh: RefreshRecord): Promise<void>;
  rotateTokenPair(oldRefreshToken: string, clientId: string, access: AccessRecord, refresh: RefreshRecord): Promise<boolean>;
  getAccess(token: string): Promise<AccessRecord | undefined>;
  putRefresh(record: RefreshRecord): Promise<void>;
  getRefresh(token: string): Promise<RefreshRecord | undefined>;
  takeRefresh(token: string): Promise<RefreshRecord | undefined>;
  deleteToken(token: string): Promise<void>;
  deleteClientToken(token: string, clientId: string): Promise<void>;
  deleteUserTokens(userId: string): Promise<void>;
  updateGrantRefreshToken(userId: string, refreshToken: string): Promise<void>;
}

/** Development-only, process-local adapter. Production startup must inject a durable encrypted implementation. */
export class MemoryPublicAuthStore implements PublicAuthStore {
  private clients = new Map<string, OAuthClientInformationFull>();
  private flows = new Map<string, GoogleFlow>();
  private codes = new Map<string, InternalCode>();
  private grants = new Map<string, GoogleGrant>();
  private access = new Map<string, AccessRecord>();
  private refresh = new Map<string, RefreshRecord>();
  async getClient(clientId: string) { return this.clients.get(clientId); }
  async registerClient(client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">) {
    const value: OAuthClientInformationFull = { ...client, client_id: randomUUID(), client_id_issued_at: Math.floor(Date.now() / 1000) };
    this.clients.set(value.client_id, value); return value;
  }
  async putFlow(flow: GoogleFlow) { this.flows.set(flow.id, flow); }
  async getFlow(id: string) { const flow = this.flows.get(id); if (flow && flow.expiresAt <= Date.now()) { this.flows.delete(id); return undefined; } return flow; }
  async takeFlowByGoogleState(state: string) {
    const flow = [...this.flows.values()].find((candidate) => candidate.googleState === state);
    if (!flow || flow.expiresAt <= Date.now()) return undefined;
    this.flows.delete(flow.id); return flow;
  }
  async setFlowStarted(id: string) { const flow = await this.getFlow(id); if (!flow || flow.started) return false; flow.started = true; return true; }
  async putGrant(grant: GoogleGrant) { this.grants.set(grant.userId, grant); }
  async putGrantAndCode(grant: GoogleGrant, code: InternalCode, binding?: GoogleAccountBinding) {
    if (grant.userId !== code.userId) throw new Error("authorization_owner_mismatch");
    if (binding && binding.mcpUserId !== grant.userId) throw new Error("authorization_owner_mismatch");
    this.grants.set(grant.userId, grant);
    this.codes.set(code.code, code);
  }
  async getGrant(userId: string) { return this.grants.get(userId); }
  async deleteUserAuthorization(userId: string) { this.grants.delete(userId); await this.deleteUserTokens(userId); }
  async putCode(code: InternalCode) { this.codes.set(code.code, code); }
  async getCode(code: string) { const record = this.codes.get(code); if (record && record.expiresAt <= Date.now()) { this.codes.delete(code); return undefined; } return record; }
  async takeCode(code: string) {
    const record = this.codes.get(code);
    if (!record || record.expiresAt <= Date.now()) { this.codes.delete(code); return undefined; }
    this.codes.delete(code);
    return record;
  }
  async putAccess(record: AccessRecord) { this.access.set(record.token, record); }
  async putTokenPair(access: AccessRecord, refresh: RefreshRecord) { this.access.set(access.token, access); this.refresh.set(refresh.token, refresh); }
  async rotateTokenPair(oldRefreshToken: string, clientId: string, access: AccessRecord, refresh: RefreshRecord) {
    const old = this.refresh.get(oldRefreshToken);
    if (!old || old.expiresAt <= Date.now() || old.clientId !== clientId || old.userId !== access.userId || old.userId !== refresh.userId) return false;
    this.refresh.delete(oldRefreshToken);
    await this.putTokenPair(access, refresh);
    return true;
  }
  async getAccess(token: string) { const record = this.access.get(token); if (record && record.expiresAt <= Date.now()) { this.access.delete(token); return undefined; } return record; }
  async putRefresh(record: RefreshRecord) { this.refresh.set(record.token, record); }
  async getRefresh(token: string) { const record = this.refresh.get(token); if (record && record.expiresAt <= Date.now()) { this.refresh.delete(token); return undefined; } return record; }
  async takeRefresh(token: string) {
    const record = this.refresh.get(token);
    if (!record || record.expiresAt <= Date.now()) { this.refresh.delete(token); return undefined; }
    this.refresh.delete(token);
    return record;
  }
  async deleteToken(token: string) { this.access.delete(token); this.refresh.delete(token); }
  async deleteClientToken(token: string, clientId: string) {
    if (this.access.get(token)?.clientId === clientId) this.access.delete(token);
    if (this.refresh.get(token)?.clientId === clientId) this.refresh.delete(token);
  }
  async deleteUserTokens(userId: string) {
    for (const [token, row] of this.access) if (row.userId === userId) this.access.delete(token);
    for (const [token, row] of this.refresh) if (row.userId === userId) this.refresh.delete(token);
  }
  async updateGrantRefreshToken(userId: string, refreshToken: string) { const grant = this.grants.get(userId); if (grant) this.grants.set(userId, { ...grant, refreshToken, updatedAt: Date.now() }); }
}
