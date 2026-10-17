#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.env.NODE_ENV === "production") throw new Error("Local Web OAuth launcher cannot run in production.");

const credentialPath = resolve(dirname(fileURLToPath(import.meta.url)), "../credentials/public-web-oauth.local.json");
const credential = JSON.parse(await readFile(credentialPath, "utf8")) as { client_id?: string; client_secret?: string; redirect_uri?: string };
const origin = "http://127.0.0.1:8787";
if (!credential.client_id || !credential.client_secret || credential.redirect_uri !== `${origin}/oauth/google/callback`) {
  throw new Error("Local Web OAuth credential is missing or has an unexpected callback.");
}
process.env.NODE_ENV = "development";
process.env.PUBLIC_AUTH_STORE = "memory";
process.env.PUBLIC_APP_ORIGIN = origin;
process.env.PORT = "8787";
process.env.GOOGLE_OAUTH_CLIENT_ID = credential.client_id;
process.env.GOOGLE_OAUTH_CLIENT_SECRET = credential.client_secret;
process.env.GOOGLE_OAUTH_CALLBACK_URL = credential.redirect_uri;
await import("./http.js");
delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;
