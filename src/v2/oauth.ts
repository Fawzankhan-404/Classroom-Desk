import { OAuth2Client } from "googleapis-common";
import { V2_BETA_SCOPES } from "./scopes.js";
import { GOOGLE_CANONICAL_CLASSROOM_SCOPES } from "../scopes.js";

export type V2OAuthConfig = { clientId: string; clientSecret: string; callbackUrl: string };

/** Beta-only OAuth configuration; V1 never reads these variables. */
export function v2OAuthConfigFromEnv(env: Record<string, string | undefined> = process.env): V2OAuthConfig {
  const clientId = env.V2_GOOGLE_OAUTH_CLIENT_ID?.trim();
  const clientSecret = env.V2_GOOGLE_OAUTH_CLIENT_SECRET?.trim();
  const callbackUrl = env.V2_GOOGLE_OAUTH_CALLBACK_URL?.trim();
  if (!clientId || !clientSecret || !callbackUrl) throw new Error("V2 beta OAuth configuration is incomplete.");
  const parsed = new URL(callbackUrl);
  if (parsed.protocol !== "https:" && parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") throw new Error("V2 beta OAuth callback must use HTTPS or an explicitly local callback.");
  return { clientId, clientSecret, callbackUrl };
}

export function createV2AuthorizationUrl(config: V2OAuthConfig, state: string): string {
  const client = new OAuth2Client(config.clientId, config.clientSecret, config.callbackUrl);
  return client.generateAuthUrl({ access_type: "offline", prompt: "consent", scope: [...V2_BETA_SCOPES], state, include_granted_scopes: false });
}

export function assertV2GrantScopes(grantedScopes: string[]): void {
  const actual = new Set(grantedScopes); const drive = "https://www.googleapis.com/auth/drive.file";
  const accepted = [new Set(V2_BETA_SCOPES), new Set([...GOOGLE_CANONICAL_CLASSROOM_SCOPES, drive])];
  if (!accepted.some((expected) => actual.size === expected.size && [...expected].every((scope) => actual.has(scope)))) throw new Error("The V2 beta Google grant does not match an approved Classroom-plus-drive.file scope set.");
}
