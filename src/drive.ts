import { parseOffice } from "officeparser";
import { PDFParse } from "pdf-parse";
import type { drive_v3 } from "@googleapis/drive";
import { MAX_FILE_BYTES } from "./config.js";

const GOOGLE_DOC = "application/vnd.google-apps.document";
const GOOGLE_SLIDES = "application/vnd.google-apps.presentation";
const PDF = "application/pdf";
const PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

async function responseBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as unknown as Uint8Array);
    size += part.length;
    if (size > MAX_FILE_BYTES) throw new Error(`File exceeds the ${MAX_FILE_BYTES / 1024 / 1024} MB safety limit.`);
    chunks.push(part);
  }
  return Buffer.concat(chunks);
}

async function download(drive: drive_v3.Drive, fileId: string): Promise<Buffer> {
  const result = await drive.files.get({ fileId, alt: "media" }, { responseType: "stream" });
  return responseBuffer(result.data as unknown as NodeJS.ReadableStream);
}

async function exportFile(drive: drive_v3.Drive, fileId: string, mimeType: string): Promise<Buffer> {
  const result = await drive.files.export({ fileId, mimeType }, { responseType: "stream" });
  return responseBuffer(result.data as unknown as NodeJS.ReadableStream);
}

async function extractPdfText(buffer: Buffer): Promise<string> {
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try { return (await parser.getText()).text; }
  finally { await parser.destroy(); }
}

export async function extractDriveText(drive: drive_v3.Drive, fileId: string): Promise<Record<string, unknown>> {
  const { data: metadata } = await drive.files.get({ fileId, fields: "id,name,mimeType,size,modifiedTime,webViewLink" });
  const mimeType = metadata.mimeType ?? "application/octet-stream";
  let buffer: Buffer;
  let text: string;
  if (mimeType === GOOGLE_DOC) {
    buffer = await exportFile(drive, fileId, "text/plain");
    text = buffer.toString("utf8");
  } else if (mimeType === GOOGLE_SLIDES) {
    buffer = await exportFile(drive, fileId, PDF);
    text = await extractPdfText(buffer);
  } else if (mimeType === PDF) {
    buffer = await download(drive, fileId);
    text = await extractPdfText(buffer);
  } else if (mimeType === PPTX) {
    buffer = await download(drive, fileId);
    const parsed = await parseOffice(buffer, { fileType: "pptx", ocr: false });
    text = (await parsed.to("text")).value;
  } else if (mimeType.startsWith("text/")) {
    buffer = await download(drive, fileId);
    text = buffer.toString("utf8");
  } else {
    throw new Error(`Unsupported attachment type: ${mimeType}. Supported: Google Docs, Google Slides, PDF, PPTX, and text files.`);
  }
  return { ...metadata, text };
}
