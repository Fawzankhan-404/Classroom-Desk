import { GOOGLE_CANONICAL_CLASSROOM_SCOPES, PUBLIC_CLASSROOM_SCOPES } from "../scopes.js";

export const V2_DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file" as const;
const GOOGLE_USERINFO_EMAIL_SCOPE = "https://www.googleapis.com/auth/userinfo.email" as const;
const GOOGLE_USERINFO_PROFILE_SCOPE = "https://www.googleapis.com/auth/userinfo.profile" as const;
export const V2_BETA_SCOPES = [...PUBLIC_CLASSROOM_SCOPES, V2_DRIVE_SCOPE] as const;
export const V2_UNIFIED_SCOPES = [...V2_BETA_SCOPES, "openid", "email"] as const;
export const V2_TEACHER_ROSTER_SCOPE = "https://www.googleapis.com/auth/classroom.rosters.readonly" as const;
export const V2_TEACHER_SUBMISSIONS_SCOPE = "https://www.googleapis.com/auth/classroom.coursework.students.readonly" as const;
export const V2_TEACHER_SCOPES = [...V2_UNIFIED_SCOPES, V2_TEACHER_ROSTER_SCOPE, V2_TEACHER_SUBMISSIONS_SCOPE] as const;
export const V2_TEACHER_REQUIRED_SCOPES = [V2_TEACHER_ROSTER_SCOPE, V2_TEACHER_SUBMISSIONS_SCOPE] as const;
/** Google labels this scope as managing both coursework and grades. Classroom Desk uses it only for teacher-owned draft coursework metadata; grade and submission write tools remain absent. */
export const V2_TEACHER_COURSEWORK_WRITE_SCOPE = "https://www.googleapis.com/auth/classroom.coursework.students" as const;
export const V2_TEACHER_WRITE_SCOPES = [...V2_TEACHER_SCOPES, V2_TEACHER_COURSEWORK_WRITE_SCOPE] as const;

// Google may return its canonical StudentSubmission scope instead of the
// equivalent coursework.me scope, and may expand the `email` alias to the
// userinfo.email URI. Accept only those exact least-privilege equivalents.
const V2_CANONICAL_UNIFIED_GRANTS = [PUBLIC_CLASSROOM_SCOPES, GOOGLE_CANONICAL_CLASSROOM_SCOPES].flatMap(
  classroomScopes => ["email", GOOGLE_USERINFO_EMAIL_SCOPE].map(
    emailScope => [...classroomScopes, V2_DRIVE_SCOPE, "openid", emailScope],
  ),
);
const V2_CANONICAL_TEACHER_GRANTS = [PUBLIC_CLASSROOM_SCOPES, GOOGLE_CANONICAL_CLASSROOM_SCOPES].flatMap(
  classroomScopes => ["email", GOOGLE_USERINFO_EMAIL_SCOPE].map(
    emailScope => [...classroomScopes, V2_DRIVE_SCOPE, "openid", emailScope, V2_TEACHER_ROSTER_SCOPE, V2_TEACHER_SUBMISSIONS_SCOPE],
  ),
);
const V2_CANONICAL_TEACHER_WRITE_GRANTS = [PUBLIC_CLASSROOM_SCOPES, GOOGLE_CANONICAL_CLASSROOM_SCOPES].flatMap(
  classroomScopes => ["email", GOOGLE_USERINFO_EMAIL_SCOPE].map(
    emailScope => [...classroomScopes, V2_DRIVE_SCOPE, "openid", emailScope, V2_TEACHER_ROSTER_SCOPE, V2_TEACHER_SUBMISSIONS_SCOPE, V2_TEACHER_COURSEWORK_WRITE_SCOPE],
  ),
);

// Google can include this previously granted scope in its token response even
// though Classroom Desk does not request or use it. Tolerate it only as the
// single extra scope alongside one of the exact supported complete grants.
const V2_KNOWN_AUTHORIZATION_GRANTS = [
  V2_UNIFIED_SCOPES,
  ...V2_CANONICAL_UNIFIED_GRANTS,
  V2_TEACHER_SCOPES,
  ...V2_CANONICAL_TEACHER_GRANTS,
  V2_TEACHER_WRITE_SCOPES,
  ...V2_CANONICAL_TEACHER_WRITE_GRANTS,
];
const V2_KNOWN_AUTHORIZATION_GRANTS_WITH_PROFILE = V2_KNOWN_AUTHORIZATION_GRANTS.map(
  (grant) => [...grant, GOOGLE_USERINFO_PROFILE_SCOPE],
);

function exactSet(scopes: readonly string[], expected: readonly string[]): boolean {
  const actual = new Set(scopes);
  return actual.size === scopes.length && actual.size === expected.length && expected.every(scope => actual.has(scope));
}

/** New MCP OAuth consent must include the stable OIDC subject scopes. */
export function isExactV2UnifiedGrant(scopes: readonly string[]): boolean {
  return exactSet(scopes, V2_UNIFIED_SCOPES)
    || V2_CANONICAL_UNIFIED_GRANTS.some((grant) => exactSet(scopes, grant));
}

/** Teacher read access is an explicit incremental grant, separate from the student default. */
export function isExactV2TeacherGrant(scopes: readonly string[]): boolean {
  return exactSet(scopes, V2_TEACHER_SCOPES)
    || V2_CANONICAL_TEACHER_GRANTS.some((grant) => exactSet(scopes, grant));
}

/** Explicitly consented teacher coursework-management grant. Never infer it from dashboard preference or read-only teacher scopes. */
export function isExactV2TeacherWriteGrant(scopes: readonly string[]): boolean {
  return exactSet(scopes, V2_TEACHER_WRITE_SCOPES)
    || V2_CANONICAL_TEACHER_WRITE_GRANTS.some((grant) => exactSet(scopes, grant));
}

/**
 * Valid Google authorization responses for the unified flow. A reconnect may
 * return the baseline grant plus previously approved teacher scopes when
 * incremental authorization is enabled. Only exact, known grant shapes are
 * accepted; legacy grants without the required OIDC identity scopes remain
 * supported for stored-record compatibility, not as a new authorization.
 */
export function isValidV2AuthorizationGrant(scopes: readonly string[]): boolean {
  return isExactV2UnifiedGrant(scopes)
    || isExactV2TeacherGrant(scopes)
    || isExactV2TeacherWriteGrant(scopes)
    || V2_KNOWN_AUTHORIZATION_GRANTS_WITH_PROFILE.some((grant) => exactSet(scopes, grant));
}

/** Existing encrypted Google grants remain usable while new consent is upgraded. */
export function isSupportedV2StoredGrant(scopes: readonly string[]): boolean {
  return exactSet(scopes, V2_UNIFIED_SCOPES)
    || V2_CANONICAL_UNIFIED_GRANTS.some((grant) => exactSet(scopes, grant))
    || exactSet(scopes, V2_BETA_SCOPES)
    || exactSet(scopes, [...GOOGLE_CANONICAL_CLASSROOM_SCOPES, V2_DRIVE_SCOPE])
    || isExactV2TeacherGrant(scopes)
    || isExactV2TeacherWriteGrant(scopes)
    || V2_KNOWN_AUTHORIZATION_GRANTS_WITH_PROFILE.some((grant) => exactSet(scopes, grant));
}
