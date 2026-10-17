import { PUBLIC_CLASSROOM_SCOPES } from "../scopes.js";
import { GOOGLE_CANONICAL_CLASSROOM_SCOPES, TEACHER_CLASSROOM_SCOPES } from "../scopes.js";

export const V2_DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file" as const;
export const V2_BETA_SCOPES = [...PUBLIC_CLASSROOM_SCOPES, V2_DRIVE_SCOPE] as const;

const canonicalV2Scopes = [...GOOGLE_CANONICAL_CLASSROOM_SCOPES, V2_DRIVE_SCOPE];
export const V2_TEACHER_SCOPES = [...V2_BETA_SCOPES, ...TEACHER_CLASSROOM_SCOPES] as const;

export function isExactV2GoogleGrant(scopes: readonly string[]): boolean {
  const actual = new Set(scopes);
  if (actual.size !== scopes.length) return false;
  const allowed = [
    V2_BETA_SCOPES,
    canonicalV2Scopes,
    V2_TEACHER_SCOPES,
    [...canonicalV2Scopes, ...TEACHER_CLASSROOM_SCOPES],
  ];
  return allowed.some((candidate) => actual.size === candidate.length && candidate.every((scope) => actual.has(scope)));
}
