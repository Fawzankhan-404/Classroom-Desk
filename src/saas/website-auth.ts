import { createHash, randomBytes } from "node:crypto";
import { OAuth2Client } from "googleapis-common";
import type { SaaSUser } from "./types.js";

export const WEBSITE_IDENTITY_SCOPES = ["openid", "email", "profile"] as const;
export interface WebsiteOAuthConfig { clientId: string; clientSecret: string; callbackUrl: string; origin: string; }
export interface WebsiteIdentityStore { upsertGoogleIdentity(input: { googleSubject: string; email: string; displayName: string; now: Date }): Promise<SaaSUser>; }
export interface LoginState { state: string; verifier: string; createdAt: number; }

export function createLoginState(now = Date.now()): LoginState { return { state: randomBytes(24).toString("base64url"), verifier: randomBytes(32).toString("base64url"), createdAt: now }; }
export function pkceChallenge(verifier: string): string { return createHash("sha256").update(verifier).digest("base64url"); }

export function buildWebsiteGoogleUrl(config: WebsiteOAuthConfig, login: LoginState): string {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", config.clientId); url.searchParams.set("redirect_uri", config.callbackUrl);
  url.searchParams.set("response_type", "code"); url.searchParams.set("scope", WEBSITE_IDENTITY_SCOPES.join(" "));
  url.searchParams.set("access_type", "offline"); url.searchParams.set("prompt", "select_account");
  url.searchParams.set("state", login.state); url.searchParams.set("code_challenge", pkceChallenge(login.verifier)); url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export async function completeWebsiteGoogleLogin(config: WebsiteOAuthConfig, store: WebsiteIdentityStore, code: string, verifier: string, now = new Date()): Promise<SaaSUser> {
  const client = new OAuth2Client(config.clientId, config.clientSecret, config.callbackUrl);
  const { tokens } = await client.getToken({ code, codeVerifier: verifier });
  if (!tokens.id_token) throw new Error("Google identity token missing.");
  const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: config.clientId });
  const payload = ticket.getPayload();
  if (!payload?.sub || !payload.email || payload.email_verified !== true) throw new Error("Verified Google identity required.");
  return store.upsertGoogleIdentity({ googleSubject: payload.sub, email: payload.email, displayName: payload.name?.trim() || payload.email, now });
}
