import { PUBLIC_CLASSROOM_SCOPES } from "../scopes.js";

export const V2_DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file" as const;
export const V2_BETA_SCOPES = [...PUBLIC_CLASSROOM_SCOPES, V2_DRIVE_SCOPE] as const;
