import type { drive_v3 } from "@googleapis/drive";
import type { classroom_v1 } from "@googleapis/classroom";
import { downloadPdf, type V2File, V2FileError } from "./files.js";
import type { AttachmentAuthorizationStore, DurableAttachmentAuthorizationStore } from "./attachments.js";
import type { GoogleDriveAttachmentReader } from "./attachment-content.js";

export type V2AuditEvent = { subject: string; action: "save_assignment_pdf"; courseId: string; courseWorkId: string; driveFileId?: string; outcome: "success" | "failure"; code?: string; timestamp: string };
export type V2Clients = {
  classroom: classroom_v1.Classroom;
  drive: drive_v3.Drive;
  /** Legacy injection retained for compatibility; the active generated-file tool is disabled. */
  driveForUpload?: (context: AssignmentContext) => Promise<drive_v3.Drive | undefined>;
  /** Legacy injection retained for compatibility; no current tool invokes it. */
  uploadPdf?: (context: AssignmentContext, name: string, bytes: Uint8Array) => Promise<{ id?: string | null; name?: string | null; mimeType?: string | null; webViewLink?: string | null }>;
  subject: string;
  /** Exact scopes on the currently stored Google grant; used to gate teacher reads. */
  grantedScopes?: readonly string[];
  /** Teacher tools require both the teacher plan entitlement and Google roles. */
  teacherEntitled?: boolean;
  audit?: (event: V2AuditEvent) => void | Promise<void>;
  diagnostic?: (event: { operation: string; status?: number; reason?: string }) => void;
  attachmentAccess?: {
    authorizations: AttachmentAuthorizationStore | DurableAttachmentAuthorizationStore;
    reader: GoogleDriveAttachmentReader;
    pickerUrl: (authorizationId: string) => string;
  };
};
export type AssignmentContext = { courseId: string; courseWorkId: string; courseName: string; assignmentTitle: string; associatedWithDeveloper: boolean; submission: classroom_v1.Schema$StudentSubmission };

export class V2WorkflowError extends Error { constructor(public readonly code: string, message: string) { super(message); } }

export function isGoogleReauthorizationFailure(error: unknown): boolean {
  const value = error as { response?: { status?: unknown; data?: { error?: unknown } }; code?: unknown; message?: unknown } | null;
  if (value?.response?.status === 401 || value?.code === "authorization" || value?.code === "invalid_grant" || value?.response?.data?.error === "invalid_grant") return true;
  return typeof value?.message === "string" && /\binvalid_grant\b/.test(value.message);
}

export function classifyGoogleReadFailure(error: unknown): "reauthorization_required" | "permission_denied" | "unavailable" {
  const value = error as { response?: { status?: unknown }; code?: unknown } | null;
  if (isGoogleReauthorizationFailure(error)) return "reauthorization_required";
  if (value?.response?.status === 403 || value?.code === "teacher_course_forbidden") return "permission_denied";
  return "unavailable";
}

export async function getAssignmentContext(clients: V2Clients, courseId: string, courseWorkId: string): Promise<AssignmentContext> {
  if (!courseId || !courseWorkId) throw new V2WorkflowError("invalid_context", "A course ID and coursework ID are required.");
  const [courseResult, workResult] = await Promise.all([
    clients.classroom.courses.get({ id: courseId }),
    clients.classroom.courses.courseWork.get({ courseId, id: courseWorkId }),
  ]);
  const course = courseResult.data; const work = workResult.data;
  if (work.courseId && work.courseId !== courseId) throw new V2WorkflowError("invalid_context", "The coursework does not belong to the requested course.");
  if (work.workType && work.workType !== "ASSIGNMENT") throw new V2WorkflowError("unsupported_work", "This operation supports ordinary Classroom assignments only.");
  const submissionResult = await clients.classroom.courses.courseWork.studentSubmissions.list({ courseId, courseWorkId, userId: "me", pageSize: 100 });
  const submission = (submissionResult.data.studentSubmissions ?? [])[0];
  if (!submission) throw new V2WorkflowError("missing_submission", "No submission is available for this assignment and student.");
  return { courseId, courseWorkId, courseName: course.name || course.id || courseId, assignmentTitle: work.title || work.id || courseWorkId, associatedWithDeveloper: work.associatedWithDeveloper === true, submission };
}

function errorMessage(error: unknown): { code: string; message: string } {
  if (error instanceof V2WorkflowError) return { code: error.code, message: error.message };
  const status = (error as { response?: { status?: number } })?.response?.status;
  if (isGoogleReauthorizationFailure(error) || status === 403) return { code: "authorization", message: "Google authorization is missing, expired, or does not include the required beta permission." };
  if (status && status >= 500) return { code: "google_unavailable", message: "Google Classroom or Drive is temporarily unavailable." };
  return { code: "google_error", message: "The requested Classroom operation could not be completed." };
}

export async function saveAssignmentPdf(clients: V2Clients, input: { courseId: string; courseWorkId: string; confirmUpload: boolean; file: V2File }): Promise<Record<string, unknown>> {
  if (input.confirmUpload !== true) throw new V2WorkflowError("confirmation_required", "The PDF was not uploaded because the student did not explicitly ask to save it to Drive.");
  try {
    await downloadPdf(input.file);
  } catch (error) {
    const safe = error instanceof V2FileError
      ? { code: error.code, message: error.message }
      : errorMessage(error);
    await clients.audit?.({ subject: clients.subject, action: "save_assignment_pdf", courseId: input.courseId, courseWorkId: input.courseWorkId, outcome: "failure", code: safe.code, timestamp: new Date().toISOString() });
    throw new V2WorkflowError(safe.code, safe.message);
  }
  throw new V2WorkflowError("external_file_transfer_unavailable", "Generated PDF transfer is disabled because this Worker cannot safely pin arbitrary external download URLs.");
}

export async function verifySubmission(clients: V2Clients, courseId: string, courseWorkId: string): Promise<Record<string, unknown>> {
  try {
    const context = await getAssignmentContext(clients, courseId, courseWorkId);
    const s = context.submission;
    const state = s.state ?? "UNKNOWN";
    const workflowState = state === "TURNED_IN" ? "TURNED_IN" : state === "RETURNED" ? "RETURNED" : state === "RECLAIMED" || state === "RECLAIMED_BY_STUDENT" ? "RECLAIMED" : "WAITING_FOR_STUDENT_SUBMISSION";
    const message = state === "TURNED_IN" ? `Google Classroom shows ${context.assignmentTitle} as TURNED_IN ✅` : state === "RETURNED" ? `Google Classroom shows ${context.assignmentTitle} as RETURNED. Review your teacher's feedback in Classroom.` : workflowState === "RECLAIMED" ? `Google Classroom shows ${context.assignmentTitle} as RECLAIMED. You can attach the final file and turn it in again.` : `Google Classroom does not show ${context.assignmentTitle} as turned in yet. It is currently ${state.toLowerCase().replaceAll("_", " ")}.`;
    return { workflowState, message, assignment: { courseId, courseWorkId, courseName: context.courseName, title: context.assignmentTitle }, submission: { id: s.id ?? null, state, updateTime: s.updateTime ?? null } };
  }
  catch (error) { const safe = errorMessage(error); throw new V2WorkflowError(safe.code, safe.message); }
}
