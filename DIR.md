# Classroom Desk — Release Readiness Worktree

This is the dedicated, isolated release-readiness worktree on branch
`codex/release-readiness-20261020`, based on main commit
`069e6e6fdea189c9925f45ba7896a6b80aae1a45`.

- Release-gate evidence and route compatibility matrix: [`docs/release/PRODUCTION_READINESS_ASSESSMENT_2026-10-21.md`](docs/release/PRODUCTION_READINESS_ASSESSMENT_2026-10-21.md)
- Production-target configuration prepared from verified Cloudflare metadata: [`wrangler.production-candidate.jsonc`](wrangler.production-candidate.jsonc). Dry-run only; do not deploy until all gates pass and the owner approves.
- Isolated D1 test database configuration: [`wrangler.release-readiness-test.jsonc`](wrangler.release-readiness-test.jsonc). It points only to the separate release-readiness database and contains no production secrets.
- `.release-readiness/` contains only temporary synthetic fixtures, schema copies, and local verification scripts/exports; it is not part of the release commit.

The primary checkout and its working-tree changes remain untouched.

## Verification checkpoint — 2026-10-21

- Release-readiness changes are on `codex/release-readiness-20261020`; the local branch includes the trial-cutoff patch and the later dependency security updates. Main is still the base commit `069e6e6fdea189c9925f45ba7896a6b80aae1a45`.
- The protected 2026-10-17 SQL export matched its recorded SHA-256. Migrations 0008–0012 and restore-from-original were rehearsed in memory with SQLite; 17 tables/147 rows and the opaque encrypted-profile column were preserved. No copy was written or sent to Cloudflare.
- Release validation: 561/561 tests, typecheck, build, Wrangler dry run, source secret check, Gitleaks tree scan, and npm audit passed. Git history alerts were verified as synthetic test fixtures.
- Production remains NO-GO: exact Worker v22 source parity, DPAPI/key compatibility, and a Cloudflare D1 restore using the protected backup remain unverified. See the release assessment.

## Production compatibility investigation — 2026-10-21

- Isolated worktree: `F:/Fawzan/classroom-desk-prod-compat-20261021`, branch `codex/production-compat-20261021`, based exactly on merged main commit `78ca5d9b9a46e45203bc1bde3207a2f110996a0a`.
- Cloudflare metadata confirms active `classroom-desk` v22 (`2080fc00-de39-43ac-a4e6-10e7512d46a6`), deployment `4c6c9e65-b567-4b6c-9165-5c3bf319cb49`, 100% traffic, script fingerprint `161000e03ed5a032ca2057d157910923fd00d0c7147cff529e64af6db9091f28`.
- `worker-v22-module.js` is the extracted 93,912-byte `profile-compatibility-worker.js` diagnostic module, SHA-256 `A98E0F942D080D9DB475A9F20E97267BE94DCE09C0E56AA3E125CB10EF8A1B4A`; it is not an exact v22 bundle. Source parity remains unverified.
- DPAPI file metadata was inspected without reading/decrypting its contents. Current process SID ends `-1001`; NTFS owner SID ends `-1004`. No application source references the DPAPI file or DPAPI APIs. Relationship to `V2_PUBLIC_AUTH_ENCRYPTION_KEY_B64` is unknown; no decryption was attempted.
- Existing isolated D1 `classroom-desk-release-readiness-20261020` is distinct from production and reports 20 tables. No rows or production data were read or changed in this investigation.
- Production remains NO-GO pending exact Worker source/behavior parity, authorized encryption compatibility verification, and restore/recovery verification from a protected production-data backup.

## Bounded compatibility rehearsal — 2026-10-21

- A new disposable D1 rehearsal database `classroom-desk-compat-rehearsal-20261021` was created for this task only. It contained synthetic accounts, encrypted envelopes produced with a synthetic key, and synthetic OAuth, billing, subscription, refund, and reservation rows. Migrations 0001–0012 applied in order.
- Cloudflare D1 Time Travel restored the scratch database to its migration-0011 checkpoint. Synthetic row counts and encrypted-envelope fingerprints were unchanged; migration 0012 reapplied successfully. Representative account, OAuth, profile, subscription, and refund queries passed. Production D1 was not accessed or changed.
- The candidate ran in Wrangler local mode on HTTPS loopback with only the scratch D1 and fake bindings. HTTP checks passed for public/health and OAuth metadata, anonymous MCP/account/billing/webhook rejection, signed-in synthetic dashboard/settings, invalid Google and Picker callbacks, dynamic client registration, S256 authorization, and invalid redirect/PKCE/resource rejection. No Google or Razorpay API was called.
- The synthetic encryption verifier accepted 1/1 profile and 1/1 OAuth test envelopes. This validates the code/key contract with synthetic material only; it does not verify the production key or records.
- `pickerUrl` is a function export in the candidate and has internal source/test references only. No external source consumer was found. Production metadata lists a class handler with the same name, but the active binding inventory shows no Durable Object binding; the historical source remains unavailable, so this is not proof of old implementation behavior.
- The read-only production preflight checks the candidate config against recorded Worker v22 metadata and fails closed when any evidence or owner approval is missing. Production remains NO-GO: exact v22 behavior, existing ciphertext, protected production-backup restore, coordinated rollback, and production OAuth/MCP acceptance are unverified.
- Additional local-only verification: a temporary Wrangler Worker using synthetic bindings passed 18 HTTP checks; a disposable local D1 migration ledger showed all 12 migrations applied and no pending migrations. Temporary config and local D1 state were removed. No remote Worker, production D1, Google, or Razorpay endpoint was used.
