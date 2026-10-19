import { PUBLIC_CLASSROOM_SCOPES } from "../scopes.js";
import type { PublicOAuthConfig } from "./oauth.js";
import type { SaaSFeatureFlags } from "../saas/flags.js";

export type RuntimeConfig = PublicOAuthConfig & {
  port: number; production: boolean; bindHost?: string;
  workerClientIp?: boolean;
  storeKind?: "memory" | "postgres" | "d1"; databaseUrl?: string; encryptionKeyBase64?: string;
  operatorName?: string; supportEmail?: string; chatgptPluginUrl?: string;
  saasFlags?: SaaSFeatureFlags;
};
const required = (name: string, env: NodeJS.ProcessEnv): string => {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Missing required configuration: ${name}`);
  return value;
};
const safeUrl = (name: string, value: string) => {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`Invalid URL configuration: ${name}`); }
  if (url.username || url.password || url.search || url.hash) throw new Error(`Invalid URL configuration: ${name}`);
  return url;
};

export function loadRuntimeConfig(env = process.env): RuntimeConfig {
  const production = env.NODE_ENV === "production";
  const originText = env.PUBLIC_APP_ORIGIN?.trim() || (production ? "" : "http://127.0.0.1:8787");
  const origin = safeUrl("PUBLIC_APP_ORIGIN", originText);
  if (production ? origin.protocol !== "https:" : !["https:", "http:"].includes(origin.protocol)) throw new Error("PUBLIC_APP_ORIGIN must use HTTPS in production.");
  if (origin.pathname !== "/") throw new Error("PUBLIC_APP_ORIGIN must be an origin without a path.");
  const resource = safeUrl("MCP_RESOURCE_URL", env.MCP_RESOURCE_URL?.trim() || new URL("/mcp", origin).toString());
  if (resource.origin !== origin.origin || resource.pathname !== "/mcp") throw new Error("MCP_RESOURCE_URL must match the application origin and /mcp route.");
  const callback = safeUrl("GOOGLE_OAUTH_CALLBACK_URL", env.GOOGLE_OAUTH_CALLBACK_URL?.trim() || new URL("/oauth/google/callback", origin).toString());
  if (callback.origin !== origin.origin || callback.pathname !== "/oauth/google/callback") throw new Error("Google callback URL must match the configured application origin and callback route.");
  const port = Number(env.PORT ?? (production ? "3000" : "8787"));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be an integer between 1 and 65535.");
  const storeKind = env.PUBLIC_AUTH_STORE?.trim() || (production ? "postgres" : "memory");
  if (storeKind !== "memory" && storeKind !== "postgres" && storeKind !== "d1") throw new Error("PUBLIC_AUTH_STORE must be memory, postgres, or d1.");
  if (production && storeKind !== "postgres" && storeKind !== "d1") throw new Error("Production requires an encrypted persistent authorization store.");
  const databaseUrl = storeKind === "postgres" ? required("DATABASE_URL", env) : undefined;
  if (databaseUrl) {
    let parsed: URL;
    try { parsed = new URL(databaseUrl); } catch { throw new Error("Invalid DATABASE_URL configuration."); }
    if (!["postgres:", "postgresql:"].includes(parsed.protocol)) throw new Error("DATABASE_URL must use PostgreSQL.");
  }
  const encryptionKeyBase64 = storeKind === "postgres" || storeKind === "d1" ? required("PUBLIC_AUTH_ENCRYPTION_KEY_B64", env) : undefined;
  if (encryptionKeyBase64 && (!/^[A-Za-z0-9+/]{43}=$/.test(encryptionKeyBase64) || Buffer.from(encryptionKeyBase64, "base64").length !== 32)) throw new Error("PUBLIC_AUTH_ENCRYPTION_KEY_B64 must be a base64-encoded 32-byte key.");
  const operatorName = production ? required("PUBLIC_OPERATOR_NAME", env) : env.PUBLIC_OPERATOR_NAME?.trim() || "Google Classroom MCP developer";
  const supportEmail = production ? required("PUBLIC_SUPPORT_EMAIL", env) : env.PUBLIC_SUPPORT_EMAIL?.trim() || "support@example.invalid";
  if (operatorName.length > 100 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(supportEmail)) throw new Error("Invalid public operator or support configuration.");
  const chatgptPluginUrl = env.CHATGPT_PLUGIN_URL?.trim() || undefined;
  if (chatgptPluginUrl) {
    const url = safeUrl("CHATGPT_PLUGIN_URL", chatgptPluginUrl);
    if (url.protocol !== "https:" || !["chatgpt.com", "www.chatgpt.com"].includes(url.hostname)) throw new Error("CHATGPT_PLUGIN_URL must be an HTTPS ChatGPT URL.");
  }
  return {
    origin, mcpResource: resource, googleCallbackUrl: callback.toString(),
    googleClientId: env.GOOGLE_OAUTH_CLIENT_ID?.trim() || required("GOOGLE_OAUTH_CLIENT_ID", env),
    googleClientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET?.trim() || required("GOOGLE_OAUTH_CLIENT_SECRET", env),
    port, production, bindHost: production ? "0.0.0.0" : "127.0.0.1", storeKind, databaseUrl, encryptionKeyBase64, operatorName, supportEmail, chatgptPluginUrl,
  };
}

export function validatePublicScopes(scopes: readonly string[]) {
  return scopes.length === PUBLIC_CLASSROOM_SCOPES.length
    && PUBLIC_CLASSROOM_SCOPES.every((scope) => scopes.includes(scope))
    && scopes.every((scope) => PUBLIC_CLASSROOM_SCOPES.includes(scope as (typeof PUBLIC_CLASSROOM_SCOPES)[number]));
}
