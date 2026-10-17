export const PUBLIC_CLASSROOM_SCOPES = [
  "https://www.googleapis.com/auth/classroom.courses.readonly",
  "https://www.googleapis.com/auth/classroom.announcements.readonly",
  "https://www.googleapis.com/auth/classroom.coursework.me.readonly",
  "https://www.googleapis.com/auth/classroom.courseworkmaterials.readonly",
  "https://www.googleapis.com/auth/classroom.topics.readonly",
  "https://www.googleapis.com/auth/classroom.student-submissions.me.readonly",
] as const;

// Google can return the student-submissions scope as the canonical grant for
// both student coursework scope strings. A live read-only courseWork.list call
// confirmed this exact five-scope grant can read coursework (HTTP 200).
export const GOOGLE_CANONICAL_CLASSROOM_SCOPES = PUBLIC_CLASSROOM_SCOPES.filter(
  (scope) => scope !== "https://www.googleapis.com/auth/classroom.coursework.me.readonly",
);

/** Requested only after a user explicitly asks to connect live teacher data. */
export const TEACHER_CLASSROOM_SCOPES = [
  "https://www.googleapis.com/auth/classroom.rosters.readonly",
  "https://www.googleapis.com/auth/classroom.coursework.students.readonly",
] as const;

export function hasTeacherClassroomScopes(scopes: readonly string[]): boolean {
  const granted = new Set(scopes);
  return TEACHER_CLASSROOM_SCOPES.every((scope) => granted.has(scope));
}

/** Exact read-only grant variants accepted when a user incrementally enables teacher data. */
export function isExactPublicTeacherGoogleGrant(scopes: readonly string[]): boolean {
  const granted = new Set(scopes);
  if (granted.size !== scopes.length) return false;
  return [PUBLIC_CLASSROOM_SCOPES, GOOGLE_CANONICAL_CLASSROOM_SCOPES].some((base) => {
    const allowed = [...base, ...TEACHER_CLASSROOM_SCOPES];
    return granted.size === allowed.length && allowed.every((scope) => granted.has(scope));
  });
}

export function isExactPublicGoogleGrant(scopes: readonly string[]): boolean {
  const granted = new Set(scopes);
  if (granted.size !== scopes.length) return false;
  return [PUBLIC_CLASSROOM_SCOPES, GOOGLE_CANONICAL_CLASSROOM_SCOPES].some(
    (allowed) => granted.size === allowed.length && allowed.every((scope) => granted.has(scope)),
  );
}
