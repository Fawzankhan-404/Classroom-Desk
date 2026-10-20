/**
 * Arbitrary external PDF downloads are disabled for the Worker runtime.
 *
 * Cloudflare Worker fetch() cannot be pinned to the IP address checked by an
 * application DNS lookup. Until the file handoff has a documented trusted-host
 * transport, accepting download URLs would leave a DNS-rebinding gap.
 */
export class V2FileError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "V2FileError";
  }
}

export type V2File = {
  download_url: string;
  file_id: string;
  mime_type?: string;
  file_name?: string;
};

export async function downloadPdf(file: V2File): Promise<never> {
  if (!file || typeof file.download_url !== "string" || !file.download_url.trim() || typeof file.file_id !== "string" || !file.file_id.trim()) {
    throw new V2FileError("missing_file", "A generated PDF file is required.");
  }
  if (file.mime_type && file.mime_type !== "application/pdf") {
    throw new V2FileError("invalid_mime", "Only application/pdf files are accepted.");
  }
  throw new V2FileError(
    "external_file_transfer_unavailable",
    "Generated PDF transfer is disabled because this Worker cannot safely pin arbitrary external download URLs.",
  );
}
