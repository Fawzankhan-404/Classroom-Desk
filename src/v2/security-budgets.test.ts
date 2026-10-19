import { Readable } from "node:stream";
import { deflateSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { GoogleDriveAttachmentReader, MAX_ATTACHMENT_BYTES } from "./attachment-content.js";
import { downloadPdf } from "./files.js";

// Exercise the real fallback boundary without loading pdfjs/canvas or making requests.
vi.mock("pdf-parse", () => ({ PDFParse: class { constructor() { throw new Error("PDF parser unavailable"); } } }));

function ascii85(bytes: Buffer): Buffer {
  const encoded: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 4) {
    const count = Math.min(4, bytes.length - offset);
    let value = 0;
    for (let i = 0; i < 4; i++) value = value * 256 + (bytes[offset + i] ?? 0);
    const digits = new Array<string>(5);
    for (let i = 4; i >= 0; i--) { digits[i] = String.fromCharCode(value % 85 + 33); value = Math.floor(value / 85); }
    encoded.push(digits.slice(0, count + 1).join(""));
  }
  return Buffer.from(encoded.join("") + "~>", "ascii");
}

function pdf(streams: Buffer[], encodeAscii85 = false, corruptChecksum = false): Buffer {
  const parts = [Buffer.from("%PDF-1.7\nBT (Earlier text must not hide a budget error) Tj ET\n")];
  for (const content of streams) {
    const compressed = deflateSync(content);
    if (corruptChecksum) compressed[compressed.length - 1] = (compressed[compressed.length - 1] ?? 0) ^ 1;
    const body = encodeAscii85 ? ascii85(compressed) : compressed;
    parts.push(Buffer.from(`<< /Filter ${encodeAscii85 ? "[/ASCII85Decode /FlateDecode]" : "/FlateDecode"} /Length ${body.length} >>\nstream\n`), body, Buffer.from("\nendstream\n"));
  }
  return Buffer.concat(parts);
}

async function readPdf(body: Buffer) {
  const drive = { files: { get: vi.fn(async (params: { alt?: string }) => params.alt === "media"
    ? { data: Readable.from([body]) }
    : { data: { id: "budget-test-file", name: "notes.pdf", mimeType: "application/pdf", size: String(body.length) } }) } };
  return new GoogleDriveAttachmentReader(drive as any).read({ kind: "drive_file", driveFileId: "budget-test-file", title: "notes.pdf" });
}

describe("PDF fallback decompression budgets", () => {
  it.each([false, true])("rejects a single compressed bomb (ASCII85=%s)", async (encoded) => {
    const body = pdf([Buffer.alloc(MAX_ATTACHMENT_BYTES + 1, 65)], encoded);
    expect(body.length).toBeLessThan(100_000);
    await expect(readPdf(body)).rejects.toMatchObject({ code: "attachment_too_large" });
  });

  it("applies the output budget cumulatively across streams", async () => {
    const part = Buffer.alloc(MAX_ATTACHMENT_BYTES / 2 + 1, 65);
    await expect(readPdf(pdf([part, part], true))).rejects.toMatchObject({ code: "attachment_too_large" });
  });

  it("also charges output from streams that fail checksum validation", async () => {
    const part = Buffer.alloc(MAX_ATTACHMENT_BYTES * 3 / 4, 65);
    await expect(readPdf(pdf([part, part], true, true))).rejects.toMatchObject({ code: "attachment_too_large" });
  });

  it("allows output exactly at the cumulative limit", async () => {
    const part = Buffer.alloc(MAX_ATTACHMENT_BYTES, 65);
    Buffer.from("BT (At limit) Tj ET").copy(part);
    await expect(readPdf(pdf([part], true))).resolves.toMatchObject({ kind: "text", text: expect.stringContaining("At limit") });
  });

  it("bounds ASCII85 short-form expansion before inflation", async () => {
    const body = Buffer.from(`%PDF-1.7\nBT (No partial success) Tj ET\nstream\n${"z".repeat(MAX_ATTACHMENT_BYTES / 4 + 1)}~>\nendstream\n`);
    await expect(readPdf(body)).rejects.toMatchObject({ code: "attachment_too_large" });
  });

  it.each([false, true])("still extracts ordinary compressed text (ASCII85=%s)", async (encoded) => {
    await expect(readPdf(pdf([Buffer.from("BT (Teacher lesson) Tj ET")], encoded))).resolves.toMatchObject({ kind: "text", text: expect.stringContaining("Teacher lesson"), truncated: false });
  });
});

describe("external PDF transfer guard", () => {
  it.each([
    "https://files.example.test/notes.pdf",
    "https://[::ffff:10.0.0.1]/notes.pdf",
    "https://127.0.0.1/notes.pdf",
    "https://metadata.google.internal/notes.pdf",
    "https://[fe80::1]/notes.pdf",
  ])("rejects external PDF handoffs before network access (%s)", async (download_url) => {
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network access must not occur"));
    try {
      await expect(downloadPdf({ file_id: "test-file", download_url, file_name: "notes.pdf" })).rejects.toMatchObject({ code: "external_file_transfer_unavailable" });
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  });
});
