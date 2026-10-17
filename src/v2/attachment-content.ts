import { parseOffice } from "officeparser";
import type { drive_v3 } from "@googleapis/drive";
import type { DiscoveredAttachment } from "./attachments.js";

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_ATTACHMENT_TEXT = 120_000;

const GOOGLE_DOC = "application/vnd.google-apps.document";
const GOOGLE_SLIDES = "application/vnd.google-apps.presentation";
const GOOGLE_SHEETS = "application/vnd.google-apps.spreadsheet";
const PDF = "application/pdf";
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export type ReadableAttachmentContent =
  | { kind: "text"; fileName: string; sourceMimeType: string; extractedMimeType: string; text: string; truncated: boolean }
  | { kind: "image"; fileName: string; sourceMimeType: string; extractedMimeType: string; bytes: Uint8Array };

export class AttachmentContentError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}

function safeName(value: unknown): string {
  const cleaned = (typeof value === "string" ? value : "Teacher attachment").normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/g, "").replace(/[<>:"/\\|?*]/g, "-").trim().slice(0, 140);
  return cleaned || "Teacher attachment";
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new AttachmentContentError("google_timeout", "Google Drive did not respond in time.")), timeoutMs);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}

async function boundedStream(stream: unknown, maxBytes: number): Promise<Buffer> {
  if (stream instanceof Uint8Array) {
    if (stream.byteLength > maxBytes) throw new AttachmentContentError("attachment_too_large", "The attachment is larger than the private beta safety limit.");
    return Buffer.from(stream);
  }
  if (stream instanceof ArrayBuffer) {
    if (stream.byteLength > maxBytes) throw new AttachmentContentError("attachment_too_large", "The attachment is larger than the private beta safety limit.");
    return Buffer.from(new Uint8Array(stream));
  }
  if (stream && typeof (stream as { getReader?: unknown }).getReader === "function") {
    const reader = (stream as ReadableStream<Uint8Array>).getReader(); const chunks: Buffer[] = []; let size = 0;
    try { for (;;) { const part = await reader.read(); if (part.done) break; const bytes = Buffer.from(part.value); size += bytes.length; if (size > maxBytes) throw new AttachmentContentError("attachment_too_large", "The attachment is larger than the private beta safety limit."); chunks.push(bytes); } }
    finally { reader.releaseLock(); }
    return Buffer.concat(chunks);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  if (!stream || typeof (stream as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] !== "function") throw new AttachmentContentError("attachment_read_failed", "Classroom Desk could not read the selected attachment.");
  for await (const chunk of stream as AsyncIterable<unknown>) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as unknown as Uint8Array);
    size += part.length;
    if (size > maxBytes) throw new AttachmentContentError("attachment_too_large", "The attachment is larger than the private beta safety limit.");
    chunks.push(part);
  }
  return Buffer.concat(chunks);
}

function validateMagic(mimeType: string, buffer: Buffer): void {
  if (mimeType === PDF && buffer.subarray(0, 5).toString() !== "%PDF-") throw new AttachmentContentError("malformed_attachment", "The selected file does not contain a valid PDF signature.");
  if ([DOCX, PPTX, XLSX].includes(mimeType) && buffer.subarray(0, 2).toString() !== "PK") throw new AttachmentContentError("malformed_attachment", "The selected Office file is malformed.");
  if (mimeType === "image/png" && !buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new AttachmentContentError("malformed_attachment", "The selected PNG image is malformed.");
  if (mimeType === "image/jpeg" && !(buffer[0] === 0xff && buffer[1] === 0xd8)) throw new AttachmentContentError("malformed_attachment", "The selected JPEG image is malformed.");
  if (mimeType === "image/gif" && !["GIF87a", "GIF89a"].includes(buffer.subarray(0, 6).toString())) throw new AttachmentContentError("malformed_attachment", "The selected GIF image is malformed.");
  if (mimeType === "image/webp" && !(buffer.subarray(0, 4).toString() === "RIFF" && buffer.subarray(8, 12).toString() === "WEBP")) throw new AttachmentContentError("malformed_attachment", "The selected WebP image is malformed.");
}

function textResult(fileName: string, sourceMimeType: string, extractedMimeType: string, value: string): ReadableAttachmentContent {
  const normalized = value.replace(/\u0000/g, "");
  return { kind: "text", fileName, sourceMimeType, extractedMimeType, text: normalized.slice(0, MAX_ATTACHMENT_TEXT), truncated: normalized.length > MAX_ATTACHMENT_TEXT };
}

async function extractPdfText(buffer: Buffer): Promise<string> {
  // Keep pdfjs (and its DOMMatrix dependency) out of the Worker module
  // initialization path. The parser is loaded only when a PDF is actually
  // read, matching the existing bounded/validated attachment pipeline.
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try { return (await parser.getText()).text; }
  finally { await parser.destroy(); }
}

async function inflatePdfStream(bytes: Buffer, budget: { remaining: number }): Promise<Buffer> {
  let offset = 0;
  const input = new ReadableStream<BufferSource>({
    pull(controller) {
      if (offset === bytes.length) { controller.close(); return; }
      const end = Math.min(offset + 16 * 1024, bytes.length);
      controller.enqueue(new Uint8Array(bytes.subarray(offset, end)));
      offset = end;
    },
  });
  const reader = input.pipeThrough(new DecompressionStream("deflate")).getReader();
  const chunks: Buffer[] = []; let size = 0; let complete = false;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) { complete = true; break; }
      if (part.value.byteLength > budget.remaining) throw new AttachmentContentError("attachment_too_large", "The PDF exceeds the decompressed attachment safety limit.");
      // Charge emitted bytes even if the stream later fails checksum validation.
      budget.remaining -= part.value.byteLength;
      size += part.value.byteLength;
      chunks.push(Buffer.from(part.value));
    }
    return Buffer.concat(chunks, size);
  } finally {
    if (!complete) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

// Worker-safe fallback for simple text PDFs when pdfjs cannot initialize its optional
// Node canvas shims. It only extracts literal PDF text operators and never treats
// arbitrary binary bytes as document content.
async function extractPdfLiteralText(buffer: Buffer): Promise<string> {
  const raw = buffer.toString("latin1");
  const sources: string[] = [raw];
  const budget = { remaining: MAX_ATTACHMENT_BYTES };
  // ReportLab and most generated PDFs compress page content with FlateDecode.
  // Bound cumulative output while inflating, not after materializing it. A
  // budget failure must reject the document rather than return partial text.
  // The PDF line ending before endstream is not part of the zlib payload.
  for (const match of raw.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    if (match[1] === undefined) continue;
    let bytes = Buffer.from(match[1], "latin1");
    try {
      // ReportLab commonly applies ASCII85Decode before FlateDecode.
      const encoded = bytes.toString("latin1").replace(/\s/g, "");
      // Do not mistake binary zlib data for ASCII85 merely because some of its
      // bytes are printable. ReportLab uses the trailing ~> form.
      if (encoded.startsWith("<~") || encoded.endsWith("~>") || /^[!-uz]+$/.test(encoded)) {
        const ascii85 = encoded.replace(/^<~/, "").replace(/~>$/, "");
        const decoded = Buffer.alloc(Math.min(MAX_ATTACHMENT_BYTES, ascii85.length * 4));
        let decodedSize = 0;
        const append = (...values: number[]) => {
          if (decodedSize + values.length > decoded.length) throw new AttachmentContentError("attachment_too_large", "The PDF exceeds the decoded attachment safety limit.");
          decoded.set(values, decodedSize); decodedSize += values.length;
        };
        let group: number[] = [];
        for (const ch of ascii85) {
          if (ch === "~") break;
          if (ch === "z" && group.length === 0) { append(0, 0, 0, 0); continue; }
          const code = ch.charCodeAt(0) - 33;
          if (code < 0 || code > 84) continue;
          group.push(code);
          if (group.length === 5) { let value = 0; for (const digit of group) value = value * 85 + digit; append((value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255); group = []; }
        }
        if (group.length > 0) { const count = group.length; while (group.length < 5) group.push(84); let value = 0; for (const digit of group) value = value * 85 + digit; for (let i = 0; i < count - 1; i++) append((value >>> (24 - i * 8)) & 255); }
        bytes = decoded.subarray(0, decodedSize);
      }
      if (bytes.length > MAX_ATTACHMENT_BYTES) throw new AttachmentContentError("attachment_too_large", "The PDF exceeds the decoded attachment safety limit.");
      const inflated = await inflatePdfStream(bytes, budget);
      sources.push(inflated.toString("latin1"));
    } catch (error) {
      if (error instanceof AttachmentContentError) throw error;
      // Non-Flate streams are still represented in the raw literal-text pass.
    }
  }
  const values: string[] = [];
  for (const source of sources) for (const match of source.matchAll(/\((?:\\.|[^()\\])*\)\s*T[Jj]/g)) {
    const value = match[0].replace(/\)\s*T[Jj]$/, "").slice(1);
    values.push(value.replace(/\\([\\()nrt])/g, (_m, c) => ({ "n": "\n", "r": "\r", "t": "\t" } as Record<string, string>)[c] ?? c));
  }
  return values.join("\n").trim();
}

export class GoogleDriveAttachmentReader {
  constructor(private readonly drive: drive_v3.Drive, private readonly options: { maxBytes?: number; timeoutMs?: number } = {}) {}

  async read(attachment: DiscoveredAttachment): Promise<ReadableAttachmentContent> {
    if (attachment.kind !== "drive_file" || !attachment.driveFileId) throw new AttachmentContentError("unsupported_attachment", "This attachment is not a Google Drive file.");
    const maxBytes = this.options.maxBytes ?? MAX_ATTACHMENT_BYTES;
    const timeoutMs = this.options.timeoutMs ?? 15_000;
    let stage = "metadata";
    try {
      const metaResponse = await withTimeout(this.drive.files.get({ fileId: attachment.driveFileId, fields: "id,name,mimeType,size,trashed" }), timeoutMs);
      const metadata = metaResponse.data;
      if (metadata.id !== attachment.driveFileId || metadata.trashed) throw new AttachmentContentError("attachment_unavailable", "The selected attachment is unavailable.");
      const mimeType = metadata.mimeType ?? "application/octet-stream";
      const fileName = safeName(metadata.name ?? attachment.title);
      const declaredSize = Number(metadata.size ?? 0);
      if (declaredSize > maxBytes) throw new AttachmentContentError("attachment_too_large", "The attachment is larger than the private beta safety limit.");

      let extractedMimeType = mimeType;
      stage = "download";
      let response;
      if (mimeType === GOOGLE_DOC || mimeType === GOOGLE_SLIDES) {
        extractedMimeType = "text/plain";
        response = await withTimeout(this.drive.files.export({ fileId: attachment.driveFileId, mimeType: extractedMimeType }, { responseType: "stream" }), timeoutMs);
      } else if (mimeType === GOOGLE_SHEETS) {
        extractedMimeType = "text/csv";
        response = await withTimeout(this.drive.files.export({ fileId: attachment.driveFileId, mimeType: extractedMimeType }, { responseType: "stream" }), timeoutMs);
      } else if (mimeType === PDF || mimeType.startsWith("text/") || IMAGE_MIMES.has(mimeType) || [DOCX, PPTX, XLSX].includes(mimeType)) {
        response = await withTimeout(this.drive.files.get({ fileId: attachment.driveFileId, alt: "media" }, { responseType: "stream" }), timeoutMs);
      } else {
        throw new AttachmentContentError("unsupported_mime", "This attachment type is not supported by the private beta.");
      }

      stage = "buffer";
      const buffer = await boundedStream(response.data as unknown as NodeJS.ReadableStream, maxBytes);
      validateMagic(mimeType, buffer);
      if (IMAGE_MIMES.has(mimeType)) return { kind: "image", fileName, sourceMimeType: mimeType, extractedMimeType: mimeType, bytes: new Uint8Array(buffer) };
      if (mimeType === PDF) {
        stage = "pdf_extract";
        try { return textResult(fileName, mimeType, "text/plain", await extractPdfText(buffer)); }
        catch (error) {
          const fallback = await extractPdfLiteralText(buffer);
          if (fallback) return textResult(fileName, mimeType, "text/plain", fallback);
          throw error;
        }
      }
      if (mimeType.startsWith("text/") || [GOOGLE_DOC, GOOGLE_SLIDES, GOOGLE_SHEETS].includes(mimeType)) return textResult(fileName, mimeType, extractedMimeType, buffer.toString("utf8"));
      const fileType = mimeType === DOCX ? "docx" : mimeType === PPTX ? "pptx" : "xlsx";
      stage = "office_extract";
      const parsed = await parseOffice(buffer, { fileType, ocr: false });
      return textResult(fileName, mimeType, "text/plain", (await parsed.to("text")).value);
    } catch (error) {
      // Safe beta diagnostics: category/status only; never include file IDs, URLs, tokens, or content.
      if (error instanceof AttachmentContentError) throw error;
      const status = (error as { response?: { status?: number }; code?: string })?.response?.status;
      if (status === 401 || status === 403 || status === 404) throw new AttachmentContentError("attachment_inaccessible", "Google did not allow Classroom Desk to open the selected file.");
      throw new AttachmentContentError("attachment_read_failed", "Classroom Desk could not read the selected attachment.");
    }
  }
}
