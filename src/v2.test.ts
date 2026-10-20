import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { downloadPdf, V2FileError } from "./v2/files.js";
import { classifyGoogleReadFailure, getAssignmentContext, isGoogleReauthorizationFailure, saveAssignmentPdf, verifySubmission } from "./v2/workflow.js";
import { V2_BETA_SCOPES, V2_DRIVE_SCOPE, V2_TEACHER_SCOPES, V2_TEACHER_WRITE_SCOPES, V2_UNIFIED_SCOPES, isExactV2TeacherGrant, isExactV2TeacherWriteGrant, isExactV2UnifiedGrant, isSupportedV2StoredGrant, isValidV2AuthorizationGrant } from "./v2/scopes.js";
import { GOOGLE_CANONICAL_CLASSROOM_SCOPES, PUBLIC_CLASSROOM_SCOPES } from "./scopes.js";
import { attachmentMetadata, getAssignmentWorkspace, getStudentOverview, resolveStudentAssignment } from "./v2/student.js";
import { createV2BetaServer } from "./v2/server.js";
import { authorizeAttachmentAccess, discoverAttachments, resolveAttachment } from "./v2/attachments.js";

describe("V2 PDF handoff", () => {
  it.each([
    "https://files.example.test/generated.pdf",
    "https://[::ffff:10.0.0.1]/generated.pdf",
    "https://127.0.0.1/generated.pdf",
    "https://metadata.google.internal/generated.pdf",
  ])("fails closed for external URL handoffs (%s)", async (download_url) => {
    await expect(downloadPdf({ file_id: "test-file", download_url, mime_type: "application/pdf" })).rejects.toMatchObject({ code: "external_file_transfer_unavailable" });
  });
  it("keeps malformed inputs and non-PDF claims rejected", async () => {
    await expect(downloadPdf({ file_id: "", download_url: "https://files.example.test/a" })).rejects.toMatchObject({ code: "missing_file" });
    await expect(downloadPdf({ file_id: "test-file", download_url: "https://files.example.test/a", mime_type: "text/plain" })).rejects.toBeInstanceOf(V2FileError);
  });
  it("keeps the V2 scope delta isolated", () => { expect(V2_BETA_SCOPES).toContain("https://www.googleapis.com/auth/drive.file"); expect(V2_BETA_SCOPES).not.toContain("https://www.googleapis.com/auth/drive.readonly"); });
  it("requires only OpenID and email for new verified account binding and retains legacy grants", () => {
    expect(V2_UNIFIED_SCOPES).toEqual([...V2_BETA_SCOPES, "openid", "email"]);
    expect(isExactV2UnifiedGrant([...V2_UNIFIED_SCOPES])).toBe(true);
    expect(isExactV2UnifiedGrant([...V2_BETA_SCOPES])).toBe(false);
    expect(isExactV2UnifiedGrant([...V2_UNIFIED_SCOPES, "profile"])).toBe(false);
    expect(isSupportedV2StoredGrant([...V2_BETA_SCOPES])).toBe(true);
    expect(isSupportedV2StoredGrant([...V2_UNIFIED_SCOPES])).toBe(true);
    expect(isExactV2TeacherGrant([...V2_TEACHER_SCOPES])).toBe(true);
    expect(isSupportedV2StoredGrant([...V2_TEACHER_SCOPES])).toBe(true);
    expect(isExactV2TeacherWriteGrant([...V2_TEACHER_WRITE_SCOPES])).toBe(true);
    expect(isSupportedV2StoredGrant([...V2_TEACHER_WRITE_SCOPES])).toBe(true);
    expect(isExactV2TeacherGrant([...V2_TEACHER_WRITE_SCOPES])).toBe(false);
    expect(isExactV2TeacherWriteGrant([...V2_TEACHER_SCOPES])).toBe(false);
    expect(isExactV2TeacherGrant([...V2_UNIFIED_SCOPES])).toBe(false);
    expect(isSupportedV2StoredGrant(["https://www.googleapis.com/auth/classroom.courses.readonly", "https://www.googleapis.com/auth/drive.readonly"])).toBe(false);
  });
  it("accepts only Google's exact canonical Classroom and email aliases for unified grants", () => {
    const canonicalEmailAlias = [...GOOGLE_CANONICAL_CLASSROOM_SCOPES, V2_DRIVE_SCOPE, "openid", "email"];
    const canonicalEmailUri = [...GOOGLE_CANONICAL_CLASSROOM_SCOPES, V2_DRIVE_SCOPE, "openid", "https://www.googleapis.com/auth/userinfo.email"];
    for (const grant of [canonicalEmailAlias, canonicalEmailUri]) {
      expect(isExactV2UnifiedGrant(grant)).toBe(true);
      expect(isSupportedV2StoredGrant(grant)).toBe(true);
      for (const requiredScope of grant) {
        expect(isExactV2UnifiedGrant(grant.filter(scope => scope !== requiredScope))).toBe(false);
      }
      expect(isExactV2UnifiedGrant([...grant, grant[0]!])).toBe(false);
      expect(isSupportedV2StoredGrant([...grant, grant[0]!])).toBe(false);
    }
    expect(isExactV2UnifiedGrant([...PUBLIC_CLASSROOM_SCOPES, V2_DRIVE_SCOPE, "openid", "https://www.googleapis.com/auth/userinfo.email"])).toBe(true);
    expect(isExactV2UnifiedGrant([...canonicalEmailUri, "email"])).toBe(false);
    expect(isExactV2UnifiedGrant(canonicalEmailUri.filter((scope) => scope !== "openid"))).toBe(false);
    expect(isExactV2UnifiedGrant([...canonicalEmailUri, "profile"])).toBe(false);
    expect(isExactV2UnifiedGrant([...canonicalEmailUri.filter((scope) => !scope.endsWith("student-submissions.me.readonly")), "https://www.googleapis.com/auth/classroom.coursework.students.readonly"])).toBe(false);
  });
  it("accepts only Google's exact optional userinfo.profile on a complete supported grant", () => {
    const profileScope = "https://www.googleapis.com/auth/userinfo.profile";
    for (const grant of [V2_UNIFIED_SCOPES, V2_TEACHER_SCOPES, V2_TEACHER_WRITE_SCOPES]) {
      const returnedScopes = [...grant, profileScope];
      expect(isValidV2AuthorizationGrant(returnedScopes)).toBe(true);
      expect(isSupportedV2StoredGrant(returnedScopes)).toBe(true);
      expect(isValidV2AuthorizationGrant([...returnedScopes, "https://www.googleapis.com/auth/drive.readonly"])).toBe(false);
      expect(isValidV2AuthorizationGrant(returnedScopes.slice(1))).toBe(false);
    }
    expect(isValidV2AuthorizationGrant([profileScope])).toBe(false);
  });
});

function clients() {
  const submission = { id: "s1", state: "TURNED_IN", updateTime: "2026-01-01T00:00:00Z" };
  const classroom = { courses: { get: vi.fn(async () => ({ data: { id: "c1", name: "Demo course" } })), courseWork: { get: vi.fn(async () => ({ data: { id: "w1", courseId: "c1", title: "Assignment 4", workType: "ASSIGNMENT" } })), studentSubmissions: { list: vi.fn(async () => ({ data: { studentSubmissions: [submission] } })) } } } } as any;
  const drive = { files: { create: vi.fn(async () => ({ data: { id: "f1", name: "Assignment-Desk.pdf", mimeType: "application/pdf", webViewLink: "https://drive.google.com/file/d/f1/view" } })) } } as any;
  return { classroom, drive, subject: "subject-a" };
}

describe("V2 Classroom workflow", () => {
  it.each([
    "https://files.example.test/generated.pdf",
    "https://[::ffff:10.0.0.1]/generated.pdf",
    "https://127.0.0.1/generated.pdf",
    "https://metadata.google.internal/generated.pdf",
  ])("rejects external PDF transfer before any Google API call (%s)", async (download_url) => {
    const c = clients();
    await expect(saveAssignmentPdf(c, { courseId: "c1", courseWorkId: "w1", confirmUpload: true, file: { file_id: "test-file", download_url } })).rejects.toMatchObject({ code: "external_file_transfer_unavailable" });
    expect(c.classroom.courses.get).not.toHaveBeenCalled();
    expect(c.classroom.courses.courseWork.get).not.toHaveBeenCalled();
    expect(c.drive.files.create).not.toHaveBeenCalled();
  });
  it("does not upload when the student declines", async () => { const c = clients(); await expect(saveAssignmentPdf(c, { courseId: "c1", courseWorkId: "w1", confirmUpload: false, file: { file_id: "test-file", download_url: "https://files.example.test/a" } })).rejects.toMatchObject({ code: "confirmation_required" }); expect(c.drive.files.create).not.toHaveBeenCalled(); });
  it("reports factual submission state", async () => { const result = await verifySubmission(clients(), "c1", "w1"); expect(result).toMatchObject({ submission: { state: "TURNED_IN" } }); });
  it("rejects a coursework/course mismatch", async () => { const c = clients(); c.classroom.courses.courseWork.get.mockResolvedValue({ data: { id: "w1", courseId: "other", title: "Wrong", workType: "ASSIGNMENT" } }); await expect(getAssignmentContext(c, "c1", "w1")).rejects.toMatchObject({ code: "invalid_context" }); });
});

function studentClients() {
  const courses = [{ id: "c1", name: "Java Basics", courseState: "ACTIVE" }, { id: "c2", name: "Advanced Java", courseState: "ACTIVE" }];
  const work = {
    c1: [
      { id: "w1", courseId: "c1", title: "Inheritance Practice", description: "Practice inheritance", workType: "ASSIGNMENT", updateTime: "2026-01-01T10:00:00Z", dueDate: { year: 2026, month: 1, day: 3 }, materials: [{ driveFile: { driveFile: { id: "teacher-file", title: "Inheritance.pdf", alternateLink: "https://drive.google.com/file/d/teacher-file/view" } } }] },
      { id: "w2", courseId: "c1", title: "Past Due Lab", workType: "ASSIGNMENT", updateTime: "2025-12-30T10:00:00Z", dueDate: { year: 2025, month: 12, day: 31 }, dueTime: { hours: 12, minutes: 0 } },
      { id: "w3", courseId: "c1", title: "Submitted Project", workType: "ASSIGNMENT", updateTime: "2025-12-29T10:00:00Z" },
      { id: "w4", courseId: "c1", title: "Returned Essay", workType: "ASSIGNMENT", updateTime: "2025-12-28T10:00:00Z" },
    ],
    c2: [{ id: "w5", courseId: "c2", title: "Inheritance Practice", workType: "ASSIGNMENT", updateTime: "2026-01-02T10:00:00Z" }],
  } as Record<string, any[]>;
  const submissions = {
    c1: [{ id: "s1", userId: "connected-user", courseWorkId: "w1", state: "CREATED", updateTime: "2026-01-01T12:00:00Z" }, { id: "s2", userId: "connected-user", courseWorkId: "w2", state: "CREATED" }, { id: "s3", userId: "connected-user", courseWorkId: "w3", state: "TURNED_IN", updateTime: "2026-01-02T08:00:00Z" }, { id: "s4", userId: "connected-user", courseWorkId: "w4", state: "RETURNED", updateTime: "2026-01-02T09:00:00Z" }],
    c2: [{ id: "s5", userId: "connected-user", courseWorkId: "w5", state: "CREATED" }],
  } as Record<string, any[]>;
  const submissionCalls: any[] = [];
  const classroom = { courses: {
    list: vi.fn(async () => ({ data: { courses } })),
    get: vi.fn(async ({ id }: any) => ({ data: courses.find((course) => course.id === id) ?? {} })),
    announcements: { list: vi.fn(async ({ courseId }: any) => ({ data: { announcements: courseId === "c1" ? [{ id: "a1", courseId, text: "Exam moved to Friday", updateTime: "2026-01-02T11:00:00Z" }] : [] } })) },
    courseWorkMaterials: { list: vi.fn(async ({ courseId }: any) => ({ data: { courseWorkMaterial: courseId === "c1" ? [{ id: "m1", courseId, title: "Inheritance notes", updateTime: "2026-01-02T10:30:00Z", materials: [{ link: { title: "Reference", url: "https://example.edu/reference" } }] }] : [] } })) },
    topics: { list: vi.fn(async ({ courseId }: any) => ({ data: { topic: courseId === "c1" ? [{ topicId: "t1", courseId, name: "Object-oriented programming" }] : [] } })) },
    courseWork: {
      list: vi.fn(async ({ courseId }: any) => ({ data: { courseWork: work[courseId] ?? [] } })),
      get: vi.fn(async ({ courseId, id }: any) => ({ data: (work[courseId] ?? []).find((item) => item.id === id) ?? {} })),
      studentSubmissions: { list: vi.fn(async (params: any) => { submissionCalls.push(params); const all = submissions[params.courseId] ?? []; return { data: { studentSubmissions: params.courseWorkId === "-" ? all : all.filter((item) => item.courseWorkId === params.courseWorkId) } }; }) },
    },
  } } as any;
  const drive = { files: { create: vi.fn(async () => ({ data: { id: "f1", name: "Final-Classroom-Desk.pdf", mimeType: "application/pdf", webViewLink: "https://drive.google.com/file/d/f1/view" } })) } } as any;
  return { classroom, drive, subject: "connected-subject", submissionCalls };
}

describe("V2 conversational student experience", () => {
  it("maps Google authorization failures to a reconnect state", () => {
    expect(classifyGoogleReadFailure({ response: { status: 401 } })).toBe("reauthorization_required");
    expect(classifyGoogleReadFailure({ code: "authorization" })).toBe("reauthorization_required");
    expect(classifyGoogleReadFailure({ response: { status: 403 } })).toBe("permission_denied");
    expect(classifyGoogleReadFailure({ code: "teacher_course_forbidden" })).toBe("permission_denied");
    expect(classifyGoogleReadFailure({ response: { status: 503 } })).toBe("unavailable");
  });
  it("covers due-soon, missing, submitted and returned views", async () => {
    const c = studentClients(); const now = new Date("2026-01-02T12:00:00Z");
    expect((await getStudentOverview(c, { courseQuery: "Java Basics", view: "due_soon", days: 7 }, { now })).assignments.map((item) => item.title)).toEqual(["Inheritance Practice"]);
    expect((await getStudentOverview(c, { courseQuery: "Java Basics", view: "missing" }, { now })).assignments.map((item) => item.title)).toEqual(["Past Due Lab"]);
    expect((await getStudentOverview(c, { courseQuery: "Java Basics", view: "submitted" }, { now })).assignments.map((item) => item.title)).toEqual(["Submitted Project"]);
    expect((await getStudentOverview(c, { courseQuery: "Java Basics", view: "returned" }, { now })).assignments.map((item) => item.title)).toEqual(["Returned Essay"]);
  });
  it("keeps date-only deadlines visible without inventing a time or missing state", async () => {
    const c = studentClients(); const now = new Date("2026-01-02T12:00:00Z");
    const result = await getStudentOverview(c, { courseQuery: "Java Basics" }, { now });
    const item = result.assignments.find((assignment) => assignment.title === "Inheritance Practice");
    expect(item).toMatchObject({ dueAt: "2026-01-03", missing: null });
    expect(result.summary.missing).toBeNull();
  });
  it("returns empty assignment results without inventing work", async () => { const c = studentClients(); c.classroom.courses.courseWork.list.mockResolvedValue({ data: { courseWork: [] } }); const result = await getStudentOverview(c, { courseQuery: "Java Basics" }); expect(result.assignments).toEqual([]); expect(result.summary.assignments).toBe(0); });
  it("marks student submission states and counts unknown when Google denies the submission read", async () => { const c = studentClients(); c.classroom.courses.courseWork.studentSubmissions.list.mockRejectedValue({ response: { status: 403 } }); const result = await getStudentOverview(c, { courseQuery: "Java Basics" }); expect(result.availability.submissionsComplete).toBe(false); expect(result.summary.missing).toBeNull(); expect(result.assignments.every(item => item.submissionState === "UNKNOWN" && item.missing === null)).toBe(true); expect((await getStudentOverview(c, { courseQuery: "Java Basics", view: "missing" })).assignments).toEqual([]); });
  it("reports assignment totals as unknown when a coursework API read fails", async () => { const c = studentClients(); c.classroom.courses.courseWork.list.mockRejectedValue({ response: { status: 503 } }); const result = await getStudentOverview(c, { courseQuery: "Java Basics" }); expect(result.availability.courseworkComplete).toBe(false); expect(result.summary.assignments).toBeNull(); });
  it("requires reconnect when any Google Classroom read reports an expired credential", async () => {
    const c = studentClients();
    c.classroom.courses.announcements.list.mockRejectedValueOnce({ response: { status: 401 } });
    await expect(getStudentOverview(c, { courseQuery: "Java Basics" })).rejects.toMatchObject({ code: "authorization" });
  });
  it("classifies revoked Google refresh tokens as reconnect failures", async () => {
    const invalidGrant = { response: { status: 400, data: { error: "invalid_grant" } } };
    expect(isGoogleReauthorizationFailure(invalidGrant)).toBe(true);
    expect(classifyGoogleReadFailure(invalidGrant)).toBe("reauthorization_required");
    expect(classifyGoogleReadFailure({ response: { status: 400, data: { error: "invalid_request" } } })).toBe("unavailable");
    const c = studentClients();
    c.classroom.courses.announcements.list.mockRejectedValueOnce(invalidGrant);
    await expect(getStudentOverview(c, { courseQuery: "Java Basics" })).rejects.toMatchObject({ code: "authorization" });
  });
  it("searches announcements, topics and material metadata", async () => { const result = await getStudentOverview(studentClients(), { courseQuery: "Java Basics", searchQuery: "inheritance" }); expect(result.assignments[0]?.title).toBe("Inheritance Practice"); expect(result.courseMaterials[0]?.title).toBe("Inheritance notes"); const catchUp = await getStudentOverview(studentClients(), { courseQuery: "Java Basics", view: "recent" }); expect(catchUp.topics[0]?.name).toMatch(/object-oriented/i); expect(catchUp.announcements[0]?.text).toMatch(/Friday/); expect(catchUp.recentActivity.length).toBeGreaterThan(0); });
  it("reports teacher Drive attachments as metadata-only", async () => { const workspace = await getAssignmentWorkspace(studentClients(), { courseQuery: "Java Basics", assignmentQuery: "Inheritance Practice" }); expect(workspace.assignment.attachments[0]).toMatchObject({ kind: "drive_file", title: "Inheritance.pdf", contentAccess: "metadata_only" }); expect(workspace.attachmentPolicy.arbitraryTeacherFileContentAvailable).toBe(false); });
  it("resolves names and safely rejects ambiguous assignments", async () => { const resolved = await resolveStudentAssignment(studentClients(), { courseQuery: "Java Basics", assignmentQuery: "Inheritance" }); expect(resolved.coursework.id).toBe("w1"); await expect(resolveStudentAssignment(studentClients(), { assignmentQuery: "Inheritance Practice" })).rejects.toMatchObject({ code: "ambiguous_assignment" }); });
  it("binds submission reads to userId me", async () => { const c = studentClients(); await getStudentOverview(c, { courseQuery: "Java Basics" }); expect(c.submissionCalls.every((call) => call.userId === "me")).toBe(true); });
  it("allows a newly published assignment with no submission yet", async () => { const c = studentClients(); c.classroom.courses.courseWork.studentSubmissions.list.mockResolvedValue({ data: {} }); const workspace = await getAssignmentWorkspace(c, { courseQuery: "Java Basics", assignmentQuery: "Inheritance" }); expect(workspace.submission.state).toBe("ASSIGNED"); });
  it("classifies non-Drive material types without claiming file content", () => { expect(attachmentMetadata([{ link: { title: "Site", url: "https://example.com" } }, { youtubeVideo: { title: "Video", alternateLink: "https://youtube.com/watch?v=x" } }, { form: { title: "Quiz", formUrl: "https://docs.google.com/forms/d/x" } }])).toMatchObject([{ kind: "link", contentAccess: "link_available" }, { kind: "youtube", contentAccess: "link_available" }, { kind: "form", contentAccess: "link_available" }]); });
  it("keeps attachment discovery, resolution and authorization separate", () => { const found = discoverAttachments([{ driveFile: { driveFile: { id: "teacher-file", title: "Lesson.pdf" } } }]); expect(resolveAttachment(found, "Lesson")).toMatchObject({ status: "resolved" }); expect(authorizeAttachmentAccess(found[0]!)).toMatchObject({ access: "metadata_only", readableByClassroomDesk: false }); expect(authorizeAttachmentAccess(found[0]!, new Set(["teacher-file"]))).toMatchObject({ access: "picker_authorized", readableByClassroomDesk: true }); });
  it("keeps teacher draft tools hidden unless the separate write flag is enabled", async () => {
    const server = createV2BetaServer({ ...studentClients(), teacherEntitled: false }, { teacherAuthorizationUrl: "https://classroom.jarvis404.com/app/teacher", teacherWriteAuthorizationUrl: "https://classroom.jarvis404.com/app/teacher" });
    const client = new Client({ name: "v2-contract", version: "1" });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name)).toEqual(["student_classroom_overview", "teacher_classroom_courses", "teacher_coursework", "teacher_course_roster", "teacher_coursework_submissions", "get_assignment_workspace", "prepare_teacher_attachment", "read_teacher_attachment", "save_assignment_pdf", "verify_assignment_submission"]);
      expect(tools.some((tool) => tool.name === "teacher_coursework_drafts" || tool.name === "teacher_create_coursework_draft" || tool.name === "teacher_update_coursework_draft")).toBe(false);
      expect(tools.find((tool) => tool.name === "save_assignment_pdf")?.annotations?.readOnlyHint).toBe(true);
      expect(tools.find((tool) => tool.name === "save_assignment_pdf")?._meta).not.toHaveProperty("openai/fileParams");
      expect(tools.every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true);
    } finally { await client.close(); await server.close(); }
  });
  it("exposes the teacher coursework draft tools only after explicit write opt-in", async () => {
    const server = createV2BetaServer(studentClients(), { teacherDraftWritesEnabled: true });
    const client = new Client({ name: "v2-explicit-write-opt-in", version: "1" });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
      const { tools } = await client.listTools();
      for (const name of ["teacher_coursework_drafts", "teacher_create_coursework_draft", "teacher_update_coursework_draft"]) expect(tools.find((tool) => tool.name === name)).toBeDefined();
      for (const name of ["teacher_create_coursework_draft", "teacher_update_coursework_draft"]) expect(tools.find((tool) => tool.name === name)?.annotations?.readOnlyHint).toBe(false);
    } finally { await client.close(); await server.close(); }
  });
  it("exposes account activation guidance without classroom data", async () => { const server = createV2BetaServer(studentClients(), { accountStatus: vi.fn(async () => ({ state: "ACCOUNT_SETUP_REQUIRED", message: "Start at https://classroom.jarvis404.com/login.", activationUrl: "https://classroom.jarvis404.com/login", billingUrl: "https://classroom.jarvis404.com/app/billing", settingsUrl: "https://classroom.jarvis404.com/app/settings", plan: null, expiresAt: null })) }); const client = new Client({ name: "account-contract", version: "1" }); const [clientSide, serverSide] = InMemoryTransport.createLinkedPair(); try { await Promise.all([server.connect(serverSide), client.connect(clientSide)]); const { tools } = await client.listTools(); expect(tools.map((tool) => tool.name)).toContain("check_account_activation"); const result = await client.callTool({ name: "check_account_activation", arguments: {} }); expect(JSON.parse((result.content as Array<{ text: string }>)[0]!.text)).toMatchObject({ state: "ACCOUNT_SETUP_REQUIRED", activationUrl: "https://classroom.jarvis404.com/login" }); } finally { await client.close(); await server.close(); } });
  it("runs the natural-language read path and reports PDF transfer as disabled", async () => { const server = createV2BetaServer(studentClients()); const client = new Client({ name: "v2-conversation", version: "1" }); const [clientSide, serverSide] = InMemoryTransport.createLinkedPair(); try { await Promise.all([server.connect(serverSide), client.connect(clientSide)]); const overview = await client.callTool({ name: "student_classroom_overview", arguments: { courseQuery: "Java Basics", view: "missing" } }); expect(JSON.parse((overview.content as Array<{ text: string }>)[0]!.text).assignments[0].title).toBe("Past Due Lab"); const workspace = await client.callTool({ name: "get_assignment_workspace", arguments: { courseQuery: "Java Basics", assignmentQuery: "Inheritance" } }); expect(JSON.parse((workspace.content as Array<{ text: string }>)[0]!.text).assignment.title).toBe("Inheritance Practice"); const transfer = await client.callTool({ name: "save_assignment_pdf", arguments: {} }); expect(transfer.isError).toBe(true); expect(JSON.parse((transfer.content as Array<{ text: string }>)[0]!.text).error).toBe("external_file_transfer_unavailable"); const verification = await client.callTool({ name: "verify_assignment_submission", arguments: { courseQuery: "Java Basics", assignmentQuery: "Submitted Project" } }); expect(JSON.parse((verification.content as Array<{ text: string }>)[0]!.text)).toMatchObject({ workflowState: "TURNED_IN", submission: { state: "TURNED_IN" } }); } finally { await client.close(); await server.close(); } });
});
