import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { V2Clients } from "./workflow.js";
import { saveAssignmentPdf, verifySubmission, V2WorkflowError } from "./workflow.js";
import { getAssignmentWorkspace, getStudentOverview, resolveStudentAssignment } from "./student.js";
import { prepareTeacherAttachment, readTeacherAttachment } from "./attachment-workflow.js";
import { createServer } from "../server.js";

const fileSchema = z.object({ download_url: z.string().url().describe("Temporary HTTPS URL for the generated PDF."), file_id: z.string().min(1).describe("OpenAI file identifier for the generated artifact."), mime_type: z.string().optional().describe("Generated file MIME type; must be application/pdf."), file_name: z.string().optional().describe("Suggested PDF filename.") });
const v2Auth = { securitySchemes: [{ type: "oauth2", scopes: ["mcp:tools"] }] };
const actionAnnotations = { readOnlyHint: false, destructiveHint: false, openWorldHint: true } as const;
const readAnnotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: true } as const;
const assignmentSelectorSchema = {
  courseId: z.string().min(1).optional().describe("Optional exact course ID from a previous result."),
  courseQuery: z.string().min(1).optional().describe("Natural course name or distinguishing text, such as Java or Operating Systems."),
  courseWorkId: z.string().min(1).optional().describe("Optional exact coursework ID from a previous result."),
  assignmentQuery: z.string().min(1).optional().describe("Natural assignment title, keyword, or distinguishing instructions text."),
};

function friendlyError(code: string, fallback: string): string {
  const messages: Record<string, string> = {
    course_not_found: "I couldn't find a Classroom course matching that. Try the course name again.",
    ambiguous_course: "I found more than one matching course. Tell me which course you mean.",
    assignment_required: "Tell me the assignment name or describe it so I can find it.",
    assignment_not_found: "I couldn't find that assignment. Try its title or course name.",
    ambiguous_assignment: "I found more than one matching assignment. Tell me the course or the full title.",
    attachment_not_found: "I couldn't find a teacher attachment on that assignment.",
    ambiguous_attachment: "I found more than one teacher attachment. Tell me which filename you want to open.",
    attachment_declined: "The file was not opened. You can try the authorization link again when you're ready.",
    attachment_expired: "That file authorization expired. Ask me to open the teacher attachment again.",
    attachment_read_failed: "I couldn't open that teacher file. Check the authorization and try again.",
    ambiguous_submission: "I found more than one submission for that assignment, so I stopped without guessing.",
    confirmation_required: "I haven't uploaded anything. Ask me to save the final PDF to Drive when you're ready.",
    invalid_file: "That file isn't a readable PDF. Please provide the final PDF again.",
    file_too_large: "That PDF is too large to process. Please provide a smaller PDF.",
    authorization: "Your Google Classroom connection needs attention. Reconnect and try again.",
    google_unavailable: "Google Classroom is temporarily unavailable. Please try again shortly.",
  };
  return messages[code] ?? fallback;
}

function errorResult(error: unknown, fallbackCode: string, fallbackMessage: string) {
  const e = error instanceof V2WorkflowError ? error : new V2WorkflowError(fallbackCode, fallbackMessage);
  return { isError: true as const, content: [{ type: "text" as const, text: JSON.stringify({ error: e.code, message: friendlyError(e.code, e.message) }) }] };
}

type AccountStatus = { state: string; message: string; activationUrl: string; billingUrl: string; settingsUrl: string; plan: string | null; expiresAt: string | null };
type McpIdentity = { name?: string; version?: string; accountStatus?: (mcpUserId: string) => Promise<AccountStatus> };

export function createV2BetaServer(clients: V2Clients, identity: McpIdentity = {}): McpServer {
  const server = new McpServer({ name: identity.name ?? "classroom-desk-v2-beta", version: identity.version ?? "2.0.0-beta.1" });
  if (identity.accountStatus) {
    server.registerTool("check_account_activation", { description: "Check the authenticated Classroom Desk account activation state. This returns only account and entitlement guidance, never Classroom content.", inputSchema: {}, _meta: v2Auth, annotations: readAnnotations }, async () => ({ content: [{ type: "text", text: JSON.stringify(await identity.accountStatus!(clients.subject)) }] }));
    server.registerTool("get_activation_guidance", { description: "Return the authenticated account's safe activation, plan, billing, and Google reconnection links. This does not grant access or expose private Classroom data.", inputSchema: {}, _meta: v2Auth, annotations: readAnnotations }, async () => { const status = await identity.accountStatus!(clients.subject); return { content: [{ type: "text", text: JSON.stringify({ state: status.state, message: status.message, activationUrl: status.activationUrl, billingUrl: status.billingUrl, settingsUrl: status.settingsUrl }) }] }; });
  }
  server.registerTool("student_classroom_overview", { description: "Answer student questions across accessible Classroom data without requiring Google IDs. Use for assignments, due dates, missing/assigned/turned-in/returned work, announcements, course materials, topics, recent activity, catch-up summaries, and keyword searches.", inputSchema: { courseQuery: z.string().min(1).optional().describe("Optional natural course name or keyword."), searchQuery: z.string().min(1).optional().describe("Optional keyword to search across course names, assignment titles/instructions, announcements, materials, and topics."), view: z.enum(["all", "due_soon", "today", "tomorrow", "missing", "assigned", "submitted", "returned", "reclaimed", "recent"]).default("all").describe("Student-centered filter for the requested view."), days: z.number().int().min(1).max(31).default(7).describe("Window in days for due_soon; ignored by other views."), limit: z.number().int().min(1).max(100).default(50).describe("Maximum results per returned category.") }, _meta: v2Auth, annotations: readAnnotations }, async (input) => {
    try { return { content: [{ type: "text", text: JSON.stringify(await getStudentOverview(clients, input)) }] }; }
    catch (error) { return errorResult(error, "overview_failed", "Classroom Desk could not build the student overview."); }
  });
  server.registerTool("get_assignment_workspace", { description: "Resolve an assignment from its course/title or IDs, then return student-friendly instructions, due information, attachment metadata, current submission state, and the supported next step. Use before helping with one assignment or when the student asks what is attached.", inputSchema: assignmentSelectorSchema, _meta: v2Auth, annotations: readAnnotations }, async (selector) => {
    try { return { content: [{ type: "text", text: JSON.stringify(await getAssignmentWorkspace(clients, selector)) }] }; }
    catch (error) { return errorResult(error, "workspace_failed", "Classroom Desk could not resolve that assignment."); }
  });
  server.registerTool("prepare_teacher_attachment", { description: "Resolve a teacher-attached Drive file by natural course, assignment, and filename. If content access is needed, return a short-lived Google Picker authorization link bound to that exact Classroom attachment and connected student. This tool does not read the file.", inputSchema: { ...assignmentSelectorSchema, attachmentQuery: z.string().min(1).optional().describe("Natural filename or distinguishing text. Omit only when the assignment has one Drive attachment.") }, _meta: v2Auth, annotations: readAnnotations }, async (selector) => {
    try { return { content: [{ type: "text", text: JSON.stringify(await prepareTeacherAttachment(clients, selector)) }] }; }
    catch (error) { return errorResult(error, "attachment_prepare_failed", "Classroom Desk could not prepare that attachment."); }
  });
  server.registerTool("read_teacher_attachment", { description: "Read one teacher attachment only after the connected student explicitly selected the exact Classroom-linked file through Google Picker. Accepts an opaque authorization ID, never a Drive file ID. Returns bounded extracted text or an image for ChatGPT reasoning.", inputSchema: { authorizationId: z.string().min(20).max(200).describe("Opaque authorization ID returned by prepare_teacher_attachment after the student completes Google Picker.") }, _meta: v2Auth, annotations: readAnnotations }, async ({ authorizationId }) => {
    try {
      const result = await readTeacherAttachment(clients, authorizationId);
      if (result.kind === "image") return { content: [{ type: "text", text: JSON.stringify({ fileName: result.fileName, sourceMimeType: result.sourceMimeType, assignmentTitle: result.assignmentTitle, message: "The explicitly authorized image is available for analysis." }) }, { type: "image", data: Buffer.from(result.bytes).toString("base64"), mimeType: result.extractedMimeType }] };
      return { content: [{ type: "text", text: JSON.stringify({ fileName: result.fileName, sourceMimeType: result.sourceMimeType, assignmentTitle: result.assignmentTitle, text: result.text, truncated: result.truncated }) }] };
    } catch (error) { return errorResult(error, "attachment_read_failed", "Classroom Desk could not read that attachment."); }
  });
  server.registerTool("save_assignment_pdf", { description: "After the student explicitly asks to save a generated PDF, resolve the assignment by name or ID, validate the OpenAI file handoff, save it to the connected student's Drive, and return a polished manual Classroom submission handoff. A Drive upload is never reported as a Classroom submission.", inputSchema: { ...assignmentSelectorSchema, confirmUpload: z.boolean().default(false).describe("Set true only after the student explicitly asks to save/upload this PDF to Drive."), file: fileSchema.describe("Generated PDF supplied through OpenAI file handoff metadata.") }, _meta: { ...v2Auth, "openai/fileParams": ["file"] }, annotations: actionAnnotations }, async ({ courseId, courseQuery, courseWorkId, assignmentQuery, confirmUpload, file }) => {
    try { const resolved = await resolveStudentAssignment(clients, { courseId, courseQuery, courseWorkId, assignmentQuery }); if (!resolved.course.id || !resolved.coursework.id) throw new V2WorkflowError("invalid_context", "The resolved assignment is missing its Classroom identity."); const result = await saveAssignmentPdf(clients, { courseId: resolved.course.id, courseWorkId: resolved.coursework.id, confirmUpload, file }); return { content: [{ type: "text", text: JSON.stringify(result) }] }; }
    catch (error) { return errorResult(error, "upload_failed", "The PDF could not be saved."); }
  });
  server.registerTool("verify_assignment_submission", { description: "Resolve an assignment by natural course/title or IDs and report the connected student's factual Google Classroom state after manual submission. Use for questions like 'I submitted it - check' or 'Did it turn in?'.", inputSchema: assignmentSelectorSchema, _meta: v2Auth, annotations: readAnnotations }, async (selector) => {
    try { const resolved = await resolveStudentAssignment(clients, selector); if (!resolved.course.id || !resolved.coursework.id) throw new V2WorkflowError("invalid_context", "The resolved assignment is missing its Classroom identity."); const result = await verifySubmission(clients, resolved.course.id, resolved.coursework.id); return { content: [{ type: "text", text: JSON.stringify(result) }] }; }
    catch (error) { return errorResult(error, "verification_failed", "The submission state could not be checked."); }
  });
  return server;
}

/** Final runtime composition: the established public V1 read tools plus the
 * isolated V2 student-assistant tools on one authenticated MCP server. */
export async function createV2CombinedServer(clients: V2Clients, identity: McpIdentity = {}): Promise<McpServer> {
  const server = createV2BetaServer(clients, identity);
  return createServer(clients, { publicV1: true, existingServer: server });
}
