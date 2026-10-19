import type { classroom_v1 } from "@googleapis/classroom";
import { listCoursesPage, type ClassroomClients } from "../classroom.js";
import type { V2Clients } from "./workflow.js";
import { V2_TEACHER_COURSEWORK_WRITE_SCOPE, V2_TEACHER_REQUIRED_SCOPES } from "./scopes.js";
import { isGoogleReauthorizationFailure, V2WorkflowError } from "./workflow.js";

const PAGE_SIZE = 100;
const MAX_COURSES = 25;
const MAX_ITEMS = 100;
const MAX_PAGES = 5;
const MAX_SUBMISSION_ATTACHMENT_METADATA = 10;
const MAX_ATTACHMENT_TITLE_LENGTH = 160;

type BoundedPageResult<T> = { items: T[]; moreAvailable: boolean; pagesComplete: boolean };

type SubmissionAttachmentKind = "drive_file" | "link" | "youtube_video" | "form" | "unknown";

function publicSubmissionAttachmentMetadata(attachments: classroom_v1.Schema$Attachment[] | undefined) {
  if (!Array.isArray(attachments)) return null;
  const items = attachments;
  return {
    count: items.length,
    items: items.slice(0, MAX_SUBMISSION_ATTACHMENT_METADATA).map((attachment) => {
      let kind: SubmissionAttachmentKind = "unknown";
      let title: string | null | undefined;
      if (attachment.driveFile) { kind = "drive_file"; title = attachment.driveFile.title; }
      else if (attachment.link) { kind = "link"; title = attachment.link.title; }
      else if (attachment.youTubeVideo) { kind = "youtube_video"; title = attachment.youTubeVideo.title; }
      else if (attachment.form) { kind = "form"; title = attachment.form.title; }
      const safeTitle = typeof title === "string"
        ? title.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, MAX_ATTACHMENT_TITLE_LENGTH) || null
        : null;
      return { kind, title: safeTitle };
    }),
    truncated: items.length > MAX_SUBMISSION_ATTACHMENT_METADATA,
  };
}

async function boundedPages<T>(fetchPage: (pageToken?: string) => Promise<{ items: T[]; nextPageToken?: string | null; complete?: boolean }>): Promise<BoundedPageResult<T>> {
  const items: T[] = [];
  let pageToken: string | undefined;
  let pagesComplete = true;
  for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber++) {
    const page = await fetchPage(pageToken);
    items.push(...page.items);
    pagesComplete = pagesComplete && page.complete !== false;
    pageToken = page.nextPageToken ?? undefined;
    if (items.length > MAX_ITEMS) return { items: items.slice(0, MAX_ITEMS), moreAvailable: true, pagesComplete: false };
    if (!pageToken) return { items, moreAvailable: false, pagesComplete };
    if (items.length === MAX_ITEMS) return { items, moreAvailable: true, pagesComplete: false };
  }
  return { items: items.slice(0, MAX_ITEMS), moreAvailable: Boolean(pageToken) || items.length > MAX_ITEMS, pagesComplete: false };
}

export type TeacherCourseworkDraftInput = {
  title?: string;
  description?: string;
  dueDate?: { year: number; month: number; day: number };
  dueTime?: { hours: number; minutes: number };
  maxPoints?: number;
};

function validateCourseworkFields(input: TeacherCourseworkDraftInput, requireTitle: boolean): Partial<classroom_v1.Schema$CourseWork> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new V2WorkflowError("invalid_coursework_draft", "Coursework draft fields are invalid.");
  const allowed = new Set(["title", "description", "dueDate", "dueTime", "maxPoints"]);
  if (Object.keys(input).some((key) => !allowed.has(key))) throw new V2WorkflowError("invalid_coursework_draft", "Only title, description, due date, due time, and maximum points can be changed.");
  const result: Partial<classroom_v1.Schema$CourseWork> = {};
  if (input.title !== undefined) {
    if (typeof input.title !== "string" || input.title.trim().length < 1 || input.title.trim().length > 300) throw new V2WorkflowError("invalid_coursework_draft", "The title must contain 1 to 300 characters.");
    result.title = input.title.trim();
  } else if (requireTitle) throw new V2WorkflowError("invalid_coursework_draft", "A title is required for a new draft.");
  if (input.description !== undefined) {
    if (typeof input.description !== "string" || input.description.length > 5000) throw new V2WorkflowError("invalid_coursework_draft", "The description must be 5000 characters or fewer.");
    result.description = input.description;
  }
  if (input.dueDate !== undefined) {
    if (!input.dueDate || typeof input.dueDate !== "object" || Array.isArray(input.dueDate)) throw new V2WorkflowError("invalid_coursework_draft", "The due date is invalid.");
    const { year, month, day } = input.dueDate;
    const date = new Date(Date.UTC(year, month - 1, day));
    if (![year, month, day].every(Number.isInteger) || year < 2000 || year > 2100 || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) throw new V2WorkflowError("invalid_coursework_draft", "The due date is invalid.");
    result.dueDate = { year, month, day };
  }
  if (input.dueTime !== undefined) {
    if (!input.dueTime || typeof input.dueTime !== "object" || Array.isArray(input.dueTime)) throw new V2WorkflowError("invalid_coursework_draft", "The due time is invalid.");
    const { hours, minutes } = input.dueTime;
    if (!Number.isInteger(hours) || hours < 0 || hours > 23 || !Number.isInteger(minutes) || minutes < 0 || minutes > 59) throw new V2WorkflowError("invalid_coursework_draft", "The due time is invalid.");
    result.dueTime = { hours, minutes };
  }
  if (input.maxPoints !== undefined) {
    if (!Number.isInteger(input.maxPoints) || input.maxPoints < 0 || input.maxPoints > 10_000) throw new V2WorkflowError("invalid_coursework_draft", "Maximum points must be a whole number from 0 to 10000.");
    result.maxPoints = input.maxPoints;
  }
  if (Object.keys(result).length === 0) throw new V2WorkflowError("invalid_coursework_draft", "Provide at least one supported coursework field to change.");
  return result;
}

function requireTeacherScopes(clients: V2Clients): void {
  if (clients.teacherEntitled !== true) throw new V2WorkflowError("teacher_entitlement_required", "Teacher features require an active Teacher entitlement.");
  const scopes = new Set(clients.grantedScopes ?? []);
  if (!V2_TEACHER_REQUIRED_SCOPES.every((scope) => scopes.has(scope))) {
    throw new V2WorkflowError("teacher_authorization_required", "Teacher read access has not been granted. Sign in to Classroom Desk and explicitly authorize Teacher access first.");
  }
}

function requireTeacherWriteScopes(clients: V2Clients): void {
  requireTeacherScopes(clients);
  if (!new Set(clients.grantedScopes ?? []).has(V2_TEACHER_COURSEWORK_WRITE_SCOPE)) {
    throw new V2WorkflowError("teacher_coursework_write_authorization_required", "This draft action needs separate Google coursework-management permission. Classroom Desk does not publish coursework or write grades.");
  }
}

function courseworkFieldMatches(expected: Partial<classroom_v1.Schema$CourseWork>, actual: classroom_v1.Schema$CourseWork): boolean {
  if (expected.title !== undefined && actual.title !== expected.title) return false;
  if (expected.description !== undefined && actual.description !== expected.description) return false;
  if (expected.maxPoints !== undefined && actual.maxPoints !== expected.maxPoints) return false;
  if (expected.dueDate !== undefined && (actual.dueDate?.year !== expected.dueDate.year || actual.dueDate?.month !== expected.dueDate.month || actual.dueDate?.day !== expected.dueDate.day)) return false;
  if (expected.dueTime !== undefined && (actual.dueTime?.hours !== expected.dueTime.hours || actual.dueTime?.minutes !== expected.dueTime.minutes)) return false;
  return true;
}

function apiStatus(error: unknown): number | undefined {
  const status = (error as { response?: { status?: number } })?.response?.status;
  return typeof status === "number" ? status : undefined;
}

function throwTeacherReadError(error: unknown, forbiddenMessage: string, unavailableMessage: string): never {
  if (error instanceof V2WorkflowError) throw error;
  const status = apiStatus(error);
  if (isGoogleReauthorizationFailure(error)) throw new V2WorkflowError("authorization", "Reconnect Google Classroom and try again.");
  if (status === 403 || status === 404) throw new V2WorkflowError("teacher_course_forbidden", forbiddenMessage);
  throw new V2WorkflowError("google_unavailable", unavailableMessage);
}

/** An authenticated course listing alone does not establish teacher status. Verify every course on the returned page with Google. */
export async function listVerifiedTeacherCourses(clients: V2Clients, pageToken?: string): Promise<{ courses: classroom_v1.Schema$Course[]; nextPageToken?: string }> {
  requireTeacherScopes(clients);
  let page: Awaited<ReturnType<typeof listCoursesPage>>;
  try {
    page = await listCoursesPage(clients as ClassroomClients, false, pageToken, MAX_COURSES);
  } catch (error) {
    throwTeacherReadError(error, "Google did not authorize teacher course access.", "Teacher courses could not be loaded from Google Classroom.");
  }
  const result: classroom_v1.Schema$Course[] = [];
  for (const course of page.courses) {
    if (!course.id) continue;
    try {
      await clients.classroom.courses.teachers.get({ courseId: course.id, userId: "me" });
      result.push(course);
    } catch (error) {
      const status = apiStatus(error);
    if (isGoogleReauthorizationFailure(error)) throw new V2WorkflowError("authorization", "Reconnect Google Classroom and try again.");
      if (status === 403 || status === 404) continue;
      throw new V2WorkflowError("google_unavailable", "Google Classroom could not verify teacher access right now.");
    }
  }
  return { courses: result, nextPageToken: page.nextPageToken };
}

export async function getTeacherOverview(clients: V2Clients, pageToken?: string) {
  const page = await listVerifiedTeacherCourses(clients, pageToken);
  const result = [];
  for (const course of page.courses) {
    if (!course.id) continue;
    const optionalRead = async <T>(request: Promise<T>): Promise<T | null> => {
      try { return await request; }
      catch (error) {
        if (error instanceof V2WorkflowError && error.code === "authorization") throw error;
        return null;
      }
    };
    const [roster, coursework] = await Promise.all([
      optionalRead(getTeacherRoster(clients, course.id)),
      optionalRead(getTeacherCoursework(clients, course.id)),
    ]);
    result.push({
      id: course.id,
      name: course.name ?? null,
      section: course.section ?? null,
      studentCount: roster === null || !roster.complete ? null : roster.students.length,
      studentCountMoreAvailable: roster?.moreAvailable ?? false,
      courseworkCount: coursework === null ? null : coursework.coursework.length,
      courseworkCountMoreAvailable: coursework?.moreAvailable ?? false,
    });
  }
  return { courses: result, nextCoursePageToken: page.nextPageToken };
}

export async function getTeacherCourseDetail(clients: V2Clients, courseId: string) {
  await requireTeacherCourse(clients, courseId);
  const [courseResult, roster, coursework] = await Promise.all([
    clients.classroom.courses.get({ id: courseId }),
    getTeacherRoster(clients, courseId),
    getTeacherCoursework(clients, courseId),
  ]);
  return {
    course: { id: courseId, name: courseResult.data.name ?? null, section: courseResult.data.section ?? null },
    students: roster.students,
    studentsMoreAvailable: roster.moreAvailable,
    studentsComplete: roster.complete,
    coursework: coursework.coursework,
    courseworkMoreAvailable: coursework.moreAvailable,
  };
}

async function requireTeacherCourse(clients: V2Clients, courseId: string): Promise<void> {
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(courseId)) throw new V2WorkflowError("invalid_course", "A valid course ID is required.");
  requireTeacherScopes(clients);
  try {
    await clients.classroom.courses.teachers.get({ courseId, userId: "me" });
  } catch (error) {
    const status = apiStatus(error);
    if (isGoogleReauthorizationFailure(error)) throw new V2WorkflowError("authorization", "Reconnect Google Classroom and try again.");
    if (status === 403 || status === 404) throw new V2WorkflowError("teacher_course_forbidden", "This Google account is not an authorized teacher for that course.");
    throw new V2WorkflowError("google_unavailable", "Google Classroom could not verify teacher access right now.");
  }
}

export async function getTeacherCoursework(clients: V2Clients, courseId: string) {
  await requireTeacherCourse(clients, courseId);
  try {
    const result = await boundedPages(async (pageToken) => {
      const response = await clients.classroom.courses.courseWork.list({ courseId, pageSize: PAGE_SIZE, pageToken, courseWorkStates: ["PUBLISHED"], orderBy: "updateTime desc" });
      return { items: response.data.courseWork ?? [], nextPageToken: response.data.nextPageToken };
    });
    return { coursework: result.items.map((work) => ({
      id: work.id ?? null,
      courseId,
      title: work.title ?? null,
      description: work.description ?? null,
      state: work.state ?? null,
      dueDate: work.dueDate ?? null,
      dueTime: work.dueTime ?? null,
      maxPoints: typeof work.maxPoints === "number" ? work.maxPoints : null,
      workType: work.workType ?? null,
      updateTime: work.updateTime ?? null,
    })), moreAvailable: result.moreAvailable };
  } catch (error) {
    throwTeacherReadError(error, "Google did not authorize coursework access for this course.", "Coursework could not be loaded from Google Classroom.");
  }
}

/** List unpublished assignment drafts only after the account has explicitly granted coursework-management permission. */
export async function getTeacherCourseworkDrafts(clients: V2Clients, courseId: string) {
  requireTeacherWriteScopes(clients);
  await requireTeacherCourse(clients, courseId);
  try {
    const result = await boundedPages(async (pageToken) => {
      const response = await clients.classroom.courses.courseWork.list({ courseId, pageSize: PAGE_SIZE, pageToken, courseWorkStates: ["DRAFT"], orderBy: "updateTime desc" });
      return { items: response.data.courseWork ?? [], nextPageToken: response.data.nextPageToken };
    });
    return { drafts: result.items.filter((work) => work.state === "DRAFT" && work.workType === "ASSIGNMENT" && Boolean(work.id)).map((work) => ({
      id: work.id!,
      title: work.title ?? null,
      description: work.description ?? null,
      dueDate: work.dueDate ?? null,
      dueTime: work.dueTime ?? null,
      maxPoints: typeof work.maxPoints === "number" ? work.maxPoints : null,
      updateTime: work.updateTime ?? null,
      state: "DRAFT" as const,
    })), moreAvailable: result.moreAvailable };
  } catch (error) {
    if (error instanceof V2WorkflowError) throw error;
    const status = apiStatus(error);
    if (isGoogleReauthorizationFailure(error)) throw new V2WorkflowError("authorization", "Reconnect Google Classroom and try again.");
    if (status === 403 || status === 404) throw new V2WorkflowError("teacher_course_forbidden", "Google did not authorize draft coursework access for that course.");
    throw new V2WorkflowError("google_unavailable", "Coursework drafts could not be loaded from Google Classroom.");
  }
}

/** Create only unpublished assignment drafts. The request body cannot set grades, submissions, assignees, materials, or publish state. */
export async function createTeacherCourseworkDraft(clients: V2Clients, courseId: string, input: TeacherCourseworkDraftInput, confirmation: string) {
  if (confirmation !== "CREATE_UNPUBLISHED_DRAFT") throw new V2WorkflowError("confirmation_required", "No draft was created. Confirm that you want an unpublished assignment draft in this Google Classroom course.");
  const fields = validateCourseworkFields(input, true);
  requireTeacherWriteScopes(clients);
  await requireTeacherCourse(clients, courseId);
  try {
    const response = await clients.classroom.courses.courseWork.create({ courseId, requestBody: { ...fields, state: "DRAFT", workType: "ASSIGNMENT" } });
    const created = response.data;
    if (!created.id) throw new V2WorkflowError("teacher_coursework_write_unverified", "Google did not return the new draft identity. Check Classroom before retrying.");
    const verified = created.state === "DRAFT" && created.associatedWithDeveloper === true
      ? created
      : (await clients.classroom.courses.courseWork.get({ courseId, id: created.id })).data;
    if (verified.courseId !== courseId || verified.state !== "DRAFT" || verified.workType !== "ASSIGNMENT" || verified.associatedWithDeveloper !== true) throw new V2WorkflowError("teacher_coursework_write_unverified", "Google did not confirm an unpublished assignment draft associated with Classroom Desk. Check Classroom before retrying.");
    return { status: "draft_created", courseId, courseWorkId: verified.id, title: verified.title ?? fields.title ?? null, state: "DRAFT" as const, gradebookWritebackEnabled: false as const };
  } catch (error) {
    if (error instanceof V2WorkflowError) throw error;
    const status = apiStatus(error);
    if (isGoogleReauthorizationFailure(error)) throw new V2WorkflowError("authorization", "Reconnect Google Classroom and try again.");
    if (status === 403 || status === 404) throw new V2WorkflowError("teacher_course_forbidden", "Google did not authorize draft creation in that course.");
    throw new V2WorkflowError("google_unavailable", "Google Classroom did not confirm the draft creation. Check Classroom before retrying.");
  }
}

/** Update selected fields on an unpublished assignment draft after a fresh version check and explicit confirmation. */
export async function updateTeacherCourseworkDraft(
  clients: V2Clients,
  courseId: string,
  courseWorkId: string,
  expectedUpdateTime: string,
  input: TeacherCourseworkDraftInput,
  confirmation: string,
) {
  if (confirmation !== "UPDATE_UNPUBLISHED_DRAFT") throw new V2WorkflowError("confirmation_required", "No draft was changed. Confirm the exact unpublished assignment draft update.");
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(courseWorkId)) throw new V2WorkflowError("invalid_coursework", "A valid coursework ID is required.");
  if (typeof expectedUpdateTime !== "string" || expectedUpdateTime.length < 10 || expectedUpdateTime.length > 64) throw new V2WorkflowError("invalid_coursework_draft", "Reload the draft and provide its current update time before editing.");
  const fields = validateCourseworkFields(input, false);
  requireTeacherWriteScopes(clients);
  await requireTeacherCourse(clients, courseId);

  try {
    const current = (await clients.classroom.courses.courseWork.get({ courseId, id: courseWorkId })).data;
    if (current.id !== courseWorkId || current.courseId !== courseId || current.workType !== "ASSIGNMENT") {
      throw new V2WorkflowError("invalid_coursework", "That assignment does not belong to the authorized course.");
    }
    if (current.state !== "DRAFT") throw new V2WorkflowError("teacher_coursework_not_draft", "Only unpublished assignment drafts can be edited with this tool.");
    // Google requires the Developer Console project that created a coursework item
    // to perform PATCH. Its read-only associatedWithDeveloper field is the server-side
    // provenance check; missing/false must fail closed before any write request.
    if (current.associatedWithDeveloper !== true) throw new V2WorkflowError("teacher_coursework_not_associated", "Only unpublished drafts associated with this Classroom Desk Google project can be edited.");
    if (!current.updateTime || current.updateTime !== expectedUpdateTime) throw new V2WorkflowError("teacher_coursework_changed", "This draft changed after it was reviewed. Reload it and confirm the update again.");

    // The updateTime check above is the latest read before patching, not an atomic precondition.
    // A concurrent edit to the same field can still race; updateMask preserves unrelated fields.
    await clients.classroom.courses.courseWork.patch({
      courseId,
      id: courseWorkId,
      updateMask: Object.keys(fields).join(","),
      requestBody: fields,
    });
    const verified = (await clients.classroom.courses.courseWork.get({ courseId, id: courseWorkId })).data;
    if (verified.id !== courseWorkId || verified.courseId !== courseId || verified.workType !== "ASSIGNMENT" || verified.state !== "DRAFT" || !courseworkFieldMatches(fields, verified)) {
      throw new V2WorkflowError("teacher_coursework_write_unverified", "Google did not confirm the draft update. Check Classroom before retrying.");
    }
    return {
      status: "draft_updated" as const,
      courseId,
      courseWorkId,
      title: verified.title ?? null,
      updateTime: verified.updateTime ?? null,
      updatedFields: Object.keys(fields),
      state: "DRAFT" as const,
      gradebookWritebackEnabled: false as const,
    };
  } catch (error) {
    if (error instanceof V2WorkflowError) throw error;
    const status = apiStatus(error);
    if (isGoogleReauthorizationFailure(error)) throw new V2WorkflowError("authorization", "Reconnect Google Classroom and try again.");
    if (status === 403 || status === 404) throw new V2WorkflowError("teacher_course_forbidden", "Google did not authorize draft editing in that course.");
    throw new V2WorkflowError("google_unavailable", "Google Classroom could not confirm the draft update. Check Classroom before retrying.");
  }
}

export async function getTeacherRoster(clients: V2Clients, courseId: string) {
  await requireTeacherCourse(clients, courseId);
  try {
    const result = await boundedPages(async (pageToken) => {
      const response = await clients.classroom.courses.students.list({ courseId, pageSize: PAGE_SIZE, pageToken });
      return { items: response.data.students ?? [], nextPageToken: response.data.nextPageToken, complete: Array.isArray(response.data.students) };
    });
    return { students: result.items.map((student) => ({
      userId: student.userId ?? null,
      fullName: student.profile?.name?.fullName ?? null,
      photoUrl: student.profile?.photoUrl ?? null,
    })), moreAvailable: result.moreAvailable, complete: result.pagesComplete };
  } catch (error) {
    throwTeacherReadError(error, "Google did not authorize roster access for this course.", "The authorized course roster could not be loaded.");
  }
}

export async function getTeacherSubmissions(clients: V2Clients, courseId: string, courseWorkId: string) {
  await requireTeacherCourse(clients, courseId);
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(courseWorkId)) throw new V2WorkflowError("invalid_coursework", "A valid coursework ID is required.");
  try {
    const [workResult, students, submissions] = await Promise.all([
      clients.classroom.courses.courseWork.get({ courseId, id: courseWorkId }),
      boundedPages(async (pageToken) => {
        const response = await clients.classroom.courses.students.list({ courseId, pageSize: PAGE_SIZE, pageToken });
        return { items: response.data.students ?? [], nextPageToken: response.data.nextPageToken, complete: Array.isArray(response.data.students) };
      }),
      boundedPages(async (pageToken) => {
        const response = await clients.classroom.courses.courseWork.studentSubmissions.list({ courseId, courseWorkId, pageSize: PAGE_SIZE, pageToken });
        const studentSubmissions = response.data.studentSubmissions;
        return {
          items: Array.isArray(studentSubmissions) ? studentSubmissions : [],
          nextPageToken: response.data.nextPageToken,
          complete: Array.isArray(studentSubmissions),
        };
      }),
    ]);
    const work = workResult.data;
    if (work.courseId && work.courseId !== courseId) throw new V2WorkflowError("invalid_coursework", "That coursework does not belong to the authorized course.");
    if (work.workType && work.workType !== "ASSIGNMENT") throw new V2WorkflowError("unsupported_coursework", "This view supports assignment submissions only.");
    const names = new Map(students.items.map((student) => [student.userId ?? "", student.profile?.name?.fullName ?? null]));
    return {
      courseId,
      courseWorkId,
      title: work.title ?? null,
      maxPoints: typeof work.maxPoints === "number" ? work.maxPoints : null,
      gradebookWritebackEnabled: false as const,
      submissionContentIncluded: false as const,
      submissions: submissions.items.map((submission) => ({
        studentName: names.get(submission.userId ?? "") ?? null,
        state: submission.state ?? "UNKNOWN",
        // Keep the boolean for existing consumers; lateStatus distinguishes an unknown value from NOT_LATE.
        late: submission.late === true,
        lateStatus: submission.late === true ? ("LATE" as const) : submission.late === false ? ("NOT_LATE" as const) : ("UNKNOWN" as const),
        assignedGrade: typeof submission.assignedGrade === "number" ? submission.assignedGrade : null,
        gradeStatus: typeof submission.assignedGrade === "number" ? ("GRADED" as const) : ("UNKNOWN" as const),
        updateTime: submission.updateTime ?? null,
        hasAttachments: Array.isArray(submission.assignmentSubmission?.attachments) ? submission.assignmentSubmission.attachments.length > 0 : null,
        attachmentMetadata: publicSubmissionAttachmentMetadata(submission.assignmentSubmission?.attachments),
      })),
      moreAvailable: submissions.moreAvailable,
      submissionPagesComplete: submissions.pagesComplete,
      studentRosterMoreAvailable: students.moreAvailable,
      studentRosterPagesComplete: students.pagesComplete,
    };
  } catch (error) {
    if (error instanceof V2WorkflowError) throw error;
    const status = apiStatus(error);
    if (isGoogleReauthorizationFailure(error)) throw new V2WorkflowError("authorization", "Reconnect Google Classroom and try again.");
    if (status === 403 || status === 404) throw new V2WorkflowError("teacher_course_forbidden", "Google did not authorize access to those submissions.");
    throw new V2WorkflowError("google_unavailable", "Submissions could not be loaded from Google Classroom.");
  }
}
