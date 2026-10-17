/**
 * ChatGPT's temporary file handoff is hosted by OpenAI. Workers cannot pin an
 * outbound HTTP connection to an IP using the supported fetch API, so the
 * Worker path accepts only this provider-controlled host and disables
 * automatic redirects. Every redirect is checked again by downloadPdf.
 */
export const WORKER_PDF_TRUSTED_HOSTS = ["files.oaiusercontent.com"] as const;

export type WorkerPdfRequest = (url: URL, signal: AbortSignal) => Promise<globalThis.Response>;

export function createWorkerPdfRequester(fetcher: typeof fetch = fetch): WorkerPdfRequest {
  return (url, signal) => fetcher(url, {
    method: "GET",
    redirect: "manual",
    credentials: "omit",
    signal,
    headers: {
      Accept: "application/pdf, application/octet-stream;q=0.9",
      "Accept-Encoding": "identity",
    },
  });
}

export const requestWorkerPdf = createWorkerPdfRequester();

