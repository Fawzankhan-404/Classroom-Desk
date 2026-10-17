import type { OAuthAccountBinding } from "../public/oauth.js";
import type { PostgresPublicAuthStore } from "../public/postgres.js";
import type { SaaSStore } from "./store.js";
import { readSessionCookie } from "./sessions.js";

/** Website OIDC subject and server session are the ownership proof. Client IDs,
 * email addresses and ChatGPT UI labels never establish an account binding. */
export function unifiedOAuthAccounts(saas: SaaSStore, auth: PostgresPublicAuthStore): OAuthAccountBinding {
  if (saas.db !== auth.db) throw new Error("unified_oauth_requires_shared_database");
  return {
    async session(cookie) {
      const token = readSessionCookie(cookie);
      const session = token ? await saas.sessions.find(token) : null;
      if (!session) return null;
      const user = await saas.getUser(session.userId);
      if (!user || user.status !== "active") return null;
      return { userId: user.id, sessionId: session.id, googleSubject: user.googleSubject, displayName: user.displayName,
        mcpUserId: await saas.getUnifiedMcpUserId(user.id) ?? `cd-account:${user.id}`, legacyMcpUserId: await saas.getLegacyMcpUserId(user.id) ?? undefined };
    },
    async identify(identity) {
      const user = await saas.upsertGoogleIdentity({ ...identity, now: new Date() });
      if (user.status !== "active") throw new Error("account_restricted");
      const created = await saas.sessions.create(user.id);
      return { token: created.token, account: { userId: user.id, sessionId: created.session.id, googleSubject: user.googleSubject, displayName: user.displayName,
        mcpUserId: await saas.getUnifiedMcpUserId(user.id) ?? `cd-account:${user.id}` } };
    },
    complete: (flow, code, grant) => auth.completeAccountAuthorization(flow, code, grant),
  };
}
