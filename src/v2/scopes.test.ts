import { describe, expect, it } from "vitest";
import { GOOGLE_CANONICAL_CLASSROOM_SCOPES, PUBLIC_CLASSROOM_SCOPES, TEACHER_CLASSROOM_SCOPES, hasTeacherClassroomScopes } from "../scopes.js";
import { V2_BETA_SCOPES, isExactV2GoogleGrant } from "./scopes.js";

describe("Classroom grant scope boundaries", () => {
  it("keeps existing student grants unchanged", () => {
    expect(isExactV2GoogleGrant([...V2_BETA_SCOPES])).toBe(true);
    expect(isExactV2GoogleGrant([...GOOGLE_CANONICAL_CLASSROOM_SCOPES, "https://www.googleapis.com/auth/drive.file"])).toBe(true);
    expect(PUBLIC_CLASSROOM_SCOPES).not.toContain(TEACHER_CLASSROOM_SCOPES[0]);
    expect(PUBLIC_CLASSROOM_SCOPES).not.toContain(TEACHER_CLASSROOM_SCOPES[1]);
  });

  it("accepts exactly the additive read-only teacher grant while requiring both teacher scopes", () => {
    expect(isExactV2GoogleGrant([...V2_BETA_SCOPES, ...TEACHER_CLASSROOM_SCOPES])).toBe(true);
    expect(hasTeacherClassroomScopes([...V2_BETA_SCOPES, ...TEACHER_CLASSROOM_SCOPES])).toBe(true);
    expect(hasTeacherClassroomScopes([...V2_BETA_SCOPES, TEACHER_CLASSROOM_SCOPES[0]])).toBe(false);
    expect(isExactV2GoogleGrant([...V2_BETA_SCOPES, ...TEACHER_CLASSROOM_SCOPES, "https://www.googleapis.com/auth/classroom.rosters"])).toBe(false);
  });

  it("rejects duplicate and write scopes in a teacher grant", () => {
    expect(isExactV2GoogleGrant([...V2_BETA_SCOPES, ...TEACHER_CLASSROOM_SCOPES, TEACHER_CLASSROOM_SCOPES[0]])).toBe(false);
    expect(isExactV2GoogleGrant([...V2_BETA_SCOPES, ...TEACHER_CLASSROOM_SCOPES, "https://www.googleapis.com/auth/classroom.coursework.students"])).toBe(false);
  });
});
