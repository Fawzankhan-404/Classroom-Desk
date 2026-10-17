# Security review — publication candidate

## Scope

This review covers the sanitized publication candidate, not the original development checkout or the live Classroom Desk service. The candidate started from commit `8be8e744bf97e528e4e8983d847e83cef1a900fd`; published `main` contains that sanitized snapshot plus the Worker compatibility fix. No Cloudflare deployment, routing change, database operation, or Razorpay operation was performed.

The managed-filesystem Deep Scan could not run because this session has no managed filesystem permission profile. It was not retried. A prompt-only scan aimed at the original revision was stopped after confirming it did not include the final changes. The review below uses local scanners, source inspection, regression tests, and a local Wrangler Workerd runtime.

## Worker PDF retrieval

The previous direct pinned-TLS transport is retained for Node execution. The Worker composition now uses the supported Worker `fetch()` API through `src/v2/worker-pdf.ts`. The Worker has no supported way in this code path to bind a Fetch request to a separately resolved IP, so this implementation does not claim DNS pinning.

This follows Cloudflare's current [Workers Fetch API](https://developers.cloudflare.com/workers/runtime-apis/fetch/) for HTTP requests. Cloudflare documents that `node:dns` `lookup`, `lookupService`, and `resolve` are not implemented in Workers ([DNS compatibility](https://developers.cloudflare.com/workers/runtime-apis/nodejs/dns/)); its [TCP sockets guidance](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/) directs HTTP traffic on ports 80/443 through `fetch()`. Cloudflare's [Worker security model](https://developers.cloudflare.com/workers/reference/security-model/) says Worker APIs restrict requests from reaching internal services.

Worker retrieval accepts only the exact HTTPS hostname `files.oaiusercontent.com`, on the default HTTPS port, with no URL credentials or fragment. IP literals, localhost, other hosts, and non-HTTPS URLs fail closed. Requests use `redirect: "manual"`; `src/v2/files.ts` validates each `Location` before issuing another request. A redirect to an untrusted host or private IP is rejected before the next fetch. The request omits browser credentials, and the response is bounded by size and time and checked for PDF MIME type and signature.

The allowlist is intentionally narrow. OpenAI's public file-handoff reference describes `download_url` as an HTTPS URL but does not promise a stable hostname. A future provider hostname change therefore makes this handoff fail closed until the allowlist is reviewed. Authorized Google Drive/Classroom attachment reading uses the existing per-file Google authorization path and is separate from this generated-file handoff.

### Runtime evidence

`wrangler dev --local` ran the actual Worker runtime (Workerd) against the changed `src/v2/files.ts` and `src/v2/worker-pdf.ts` modules with Node compatibility enabled:

- A synthetic PDF response completed through `downloadPdf`: 18 bytes, `%PDF-` signature.
- An outbound Worker fetch to the allowlisted provider host completed at the network layer and returned HTTP 404 for `/` (no real artifact was requested).
- `redirect: "manual"` against a public endpoint returned HTTP 307 with a visible `Location` header.
- Unit regression tests verified same-host redirect handling and rejection of cross-host, loopback, and metadata-IP redirects before a second request.

This verifies local Workerd behavior. No remote Worker deployment or production egress check was performed.

## Independent source review

Reviewed authentication and identity binding, OAuth state/PKCE and callback handling, token storage/rotation, MCP authorization, Google Picker authorization, account/session isolation, billing authorization, external requests, redirect handling, teacher-demo boundaries, and PDF retrieval.

Files reviewed directly or in the independent source review:

- `src/v2/worker-pdf.ts`, `src/v2/files.ts`, `src/v2/pinned-https.ts`
- `src/v2-worker.ts`, `src/final-worker.ts`
- `src/v2/oauth.ts`, `src/v2/attachments.ts`, `src/v2/attachment-workflow.ts`, `src/v2/attachment-content.ts`
- `src/saas/csrf.ts`, `src/saas/sessions.ts`, `src/saas/website-auth.ts`, `src/saas/website-routes.ts`, `src/saas/store.ts`
- `src/public/http.ts`, `src/public/oauth.ts`, `src/public/store.ts`, `src/public/config.ts`
- `.env.example`, `wrangler.example.jsonc`, `.gitignore`, `.github/workflows/quality.yml`
- `src/v2.test.ts`, `src/v2/security-budgets.test.ts`

No material exploitable finding was confirmed in those areas. In particular, the Worker path does not accept arbitrary external hosts, redirects are checked before following, preference selection does not grant Google teacher permissions, demo approval has no gradebook writeback, and billing admin access is not inferred from the unverified legacy allowlist.

## Scanner results

- Gitleaks `dir` scan: no leaks found in the candidate working tree (about 3.47 MB scanned).
- Gitleaks `git` scan: no leaks found in the commits reachable from the final publication `main` branch, including the review report.
- `node tools/source-secret-check.mjs`: 107 files scanned, no findings. This is a pattern check, not proof that a secret cannot exist.
- Semgrep `p/security-audit`: 22 rules over 104 TypeScript/JavaScript files; about 100% of parsed lines.
  - Seven HTTP findings are confined to `src/local-e2e.ts`, whose fixed origin is `http://127.0.0.1:8787` for loopback-only local integration tests.
  - Three possible XSS findings in `src/public/http.ts` concern `operator` and `support` values. Both are passed through `escapeHtml`, which escapes `&`, `<`, `>`, double quotes, and apostrophes before interpolation. The support address is also validated by the runtime config. These are triaged false positives; the encoded values are not used as executable script content.
- `npm audit --audit-level=moderate`: zero known vulnerabilities across production and development dependencies.

Semgrep findings were reviewed rather than suppressed. No Semgrep rules were added to the shipped source, and the scanner was installed only in its isolated tool cache.

## Publication hygiene

The candidate has no configured Git remote, no additional branches or tags, and one root commit rather than the private development history. `.env` and `.env.*` are ignored except `.env.example`; the example contains blank credential fields and local placeholders. `wrangler.example.jsonc` uses a placeholder database ID and example domain. The only GitHub workflow runs quality checks with read-only repository permission and has no deployment step. Gitleaks and the source-secret check found no credential patterns.

## Remaining limits

- The Deep Scan's managed filesystem worker is unavailable in this session; the coverage above comes from local scanners and manual review.
- Runtime verification used local Workerd, not a deployed Cloudflare environment. Production was intentionally left unchanged.
- The OpenAI file-handoff documentation does not guarantee the allowlisted hostname. Hostname changes require a security review; the current behavior is fail closed.
- Gitleaks and the source-secret checker cannot prove the absence of every form of private data. The publication commit itself must be checked again after the final report and code are committed.

## Assessment

The identified Worker incompatibility is resolved with a Worker-supported, exact-host allowlist and validated manual redirects. No material security finding remains in the reviewed candidate. The sanitized `main` branch is public. GitHub requires sudo-mode reauthentication before collaborator invitations and branch protection can be saved; those settings remain pending.
