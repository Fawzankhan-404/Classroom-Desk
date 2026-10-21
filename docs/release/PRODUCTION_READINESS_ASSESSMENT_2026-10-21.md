# Classroom Desk Production Readiness Assessment

**Assessment date:** 2026-10-21
**Release branch:** `codex/release-readiness-20261020`
**Base commit:** `069e6e6fdea189c9925f45ba7896a6b80aae1a45`
**Production Worker:** `classroom-desk`
**Production D1:** `classroom-desk-db`

## Gate summary

| Gate | Result | Evidence |
|---|---|---|
| Isolated migrations 0008–0012 | **PASS (synthetic clone)** | Applied sequentially to isolated D1 `classroom-desk-release-readiness-20261020`; representative migration-dependent queries and synthetic record preservation passed. No production rows were used. |
| Production schema baseline | **PASS (schema shape only)** | Production ledger reports 0001–0007. Application object names and 16 checked table column sets match the local 0001–0007 baseline. Twenty-three raw DDL text hashes differ; D1 serialization/alter-table normalization was observed, so exact DDL equivalence is not claimed. This does not verify production record compatibility. |
| Protected backup row compatibility for 0008–0012 | **PARTIAL** | The checksum-verified 2026-10-17 D1 export was loaded into an in-memory SQLite database. Migrations 0008–0012 applied; all 17 tables/147 rows, common pre-existing columns, and the encrypted-profile column remained unchanged; integrity and foreign-key checks passed. This is not a Cloudflare D1 restore and does not prove current production data compatibility. |
| Real production encrypted-record compatibility | **BLOCKED** | The current Windows session cannot access the DPAPI owner profile, and no application code or documented verifier was found that creates or consumes `credentials/public-auth-key.dpapi`. No decryption was attempted. |
| Exact Worker v22 source/build | **BLOCKED** | Cloudflare confirms the active version/deployment metadata, but the version endpoint returned metadata rather than executable source. The known bundle hash is not matched to a repository build. The recovered `worker-v22-module.js` is diagnostic-only, not the full application. |
| Candidate configuration / dry-run | **PASS (configuration subset)** | `wrangler.production-candidate.jsonc` targets the verified Worker name, domain route, D1 ID, rate-limit namespaces, compatibility settings, observability, secret names, and `keep_vars`; Wrangler dry-run succeeded. It was not deployed. Wrangler 4.149 rejects the metadata field `usage_model`; it is omitted from the config and remains a deployment-setting verification item. |
| Worker rollback rehearsal | **PASS (isolated mechanics only)** | A temporary unrouted Worker with no bindings was moved from test version 2 back to version 1 through the version deployment controls, then removed. This does not prove v22 is safe or that production rollback is data-compatible. |
| D1 restore/reapply rehearsal | **PASS (isolated D1 only)** | A D1 time-travel bookmark restored the scratch database to migrations 0001–0007; synthetic rows and profile-ciphertext hashes remained unchanged. Migrations 0008–0012 were reapplied. A local SQLite import passed `integrity_check=ok` and zero foreign-key violations. |
| Protected backup migration/recovery rehearsal | **PARTIAL (local in-memory SQLite)** | The known export SHA-256 matched. The export loaded with `integrity_check=ok` and zero foreign-key violations; migrations 0008–0012 preserved row counts, common-column contents, and encrypted-profile ciphertext. A second in-memory database reloaded the original export and matched the original snapshot. The export was not written to disk or transferred to Cloudflare. |
| Cloudflare D1 restore from production backup | **BLOCKED** | No production backup was imported into an isolated Cloudflare D1 clone. The D1 restore rehearsal used synthetic data; the protected backup rehearsal used in-memory SQLite only. |
| `RECLAIMED_BY_STUDENT` wording | **PASS** | UI now displays “Unsubmitted by student”; regression assertion checks the wording and excludes the raw enum. |
| Trial cutoff policy | **PASS (provider-confirmed behavior; production provider not called)** | New-order route rejects requests after cutoff before provider creation and refuses checkout data if the provider's `created_at` is after cutoff. Resume after cutoff requires an existing pending reservation, provider order in `created`/`attempted`, exact amount/currency/account, `amount_paid=0`, `amount_due=amount`, a complete payment listing, all returned payments belonging to that order, and every payment attempt `failed`. See focused regression tests. |
| Current source-tree secret scan | **PASS** | Gitleaks 8.30.1 scanned the worktree tree with no findings. |
| Git history secret scan | **PASS (false positives confirmed)** | Both historical `generic-api-key` matches are the same fixed synthetic internal-token fixture in `src/saas/connection-status.test.ts`, used only by a localhost test server. The current source-tree scan has zero findings. No production credential or history rewrite was involved. |
| Dependency audit | **PASS** | The final production dependency audit (`npm audit --omit=dev`) and full dependency audit both report zero vulnerabilities after updating the MCP SDK and its patched transitive dependencies. |
| Production release decision | **NO-GO** | Exact v22 behavior, production-key compatibility, and coordinated production Worker/D1 recovery remain unverified. |

## Production provenance and route compatibility

Cloudflare metadata identifies Worker `classroom-desk`, version ID
`2080fc00-de39-43ac-a4e6-10e7512d46a6`, deployment ID
`4c6c9e65-b567-4b6c-9165-5c3bf319cb49`, and route
`classroom.jarvis404.com/*`. The active version metadata reports a Wrangler
deployment created 2026-10-15 17:44:59 UTC. The known bundle fingerprint is
`161000e03ed5a032ca2057d157910923fd00d0c7147cff529e64af6db9091f28`.
Cloudflare’s version-script response did not contain executable source; it
contained metadata fields only (`etag`, handlers, named handlers, and
`last_deployed_from`). Deployment metadata reports the source as Wrangler. No
exact source/build match was established.

An additional approved-source check inspected all 67 GitHub Actions runs
available in this public repository. The only workflow is `quality.yml`; the
run associated with the nearest production-era commit had no downloadable
artifacts. No deployment workflow or reproducible v22 bundle is available
there. This does not recover v22 provenance or establish behavioral parity.

The table below separates live HTTP evidence from source-tree route presence.
It does **not** establish v22 behavioral parity.

| Route | Live read-only result | Current candidate source | v22 parity |
|---|---|---|---|
| `/` | 200 | Registered | Unknown |
| `/health` | 200 | Registered | Unknown |
| `/ready` | 200 | Registered | Unknown |
| `/pricing` | 200 | Registered | Unknown |
| `/support` | 200 | Registered | Unknown |
| `/app` | 303 | Authenticated page route registered | Unknown |
| `/start` | 404 | No exact route registered | Unknown |
| `/connecting` | 404 | No exact route registered | Unknown |
| `/account` | 404 | No exact route registered | Unknown |
| `/.well-known/oauth-authorization-server` | 200 | OAuth metadata is implemented | Unknown |
| `/.well-known/oauth-protected-resource` | 404 | No matching response observed | Unknown |
| `/mcp` | 401 without credentials | MCP transport registered | Unknown; no authenticated production request was made |
| `/login`, `/auth/google/callback` | Not probed to avoid starting OAuth | Website OAuth routes registered | Unknown |
| `/authorize`, `/connect/google`, `/oauth/google/callback`, `/disconnect/google` | Not invoked | OAuth routes registered | Unknown |
| `/app/student`, `/app/teacher`, `/app/teacher/courses/:courseId`, coursework detail | Not probed with an authenticated account | Candidate routes registered | Unknown |
| `/api/billing/*`, `/webhooks/razorpay` | Not invoked | Candidate routes registered | Unknown |
| `/api/referrals/*`, `/api/account/*`, `/api/teacher/*` | Not invoked | Candidate routes registered | Unknown |
| `/admin/*` | Not invoked | Candidate routes registered | Unknown |
| `/picker/*` and attachment/PDF routes | Not invoked | Candidate route support exists; workflow remains separately unverified | Unknown |

Production settings observed by metadata-only reads: compatibility date
`2026-10-02`, `nodejs_compat`, standard usage model, observability enabled,
and the verified D1/rate-limit bindings. Binding names and types were read;
secret values were not. `wrangler.production-candidate.jsonc` declares the
verified 12 secret names only, leaves dashboard variables to
`keep_vars: true`, and includes the D1 ID, route, and rate-limit namespace IDs.
The config is a preparation artifact, not a deployment authorization or proof
that the candidate preserves all v22 behavior.

## D1 migration and recovery evidence

The isolated test database began from migrations 0001–0007 and contained only
synthetic accounts, synthetic encrypted-profile fixtures generated with a
temporary in-memory test key, and synthetic payment/auth-state rows. It was
not seeded from production records or a production backup.

Migrations 0008, 0009, 0010, 0011, and 0012 applied in order. Representative
queries exercised the OAuth mapping insert, account experience preference,
trial/subscription reservation, and cumulative refund fields. Five synthetic
profile ciphertext fingerprints were identical before and after migrations.
The 0012 checks returned the expected synthetic refund totals. D1’s API
authorizer denied remote PRAGMA calls; the scratch database export was imported
into local SQLite for integrity and foreign-key checks. The export was
synthetic-only.

The isolated restore used bookmark
`00000002-0000000a-0000510a-98fadeecddc9b3bc2d7b573c85043ac8`. The scratch
database returned to migrations 0001–0007 with synthetic row counts and
ciphertext hashes unchanged, then 0008–0012 were reapplied. This validates the
isolated restore mechanics only. It does not validate a restore of production
data, encrypted records, or a production D1 time-travel point.

Worker rollback mechanics were also rehearsed on an unrouted disposable test
Worker with no D1 or other bindings. The deployment control restored its test
version `019c2337-de1c-4c4c-973d-ce717d836ac2` after test version
`3db45d12-a7ac-452c-ac49-f0e3fd046cd0`. The temporary Worker was then removed. A
production Worker-only rollback could still be unsafe if the new code changes
data or schema; D1 and Worker recovery must remain coordinated.

## DPAPI and encrypted records

The current process is `DESKTOP-5GIVG6B\dell` (SID ending `-1001`). The
protected file is 262 bytes and its NTFS owner is
`DESKTOP-5GIVG6B\CodexSandboxOffline` (SID ending `-1004`). That local profile
exists at `C:\Users\CodexSandboxOffline`, but is not loaded in the current
session; its DPAPI profile directory is not accessible to the current process.
The NTFS owner alone does not establish the DPAPI protection identity. No
unprotect/decryption attempt was made.

The source uses `V2_PUBLIC_AUTH_ENCRYPTION_KEY_B64` as a canonical base64
32-byte AES-256-GCM master key, deriving profile and lookup keys with
HKDF-SHA256 and purpose labels. Profile ciphertext uses the `v1.<iv>.<tag>.<body>`
format. The repository does not show the `.dpapi` file being created or
consumed, so its relationship to that production binding is unknown. Production
metadata confirms the encryption binding name/type only; it does not validate
the value. Five nonempty encrypted-profile records were previously counted,
but their plaintext and ciphertext were not accessed in this assessment.

### Safe verification plan (production key check not run)

1. First establish, from a trusted application record or owner-confirmed
   provenance, which Windows SID and supported application mechanism protect
   `credentials/public-auth-key.dpapi`. NTFS ownership alone is insufficient.
   Do not attempt to unlock or decrypt another profile without that verified
   mechanism and explicit owner authorization.
2. Confirm that the approved mechanism is the one that created/consumes the
   protected blob and exposes only an in-memory key handle to the verifier.
3. Run it against a protected offline copy containing the five ciphertexts;
   decrypt in process memory only and return counts/booleans, never plaintext,
   keys, or ciphertext.
4. Report only whether all five decrypt, the encrypted OAuth record format is
   readable, and whether ciphertext fingerprints remain unchanged. Do not
   write the clone or production data.

The backup export used for the migration rehearsal matched its recorded
SHA-256. The key-verification gate remains **BLOCKED** until the original
protection identity and approved verifier are verified.

## Trial policy and wording changes

The new-order route checks the cutoff before calling the provider; the storage
reservation also rejects after cutoff. It validates the provider's order
`created_at` before returning checkout data, so a request that straddles the
cutoff does not expose a late-created order for payment. Resume after cutoff is
limited to an existing pending order and now fails closed for any
in-flight/authorized, captured/refunded, mismatched, incomplete, or otherwise
unverified payment listing. Regression tests cover the cutoff, late provider
creation, failed-attempt resume, closed order, authorized payment, missing order
amounts, a full payment page, and no-provider-call behavior after cutoff.

The existing Razorpay Orders API documentation describes `created` and
`attempted` order states and reports `amount_paid` / `amount_due`; this
assessment relies on provider API responses at resume time and does not claim
that local tests prove the live provider behavior. See [Razorpay Fetch Order
API](https://razorpay.com/docs/api/orders/fetch-with-id/?preferred-country=IN).

`RECLAIMED_BY_STUDENT` now renders as “Unsubmitted by student.” The raw enum
remains hidden from account-facing output.

## Final validation

- Focused tests after the final code change: **100 passed** across
  `billing-hardening.test.ts` and `dashboard-pages.test.ts`.
- Final full suite after all code changes: **561 passed** across 54 files.
- After the release-branch dependency security fix: full suite **561/561** in
  54 files; typecheck, build, production-config Wrangler dry-run,
  `git diff --check`, source-secret check, and Gitleaks source-tree scan passed.
- Gitleaks 8.30.1 history scan reported two historical matches; both were
  reviewed and confirmed as the same synthetic localhost test fixture.
- `npm audit --omit=dev` and full `npm audit` passed with zero vulnerabilities.
- Dependency changes are limited to the MCP SDK pin (`1.31.0` to `1.32.1`) and
  21 package-lock resolutions. The patched transitive versions include `hono`
  `4.13.13` and `vite` `8.3.4`; their related transitive packages also moved
  within existing declared ranges.

## Decision and required action

**Production release: NO-GO.** Exact v22 behavioral source parity, authorized
DPAPI/key verification against the five encrypted records, and a Cloudflare D1
restore from the protected production backup remain unverified. The local
in-memory SQLite rehearsal and synthetic Cloudflare D1 rehearsal do not prove
those production gates. No production Worker, route, D1 row, secret, OAuth
grant, or billing setting was changed.

The next owner action is to provide or confirm the trusted provenance and
approved in-process verifier for the DPAPI-protected file. After that mechanism
is verified, the authorized Windows identity can run it against the protected
offline copy. This assessment did not attempt to unlock a profile or decrypt
the file or production records.
