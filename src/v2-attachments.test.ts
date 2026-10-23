import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { AttachmentAuthorizationStore } from "./v2/attachments.js";
import { AttachmentContentError, GoogleDriveAttachmentReader, MAX_ATTACHMENT_TEXT, MAX_PDF_PAGES } from "./v2/attachment-content.js";
import { prepareTeacherAttachment, readTeacherAttachment } from "./v2/attachment-workflow.js";
import { buildPickerUrl } from "./v2/urls.js";

const attachment = { kind: "drive_file" as const, title: "Inheritance notes.txt", driveFileId: "teacher-file" };

function driveFor(mimeType: string, body: string | Buffer, metadata: Record<string, unknown> = {}) {
  const get = vi.fn(async (params: any) => params.alt === "media"
    ? { data: Readable.from([body]) }
    : { data: { id: "teacher-file", name: "Inheritance notes.txt", mimeType, size: String(Buffer.byteLength(body)), trashed: false, ...metadata } });
  const exportFile = vi.fn(async () => ({ data: Readable.from([body]) }));
  return { files: { get, export: exportFile } } as any;
}

function syntheticTextPdf(text: string, pageCount = 1): Buffer {
  const objects = ["%PDF-1.4\n"];
  const offsets: number[] = [];
  const addObject = (id: number, body: string) => {
    offsets[id] = objects.join("").length;
    objects.push(`${id} 0 obj\n${body}\nendobj\n`);
  };
  const encodedText = Array.from(new TextEncoder().encode(text), (byte) => byte.toString(16).padStart(2, "0")).join("");
  // Hex-string text is intentionally unsupported by the literal-only fallback;
  // this assertion therefore proves the PDF.js parser path was used.
  const content = `BT /F1 12 Tf 72 720 Td <${encodedText}> Tj ET`;
  addObject(1, "<</Type/Catalog/Pages 2 0 R>>");
  const pageIds = Array.from({ length: pageCount }, (_, index) => index + 5);
  addObject(2, `<</Type/Pages/Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}]/Count ${pageCount}>>`);
  addObject(3, `<</Length ${content.length}>>\nstream\n${content}\nendstream`);
  addObject(4, "<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>");
  for (const id of pageIds) addObject(id, `<</Type/Page/Parent 2 0 R/MediaBox [0 0 612 792]/Resources <</Font <</F1 4 0 R>>>>/Contents 3 0 R>>`);
  const xrefOffset = objects.join("").length;
  const objectCount = pageCount + 5;
  objects.push(`xref\n0 ${objectCount}\n0000000000 65535 f \n`);
  for (let id = 1; id < objectCount; id += 1) objects.push(`${String(offsets[id]).padStart(10, "0")} 00000 n \n`);
  objects.push(`trailer\n<</Size ${objectCount}/Root 1 0 R>>\nstartxref\n${xrefOffset}\n%%EOF`);
  return Buffer.from(objects.join(""), "latin1");
}

function betaClients(options: { now?: () => number; mimeType?: string; body?: string | Buffer; subject?: string } = {}) {
  const work = { id: "w1", courseId: "c1", title: "Inheritance Assignment", workType: "ASSIGNMENT", materials: [{ driveFile: { driveFile: { id: "teacher-file", title: "Inheritance notes.txt" } } }] };
  const classroom = { courses: {
    list: vi.fn(async () => ({ data: { courses: [{ id: "c1", name: "Java Lab", courseState: "ACTIVE" }] } })),
    courseWork: {
      list: vi.fn(async () => ({ data: { courseWork: [work] } })),
      get: vi.fn(async () => ({ data: work })),
    },
  } } as any;
  const drive = driveFor(options.mimeType ?? "text/plain", options.body ?? "Teacher lesson content");
  const authorizations = new AttachmentAuthorizationStore(1_000, options.now);
  return {
    classroom,
    drive,
    subject: options.subject ?? "student-a",
    attachmentAccess: { authorizations, reader: new GoogleDriveAttachmentReader(drive), pickerUrl: (id: string) => `http://127.0.0.1:8792/picker/${id}` },
  } as any;
}

describe("V2 explicit teacher attachment authorization", () => {
  it("normalizes configured origins and keeps a fresh authorization valid for its TTL", async () => {
    expect(buildPickerUrl("https://classroom.jarvis404.com/", "opaque")).toBe("https://classroom.jarvis404.com/picker/opaque");
    let now = 1_700_000_000_000;
    const store = new AttachmentAuthorizationStore(600_000, () => now);
    const created = store.create({ subject: "student-a", courseId: "c1", courseWorkId: "w1", attachment });
    expect(created.expiresAt).toBe(now + 600_000);
    expect(store.lookup(created.id)?.status).toBe("pending");
    now += 599_999;
    expect(store.lookup(created.id)?.status).toBe("pending");
  });
  it("discovers a teacher file and prepares a natural, opaque Picker request", async () => {
    const clients = betaClients();
    const result = await prepareTeacherAttachment(clients, { courseQuery: "Java", assignmentQuery: "Inheritance" });
    expect(result).toMatchObject({ state: "ATTACHMENT_AUTHORIZATION_REQUIRED", assignment: { title: "Inheritance Assignment" }, attachment: { title: "Inheritance notes.txt", contentAccess: "metadata_only" } });
    expect(result.authorization).toMatchObject({ url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:8792\/picker\//) });
    expect(JSON.stringify(result)).not.toContain("teacher-file");
  });

  it("cannot read before authorization, then reads only the bound selected file", async () => {
    const clients = betaClients();
    const prepared = await prepareTeacherAttachment(clients, { assignmentQuery: "Inheritance" }) as any;
    await expect(readTeacherAttachment(clients, prepared.authorization.id)).rejects.toMatchObject({ code: "authorization_required" });
    clients.attachmentAccess.authorizations.complete(prepared.authorization.id, "student-a", "teacher-file");
    await expect(readTeacherAttachment(clients, prepared.authorization.id)).resolves.toMatchObject({ kind: "text", text: "Teacher lesson content", assignmentTitle: "Inheritance Assignment" });
  });

  it("handles denial, expiry, wrong file, and cross-user access without leaking identity", async () => {
    let now = 1_000;
    const clients = betaClients({ now: () => now });
    const denied = await prepareTeacherAttachment(clients, { assignmentQuery: "Inheritance" }) as any;
    clients.attachmentAccess.authorizations.complete(denied.authorization.id, "student-a");
    await expect(readTeacherAttachment(clients, denied.authorization.id)).rejects.toMatchObject({ code: "authorization_denied" });
    const wrong = await prepareTeacherAttachment(clients, { assignmentQuery: "Inheritance" }) as any;
    expect(() => clients.attachmentAccess.authorizations.complete(wrong.authorization.id, "student-a", "arbitrary-file")).toThrowError(/Select the attachment/);
    await expect(readTeacherAttachment({ ...clients, subject: "student-b" }, wrong.authorization.id)).rejects.toMatchObject({ code: "authorization_not_found" });
    now = 5_000;
    await expect(readTeacherAttachment(clients, wrong.authorization.id)).rejects.toMatchObject({ code: "authorization_expired" });
  });
});

describe("V2 authorized attachment content", () => {
  it("extracts text from a PDF using the Worker-compatible PDF.js build", async () => {
    const pdf = syntheticTextPdf("Synthetic worker PDF text");
    const result = await new GoogleDriveAttachmentReader(driveFor("application/pdf", pdf)).read(attachment);
    expect(result.kind).toBe("text");
    if (result.kind === "text") expect(result.text).toContain("Synthetic worker PDF text");
  });

  it("bounds PDF extraction by page count and output length", async () => {
    const pdf = syntheticTextPdf("bounded page text ".repeat(20), MAX_PDF_PAGES + 1);
    const result = await new GoogleDriveAttachmentReader(driveFor("application/pdf", pdf)).read(attachment);
    expect(result.kind).toBe("text");
    if (result.kind === "text") {
      expect(result.text.length).toBeLessThanOrEqual(MAX_ATTACHMENT_TEXT);
      expect(result.truncated).toBe(true);
    }
  });

  it.each([
    ["application/vnd.google-apps.document", "text/plain"],
    ["application/vnd.google-apps.presentation", "text/plain"],
    ["application/vnd.google-apps.spreadsheet", "text/csv"],
  ])("exports %s using %s", async (mimeType, exportMime) => {
    const drive = driveFor(mimeType, "exported teacher content");
    const result = await new GoogleDriveAttachmentReader(drive).read(attachment);
    expect(result).toMatchObject({ kind: "text", text: "exported teacher content", sourceMimeType: mimeType, extractedMimeType: exportMime });
    expect(drive.files.export).toHaveBeenCalledWith({ fileId: "teacher-file", mimeType: exportMime }, { responseType: "stream" });
  });

  it("rejects unsupported, malformed, oversized, inaccessible, and failed files predictably", async () => {
    await expect(new GoogleDriveAttachmentReader(driveFor("application/zip", "PK")).read(attachment)).rejects.toMatchObject({ code: "unsupported_mime", message: "This attachment type is not supported." });
    await expect(new GoogleDriveAttachmentReader(driveFor("application/pdf", "not a pdf")).read(attachment)).rejects.toMatchObject({ code: "malformed_attachment" });
    await expect(new GoogleDriveAttachmentReader(driveFor("text/plain", "too large"), { maxBytes: 3 }).read(attachment)).rejects.toMatchObject({ code: "attachment_too_large", message: "The attachment exceeds the supported size limit." });
    const inaccessible = driveFor("text/plain", "x"); inaccessible.files.get.mockRejectedValue({ response: { status: 403 } });
    await expect(new GoogleDriveAttachmentReader(inaccessible).read(attachment)).rejects.toMatchObject({ code: "attachment_inaccessible" });
    const failed = driveFor("text/plain", "x"); failed.files.get.mockRejectedValue(new Error("secret diagnostic"));
    await expect(new GoogleDriveAttachmentReader(failed).read(attachment)).rejects.toMatchObject({ code: "attachment_read_failed", message: "Classroom Desk could not read the selected attachment." });
  });

  it("uses a neutral message when attachment reading is unavailable", async () => {
    const clients = betaClients();
    delete clients.attachmentAccess;
    await expect(readTeacherAttachment(clients, "opaque-authorization-id")).rejects.toMatchObject({
      code: "attachment_beta_unavailable",
      message: "Teacher attachment reading is not configured for this connection.",
    });
  });
});
