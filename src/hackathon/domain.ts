import { createHash } from "node:crypto";

export type RubricCriterion = { id: string; label: string; maxPoints: number; group: "required" | "choice" | "optional" };
export type Rubric = { id: string; version: number; title: string; choose: { group: "choice"; count: number }; criteria: RubricCriterion[]; maximumPoints: number };
export type SyntheticSubmission = { id: string; studentLabel: string; state: "SUBMITTED" | "MISSING" | "UNREADABLE"; response: string | null };

export const rubric: Rubric = {
  id: "argument-writing", version: 1, title: "Evidence-based argument", choose: { group: "choice", count: 2 },
  criteria: [
    { id: "claim", label: "Clear, focused claim", maxPoints: 4, group: "required" },
    { id: "evidence", label: "Relevant textual evidence", maxPoints: 6, group: "required" },
    { id: "reasoning", label: "Reasoning connects evidence to claim", maxPoints: 6, group: "choice" },
    { id: "counterclaim", label: "Acknowledges a counterclaim", maxPoints: 4, group: "choice" },
    { id: "organization", label: "Intentional organization", maxPoints: 4, group: "choice" },
    { id: "conventions", label: "Editing and conventions", maxPoints: 2, group: "optional" },
  ], maximumPoints: 22,
};

export const submissions: SyntheticSubmission[] = [
  { id: "syn-01", studentLabel: "Synthetic response 01", state: "SUBMITTED", response: "The school should add shade trees beside the west court. The grounds report says the court reached 38°C at noon, while the planted walkway measured 31°C. This six-degree difference supports adding trees where students gather. A tree plan also needs regular watering, so the school should assign a weekly check." },
  { id: "syn-02", studentLabel: "Synthetic response 02", state: "SUBMITTED", response: "Our library should stay open one hour later. In our survey, 18 of 25 students said they need a quiet place after activities. Some may say staff cannot stay late, but a rotating schedule could cover two evenings each week." },
  { id: "syn-03", studentLabel: "Synthetic response 03", state: "SUBMITTED", response: "The class garden deserves a second water barrel. The garden log shows that its first barrel was empty on four Fridays. A second barrel would hold more collected rainwater and make weekend watering easier." },
  { id: "syn-04", studentLabel: "Synthetic response 04", state: "SUBMITTED", response: "Students should be allowed to borrow calculators. The checkout sheet records 12 requests last month. A sign-out list can help keep track of them. The school can begin with ten calculators and review the checkout list in a month." },
  { id: "syn-05", studentLabel: "Synthetic response 05", state: "MISSING", response: null },
  { id: "syn-06", studentLabel: "Synthetic response 06", state: "UNREADABLE", response: null },
];

export type TeacherMark = { submissionId: string; criterionPoints: Record<string, number>; selectedChoiceIds: string[]; optionalCriteriaIds: string[]; evidence: Array<{ criterionId: string; quote: string }>; teacherNote?: string };
export type AssessmentProposal = Pick<TeacherMark, "submissionId" | "criterionPoints" | "selectedChoiceIds" | "optionalCriteriaIds" | "evidence">;
export type AssessmentReport = { id: string; idempotencyKey: string; assignment: string; rubricId: string; rubricVersion: number; assessmentSource: "MCP_PROPOSAL" | "TEACHER_ENTERED" | "NONE"; submissions: Array<{ submissionId: string; studentLabel: string; state: SyntheticSubmission["state"]; score: number | null; possiblePoints: number; criterionPoints: Record<string, number>; selectedChoiceIds: string[]; optionalCriteriaIds: string[]; evidence: TeacherMark["evidence"]; reviewFlags: string[]; status: "AWAITING_TEACHER_REVIEW" | "DRAFT" | "APPROVED_LOCAL" }>; approved: boolean; syntheticOnly: true; gradebookWriteback: false };

export function assessmentKey(assignmentId: string, rubricValue = rubric, rows = submissions): string {
  const source = JSON.stringify({ assignmentId, rubricId: rubricValue.id, version: rubricValue.version, choose: rubricValue.choose, criteria: rubricValue.criteria, submissions: rows.map((row) => ({ id: row.id, state: row.state, response: row.response })) });
  return createHash("sha256").update(source).digest("hex");
}

export function possiblePoints(rubricValue: Rubric, selectedChoiceIds: string[] = [], optionalCriteriaIds: string[] = []): number {
  const selected = new Set(selectedChoiceIds);
  const required = rubricValue.criteria.filter((item) => item.group === "required").reduce((sum, item) => sum + item.maxPoints, 0);
  const choices = rubricValue.criteria.filter((item) => item.group === "choice" && selected.has(item.id));
  const optionalIds = new Set(optionalCriteriaIds);
  const optional = rubricValue.criteria.filter((item) => item.group === "optional" && optionalIds.has(item.id)).reduce((sum, item) => sum + item.maxPoints, 0);
  return required + choices.reduce((sum, item) => sum + item.maxPoints, 0) + optional;
}

export function validateTeacherMark(mark: TeacherMark, rows = submissions, rubricValue = rubric): { score: number; possible: number; flags: string[] } {
  const row = rows.find((candidate) => candidate.id === mark.submissionId);
  if (!row) throw new Error("Unknown synthetic submission");
  const flags: string[] = [];
  if (row.state !== "SUBMITTED") return { score: 0, possible: 0, flags: [row.state === "MISSING" ? "MISSING_WORK" : "UNREADABLE_RESPONSE", "TEACHER_REVIEW_REQUIRED"] };
  const choiceIds = new Set(rubricValue.criteria.filter((item) => item.group === "choice").map((item) => item.id));
  if (mark.selectedChoiceIds.length !== rubricValue.choose.count || new Set(mark.selectedChoiceIds).size !== mark.selectedChoiceIds.length || mark.selectedChoiceIds.some((id) => !choiceIds.has(id))) {
    throw new Error(`Select exactly ${rubricValue.choose.count} distinct choice criteria`);
  }
  const optionalIds = new Set(rubricValue.criteria.filter((item) => item.group === "optional").map((item) => item.id));
  if (new Set(mark.optionalCriteriaIds).size !== mark.optionalCriteriaIds.length || mark.optionalCriteriaIds.some((id) => !optionalIds.has(id))) throw new Error("Unknown optional rubric criterion");
  const active = rubricValue.criteria.filter((item) => item.group === "required" || (item.group === "choice" && mark.selectedChoiceIds.includes(item.id)) || (item.group === "optional" && mark.optionalCriteriaIds.includes(item.id)));
  for (const key of Object.keys(mark.criterionPoints)) if (!active.some((item) => item.id === key)) throw new Error(`Inactive or unknown criterion: ${key}`);
  for (const item of mark.evidence) if (!active.some((criterion) => criterion.id === item.criterionId)) throw new Error(`Inactive or unknown evidence criterion: ${item.criterionId}`);
  let score = 0;
  for (const item of active) {
    const points = mark.criterionPoints[item.id] ?? 0;
    if (!Number.isFinite(points) || points < 0 || points > item.maxPoints) throw new Error(`Points for ${item.id} must be between 0 and ${item.maxPoints}`);
    score += points;
  }
  for (const item of active) {
    const itemEvidence = mark.evidence.filter((evidence) => evidence.criterionId === item.id);
    for (const evidence of itemEvidence) if (!evidence.quote.trim() || !row.response!.includes(evidence.quote)) flags.push(`UNVERIFIED_EVIDENCE:${item.id}`);
    if ((mark.criterionPoints[item.id] ?? 0) > 0 && itemEvidence.length === 0) flags.push(`EVIDENCE_REVIEW:${item.id}`);
  }
  if (score > possiblePoints(rubricValue, mark.selectedChoiceIds, mark.optionalCriteriaIds)) throw new Error("Score exceeds the selected rubric maximum");
  if (flags.length) flags.push("TEACHER_REVIEW_REQUIRED");
  return { score, possible: possiblePoints(rubricValue, mark.selectedChoiceIds, mark.optionalCriteriaIds), flags: [...new Set(flags)] };
}

export function createReport(): AssessmentReport {
  const idempotencyKey = assessmentKey("synthetic-argument-assignment");
  return {
    id: `assessment-${idempotencyKey.slice(0, 12)}`, idempotencyKey, assignment: "Synthetic Argument Writing", rubricId: rubric.id,
    rubricVersion: rubric.version, assessmentSource: "NONE",
    submissions: submissions.map((row) => ({ submissionId: row.id, studentLabel: row.studentLabel, state: row.state, score: null, possiblePoints: row.state === "SUBMITTED" ? rubric.maximumPoints : 0, criterionPoints: {}, selectedChoiceIds: [], optionalCriteriaIds: [], evidence: [], reviewFlags: [row.state === "MISSING" ? "MISSING_WORK" : row.state === "UNREADABLE" ? "UNREADABLE_RESPONSE" : "AWAITING_ASSESSMENT", "TEACHER_REVIEW_REQUIRED"], status: "AWAITING_TEACHER_REVIEW" })),
    approved: false, syntheticOnly: true, gradebookWriteback: false,
  };
}

export function validateAssessmentProposals(idempotencyKey: string, proposals: AssessmentProposal[], rows = submissions, rubricValue = rubric): AssessmentReport {
  const expectedKey = assessmentKey("synthetic-argument-assignment", rubricValue, rows);
  if (idempotencyKey !== expectedKey) throw new Error("ASSESSMENT_KEY_MISMATCH: reload the synthetic assessment packet");
  const requiredRows = rows.filter((row) => row.state === "SUBMITTED");
  if (proposals.length !== requiredRows.length) throw new Error(`PROPOSAL_COUNT_MISMATCH: expected ${requiredRows.length} submitted responses`);
  const byId = new Map<string, AssessmentProposal>();
  for (const proposal of proposals) {
    if (byId.has(proposal.submissionId)) throw new Error("DUPLICATE_SUBMISSION_PROPOSAL");
    if (!requiredRows.some((row) => row.id === proposal.submissionId)) throw new Error("UNKNOWN_OR_NON_SUBMITTED_RESPONSE");
    byId.set(proposal.submissionId, proposal);
  }
  if (requiredRows.some((row) => !byId.has(row.id))) throw new Error("MISSING_SUBMISSION_PROPOSAL");
  for (const proposal of proposals) {
    const activeIds = rubricValue.criteria.filter((item) => item.group === "required" || (item.group === "choice" && proposal.selectedChoiceIds.includes(item.id)) || (item.group === "optional" && proposal.optionalCriteriaIds.includes(item.id))).map((item) => item.id).sort();
    if (Object.keys(proposal.criterionPoints).sort().join(",") !== activeIds.join(",")) throw new Error(`CRITERION_SET_MISMATCH: ${proposal.submissionId}`);
    for (const criterionId of activeIds) if (!proposal.evidence.some((item) => item.criterionId === criterionId)) throw new Error(`EVIDENCE_REQUIRED: ${proposal.submissionId}:${criterionId}`);
  }
  const report = createReport();
  report.assessmentSource = "MCP_PROPOSAL";
  report.submissions = report.submissions.map((entry) => {
    const proposal = byId.get(entry.submissionId);
    if (!proposal) return entry;
    const checked = validateTeacherMark({ ...proposal, submissionId: entry.submissionId }, rows, rubricValue);
    if (checked.flags.some((flag) => flag.startsWith("UNVERIFIED_EVIDENCE:") || flag.startsWith("EVIDENCE_REVIEW:"))) throw new Error(`EVIDENCE_VALIDATION_FAILED: ${entry.submissionId}`);
    return {
      ...entry, score: checked.score, possiblePoints: checked.possible, criterionPoints: proposal.criterionPoints,
      selectedChoiceIds: proposal.selectedChoiceIds, optionalCriteriaIds: proposal.optionalCriteriaIds, evidence: proposal.evidence,
      reviewFlags: ["CHATGPT_PROPOSAL_REQUIRES_TEACHER_REVIEW"], status: "DRAFT",
    };
  });
  return report;
}
