import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { downloadPdf, V2FileError } from "./v2/files.js";
import { isDisallowedAddress } from "./v2/pinned-https.js";
import { EventEmitter } from "node:events";
import { createPinnedHttpsRequester } from "./v2/pinned-https.js";
import { getAssignmentContext, saveAssignmentPdf, verifySubmission } from "./v2/workflow.js";
import { V2_BETA_SCOPES } from "./v2/scopes.js";
import { attachmentMetadata, getAssignmentWorkspace, getStudentOverview, resolveStudentAssignment } from "./v2/student.js";
import { createV2BetaServer } from "./v2/server.js";
import { authorizeAttachmentAccess, discoverAttachments, resolveAttachment } from "./v2/attachments.js";

const lookup = vi.fn(async () => [{ address: "8.8.8.8", family: 4 as const }]);
const response = (body: string, headers: Record<string, string> = { "content-type": "application/pdf" }) => new Response(body, { status: 200, headers });

describe("V2 PDF handoff", () => {
  it("accepts a PDF and normalizes its filename", async () => { const got = await downloadPdf({ file_id: "test-file", download_url: "https://files.example.test/a", file_name: "../Final: answer.pdf", mime_type: "application/pdf" }, { lookup, fetchPinned: vi.fn(async () => response("%PDF-1.7\nbody")) }); expect(got.filename).toBe("-Final- answer.pdf"); expect(got.buffer.subarray(0, 5).toString()).toBe("%PDF-"); });
  it("rejects non-HTTPS, private, wrong MIME, fake and oversized files", async () => {
    await expect(downloadPdf({ file_id: "test-file", download_url: "http://example.test/a" }, { lookup })).rejects.toMatchObject({ code: "unsafe_url" });
    await expect(downloadPdf({ file_id: "test-file", download_url: "https://localhost/a" }, { lookup })).rejects.toBeInstanceOf(V2FileError);
    await expect(downloadPdf({ file_id: "test-file", download_url: "https://example.test/a" }, { lookup, fetchPinned: vi.fn(async () => response("%PDF-", { "content-type": "text/plain" })) })).rejects.toMatchObject({ code: "invalid_mime" });
    await expect(downloadPdf({ file_id: "test-file", download_url: "https://example.test/a" }, { lookup, fetchPinned: vi.fn(async () => response("not-pdf")) })).rejects.toMatchObject({ code: "invalid_pdf" });
    await expect(downloadPdf({ file_id: "test-file", download_url: "https://example.test/a" }, { lookup, maxBytes: 4, fetchPinned: vi.fn(async () => response("%PDF-123")) })).rejects.toMatchObject({ code: "too_large" });
  });
  it("blocks special-use IPv4, IPv6, mapped IPv4, metadata, and mixed DNS answers", async () => {
    for (const ip of ["0.0.0.0", "10.2.3.4", "100.64.0.1", "127.0.0.1", "169.254.169.254", "172.16.1.1", "192.168.1.1", "198.18.0.1", "224.0.0.1", "::", "::1", "fc00::1", "fe80::1", "::ffff:127.0.0.1", "2001:db8::1"]) expect(isDisallowedAddress(ip), ip).toBe(true);
    expect(isDisallowedAddress("2606:4700:4700::1111")).toBe(false);
    expect(isDisallowedAddress("::ffff:8.8.8.8")).toBe(false);
    const mixed = vi.fn(async () => [{ address: "8.8.8.8", family: 4 as const }, { address: "169.254.169.254", family: 4 as const }]);
    const request = vi.fn(async () => response("%PDF-1.7"));
    await expect(downloadPdf({ file_id: "test", download_url: "https://attacker.test/file" }, { lookup: mixed, fetchPinned: request })).rejects.toMatchObject({ code: "unsafe_url" });
    expect(request).not.toHaveBeenCalled();
  });
  it("pins each redirect connection to that hop's validated DNS answer", async () => {
    const lookup = vi.fn(async (host: string) => [{ address: host === "files.example.test" ? "8.8.8.8" : "1.1.1.1", family: 4 as const }]);
    const request = vi.fn().mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "https://cdn.example.test/file" } })).mockResolvedValueOnce(response("%PDF-1.4"));
    const got = await downloadPdf({ file_id: "test-file", download_url: "https://files.example.test/file" }, { lookup, fetchPinned: request });
    expect(got.buffer.length).toBeGreaterThan(5);
    expect(request.mock.calls.map(([url, address]) => [url.hostname, address.address])).toEqual([["files.example.test", "8.8.8.8"], ["cdn.example.test", "1.1.1.1"]]);
  });
  it("revalidates and blocks an unsafe redirect before opening its connection", async () => {
    const lookup = vi.fn(async (host: string) => [{ address: host === "files.example.test" ? "8.8.8.8" : "127.0.0.1", family: 4 as const }]);
    const request = vi.fn(async () => new Response(null, { status: 302, headers: { location: "https://internal.example.test/admin" } }));
    await expect(downloadPdf({ file_id: "test", download_url: "https://files.example.test/file" }, { lookup, fetchPinned: request })).rejects.toMatchObject({ code: "unsafe_url" });
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("connects to the pinned address while retaining the original TLS hostname", async () => {
    const socket = new EventEmitter() as EventEmitter & { authorized: boolean; remoteAddress: string; setTimeout: (ms: number, callback: () => void) => void; destroy: () => void; write: (data: string) => void };
    socket.authorized = true; socket.remoteAddress = "8.8.8.8"; socket.setTimeout = () => {}; socket.destroy = () => {}; socket.write = vi.fn();
    const connect = vi.fn(() => { queueMicrotask(() => { socket.emit("secureConnect"); socket.emit("data", Buffer.from("HTTP/1.1 200 OK\r\nContent-Type: application/pdf\r\nContent-Length: 8\r\nConnection: close\r\n\r\n%PDF-1.4")); socket.emit("end"); }); return socket; });
    const request = createPinnedHttpsRequester(connect as any);
    const result = await request(new URL("https://files.example.test/assignment.pdf?sig=redacted"), { address: "8.8.8.8", family: 4 }, new AbortController().signal, 1024);
    expect(connect).toHaveBeenCalledWith(expect.objectContaining({ host: "8.8.8.8", port: 443, servername: "files.example.test", rejectUnauthorized: true }));
    expect(socket.write).toHaveBeenCalledWith(expect.stringContaining("GET /assignment.pdf?sig=redacted HTTP/1.1"));
    expect(socket.write).toHaveBeenCalledWith(expect.stringContaining("Host: files.example.test"));
    expect(await result.text()).toBe("%PDF-1.4");
  });
  it("keeps the V2 scope delta isolated", () => { expect(V2_BETA_SCOPES).toContain("https://www.googleapis.com/auth/drive.file"); expect(V2_BETA_SCOPES).not.toContain("https://www.googleapis.com/auth/drive.readonly"); });
});

function clients() {
  const submission = { id: "s1", state: "TURNED_IN", updateTime: "2026-01-01T00:00:00Z" };
  const classroom = { courses: { get: vi.fn(async () => ({ data: { id: "c1", name: "Demo course" } })), courseWork: { get: vi.fn(async () => ({ data: { id: "w1", courseId: "c1", title: "Assignment 4", workType: "ASSIGNMENT" } })), studentSubmissions: { list: vi.fn(async () => ({ data: { studentSubmissions: [submission] } })) } } } } as any;
  const drive = { files: { create: vi.fn(async () => ({ data: { id: "f1", name: "Assignment-Desk.pdf", mimeType: "application/pdf", webViewLink: "https://drive.google.com/file/d/f1/view" } })) } } as any;
  return { classroom, drive, subject: "subject-a", downloadOptions: { lookup, fetchPinned: vi.fn(async () => response("%PDF-1.7\nbody")) } };
}

describe("V2 Classroom workflow", () => {
  it("binds upload to the supplied assignment and returns a polished manual handoff", async () => { const c = clients(); const result = await saveAssignmentPdf(c, { courseId: "c1", courseWorkId: "w1", confirmUpload: true, file: { file_id: "test-file", download_url: "https://files.example.test/a", file_name: "Assignment.pdf" } }); expect(result).toMatchObject({ status: "uploaded", fileState: "FILE_SAVED_TO_DRIVE", workflowState: "WAITING_FOR_STUDENT_SUBMISSION" }); expect(result.message).toMatch(/Assignment-Desk\.pdf/); expect(result.limitation).toMatch(/cannot attach/i); expect(result).not.toHaveProperty("submission"); expect(c.drive.files.create).toHaveBeenCalledTimes(1); });
  it("does not upload when the student declines", async () => { const c = clients(); await expect(saveAssignmentPdf(c, { courseId: "c1", courseWorkId: "w1", confirmUpload: false, file: { file_id: "test-file", download_url: "https://files.example.test/a" } })).rejects.toMatchObject({ code: "confirmation_required" }); expect(c.drive.files.create).not.toHaveBeenCalled(); });
  it("returns a sanitized Drive failure", async () => { const c = clients(); c.drive.files.create.mockRejectedValue({ response: { status: 503 } }); await expect(saveAssignmentPdf(c, { courseId: "c1", courseWorkId: "w1", confirmUpload: true, file: { file_id: "test-file", download_url: "https://files.example.test/a" } })).rejects.toMatchObject({ code: "google_unavailable" }); });
  it("reports factual submission state", async () => { const result = await verifySubmission(clients(), "c1", "w1"); expect(result).toMatchObject({ submission: { state: "TURNED_IN" } }); });
  it("rejects a coursework/course mismatch", async () => { const c = clients(); c.classroom.courses.courseWork.get.mockResolvedValue({ data: { id: "w1", courseId: "other", title: "Wrong", workType: "ASSIGNMENT" } }); await expect(getAssignmentContext(c, "c1", "w1")).rejects.toMatchObject({ code: "invalid_context" }); });
});

function studentClients() {
  const courses = [{ id: "c1", name: "Java Basics", courseState: "ACTIVE" }, { id: "c2", name: "Advanced Java", courseState: "ACTIVE" }];
  const work = {
    c1: [
      { id: "w1", courseId: "c1", title: "Inheritance Practice", description: "Practice inheritance", workType: "ASSIGNMENT", updateTime: "2026-01-01T10:00:00Z", dueDate: { year: 2026, month: 1, day: 3 }, materials: [{ driveFile: { driveFile: { id: "teacher-file", title: "Inheritance.pdf", alternateLink: "https://drive.google.com/file/d/teacher-file/view" } } }] },
      { id: "w2", courseId: "c1", title: "Past Due Lab", workType: "ASSIGNMENT", updateTime: "2025-12-30T10:00:00Z", dueDate: { year: 2025, month: 12, day: 31 } },
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
  return { classroom, drive, subject: "connected-subject", downloadOptions: { lookup, fetchPinned: vi.fn(async () => response("%PDF-1.7\nbody")) }, submissionCalls };
}

describe("V2 conversational student experience", () => {
  it("covers due-soon, missing, submitted and returned views", async () => {
    const c = studentClients(); const now = new Date("2026-01-02T12:00:00Z");
    expect((await getStudentOverview(c, { courseQuery: "Java Basics", view: "due_soon", days: 7 }, { now })).assignments.map((item) => item.title)).toEqual(["Inheritance Practice"]);
    expect((await getStudentOverview(c, { courseQuery: "Java Basics", view: "missing" }, { now })).assignments.map((item) => item.title)).toEqual(["Past Due Lab"]);
    expect((await getStudentOverview(c, { courseQuery: "Java Basics", view: "submitted" }, { now })).assignments.map((item) => item.title)).toEqual(["Submitted Project"]);
    expect((await getStudentOverview(c, { courseQuery: "Java Basics", view: "returned" }, { now })).assignments.map((item) => item.title)).toEqual(["Returned Essay"]);
  });
  it("returns empty assignment results without inventing work", async () => { const c = studentClients(); c.classroom.courses.courseWork.list.mockResolvedValue({ data: { courseWork: [] } }); const result = await getStudentOverview(c, { courseQuery: "Java Basics" }); expect(result.assignments).toEqual([]); expect(result.summary.assignments).toBe(0); });
  it("searches announcements, topics and material metadata", async () => { const result = await getStudentOverview(studentClients(), { courseQuery: "Java Basics", searchQuery: "inheritance" }); expect(result.assignments[0]?.title).toBe("Inheritance Practice"); expect(result.courseMaterials[0]?.title).toBe("Inheritance notes"); const catchUp = await getStudentOverview(studentClients(), { courseQuery: "Java Basics", view: "recent" }); expect(catchUp.topics[0]?.name).toMatch(/object-oriented/i); expect(catchUp.announcements[0]?.text).toMatch(/Friday/); expect(catchUp.recentActivity.length).toBeGreaterThan(0); });
  it("reports teacher Drive attachments as metadata-only", async () => { const workspace = await getAssignmentWorkspace(studentClients(), { courseQuery: "Java Basics", assignmentQuery: "Inheritance Practice" }); expect(workspace.assignment.attachments[0]).toMatchObject({ kind: "drive_file", title: "Inheritance.pdf", contentAccess: "metadata_only" }); expect(workspace.attachmentPolicy.arbitraryTeacherFileContentAvailable).toBe(false); });
  it("resolves names and safely rejects ambiguous assignments", async () => { const resolved = await resolveStudentAssignment(studentClients(), { courseQuery: "Java Basics", assignmentQuery: "Inheritance" }); expect(resolved.coursework.id).toBe("w1"); await expect(resolveStudentAssignment(studentClients(), { assignmentQuery: "Inheritance Practice" })).rejects.toMatchObject({ code: "ambiguous_assignment" }); });
  it("binds submission reads to userId me", async () => { const c = studentClients(); await getStudentOverview(c, { courseQuery: "Java Basics" }); expect(c.submissionCalls.every((call) => call.userId === "me")).toBe(true); });
  it("allows a newly published assignment with no submission yet", async () => { const c = studentClients(); c.classroom.courses.courseWork.studentSubmissions.list.mockResolvedValue({ data: {} }); const workspace = await getAssignmentWorkspace(c, { courseQuery: "Java Basics", assignmentQuery: "Inheritance" }); expect(workspace.submission.state).toBe("ASSIGNED"); });
  it("classifies non-Drive material types without claiming file content", () => { expect(attachmentMetadata([{ link: { title: "Site", url: "https://example.com" } }, { youtubeVideo: { title: "Video", alternateLink: "https://youtube.com/watch?v=x" } }, { form: { title: "Quiz", formUrl: "https://docs.google.com/forms/d/x" } }])).toMatchObject([{ kind: "link", contentAccess: "link_available" }, { kind: "youtube", contentAccess: "link_available" }, { kind: "form", contentAccess: "link_available" }]); });
  it("keeps attachment discovery, resolution and authorization separate", () => { const found = discoverAttachments([{ driveFile: { driveFile: { id: "teacher-file", title: "Lesson.pdf" } } }]); expect(resolveAttachment(found, "Lesson")).toMatchObject({ status: "resolved" }); expect(authorizeAttachmentAccess(found[0]!)).toMatchObject({ access: "metadata_only", readableByClassroomDesk: false }); expect(authorizeAttachmentAccess(found[0]!, new Set(["teacher-file"]))).toMatchObject({ access: "picker_authorized", readableByClassroomDesk: true }); });
  it("exposes four read orchestrators and two bounded workflow tools", async () => { const server = createV2BetaServer(studentClients()); const client = new Client({ name: "v2-contract", version: "1" }); const [clientSide, serverSide] = InMemoryTransport.createLinkedPair(); try { await Promise.all([server.connect(serverSide), client.connect(clientSide)]); const { tools } = await client.listTools(); expect(tools.map((tool) => tool.name)).toEqual(["student_classroom_overview", "get_assignment_workspace", "prepare_teacher_attachment", "read_teacher_attachment", "save_assignment_pdf", "verify_assignment_submission"]); expect(tools.find((tool) => tool.name === "save_assignment_pdf")?.annotations?.readOnlyHint).toBe(false); expect(tools.filter((tool) => tool.name !== "save_assignment_pdf").every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true); } finally { await client.close(); await server.close(); } });
  it("exposes account activation guidance without classroom data", async () => { const server = createV2BetaServer(studentClients(), { accountStatus: vi.fn(async () => ({ state: "ACCOUNT_SETUP_REQUIRED", message: "Start at https://classroom.jarvis404.com/login.", activationUrl: "https://classroom.jarvis404.com/login", billingUrl: "https://classroom.jarvis404.com/app/billing", settingsUrl: "https://classroom.jarvis404.com/app/settings", plan: null, expiresAt: null })) }); const client = new Client({ name: "account-contract", version: "1" }); const [clientSide, serverSide] = InMemoryTransport.createLinkedPair(); try { await Promise.all([server.connect(serverSide), client.connect(clientSide)]); const { tools } = await client.listTools(); expect(tools.map((tool) => tool.name)).toContain("check_account_activation"); const result = await client.callTool({ name: "check_account_activation", arguments: {} }); expect(JSON.parse((result.content as Array<{ text: string }>)[0]!.text)).toMatchObject({ state: "ACCOUNT_SETUP_REQUIRED", activationUrl: "https://classroom.jarvis404.com/login" }); } finally { await client.close(); await server.close(); } });
  it("runs the natural-language tool path without caller-supplied IDs", async () => { const server = createV2BetaServer(studentClients()); const client = new Client({ name: "v2-conversation", version: "1" }); const [clientSide, serverSide] = InMemoryTransport.createLinkedPair(); try { await Promise.all([server.connect(serverSide), client.connect(clientSide)]); const overview = await client.callTool({ name: "student_classroom_overview", arguments: { courseQuery: "Java Basics", view: "missing" } }); expect(JSON.parse((overview.content as Array<{ text: string }>)[0]!.text).assignments[0].title).toBe("Past Due Lab"); const workspace = await client.callTool({ name: "get_assignment_workspace", arguments: { courseQuery: "Java Basics", assignmentQuery: "Inheritance" } }); expect(JSON.parse((workspace.content as Array<{ text: string }>)[0]!.text).assignment.title).toBe("Inheritance Practice"); const upload = await client.callTool({ name: "save_assignment_pdf", arguments: { courseQuery: "Java Basics", assignmentQuery: "Inheritance", confirmUpload: true, file: { file_id: "test-file", download_url: "https://files.example.test/a", file_name: "Final.pdf", mime_type: "application/pdf" } } }); expect(JSON.parse((upload.content as Array<{ text: string }>)[0]!.text)).toMatchObject({ fileState: "FILE_SAVED_TO_DRIVE", workflowState: "WAITING_FOR_STUDENT_SUBMISSION" }); const verification = await client.callTool({ name: "verify_assignment_submission", arguments: { courseQuery: "Java Basics", assignmentQuery: "Submitted Project" } }); expect(JSON.parse((verification.content as Array<{ text: string }>)[0]!.text)).toMatchObject({ workflowState: "TURNED_IN", submission: { state: "TURNED_IN" } }); } finally { await client.close(); await server.close(); } });
});
