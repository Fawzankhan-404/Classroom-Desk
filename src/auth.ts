import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OAuth2Client } from "googleapis-common";
import open from "open";
import { paths, SCOPES } from "./config.js";

type ClientSecretFile = {
  installed?: { client_id?: string; client_secret?: string; redirect_uris?: string[] };
};

export async function loadSavedAuth(): Promise<OAuth2Client> {
  let raw: string;
  try {
    raw = await fs.readFile(paths.token, "utf8");
  } catch {
    throw new Error(`OAuth token not found. Run \"npm run auth\" in ${paths.projectRoot}.`);
  }
  const token = JSON.parse(raw) as { client_id?: string; client_secret?: string; refresh_token?: string };
  if (!token.client_id || !token.client_secret || !token.refresh_token) {
    throw new Error("Token file is incomplete. Delete credentials/token.json and run npm run auth again.");
  }
  const client = new OAuth2Client(token.client_id, token.client_secret);
  client.setCredentials(token);
  return client;
}

async function saveCredentials(client: { credentials: { refresh_token?: string | null } }): Promise<void> {
  const content = JSON.parse(await fs.readFile(paths.credentials, "utf8")) as ClientSecretFile;
  const keys = content.installed;
  if (!keys?.client_id || !keys.client_secret || !client.credentials.refresh_token) {
    throw new Error("OAuth client file or returned credentials are incomplete.");
  }
  await fs.mkdir(path.dirname(paths.token), { recursive: true });
  await fs.writeFile(
    paths.token,
    JSON.stringify({
      type: "authorized_user",
      client_id: keys.client_id,
      client_secret: keys.client_secret,
      refresh_token: client.credentials.refresh_token,
    }, null, 2),
    { encoding: "utf8", mode: 0o600 },
  );
}

async function main(): Promise<void> {
  try {
    await fs.access(paths.credentials);
  } catch {
    throw new Error(`Missing ${paths.credentials}. Download an OAuth Desktop app client JSON and save it there.`);
  }
  const content = JSON.parse(await fs.readFile(paths.credentials, "utf8")) as ClientSecretFile;
  const keys = content.installed;
  if (!keys?.client_id || !keys.client_secret) {
    throw new Error("oauth-client.json must be a Google OAuth Desktop app credential file.");
  }
  const client = await authorize(keys.client_id, keys.client_secret);
  await saveCredentials(client);
  process.stdout.write("Authorization complete. Token saved locally to credentials/token.json.\n");
}

async function authorize(clientId: string, clientSecret: string): Promise<OAuth2Client> {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", async () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not create the local OAuth callback server."));
        return;
      }
      const redirectUri = `http://127.0.0.1:${address.port}/oauth2callback`;
      const client = new OAuth2Client(clientId, clientSecret, redirectUri);
      const url = client.generateAuthUrl({ access_type: "offline", prompt: "consent", scope: [...SCOPES] });
      server.on("request", async (request, response) => {
        try {
          const incoming = new URL(request.url ?? "/", redirectUri);
          const code = incoming.searchParams.get("code");
          const error = incoming.searchParams.get("error");
          if (error) throw new Error(`Google authorization was denied: ${error}`);
          if (!code) { response.writeHead(400).end("Missing authorization code."); return; }
          const { tokens } = await client.getToken(code);
          client.setCredentials(tokens);
          response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" }).end("Authorization complete. You can close this tab.");
          server.close();
          resolve(client);
        } catch (error) {
          response.writeHead(500).end("Authorization failed. Return to the terminal for details.");
          server.close();
          reject(error);
        }
      });
      process.stdout.write("Opening Google authorization in your browser.\n");
      try {
        await open(url);
      } catch {
        server.close();
        reject(new Error("Could not open the browser. Re-run npm run auth after checking the Windows default-browser setting."));
      }
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Authorization failed"}\n`);
    process.exitCode = 1;
  });
}
