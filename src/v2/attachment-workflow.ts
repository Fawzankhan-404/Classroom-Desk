import { discoverAttachments, publicAttachmentMetadata, resolveAttachment, AttachmentAuthorizationError } from "./attachments.js";
import type { ReadableAttachmentContent } from "./attachment-content.js";
import { resolveStudentAssignment, type AssignmentSelector } from "./student.js";
import type { V2Clients } from "./workflow.js";
import { V2WorkflowError } from "./workflow.js";

function runtime(clients: V2Clients) {
  if (!clients.attachmentAccess) throw new V2WorkflowError("attachment_beta_unavailable", "Teacher attachment reading is not configured for this connection.");
  return clients.attachmentAccess;
}

function mapAuthorizationError(error: unknown): never {
  if (error instanceof AttachmentAuthorizationError) throw new V2WorkflowError(error.code, error.message);
  throw error;
}

export async function prepareTeacherAttachment(
  clients: V2Clients,
  selector: AssignmentSelector & { attachmentQuery?: string },
): Promise<Record<string, unknown>> {
  const resolved = await resolveStudentAssignment(clients, selector);
  const courseId = resolved.course.id;
  const courseWorkId = resolved.coursework.id;
  if (!courseId || !courseWorkId) throw new V2WorkflowError("invalid_context", "The resolved assignment is missing its Classroom identity.");
  const attachments = discoverAttachments(resolved.coursework.materials);
  const driveAttachments = attachments.filter((item) => item.kind === "drive_file");
  if (driveAttachments.length === 0) throw new V2WorkflowError("attachment_not_found", "This assignment has no Google Drive attachment available to select.");
  let attachment;
  if (selector.attachmentQuery?.trim()) {
    const match = resolveAttachment(driveAttachments, selector.attachmentQuery);
    if (match.status !== "resolved") {
      if (match.status === "not_found") throw new V2WorkflowError("attachment_not_found", "No attached Drive file matched that description.");
      throw new V2WorkflowError("ambiguous_attachment", `Multiple attachments matched. Choose one: ${match.candidates.join(", ")}`);
    }
    attachment = match.attachment;
  } else if (driveAttachments.length === 1) attachment = driveAttachments[0]!;
  else throw new V2WorkflowError("ambiguous_attachment", `This assignment has multiple Drive files. Choose one: ${driveAttachments.slice(0, 10).map((item) => item.title).join(", ")}`);

  const access = runtime(clients);
  try {
    const authorization = await access.authorizations.create({ subject: clients.subject, courseId, courseWorkId, attachment });
    return {
      state: "ATTACHMENT_AUTHORIZATION_REQUIRED",
      assignment: { courseName: resolved.course.name ?? "Unnamed course", title: resolved.coursework.title ?? "Untitled assignment" },
      attachment: publicAttachmentMetadata(resolved.coursework.materials).find((item) => item.kind === "drive_file" && item.title === attachment.title),
      authorization: { id: authorization.id, expiresAt: new Date(authorization.expiresAt).toISOString(), url: access.pickerUrl(authorization.id) },
      message: `I found ${attachment.title}. Google requires you to allow Classroom Desk to open this teacher-provided file. Open the link and select that exact file.`,
    };
  } catch (error) { return mapAuthorizationError(error); }
}

export async function readTeacherAttachment(clients: V2Clients, authorizationId: string): Promise<ReadableAttachmentContent & { assignmentTitle: string }> {
  const access = runtime(clients);
  let record;
  try { record = await access.authorizations.requireAuthorized(authorizationId, clients.subject); }
  catch (error) { return mapAuthorizationError(error); }

  const work = await clients.classroom.courses.courseWork.get({ courseId: record.courseId, id: record.courseWorkId });
  const current = discoverAttachments(work.data.materials).find((item) => item.kind === "drive_file" && item.driveFileId === record.attachment.driveFileId);
  if (!current) throw new V2WorkflowError("attachment_changed", "The selected file is no longer attached to this assignment.");
  const content = await access.reader.read(current);
  return { ...content, assignmentTitle: work.data.title ?? "Untitled assignment" };
}
