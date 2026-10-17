import { describe, expect, it } from "vitest";
import { assessmentKey, createReport, possiblePoints, rubric, submissions, validateTeacherMark, type TeacherMark } from "./domain.js";

describe("synthetic teacher assessment domain", () => {
  it("keeps rubric requirements, choose-two group, optional item, and version explicit", () => {
    expect(rubric.version).toBe(1);
    expect(rubric.criteria.filter((item) => item.group === "required").map((item) => item.id)).toEqual(["claim", "evidence"]);
    expect(rubric.choose.count).toBe(2);
    expect(possiblePoints(rubric, ["reasoning", "counterclaim"])).toBe(20);
    expect(possiblePoints(rubric, ["reasoning", "counterclaim"], ["conventions"])).toBe(22);
  });

  it("returns an idempotent, unscored review draft and preserves missing/unreadable flags", () => {
    expect(assessmentKey("synthetic-argument-assignment")).toBe(assessmentKey("synthetic-argument-assignment"));
    const report = createReport();
    expect(report.assessmentSource).toBe("NONE");
    expect(report.submissions.every((item) => item.score === null)).toBe(true);
    expect(report.submissions.find((item) => item.state === "MISSING")?.reviewFlags).toContain("MISSING_WORK");
    expect(report.submissions.find((item) => item.state === "UNREADABLE")?.reviewFlags).toContain("UNREADABLE_RESPONSE");
    expect(report.approved).toBe(false);
  });

  it("enforces required scoring, choice count, point caps, optional policies, and exact evidence", () => {
    const good: TeacherMark = { submissionId: "syn-01", criterionPoints: { claim: 3, evidence: 5, reasoning: 4, counterclaim: 2 }, selectedChoiceIds: ["reasoning", "counterclaim"], optionalCriteriaIds: [], evidence: [{ criterionId: "claim", quote: "The school should add shade trees beside the west court." }, { criterionId: "evidence", quote: "The grounds report says the court reached 38°C at noon" }, { criterionId: "reasoning", quote: "This six-degree difference supports adding trees where students gather." }, { criterionId: "counterclaim", quote: "A tree plan also needs regular watering" }] };
    expect(validateTeacherMark(good)).toMatchObject({ score: 14, possible: 20, flags: [] });
    expect(() => validateTeacherMark({ ...good, selectedChoiceIds: ["reasoning"] })).toThrow(/Select exactly 2/);
    expect(() => validateTeacherMark({ ...good, criterionPoints: { ...good.criterionPoints, claim: 5 } })).toThrow(/between 0 and 4/);
    expect(() => validateTeacherMark({ ...good, criterionPoints: { ...good.criterionPoints, organization: 1 } })).toThrow(/Inactive or unknown/);
    expect(() => validateTeacherMark({ ...good, optionalCriteriaIds: ["other"] })).toThrow(/Unknown optional/);
    expect(validateTeacherMark({ ...good, evidence: [{ criterionId: "evidence", quote: "invented evidence" }] }).flags).toContain("UNVERIFIED_EVIDENCE:evidence");
  });

  it("never scores missing or unreadable responses", () => {
    const mark: TeacherMark = { submissionId: "syn-05", criterionPoints: {}, selectedChoiceIds: [], optionalCriteriaIds: [], evidence: [] };
    expect(validateTeacherMark(mark)).toMatchObject({ score: 0, possible: 0, flags: ["MISSING_WORK", "TEACHER_REVIEW_REQUIRED"] });
    expect(submissions.find((item) => item.id === "syn-06")?.response).toBeNull();
  });
});
