import path from "node:path";
import { fileURLToPath } from "node:url";
import { PUBLIC_CLASSROOM_SCOPES } from "./scopes.js";
export { PUBLIC_CLASSROOM_SCOPES } from "./scopes.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const paths = {
  projectRoot,
  credentials: path.join(projectRoot, "credentials", "oauth-client.json"),
  token: path.join(projectRoot, "credentials", "token.json"),
};

/** Local developer-only scope list. This capability is excluded from public MCP. */
export const SCOPES = [
  ...PUBLIC_CLASSROOM_SCOPES,
  "https://www.googleapis.com/auth/drive.readonly",
] as const;

export const MAX_FILE_BYTES = 100 * 1024 * 1024;
