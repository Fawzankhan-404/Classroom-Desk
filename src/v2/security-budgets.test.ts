import { Readable } from "node:stream";
import { deflateSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

const file = { file_id: "test-file", download_url: "https://files.example.test/notes.pdf", file_name: "notes.pdf" };
const lookup = vi.fn(async () => [{ address: "8.8.8.8", family: 4 as const }]);

describe("PDF download lifetime budget", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it.each([false, true])("times out and cancels a stalled body (partial=%s)", async (partial) => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ start(controller) { if (partial) controller.enqueue(Buffer.from("%PDF-1.7\n")); }, cancel });
    let signal: AbortSignal | null | undefined;
    const fetch = vi.fn(async (_url: unknown, _address: unknown, requestSignal?: AbortSignal) => { signal = requestSignal; return new Response(body, { headers: { "content-type": "application/pdf" } }); });
    const result = downloadPdf(file, { lookup, fetchPinned: fetch, timeoutMs: 50 });
    const rejected = expect(result).rejects.toMatchObject({ code: "timeout" });
    await vi.advanceTimersByTimeAsync(50);
    await rejected;
    expect(signal?.aborted).toBe(true);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("shares the same deadline across redirects and cancels both bodies", async () => {
    const cancelRedirect = vi.fn(); const cancelFinal = vi.fn();
    const redirectBody = new ReadableStream<Uint8Array>({ cancel: cancelRedirect });
    const finalBody = new ReadableStream<Uint8Array>({ cancel: cancelFinal });
    const fetch = vi.fn()
      .mockImplementationOnce(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); return new Response(redirectBody, { status: 302, headers: { location: "https://cdn.example.test/notes.pdf" } }); })
      .mockResolvedValueOnce(new Response(finalBody, { headers: { "content-type": "application/pdf" } }));
    const rejected = expect(downloadPdf(file, { lookup, fetchPinned: fetch, timeoutMs: 50 })).rejects.toMatchObject({ code: "timeout" });
    await vi.advanceTimersByTimeAsync(50);
    await rejected;
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(cancelRedirect).toHaveBeenCalledTimes(1);
    expect(cancelFinal).toHaveBeenCalledTimes(1);
    expect(finalBody.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not wait forever for cancellation after the deadline", async () => {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const body = new ReadableStream<Uint8Array>({ cancel });
    const fetch = vi.fn(async () => new Response(body, { headers: { "content-type": "application/pdf" } }));
    const rejected = expect(downloadPdf(file, { lookup, fetchPinned: fetch, timeoutMs: 50 })).rejects.toMatchObject({ code: "timeout" });
    await vi.advanceTimersByTimeAsync(50);
    await rejected;
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
  });

  it("bounds DNS validation and a fetch that ignores abort", async () => {
    const stalledLookup = vi.fn(() => new Promise(() => {})) as any;
    const fetch = vi.fn(() => new Promise<Response>(() => {}));
    const dnsFailure = expect(downloadPdf(file, { lookup: stalledLookup, fetchPinned: fetch, timeoutMs: 50 })).rejects.toMatchObject({ code: "timeout" });
    await vi.advanceTimersByTimeAsync(50); await dnsFailure;
    expect(fetch).not.toHaveBeenCalled();
    const fetchFailure = expect(downloadPdf(file, { lookup, fetchPinned: fetch, timeoutMs: 50 })).rejects.toMatchObject({ code: "timeout" });
    await vi.advanceTimersByTimeAsync(50); await fetchFailure;
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves valid streaming downloads and clears their deadline", async () => {
    let signal: AbortSignal | null | undefined;
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(Buffer.from("%PDF-1.7\n")); setTimeout(() => { controller.enqueue(Buffer.from("valid body")); controller.close(); }, 30); } });
    const fetch = vi.fn(async (_url: unknown, _address: unknown, requestSignal?: AbortSignal) => { signal = requestSignal; return new Response(body, { headers: { "content-type": "application/pdf" } }); });
    const result = downloadPdf(file, { lookup, fetchPinned: fetch, timeoutMs: 50 });
    await vi.advanceTimersByTimeAsync(30);
    await expect(result).resolves.toMatchObject({ buffer: Buffer.from("%PDF-1.7\nvalid body"), filename: "notes.pdf", sourceFileId: "test-file" });
    expect(body.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(signal?.aborted).toBe(false);
  });

  it.each(["mime", "size"])("cancels a rejected %s response and clears its deadline", async (reason) => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(Buffer.from("%PDF-1.7\n")); }, cancel });
    const fetch = vi.fn(async () => new Response(body, { headers: { "content-type": reason === "mime" ? "text/plain" : "application/pdf" } }));
    await expect(downloadPdf(file, { lookup, fetchPinned: fetch, maxBytes: reason === "size" ? 4 : undefined, timeoutMs: 50 })).rejects.toMatchObject({ code: reason === "mime" ? "invalid_mime" : "too_large" });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
