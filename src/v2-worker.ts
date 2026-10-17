import { httpServerHandler } from "cloudflare:node";
import { isIP } from "node:net";
import { createHash, randomBytes } from "node:crypto";
import { OAuth2Client } from "googleapis-common";
import { ipKeyGenerator } from "express-rate-limit";
import { loadRuntimeConfig } from "./public/config.js";
import { createPublicApp } from "./public/http.js";
import { PostgresPublicAuthStore } from "./public/postgres.js";
import { HyperdriveDatabase } from "./public/hyperdrive.js";
import { createClients } from "./classroom.js";
import { createV2BetaServer } from "./v2/server.js";
import { V2_BETA_SCOPES } from "./v2/scopes.js";
import { GOOGLE_CANONICAL_CLASSROOM_SCOPES } from "./scopes.js";
import { DurableAttachmentAuthorizationStore } from "./v2/attachments.js";
import { GoogleDriveAttachmentReader } from "./v2/attachment-content.js";
import { buildOnePickAuthorizationUrl, parseOnePickCallback, DRIVE_FILE_SCOPE } from "./v2/picker.js";
import { buildPickerUrl } from "./v2/urls.js";
import { discoverAttachments } from "./v2/attachments.js";

type Bindings = {
  V2_HYPERDRIVE?: { connectionString: string };
  V2_PRODUCTION_HYPERDRIVE?: { connectionString: string };
  V2_PUBLIC_RATE_LIMIT: { limit(input: { key: string }): Promise<{ success: boolean }> };
  V2_AUTH_RATE_LIMIT: { limit(input: { key: string }): Promise<{ success: boolean }> };
  V2_PUBLIC_APP_ORIGIN: string;
  V2_PUBLIC_OPERATOR_NAME: string;
  V2_PUBLIC_SUPPORT_EMAIL: string;
  V2_PUBLIC_AUTH_ENCRYPTION_KEY_B64: string;
  V2_GOOGLE_OAUTH_CLIENT_ID: string;
  V2_GOOGLE_OAUTH_CLIENT_SECRET: string;
  V2_PICKER_CALLBACK_URL: string;
  V2_AUTH_TABLE?: string;
};

const betaGrant = (scopes: string[]) => {
  const actual = new Set(scopes);
  const accepted = [new Set(V2_BETA_SCOPES), new Set([...GOOGLE_CANONICAL_CLASSROOM_SCOPES, "https://www.googleapis.com/auth/drive.file"] )];
  return accepted.some((expected) => actual.size === expected.size && [...expected].every((scope) => actual.has(scope)));
};

export const pickerUrl = buildPickerUrl;

let handler: ReturnType<typeof httpServerHandler> | undefined;

export default {
  async fetch(request: Request, bindings: Bindings, context: unknown) {
    const path = new URL(request.url).pathname;
    const clientIp = request.headers.get("cf-connecting-ip") ?? "";
    if (path !== "/health" && !isIP(clientIp)) return Response.json({ error: "invalid_client_address" }, { status: 400 });
    if (!handler) {
      const hyperdrive = bindings.V2_PRODUCTION_HYPERDRIVE ?? bindings.V2_HYPERDRIVE;
      if (!hyperdrive) return Response.json({ error: "storage_unavailable" }, { status: 503 });
      const config = loadRuntimeConfig({
        NODE_ENV: "production", PUBLIC_AUTH_STORE: "postgres", DATABASE_URL: hyperdrive.connectionString,
        PUBLIC_APP_ORIGIN: bindings.V2_PUBLIC_APP_ORIGIN, PUBLIC_OPERATOR_NAME: bindings.V2_PUBLIC_OPERATOR_NAME,
        PUBLIC_SUPPORT_EMAIL: bindings.V2_PUBLIC_SUPPORT_EMAIL, PUBLIC_AUTH_ENCRYPTION_KEY_B64: bindings.V2_PUBLIC_AUTH_ENCRYPTION_KEY_B64,
        GOOGLE_OAUTH_CLIENT_ID: bindings.V2_GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET: bindings.V2_GOOGLE_OAUTH_CLIENT_SECRET,
        GOOGLE_OAUTH_CALLBACK_URL: `${bindings.V2_PUBLIC_APP_ORIGIN}/oauth/google/callback`, MCP_RESOURCE_URL: `${bindings.V2_PUBLIC_APP_ORIGIN}/mcp`,
      });
      config.googleScopes = V2_BETA_SCOPES;
      config.googleGrantValidator = betaGrant;
      const database = new HyperdriveDatabase(config.databaseUrl!);
      const store = new PostgresPublicAuthStore(database, config.encryptionKeyBase64, bindings.V2_AUTH_TABLE?.trim() || "v2_beta_auth_records");
      const attachmentAuthorizations = new DurableAttachmentAuthorizationStore(store);
      const pickerCallback = bindings.V2_PICKER_CALLBACK_URL;
      // A reachable database is insufficient: OAuth needs the beta schema.
      const { app } = createPublicApp({ ...config, workerClientIp: true }, store, undefined, () => store.ready(), createClients, {
        resourceName: "Classroom Desk V2 beta",
        mcpFactory: async (auth, userId) => {
          const clients = createClients(auth);
          const reader = { read: async (attachment: Parameters<GoogleDriveAttachmentReader["read"]>[0]) => {
            if (!attachment.driveFileId) throw new Error("picker_authorization_required");
            const tokens = await attachmentAuthorizations.getPickerGrant<Record<string, unknown>>(userId, attachment.driveFileId);
            if (!tokens || typeof tokens.access_token !== "string") throw new Error("picker_authorization_required");
            const oauth = new OAuth2Client(bindings.V2_GOOGLE_OAUTH_CLIENT_ID, bindings.V2_GOOGLE_OAUTH_CLIENT_SECRET, pickerCallback);
            oauth.setCredentials(tokens as never);
            return new GoogleDriveAttachmentReader(createClients(oauth).drive).read(attachment);
          } } as GoogleDriveAttachmentReader;
          return createV2BetaServer({ ...clients, subject: userId, uploadPdf: async (context, name, bytes) => {
            const work = (await clients.classroom.courses.courseWork.get({ courseId: context.courseId, id: context.courseWorkId })).data;
            const driveIds = discoverAttachments(work.materials).filter((item) => item.kind === "drive_file" && item.driveFileId).map((item) => item.driveFileId!);
            let accessToken: string | undefined;
            for (const fileId of driveIds) { const tokens = await attachmentAuthorizations.getPickerGrant<Record<string, unknown>>(userId, fileId); if (tokens && typeof tokens.access_token === "string") { accessToken = tokens.access_token; break; } }
            if (!accessToken) throw new Error("picker_authorization_required");
            const form = new FormData();
            form.append("metadata", new Blob([JSON.stringify({ name, mimeType: "application/pdf" })], { type: "application/json" }));
            const payload = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
            form.append("file", new Blob([payload], { type: "application/pdf" }), name);
            const response = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType,webViewLink", { method: "POST", headers: { Authorization: `Bearer ${accessToken}` }, body: form });
            if (!response.ok) { const error = new Error("Google Drive upload failed"); (error as { response?: { status?: number } }).response = { status: response.status }; throw error; }
            return await response.json() as { id?: string | null; name?: string | null; mimeType?: string | null; webViewLink?: string | null };
          }, driveForUpload: async (context) => {
            const work = (await clients.classroom.courses.courseWork.get({ courseId: context.courseId, id: context.courseWorkId })).data;
            const driveIds = discoverAttachments(work.materials).filter((item) => item.kind === "drive_file" && item.driveFileId).map((item) => item.driveFileId!);
            for (const fileId of driveIds) {
              const tokens = await attachmentAuthorizations.getPickerGrant<Record<string, unknown>>(userId, fileId);
              if (tokens && typeof tokens.access_token === "string") {
                const oauth = new OAuth2Client(bindings.V2_GOOGLE_OAUTH_CLIENT_ID, bindings.V2_GOOGLE_OAUTH_CLIENT_SECRET, pickerCallback);
                oauth.setCredentials(tokens as never);
                return createClients(oauth).drive;
              }
            }
            return undefined;
          }, attachmentAccess: { authorizations: attachmentAuthorizations, reader, pickerUrl: (id) => pickerUrl(config.origin.toString(), id) } });
        },
        registerRoutes: (routeApp) => {
          routeApp.get("/v2-runtime", (_req, res) => res.status(200).json({ status: "ready", runtime: "v2-beta" }));
          routeApp.get(/^\/picker\/([A-Za-z0-9_-]{20,})$/, async (req, res) => {
        const id = String(req.params[0] ?? ""); const pending = await attachmentAuthorizations.lookup(id);
        if (!pending || pending.status !== "pending" || !pending.attachment.driveFileId) return res.status(400).type("text").send("This file authorization expired or is unavailable.");
        const verifier = randomBytes(48).toString("base64url"); const challenge = createHash("sha256").update(verifier).digest("base64url");
        await attachmentAuthorizations.putPickerSession(id, verifier, pending.attachment.driveFileId);
        const url = buildOnePickAuthorizationUrl({ clientId: bindings.V2_GOOGLE_OAUTH_CLIENT_ID, redirectUri: pickerCallback, state: id, codeChallenge: challenge, fileId: pending.attachment.driveFileId });
            return res.redirect(302, url);
          });
          routeApp.get(new URL(pickerCallback).pathname, async (req, res) => {
        const id = typeof req.query.state === "string" ? req.query.state : ""; const session = await attachmentAuthorizations.takePickerSession(id); const pending = await attachmentAuthorizations.lookup(id);
        try {
          if (!session || !pending || pending.status !== "pending") throw new Error("picker_state_invalid");
          const callbackUrl = new URL(req.originalUrl, config.origin).toString(); const parsed = parseOnePickCallback({ callbackUrl, redirectUri: pickerCallback, expectedState: id, expectedFileId: session.expectedFileId });
          const oauth = new OAuth2Client(bindings.V2_GOOGLE_OAUTH_CLIENT_ID, bindings.V2_GOOGLE_OAUTH_CLIENT_SECRET, pickerCallback);
          const { tokens } = await oauth.getToken({ code: parsed.code, codeVerifier: session.verifier });
          const granted = new Set((tokens.scope ?? "").split(/\s+/).filter(Boolean));
          if (!tokens.access_token || granted.size !== 1 || !granted.has(DRIVE_FILE_SCOPE)) throw new Error("picker_scope_invalid");
          oauth.setCredentials(tokens);
          const tokenExpiry = typeof tokens.expiry_date === "number" && Number.isFinite(tokens.expiry_date) ? tokens.expiry_date : Date.now() + 3600000;
          const grantExpiry = Math.min(Date.now() + 3600000, tokenExpiry);
          if (grantExpiry <= Date.now()) throw new Error("picker_token_expired");
          await attachmentAuthorizations.putPickerGrant(pending.subject, session.expectedFileId, tokens, grantExpiry);
          await attachmentAuthorizations.complete(id, pending.subject, session.expectedFileId);
          res.setHeader("Cache-Control", "no-store"); return res.type("text").send("Attachment authorized. Return to ChatGPT and ask Classroom Desk to read it.");
        } catch { return res.status(400).type("text").send("Attachment authorization was not completed. You can try again from Classroom Desk."); }
          });
        },
      });
      app.listen(3001);
      handler = httpServerHandler({ port: 3001 });
    }
    return handler.fetch(request, bindings, context);
  },
  async scheduled(_event: unknown, bindings: Bindings) {
    try {
      const store = new PostgresPublicAuthStore(new HyperdriveDatabase((bindings.V2_PRODUCTION_HYPERDRIVE ?? bindings.V2_HYPERDRIVE)!.connectionString), bindings.V2_PUBLIC_AUTH_ENCRYPTION_KEY_B64, bindings.V2_AUTH_TABLE?.trim() || "v2_beta_auth_records");
      await store.pruneExpired();
    } catch {
      // Background cleanup intentionally exposes no database details.
    }
  },
};
