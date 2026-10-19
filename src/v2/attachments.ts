import type { classroom_v1 } from "@googleapis/classroom";
import { randomBytes } from "node:crypto";
import type { PostgresPublicAuthStore } from "../public/postgres.js";

export type AttachmentKind = "drive_file" | "link" | "youtube" | "form" | "unknown";
export type AttachmentAccess = "metadata_only" | "link_available" | "picker_authorized";

export type DiscoveredAttachment = {
  kind: AttachmentKind;
  title: string;
  url?: string;
  driveFileId?: string;
};

export type PublicAttachmentMetadata = {
  kind: AttachmentKind;
  title: string;
  url?: string;
  contentAccess: "metadata_only" | "link_available";
  contentUnavailableReason?: string;
  futureAuthorizationPath?: string;
};

export type AttachmentAuthorization = {
  access: AttachmentAccess;
  readableByClassroomDesk: boolean;
  reason: string;
};

const clean = (value: unknown, fallback: string): string => typeof value === "string" && value.trim() ? value.trim().slice(0, 300) : fallback;
const safeUrl = (value: unknown): string | undefined => {
  if (typeof value !== "string" || value.length > 1_500) return undefined;
  try { const url = new URL(value); return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.toString() : undefined; }
  catch { return undefined; }
};

/** Discover attachment references from Classroom metadata. This does not authorize content access. */
export function discoverAttachments(materials: classroom_v1.Schema$Material[] | null | undefined): DiscoveredAttachment[] {
  return (materials ?? []).map((material) => {
    const drive = material.driveFile?.driveFile;
    if (drive) return { kind: "drive_file", title: clean(drive.title, "Classroom attachment"), ...(safeUrl(drive.alternateLink) ? { url: safeUrl(drive.alternateLink) } : {}), ...(drive.id ? { driveFileId: drive.id } : {}) };
    if (material.link) return { kind: "link", title: clean(material.link.title, "Link"), ...(safeUrl(material.link.url) ? { url: safeUrl(material.link.url) } : {}) };
    if (material.youtubeVideo) return { kind: "youtube", title: clean(material.youtubeVideo.title, "YouTube video"), ...(safeUrl(material.youtubeVideo.alternateLink) ? { url: safeUrl(material.youtubeVideo.alternateLink) } : {}) };
    if (material.form) return { kind: "form", title: clean(material.form.title, "Google Form"), ...(safeUrl(material.form.formUrl) ? { url: safeUrl(material.form.formUrl) } : {}) };
    return { kind: "unknown", title: "Classroom material" };
  });
}

/** Resolve a human attachment name without guessing when multiple items match. */
export function resolveAttachment(attachments: DiscoveredAttachment[], query: string): { status: "resolved"; attachment: DiscoveredAttachment } | { status: "not_found" | "ambiguous"; candidates: string[] } {
  const needle = query.normalize("NFKC").toLocaleLowerCase().trim();
  const exact = attachments.filter((item) => item.title.normalize("NFKC").toLocaleLowerCase() === needle);
  const matches = exact.length ? exact : attachments.filter((item) => item.title.normalize("NFKC").toLocaleLowerCase().includes(needle));
  if (matches.length === 1) return { status: "resolved", attachment: matches[0]! };
  return { status: matches.length ? "ambiguous" : "not_found", candidates: matches.slice(0, 10).map((item) => item.title) };
}

/** Decide whether the current grant authorizes content. Classroom references alone never grant Drive access. */
export function authorizeAttachmentAccess(attachment: DiscoveredAttachment, pickerAuthorizedDriveFileIds: ReadonlySet<string> = new Set()): AttachmentAuthorization {
  if (attachment.kind !== "drive_file") return { access: "link_available", readableByClassroomDesk: false, reason: "The external resource link is available, but Classroom Desk does not fetch arbitrary web content." };
  if (attachment.driveFileId && pickerAuthorizedDriveFileIds.has(attachment.driveFileId)) return { access: "picker_authorized", readableByClassroomDesk: true, reason: "The student explicitly selected this Drive file for the app through Google Picker." };
  return { access: "metadata_only", readableByClassroomDesk: false, reason: "drive.file does not authorize an existing teacher-owned file merely because Classroom references it." };
}

/** Convert internal references to safe student-facing metadata without exposing Drive IDs. */
export function publicAttachmentMetadata(materials: classroom_v1.Schema$Material[] | null | undefined): PublicAttachmentMetadata[] {
  return discoverAttachments(materials).map((attachment) => {
    const authorization = authorizeAttachmentAccess(attachment);
    if (attachment.kind !== "drive_file") return { kind: attachment.kind, title: attachment.title, ...(attachment.url ? { url: attachment.url } : {}), contentAccess: "link_available" };
    return { kind: attachment.kind, title: attachment.title, ...(attachment.url ? { url: attachment.url } : {}), contentAccess: "metadata_only", contentUnavailableReason: authorization.reason, futureAuthorizationPath: "Explicit Google Picker selection with drive.file is the narrowest next step. Automatic access to every teacher file would require a separately reviewed drive.readonly tier." };
  });
}

export interface AttachmentContentProvider {
  fetchAuthorizedContent(attachment: DiscoveredAttachment): Promise<{ mimeType: string; bytes: Uint8Array; fileName: string }>;
}

export type PendingAttachmentAuthorization = {
  id: string;
  subject: string;
  courseId: string;
  courseWorkId: string;
  attachment: DiscoveredAttachment;
  expiresAt: number;
  status: "pending" | "authorized" | "denied";
};

export class AttachmentAuthorizationError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}

/**
 * Short-lived, in-memory Picker state. The model only
 * receives the opaque id; the Drive id remains bound to Classroom metadata.
 */
export class AttachmentAuthorizationStore {
  private readonly records = new Map<string, PendingAttachmentAuthorization>();

  constructor(private readonly ttlMs = 10 * 60_000, private readonly now = () => Date.now()) {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error("Attachment authorization TTL must be positive.");
  }

  create(input: Omit<PendingAttachmentAuthorization, "id" | "expiresAt" | "status">): PendingAttachmentAuthorization {
    if (input.attachment.kind !== "drive_file" || !input.attachment.driveFileId) {
      throw new AttachmentAuthorizationError("unsupported_attachment", "Only a Classroom Drive attachment can be authorized through Google Picker.");
    }
    const record: PendingAttachmentAuthorization = {
      ...input,
      id: randomBytes(24).toString("base64url"),
      // All internal expiry values are UTC epoch milliseconds. Never mix
      // OAuth seconds or Date strings into the comparison path.
      expiresAt: Math.trunc(this.now()) + Math.trunc(this.ttlMs),
      status: "pending",
    };
    this.records.set(record.id, record);
    return { ...record, attachment: { ...record.attachment } };
  }

  complete(id: string, subject: string, selectedDriveFileId?: string): void {
    const record = this.getActive(id, subject);
    if (!selectedDriveFileId) {
      record.status = "denied";
      return;
    }
    if (selectedDriveFileId !== record.attachment.driveFileId) {
      throw new AttachmentAuthorizationError("wrong_file", "Select the attachment shown for this Classroom assignment.");
    }
    record.status = "authorized";
  }

  requirePending(id: string, subject: string): PendingAttachmentAuthorization {
    const record = this.getActive(id, subject);
    if (record.status !== "pending") {
      throw new AttachmentAuthorizationError("authorization_not_pending", "This file authorization is no longer awaiting a Google Picker selection.");
    }
    return { ...record, attachment: { ...record.attachment } };
  }

  requireAuthorized(id: string, subject: string): PendingAttachmentAuthorization {
    const record = this.getActive(id, subject);
    if (record.status === "denied") throw new AttachmentAuthorizationError("authorization_denied", "The file remains inaccessible because authorization was declined.");
    if (record.status !== "authorized") throw new AttachmentAuthorizationError("authorization_required", "Explicit Google file authorization is still required.");
    return { ...record, attachment: { ...record.attachment } };
  }

  /** Internal beta-runtime lookup used only after the opaque callback state is validated. */
  lookup(id: string): PendingAttachmentAuthorization | undefined {
    const record = this.records.get(id);
    if (!record || record.expiresAt <= this.now()) { if (record) this.records.delete(id); return undefined; }
    return { ...record, attachment: { ...record.attachment } };
  }

  private getActive(id: string, subject: string): PendingAttachmentAuthorization {
    const record = this.records.get(id);
    if (!record || record.subject !== subject) {
      throw new AttachmentAuthorizationError("authorization_not_found", "This file authorization is unavailable for the connected user.");
    }
    if (record.expiresAt <= this.now()) {
      this.records.delete(id);
      throw new AttachmentAuthorizationError("authorization_expired", "The file authorization expired. Ask to open the attachment again.");
    }
    return record;
  }
}

/** Durable beta variant: keeps opaque authorization state in the encrypted V2 Neon table. */
export class DurableAttachmentAuthorizationStore {
  constructor(private readonly store: PostgresPublicAuthStore, private readonly ttlMs = 10 * 60_000, private readonly now = () => Date.now()) {}
  async create(input: Omit<PendingAttachmentAuthorization, "id" | "expiresAt" | "status">) {
    if (input.attachment.kind !== "drive_file" || !input.attachment.driveFileId) throw new AttachmentAuthorizationError("unsupported_attachment", "Only a Classroom Drive attachment can be authorized through Google Picker.");
    const record: PendingAttachmentAuthorization = { ...input, id: randomBytes(24).toString("base64url"), expiresAt: Math.trunc(this.now()) + Math.trunc(this.ttlMs), status: "pending" };
    await this.store.putEphemeral("attachment", record.id, record, record.subject, record.expiresAt); return record;
  }
  async lookup(id: string) { const record = await this.store.getEphemeral<PendingAttachmentAuthorization>("attachment", id); return record && record.expiresAt > this.now() ? record : undefined; }
  async complete(id: string, subject: string, selectedDriveFileId?: string) {
    const record = await this.lookup(id); if (!record || record.subject !== subject) throw new AttachmentAuthorizationError("authorization_not_found", "This file authorization is unavailable for the connected user.");
    if (!selectedDriveFileId) { record.status = "denied"; } else if (selectedDriveFileId !== record.attachment.driveFileId) throw new AttachmentAuthorizationError("wrong_file", "Select the attachment shown for this Classroom assignment."); else record.status = "authorized";
    await this.store.putEphemeral("attachment", id, record, subject, record.expiresAt);
  }
  async requirePending(id: string, subject: string) { const record = await this.lookup(id); if (!record || record.subject !== subject || record.status !== "pending") throw new AttachmentAuthorizationError("authorization_not_pending", "This file authorization is no longer awaiting a Google Picker selection."); return record; }
  async requireAuthorized(id: string, subject: string) { const record = await this.lookup(id); if (!record || record.subject !== subject) throw new AttachmentAuthorizationError("authorization_not_found", "This file authorization is unavailable for the connected user."); if (record.status === "denied") throw new AttachmentAuthorizationError("authorization_denied", "The file remains inaccessible because authorization was declined."); if (record.status !== "authorized") throw new AttachmentAuthorizationError("authorization_required", "Explicit Google file authorization is still required."); return record; }
  async putPickerSession(id: string, verifier: string, expectedFileId: string) { await this.store.putEphemeral("picker_session", id, { verifier, expectedFileId }, id, Math.trunc(this.now()) + Math.trunc(this.ttlMs)); }
  async getPickerSession(id: string): Promise<{ verifier: string; expectedFileId: string } | undefined> { return this.store.getEphemeral("picker_session", id); }
  async takePickerSession(id: string): Promise<{ verifier: string; expectedFileId: string } | undefined> { return this.store.takeEphemeral("picker_session", id); }
  async putPickerGrant(subject: string, fileId: string, tokens: unknown, expiresAt: number) { await this.store.putEphemeral("picker_grant", `${subject}:${fileId}`, tokens, subject, expiresAt); }
  async getPickerGrant<T>(subject: string, fileId: string): Promise<T | undefined> { return this.store.getEphemeral<T>("picker_grant", `${subject}:${fileId}`); }
}
