import type { classroom_v1 } from "@googleapis/classroom";
import { dueAt, listAnnouncements, listCourses, listCourseWork, listMaterials, listMySubmissions, listTopics } from "../classroom.js";
import { publicAttachmentMetadata, type PublicAttachmentMetadata } from "./attachments.js";
import type { V2Clients } from "./workflow.js";
import { V2WorkflowError } from "./workflow.js";

const MAX_TEXT = 4_000;
const DEFAULT_LIMIT = 50;

const cleanText = (value: unknown, max = MAX_TEXT): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined;
const normalized = (value: unknown): string =>
  typeof value === "string" ? value.normalize("NFKC").toLocaleLowerCase().trim() : "";
const contains = (value: unknown, query: string): boolean => normalized(value).includes(normalized(query));

export type StudentView = "all" | "due_soon" | "today" | "tomorrow" | "missing" | "assigned" | "submitted" | "returned" | "reclaimed" | "recent";
export type AssignmentSelector = { courseId?: string; courseQuery?: string; courseWorkId?: string; assignmentQuery?: string };
export type ResolvedAssignment = { course: classroom_v1.Schema$Course; coursework: classroom_v1.Schema$CourseWork };

export type AttachmentMetadata = PublicAttachmentMetadata;
export const attachmentMetadata = publicAttachmentMetadata;

function submissionState(submission: classroom_v1.Schema$StudentSubmission | undefined): string {
  return submission?.state ?? "ASSIGNED";
}

function assignmentFlags(work: classroom_v1.Schema$CourseWork, submission: classroom_v1.Schema$StudentSubmission | undefined, now: Date, submissionStatusAvailable = true) {
  const state = submissionStatusAvailable ? submissionState(submission) : "UNKNOWN";
  const due = dueAt(work);
  const dueMs = due ? Date.parse(due) : Number.NaN;
  const submitted = state === "TURNED_IN" || state === "RETURNED";
  return {
    state,
    dueAt: due,
    late: submission?.late === true,
    missing: submissionStatusAvailable && Number.isFinite(dueMs) && dueMs < now.getTime() && !submitted,
    submitted,
    returned: state === "RETURNED",
    reclaimed: state === "RECLAIMED" || state === "RECLAIMED_BY_STUDENT",
  };
}

function assignmentSummary(course: classroom_v1.Schema$Course, work: classroom_v1.Schema$CourseWork, submission: classroom_v1.Schema$StudentSubmission | undefined, now: Date, submissionStatusAvailable = true) {
  const flags = assignmentFlags(work, submission, now, submissionStatusAvailable);
  return {
    courseId: course.id,
    courseName: cleanText(course.name, 300) ?? "Unnamed course",
    courseWorkId: work.id,
    title: cleanText(work.title, 500) ?? "Untitled assignment",
    ...(cleanText(work.description) ? { instructions: cleanText(work.description) } : {}),
    dueAt: flags.dueAt,
    submissionState: flags.state,
    late: flags.late,
    missing: flags.missing,
    updatedAt: work.updateTime ?? null,
    assignmentUrl: work.id && course.id ? `https://classroom.google.com/c/${encodeURIComponent(course.id)}/a/${encodeURIComponent(work.id)}/details` : null,
    attachments: attachmentMetadata(work.materials),
  };
}

function matchesWindow(view: StudentView, due: string | null, flags: ReturnType<typeof assignmentFlags>, now: Date, days: number): boolean {
  if (["all", "recent"].includes(view)) return true;
  if (view === "missing") return flags.missing;
  if (view === "assigned") return !flags.submitted && !flags.returned && !flags.reclaimed;
  if (view === "submitted") return flags.state === "TURNED_IN";
  if (view === "returned") return flags.returned;
  if (view === "reclaimed") return flags.reclaimed;
  if (!due) return false;
  const dueMs = Date.parse(due);
  const start = new Date(now); start.setUTCHours(0, 0, 0, 0);
  const end = new Date(start);
  if (view === "today") end.setUTCDate(end.getUTCDate() + 1);
  else if (view === "tomorrow") { start.setUTCDate(start.getUTCDate() + 1); end.setUTCDate(end.getUTCDate() + 2); }
  else end.setUTCDate(end.getUTCDate() + Math.max(1, days));
  return dueMs >= start.getTime() && dueMs < end.getTime();
}

function queryMatches(item: { title?: unknown; description?: unknown }, courseName: unknown, query?: string): boolean {
  if (!query?.trim()) return true;
  return contains(item.title, query) || contains(item.description, query) || contains(courseName, query);
}

export async function getStudentOverview(clients: V2Clients, input: { courseQuery?: string; searchQuery?: string; view?: StudentView; days?: number; limit?: number; courseLimit?: number }, options: { now?: Date } = {}) {
  const now = options.now ?? new Date();
  const view = input.view ?? "all";
  const limit = Math.min(Math.max(input.limit ?? DEFAULT_LIMIT, 1), 100);
  const courseLimit = Math.min(Math.max(input.courseLimit ?? 25, 1), 25);
  const days = Math.min(Math.max(input.days ?? 7, 1), 31);
  const allCourses = await listCourses(clients);
  const selectedCourses = input.courseQuery?.trim()
    ? allCourses.filter((course) => course.id === input.courseQuery || contains(course.name, input.courseQuery!))
    : allCourses;
  if (input.courseQuery && selectedCourses.length === 0) throw new V2WorkflowError("course_not_found", "No accessible course matched that name.");
  const shownCourses = selectedCourses.slice(0, courseLimit);

  const bundles = await Promise.all(shownCourses.map(async (course) => {
    if (!course.id) return { course, coursework: [], submissions: [], announcements: [], materials: [], topics: [], partial: true, submissionStatusAvailable: false };
    // A Classroom account can be both a teacher and a student. Google may
    // reject one student-only collection (for example submissions on a
    // teacher-owned course) while allowing the rest. Keep the overview
    // useful by isolating each bounded read instead of failing the entire
    // request on one inaccessible collection.
    const settled = await Promise.allSettled([
      listCourseWork(clients, course.id), listMySubmissions(clients, course.id), listAnnouncements(clients, course.id), listMaterials(clients, course.id), listTopics(clients, course.id),
    ]);
    const value = <T>(index: number): T[] => settled[index]?.status === "fulfilled" ? settled[index].value as T[] : [];
    const coursework = value<classroom_v1.Schema$CourseWork>(0);
    const submissions = value<classroom_v1.Schema$StudentSubmission>(1);
    const announcements = value<classroom_v1.Schema$Announcement>(2);
    const materials = value<classroom_v1.Schema$CourseWorkMaterial>(3);
    const topics = value<classroom_v1.Schema$Topic>(4);
    return { course, coursework, submissions, announcements, materials, topics, partial: settled.some((result) => result.status === "rejected"), submissionStatusAvailable: settled[1]?.status === "fulfilled" };
  }));

  const assignments = bundles.flatMap(({ course, coursework, submissions, submissionStatusAvailable }) => {
    const byWork = new Map(submissions.map((submission) => [submission.courseWorkId, submission]));
    return coursework.filter((work) => work.workType === "ASSIGNMENT" || !work.workType).filter((work) => queryMatches(work, course.name, input.searchQuery)).filter((work) => {
      if (!submissionStatusAvailable && ["missing", "assigned", "submitted", "returned", "reclaimed"].includes(view)) return false;
      const flags = assignmentFlags(work, byWork.get(work.id ?? ""), now, submissionStatusAvailable);
      return matchesWindow(view, dueAt(work), flags, now, days);
    }).map((work) => assignmentSummary(course, work, byWork.get(work.id ?? ""), now, submissionStatusAvailable));
  }).sort((a, b) => {
    if (a.dueAt && b.dueAt) return a.dueAt.localeCompare(b.dueAt);
    if (a.dueAt) return -1;
    if (b.dueAt) return 1;
    return String(b.updatedAt).localeCompare(String(a.updatedAt));
  }).slice(0, limit);

  const announcements = bundles.flatMap(({ course, announcements: items }) => items.filter((item) => queryMatches({ description: item.text }, course.name, input.searchQuery)).map((item) => ({ courseId: course.id, courseName: cleanText(course.name, 300), announcementId: item.id, text: cleanText(item.text), updatedAt: item.updateTime ?? item.creationTime ?? null, attachments: attachmentMetadata(item.materials) }))).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, limit);
  const courseMaterials = bundles.flatMap(({ course, materials }) => materials.filter((item) => queryMatches(item, course.name, input.searchQuery)).map((item) => ({ courseId: course.id, courseName: cleanText(course.name, 300), materialId: item.id, title: cleanText(item.title, 500), description: cleanText(item.description), updatedAt: item.updateTime ?? item.creationTime ?? null, attachments: attachmentMetadata(item.materials) }))).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, limit);
  const topics = bundles.flatMap(({ course, topics }) => topics.filter((topic) => !input.searchQuery || contains(topic.name, input.searchQuery) || contains(course.name, input.searchQuery)).map((topic) => ({ courseId: course.id, courseName: cleanText(course.name, 300), topicId: topic.topicId, name: cleanText(topic.name, 300) }))).slice(0, limit);
  const recentActivity = [
    ...assignments.map((item) => ({ type: "assignment", courseName: item.courseName, title: item.title, updatedAt: item.updatedAt })),
    ...announcements.map((item) => ({ type: "announcement", courseName: item.courseName, title: item.text?.slice(0, 180), updatedAt: item.updatedAt })),
    ...courseMaterials.map((item) => ({ type: "course_material", courseName: item.courseName, title: item.title, updatedAt: item.updatedAt })),
  ].filter((item) => item.updatedAt).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, limit);

  return {
    view,
    generatedAt: now.toISOString(),
    partialData: bundles.some((bundle) => bundle.partial),
    summary: {
      courses: selectedCourses.length,
      coursesShown: shownCourses.length,
      coursesTruncated: selectedCourses.length > shownCourses.length,
      submissionStatusAvailable: bundles.every((bundle) => bundle.submissionStatusAvailable),
      assignments: assignments.length,
      missing: assignments.filter((item) => item.missing).length,
      turnedIn: assignments.filter((item) => item.submissionState === "TURNED_IN").length,
      returned: assignments.filter((item) => item.submissionState === "RETURNED").length,
    },
    courses: shownCourses.slice(0, limit).map((course) => ({ id: course.id, name: cleanText(course.name, 300), section: cleanText(course.section, 300), state: course.courseState })),
    assignments,
    announcements,
    courseMaterials,
    topics,
    recentActivity,
  };
}

function ambiguityMessage(matches: ResolvedAssignment[]): string {
  return matches.slice(0, 5).map(({ course, coursework }) => `${course.name ?? "Unnamed course"}: ${coursework.title ?? "Untitled assignment"}`).join("; ");
}

export async function resolveStudentAssignment(clients: V2Clients, selector: AssignmentSelector): Promise<ResolvedAssignment> {
  const assignmentNeedle = selector.courseWorkId?.trim() || selector.assignmentQuery?.trim();
  if (!assignmentNeedle) throw new V2WorkflowError("assignment_required", "Describe the assignment or provide its coursework ID.");
  const courses = await listCourses(clients);
  let courseCandidates = courses;
  const courseNeedle = selector.courseId?.trim() || selector.courseQuery?.trim();
  if (courseNeedle) {
    const exact = courses.filter((course) => course.id === courseNeedle || normalized(course.name) === normalized(courseNeedle));
    courseCandidates = exact.length ? exact : courses.filter((course) => contains(course.name, courseNeedle));
    if (courseCandidates.length === 0) throw new V2WorkflowError("course_not_found", "No accessible course matched that description.");
    if (courseCandidates.length > 1 && !selector.courseWorkId) throw new V2WorkflowError("ambiguous_course", `Multiple courses matched. Be more specific: ${courseCandidates.slice(0, 5).map((course) => course.name).join(", ")}`);
  }
  const all = (await Promise.all(courseCandidates.slice(0, 25).map(async (course) => {
    if (!course.id) return { course, coursework: [] as classroom_v1.Schema$CourseWork[] };
    try { return { course, coursework: await listCourseWork(clients, course.id) }; }
    catch (error) {
      const response = (error as { response?: { status?: number; data?: { error?: { status?: string; reason?: string } } } }).response;
      clients.diagnostic?.({ operation: "classroom.courseWork.list", status: response?.status, reason: response?.data?.error?.status ?? response?.data?.error?.reason });
      throw error;
    }
  }))).flatMap(({ course, coursework }) => coursework.filter((work) => work.workType === "ASSIGNMENT" || !work.workType).map((work) => ({ course, coursework: work })));
  const idMatches = all.filter(({ coursework }) => coursework.id === assignmentNeedle);
  const exactTitle = all.filter(({ coursework }) => normalized(coursework.title) === normalized(assignmentNeedle));
  const matches = idMatches.length ? idMatches : exactTitle.length ? exactTitle : all.filter(({ coursework }) => contains(coursework.title, assignmentNeedle) || contains(coursework.description, assignmentNeedle));
  if (matches.length === 0) throw new V2WorkflowError("assignment_not_found", "No accessible assignment matched that description.");
  if (matches.length > 1) throw new V2WorkflowError("ambiguous_assignment", `Multiple assignments matched. Be more specific: ${ambiguityMessage(matches)}`);
  return matches[0]!;
}

export async function getAssignmentWorkspace(clients: V2Clients, selector: AssignmentSelector) {
  const resolved = await resolveStudentAssignment(clients, selector);
  const courseId = resolved.course.id;
  const courseWorkId = resolved.coursework.id;
  if (!courseId || !courseWorkId) throw new V2WorkflowError("invalid_context", "The resolved assignment is missing its Classroom identity.");
  const submissions = await listMySubmissions(clients, courseId, courseWorkId);
  // A newly published assignment can legitimately have no submission yet.
  // Resolve the workspace from Classroom coursework and report ASSIGNED until
  // the student's submission resource exists; do not make pre-submission
  // attachment assistance depend on a submission row.
  if (submissions.length > 1) throw new V2WorkflowError("ambiguous_submission", "More than one submission matched the connected student.");
  const submission = submissions[0];
  const flags = assignmentFlags(resolved.coursework, submission, new Date());
  return {
    assignment: assignmentSummary(resolved.course, resolved.coursework, submission, new Date()),
    submission: { state: flags.state, late: flags.late, missing: flags.missing, updatedAt: submission?.updateTime ?? null, assignedGrade: submission?.assignedGrade ?? null },
    attachmentPolicy: {
      metadataAvailable: true,
      arbitraryTeacherFileContentAvailable: false,
      reason: "Teacher-provided file content is available after you allow access to that exact file. Classroom Desk does not browse your Drive.",
    },
    nextStep: flags.state === "TURNED_IN" ? "Google Classroom shows this assignment as turned in." : flags.state === "RETURNED" ? "The teacher returned this assignment. Review the feedback in Classroom before resubmitting." : "Use ChatGPT to prepare the work. When the final PDF is ready, explicitly ask Classroom Desk to save it to Drive.",
  };
}
