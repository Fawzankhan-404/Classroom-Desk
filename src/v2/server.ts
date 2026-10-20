import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { V2Clients } from "./workflow.js";
import { verifySubmission, V2WorkflowError } from "./workflow.js";
import { getAssignmentWorkspace, getStudentOverview, resolveStudentAssignment } from "./student.js";
import { createTeacherCourseworkDraft, getTeacherCoursework, getTeacherCourseworkDrafts, getTeacherRoster, getTeacherSubmissions, listVerifiedTeacherCourses, updateTeacherCourseworkDraft } from "./teacher.js";
import { prepareTeacherAttachment, readTeacherAttachment } from "./attachment-workflow.js";
import { createServer } from "../server.js";

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
    confirmation_required: "Generated PDF transfer is unavailable. Download the file yourself and attach it in Google Classroom.",
    invalid_file: "That file isn't a readable PDF. Please provide the final PDF again.",
    external_file_transfer_unavailable: "Saving a generated PDF from an external download link is temporarily unavailable. This Worker cannot safely pin arbitrary download URLs, so nothing was downloaded or added to Drive. Download the PDF yourself and attach it in Google Classroom.",
    file_too_large: "That PDF is too large to process. Please provide a smaller PDF.",
    authorization: "Your Google Classroom connection needs attention. Reconnect and try again.",
    teacher_entitlement_required: "Teacher data is available only with an active Teacher entitlement and Google’s verified teacher authorization.",
    teacher_coursework_write_authorization_required: "Creating an unpublished draft needs separate Google permission. Classroom Desk does not publish drafts or write grades.",
    google_unavailable: "Google Classroom is temporarily unavailable. Please try again shortly.",
  };
  return messages[code] ?? fallback;
}

function errorResult(error: unknown, fallbackCode: string, fallbackMessage: string) {
  const e = error instanceof V2WorkflowError ? error : new V2WorkflowError(fallbackCode, fallbackMessage);
  return { isError: true as const, content: [{ type: "text" as const, text: JSON.stringify({ error: e.code, message: friendlyError(e.code, e.message) }) }] };
}

type AccountStatus = { state: string; message: string; activationUrl: string; billingUrl: string; settingsUrl: string; plan: string | null; expiresAt: string | null };
type McpIdentity = { name?: string; version?: string; linkWebsiteAccount?: (code: string, mcpUserId: string) => Promise<boolean>; accountStatus?: (mcpUserId: string) => Promise<AccountStatus>; teacherAuthorizationUrl?: string; teacherWriteAuthorizationUrl?: string; teacherDraftWritesEnabled?: boolean };

export function createV2BetaServer(clients: V2Clients, identity: McpIdentity = {}): McpServer {
  const server = new McpServer({ name: identity.name ?? "classroom-desk-v2-beta", version: identity.version ?? "2.0.0-beta.1" });
  if (identity.linkWebsiteAccount) server.registerTool("link_website_account", { description: "Pair this authenticated Classroom Desk MCP connection with the signed-in Classroom Desk website using a short-lived one-time code. This changes only the website account link and does not grant Google or Classroom permissions.", inputSchema: { code: z.string().min(20).max(100).describe("One-time code shown by Classroom Desk website account linking.") }, _meta: v2Auth, annotations: readAnnotations }, async ({ code }) => ({ content: [{ type: "text", text: JSON.stringify({ linked: await identity.linkWebsiteAccount!(code, clients.subject), message: "Website account pairing completed only if linked is true." }) }] }));
  if (identity.accountStatus) {
    server.registerTool("check_account_activation", { description: "Check the authenticated Classroom Desk account activation state. This returns only account and entitlement guidance, never Classroom content.", inputSchema: {}, _meta: v2Auth, annotations: readAnnotations }, async () => ({ content: [{ type: "text", text: JSON.stringify(await identity.accountStatus!(clients.subject)) }] }));
    server.registerTool("get_activation_guidance", { description: "Return the authenticated account's safe activation, plan, billing, and Google reconnection links. This does not grant access or expose private Classroom data.", inputSchema: {}, _meta: v2Auth, annotations: readAnnotations }, async () => { const status = await identity.accountStatus!(clients.subject); return { content: [{ type: "text", text: JSON.stringify({ state: status.state, message: status.message, activationUrl: status.activationUrl, billingUrl: status.billingUrl, settingsUrl: status.settingsUrl }) }] }; });
  }
  server.registerTool("student_classroom_overview", { description: "Answer student questions across accessible Classroom data without requiring Google IDs. Use for assignments, due dates, missing/assigned/turned-in/returned work, announcements, course materials, topics, recent activity, catch-up summaries, and keyword searches.", inputSchema: { courseQuery: z.string().min(1).optional().describe("Optional natural course name or keyword."), searchQuery: z.string().min(1).optional().describe("Optional keyword to search across course names, assignment titles/instructions, announcements, materials, and topics."), view: z.enum(["all", "due_soon", "today", "tomorrow", "missing", "assigned", "submitted", "returned", "reclaimed", "recent"]).default("all").describe("Student-centered filter for the requested view."), days: z.number().int().min(1).max(31).default(7).describe("Window in days for due_soon; ignored by other views."), limit: z.number().int().min(1).max(100).default(50).describe("Maximum results per returned category.") }, _meta: v2Auth, annotations: readAnnotations }, async (input) => {
    try { return { content: [{ type: "text", text: JSON.stringify(await getStudentOverview(clients, input)) }] }; }
    catch (error) { return errorResult(error, "overview_failed", "Classroom Desk could not build the student overview."); }
  });
  const teacherError = (error: unknown) => {
    if (error instanceof V2WorkflowError && error.code === "teacher_authorization_required") {
      return { isError: true as const, content: [{ type: "text" as const, text: JSON.stringify({ error: error.code, message: friendlyError(error.code, error.message), authorizationUrl: identity.teacherAuthorizationUrl ?? "https://classroom.jarvis404.com/app/teacher" }) }] };
    }
    if (error instanceof V2WorkflowError && error.code === "teacher_coursework_write_authorization_required") {
      return { isError: true as const, content: [{ type: "text" as const, text: JSON.stringify({ error: error.code, message: friendlyError(error.code, error.message), authorizationUrl: identity.teacherWriteAuthorizationUrl ?? "https://classroom.jarvis404.com/app/teacher" }) }] };
    }
    return errorResult(error, "teacher_read_failed", "Google Classroom teacher data could not be read.");
  };
  server.registerTool("teacher_classroom_courses", { description: "List one page of Google Classroom courses where Google verifies the authenticated account as a teacher. Requires a separate, explicit teacher read authorization; selecting Teacher mode alone grants nothing. Read-only; pass nextPageToken to continue when present.", inputSchema: { pageToken: z.string().min(1).max(4096).optional() }, _meta: v2Auth, annotations: readAnnotations }, async ({ pageToken }) => {
    try { const page = await listVerifiedTeacherCourses(clients, pageToken); return { content: [{ type: "text", text: JSON.stringify({ courses: page.courses.map(course => ({ id: course.id ?? null, name: course.name ?? null, section: course.section ?? null, state: course.courseState ?? null })), nextPageToken: page.nextPageToken ?? null }) }] }; }
    catch (error) { return teacherError(error); }
  });
  server.registerTool("teacher_coursework", { description: "List published coursework only after Google confirms the authenticated account is a teacher in that exact course. Read-only; no coursework or gradebook writes.", inputSchema: { courseId: z.string().min(1).max(256) }, _meta: v2Auth, annotations: readAnnotations }, async ({ courseId }) => {
    try { const result = await getTeacherCoursework(clients, courseId); return { content: [{ type: "text", text: JSON.stringify({ coursework: result.coursework, moreAvailable: result.moreAvailable }) }] }; }
    catch (error) { return teacherError(error); }
  });
  if (identity.teacherDraftWritesEnabled === true) {
    server.registerTool("teacher_coursework_drafts", { description: "List unpublished assignment drafts for a course only after Google verifies teacher membership and the teacher explicitly granted coursework-management permission. Includes updateTime so a later confirmed draft edit can reject stale state. Read-only. The Google scope also permits grade management; Classroom Desk does not expose or perform grade writes.", inputSchema: { courseId: z.string().min(1).max(256) }, _meta: v2Auth, annotations: readAnnotations }, async ({ courseId }) => {
      try { const result = await getTeacherCourseworkDrafts(clients, courseId); return { content: [{ type: "text", text: JSON.stringify({ drafts: result.drafts, moreAvailable: result.moreAvailable, published: false }) }] }; }
      catch (error) { return teacherError(error); }
    });
    server.registerTool("teacher_create_coursework_draft", { description: "Create an unpublished Google Classroom assignment draft in a course where Google confirms you are a teacher. This performs a real Classroom write but never publishes the item or writes grades/submissions. Google consent for this permission also covers grade management. Call only after the teacher explicitly requests this exact draft and sets confirmation to CREATE_UNPUBLISHED_DRAFT.", inputSchema: {
    courseId: z.string().min(1).max(256),
    title: z.string().trim().min(1).max(300),
    description: z.string().max(5000).optional(),
    dueDate: z.object({ year: z.number().int().min(2000).max(2100), month: z.number().int().min(1).max(12), day: z.number().int().min(1).max(31) }).strict().optional(),
    dueTime: z.object({ hours: z.number().int().min(0).max(23), minutes: z.number().int().min(0).max(59) }).strict().optional(),
    maxPoints: z.number().int().min(0).max(10000).optional(),
    confirmation: z.literal("CREATE_UNPUBLISHED_DRAFT"),
  }, _meta: v2Auth, annotations: actionAnnotations }, async ({ courseId, title, description, dueDate, dueTime, maxPoints, confirmation }) => {
    try { return { content: [{ type: "text", text: JSON.stringify(await createTeacherCourseworkDraft(clients, courseId, { title, description, dueDate, dueTime, maxPoints }, confirmation)) }] }; }
    catch (error) { return teacherError(error); }
    });
    server.registerTool("teacher_update_coursework_draft", { description: "Update selected fields on an unpublished assignment draft created by this Classroom Desk Google project. This performs a real Google Classroom PATCH and requires a separate coursework-management grant, verified teacher membership, the draft's current updateTime, and explicit confirmation UPDATE_UNPUBLISHED_DRAFT. Only title, description, due date/time, and maximum points are accepted; grades and publication state are never changed. Google does not provide an atomic draft-state precondition, so a concurrent publish between the state check and PATCH cannot be ruled out; do not use if that residual race is unacceptable.", inputSchema: {
    courseId: z.string().min(1).max(256),
    courseWorkId: z.string().min(1).max(256),
    expectedUpdateTime: z.string().min(10).max(64),
    title: z.string().trim().min(1).max(300).optional(),
    description: z.string().max(5000).optional(),
    dueDate: z.object({ year: z.number().int().min(2000).max(2100), month: z.number().int().min(1).max(12), day: z.number().int().min(1).max(31) }).strict().optional(),
    dueTime: z.object({ hours: z.number().int().min(0).max(23), minutes: z.number().int().min(0).max(59) }).strict().optional(),
    maxPoints: z.number().int().min(0).max(10000).optional(),
    confirmation: z.literal("UPDATE_UNPUBLISHED_DRAFT"),
  }, _meta: v2Auth, annotations: actionAnnotations }, async ({ courseId, courseWorkId, expectedUpdateTime, title, description, dueDate, dueTime, maxPoints, confirmation }) => {
    try { return { content: [{ type: "text", text: JSON.stringify(await updateTeacherCourseworkDraft(clients, courseId, courseWorkId, expectedUpdateTime, { title, description, dueDate, dueTime, maxPoints }, confirmation)) }] }; }
    catch (error) { return teacherError(error); }
    });
  }
  server.registerTool("teacher_course_roster", { description: "Read the roster for a course only after Google verifies the authenticated account as a teacher in that course. Returns names only, not email addresses. Read-only.", inputSchema: { courseId: z.string().min(1).max(256) }, _meta: v2Auth, annotations: readAnnotations }, async ({ courseId }) => {
    try { const roster = await getTeacherRoster(clients, courseId); return { content: [{ type: "text", text: JSON.stringify({ students: roster.students.map((student) => ({ fullName: student.fullName })), moreAvailable: roster.moreAvailable, complete: roster.complete }) }] }; }
    catch (error) { return teacherError(error); }
  });
  server.registerTool("teacher_coursework_submissions", { description: "Read real student submission states, existing grades, and bounded attachment type/title metadata for one coursework item only after Google verifies teacher membership in the course. Attachment URLs, file IDs, and file contents are not returned. Missing submissions remain UNKNOWN/ASSIGNED as Google reports them. Gradebook writes are disabled.", inputSchema: { courseId: z.string().min(1).max(256), courseWorkId: z.string().min(1).max(256) }, _meta: v2Auth, annotations: readAnnotations }, async ({ courseId, courseWorkId }) => {
    try { return { content: [{ type: "text", text: JSON.stringify(await getTeacherSubmissions(clients, courseId, courseWorkId)) }] }; }
    catch (error) { return teacherError(error); }
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
  server.registerTool("save_assignment_pdf", { description: "Temporarily unavailable. Classroom Desk does not fetch arbitrary external PDF URLs or add generated files to Drive until the Worker has a verified trusted-host transfer path. Download the PDF yourself and attach it in Google Classroom. No Classroom or Drive changes are made by this tool.", inputSchema: {}, _meta: v2Auth, annotations: readAnnotations }, async () => errorResult(new V2WorkflowError("external_file_transfer_unavailable", "Generated PDF transfer is temporarily unavailable."), "upload_failed", "Generated PDF transfer is temporarily unavailable. No file was downloaded or added to Drive."));
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
  // The legacy public V1 composer sets `publicPageLimit` on its client object.
  // Keep that response cap local so the V2 student workflows retain their full
  // pagination behavior when both tool sets share one MCP server.
  return createServer({ ...clients }, { publicV1: true, existingServer: server });
}
