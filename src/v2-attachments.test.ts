import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { AttachmentAuthorizationStore } from "./v2/attachments.js";
import { AttachmentContentError, GoogleDriveAttachmentReader } from "./v2/attachment-content.js";
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
  it("normalizes beta origins and keeps a fresh authorization valid for its TTL", async () => {
    expect(buildPickerUrl("https://beta.classroom.jarvis404.com/", "opaque")).toBe("https://beta.classroom.jarvis404.com/picker/opaque");
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
    await expect(new GoogleDriveAttachmentReader(driveFor("application/zip", "PK")).read(attachment)).rejects.toMatchObject({ code: "unsupported_mime" });
    await expect(new GoogleDriveAttachmentReader(driveFor("application/pdf", "not a pdf")).read(attachment)).rejects.toMatchObject({ code: "malformed_attachment" });
    await expect(new GoogleDriveAttachmentReader(driveFor("text/plain", "too large"), { maxBytes: 3 }).read(attachment)).rejects.toMatchObject({ code: "attachment_too_large" });
    const inaccessible = driveFor("text/plain", "x"); inaccessible.files.get.mockRejectedValue({ response: { status: 403 } });
    await expect(new GoogleDriveAttachmentReader(inaccessible).read(attachment)).rejects.toMatchObject({ code: "attachment_inaccessible" });
    const failed = driveFor("text/plain", "x"); failed.files.get.mockRejectedValue(new Error("secret diagnostic"));
    await expect(new GoogleDriveAttachmentReader(failed).read(attachment)).rejects.toMatchObject({ code: "attachment_read_failed", message: "Classroom Desk could not read the selected attachment." });
  });
});
