import { isDisallowedAddress, requestPinnedHttps, resolvePublicAddresses, type PinnedRequest, type ResolvedAddress } from "./pinned-https.js";
import net from "node:net";

export const MAX_V2_PDF_BYTES = 20 * 1024 * 1024;
const MAX_REDIRECTS = 3;

export class V2FileError extends Error { constructor(public readonly code: string, message: string) { super(message); } }

async function validateUrl(raw: string, lookup: (host: string) => Promise<ResolvedAddress[]>): Promise<{ url: URL; address: ResolvedAddress }> {
  let url: URL;
  try { url = new URL(raw); } catch { throw new V2FileError("invalid_url", "The generated file URL is invalid."); }
  if (url.protocol !== "https:" || url.username || url.password || !url.hostname || url.hash || (url.port && url.port !== "443")) throw new V2FileError("unsafe_url", "Only public HTTPS file URLs on port 443 are accepted.");
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || (net.isIP(host) !== 0 && isDisallowedAddress(host))) throw new V2FileError("unsafe_url", "The generated file URL points to a private or local destination.");
  try {
    const records = await lookup(host);
    if (!records.length || records.some((record) => isDisallowedAddress(record.address))) throw new V2FileError("unsafe_url", "The generated file URL points to a private or local destination.");
    // The selected address is passed to a transport that connects directly to this IP.
    return { url, address: records[0]! };
  } catch (error) { if (error instanceof V2FileError) throw error; throw new V2FileError("unresolvable_url", "The generated file URL could not be validated."); }
}

function safeFilename(input: string | undefined): string {
  const normalized = (input || "assignment.pdf").normalize("NFKC").replace(/[\u0000-\u001f\u007f]/g, "").replace(/[<>:"/\\|?*]/g, "-").replace(/\.{2,}/g, ".").trim().replace(/[. ]+$/g, "").slice(0, 100);
  const base = normalized.replace(/^[. ]+/, "") || "assignment";
  return /\.pdf$/i.test(base) ? base : `${base}.pdf`;
}

export type V2File = { download_url: string; file_id: string; mime_type?: string; file_name?: string };
export type DownloadedPdf = { buffer: Buffer; filename: string; sourceFileId?: string };

export async function downloadPdf(file: V2File, options: { fetchPinned?: PinnedRequest; lookup?: (host: string) => Promise<ResolvedAddress[]>; timeoutMs?: number; maxBytes?: number } = {}): Promise<DownloadedPdf> {
  if (!file || typeof file.download_url !== "string") throw new V2FileError("missing_file", "A generated PDF file is required.");
  if (file.mime_type && file.mime_type !== "application/pdf") throw new V2FileError("invalid_mime", "Only application/pdf files are accepted.");
  const fetchPinned = options.fetchPinned ?? requestPinnedHttps; const lookup = options.lookup ?? resolvePublicAddresses; const maxBytes = options.maxBytes ?? MAX_V2_PDF_BYTES; const timeoutMs = options.timeoutMs ?? 15_000;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { reject(new V2FileError("timeout", "The generated PDF download timed out.")); controller.abort(); }, timeoutMs);
  });
  const withinDeadline = <T>(promise: Promise<T>): Promise<T> => Promise.race([promise, deadline]);
  let response: Response | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let complete = false;
  try {
    let current = await withinDeadline(validateUrl(file.download_url, lookup));
    for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect++) {
      response = await withinDeadline(fetchPinned(current.url, current.address, controller.signal, maxBytes));
      if (response.status >= 300 && response.status < 400) {
        if (redirect === MAX_REDIRECTS) throw new V2FileError("too_many_redirects", "The generated PDF URL redirected too many times.");
        const location = response.headers.get("location"); if (!location) throw new V2FileError("invalid_redirect", "The generated PDF redirect was invalid.");
        void response.body?.cancel().catch(() => {});
        response = undefined;
        current = await withinDeadline(validateUrl(new URL(location, current.url).toString(), lookup)); continue;
      }
      if (!response.ok) throw new V2FileError("download_failed", "The generated PDF could not be downloaded.");
      const contentType = ((response.headers.get("content-type") || "").split(";", 1)[0] ?? "").trim().toLowerCase();
      if (contentType !== "application/pdf") throw new V2FileError("invalid_mime", "The generated file is not an application/pdf.");
      const declared = Number(response.headers.get("content-length") || 0); if (declared > maxBytes) throw new V2FileError("too_large", "The generated PDF is too large.");
      if (!response.body) throw new V2FileError("download_failed", "The generated PDF response was empty.");
      reader = response.body.getReader(); const chunks: Uint8Array[] = []; let total = 0;
      while (true) {
        const part = await withinDeadline(reader.read());
        if (part.done) { complete = true; break; }
        total += part.value.byteLength;
        if (total > maxBytes) throw new V2FileError("too_large", "The generated PDF is too large.");
        chunks.push(part.value);
      }
      const buffer = Buffer.concat(chunks.map((c) => Buffer.from(c))); if (buffer.length < 5 || buffer.subarray(0, 5).toString() !== "%PDF-") throw new V2FileError("invalid_pdf", "The generated file is not a valid PDF.");
      return { buffer, filename: safeFilename(file.file_name), sourceFileId: file.file_id };
    }
    throw new V2FileError("too_many_redirects", "The generated PDF URL redirected too many times.");
  } catch (error) {
    if (error instanceof V2FileError) throw error;
    if (controller.signal.aborted || (error as Error)?.name === "AbortError") throw new V2FileError("timeout", "The generated PDF download timed out.");
    throw new V2FileError("download_failed", "The generated PDF could not be downloaded.");
  } finally {
    clearTimeout(timer);
    // Cancellation must not extend the deadline if an underlying source stalls.
    if (reader) {
      if (!complete) void reader.cancel().catch(() => {});
      reader.releaseLock();
    } else {
      void response?.body?.cancel().catch(() => {});
    }
  }
}

export { safeFilename };
