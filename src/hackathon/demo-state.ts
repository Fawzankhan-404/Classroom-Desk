import { createReport, submissions, validateTeacherMark, type AssessmentReport, type TeacherMark } from "./domain.js";

export interface StoredDemoMark {
  mark: TeacherMark;
  score: number | null;
  possible: number;
  flags: string[];
  approved: boolean;
}

export interface SyntheticDemoState {
  marks: Map<string, StoredDemoMark>;
}

export function createSyntheticDemoState(): SyntheticDemoState {
  return { marks: new Map() };
}

export function saveSyntheticDemoMark(state: SyntheticDemoState, mark: TeacherMark): StoredDemoMark {
  const submission = submissions.find((item) => item.id === mark.submissionId);
  if (!submission) throw new Error("UNKNOWN_SYNTHETIC_SUBMISSION");
  const checked = validateTeacherMark(mark);
  if (checked.flags.some((flag) => flag.startsWith("UNVERIFIED_EVIDENCE:"))) throw new Error("EVIDENCE_NOT_IN_RESPONSE");
  const value = { mark, score: submission.state === "SUBMITTED" ? checked.score : null, possible: checked.possible, flags: checked.flags, approved: false };
  state.marks.set(mark.submissionId, value);
  return value;
}

export function approveSyntheticDemoMark(state: SyntheticDemoState, submissionId: string): StoredDemoMark {
  const existing = state.marks.get(submissionId);
  if (!existing) throw new Error("SAVE_DRAFT_FIRST");
  if (existing.flags.length > 0) throw new Error("REVIEW_FLAGS_MUST_BE_RESOLVED");
  existing.approved = true;
  return existing;
}

export function syntheticDemoReport(state: SyntheticDemoState): AssessmentReport {
  const report = createReport();
  report.submissions = report.submissions.map((entry) => {
    const stored = state.marks.get(entry.submissionId);
    return stored ? {
      ...entry,
      score: entry.state === "SUBMITTED" ? stored.score : null,
      possiblePoints: stored.possible,
      criterionPoints: stored.mark.criterionPoints,
      selectedChoiceIds: stored.mark.selectedChoiceIds,
      optionalCriteriaIds: stored.mark.optionalCriteriaIds,
      evidence: stored.mark.evidence,
      reviewFlags: stored.flags,
      status: stored.approved ? "APPROVED_LOCAL" : "DRAFT",
    } : entry;
  });
  if (state.marks.size) report.assessmentSource = "TEACHER_ENTERED";
  return { ...report, approved: report.submissions.some((item) => item.status === "APPROVED_LOCAL"), gradebookWriteback: false };
}
