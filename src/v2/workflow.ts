import type { drive_v3 } from "@googleapis/drive";
import type { classroom_v1 } from "@googleapis/classroom";
import { downloadPdf, type V2File } from "./files.js";
import type { AttachmentAuthorizationStore, DurableAttachmentAuthorizationStore } from "./attachments.js";
import type { GoogleDriveAttachmentReader } from "./attachment-content.js";

export type V2AuditEvent = { subject: string; action: "save_assignment_pdf"; courseId: string; courseWorkId: string; driveFileId?: string; outcome: "success" | "failure"; code?: string; timestamp: string };
export type V2Clients = {
  classroom: classroom_v1.Classroom;
  drive: drive_v3.Drive;
  /** Maximum number of Classroom API pages read per collection. */
  publicPageLimit?: number;
  /** Drive client backed by the explicit Picker grant, when one has been established. */
  driveForUpload?: (context: AssignmentContext) => Promise<drive_v3.Drive | undefined>;
  uploadPdf?: (context: AssignmentContext, name: string, bytes: Uint8Array) => Promise<{ id?: string | null; name?: string | null; mimeType?: string | null; webViewLink?: string | null }>;
  subject: string;
  downloadOptions?: Parameters<typeof downloadPdf>[1];
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
  if (status === 401 || status === 403) return { code: "authorization", message: "Google authorization is missing, expired, or does not include the required beta permission." };
  if (status && status >= 500) return { code: "google_unavailable", message: "Google Classroom or Drive is temporarily unavailable." };
  return { code: "google_error", message: "The requested Classroom operation could not be completed." };
}

export async function saveAssignmentPdf(clients: V2Clients, input: { courseId: string; courseWorkId: string; confirmUpload: boolean; file: V2File }): Promise<Record<string, unknown>> {
  if (input.confirmUpload !== true) throw new V2WorkflowError("confirmation_required", "The PDF was not uploaded because the student did not explicitly ask to save it to Drive.");
  const context = await getAssignmentContext(clients, input.courseId, input.courseWorkId);
  const downloaded = await downloadPdf(input.file, clients.downloadOptions);
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const name = downloaded.filename.replace(/\.pdf$/i, "") + `-Classroom-Desk-${stamp}.pdf`;
  try {
    let file: { id?: string | null; name?: string | null; mimeType?: string | null; webViewLink?: string | null };
    if (clients.uploadPdf) file = await clients.uploadPdf(context, name, new Uint8Array(downloaded.buffer));
    else {
      const uploadDrive = clients.driveForUpload ? await clients.driveForUpload(context) : clients.drive;
      if (!uploadDrive) throw new V2WorkflowError("authorization", "The beta Drive authorization is missing. Select the teacher attachment through Google Picker first.");
      const result = await uploadDrive.files.create({ requestBody: { name, mimeType: "application/pdf" }, media: { mimeType: "application/pdf", body: new Uint8Array(downloaded.buffer) }, fields: "id,name,mimeType,size,webViewLink,createdTime" });
      file = result.data;
    }
    await clients.audit?.({ subject: clients.subject, action: "save_assignment_pdf", courseId: context.courseId, courseWorkId: context.courseWorkId, driveFileId: file.id ?? undefined, outcome: "success", timestamp: new Date().toISOString() });
    const safeName = file.name ?? name;
    const assignmentUrl = `https://classroom.google.com/c/${encodeURIComponent(context.courseId)}/a/${encodeURIComponent(context.courseWorkId)}/details`;
    return {
      status: "uploaded",
      fileState: "FILE_SAVED_TO_DRIVE",
      workflowState: "WAITING_FOR_STUDENT_SUBMISSION",
      assignment: { courseId: context.courseId, courseWorkId: context.courseWorkId, courseName: context.courseName, title: context.assignmentTitle, url: assignmentUrl },
      file: { id: file.id, name: safeName, mimeType: file.mimeType, webViewLink: file.webViewLink ?? null },
      message: `Your assignment is ready ✅\n\nI've saved the completed PDF to your Google Drive as ${safeName}.\n\nTo submit it:\n1. Open ${context.assignmentTitle}.\n2. Choose Add or create → Google Drive.\n3. Select ${safeName}.\n4. Click Turn in.\n\nOnce you've submitted it, I can check that Google Classroom shows it as turned in.`,
      manualInstructions: [`Open ${context.assignmentTitle} in Google Classroom.`, `Choose Add or create, select Google Drive, and choose ${safeName}.`, "Click Turn in, then ask Classroom Desk to verify the submission."],
      limitation: "Classroom Desk cannot attach a Drive file automatically to an ordinary assignment created by an unrelated teacher.",
    };
  } catch (error) { const safe = errorMessage(error); await clients.audit?.({ subject: clients.subject, action: "save_assignment_pdf", courseId: input.courseId, courseWorkId: input.courseWorkId, outcome: "failure", code: safe.code, timestamp: new Date().toISOString() }); throw new V2WorkflowError(safe.code, safe.message); }
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
