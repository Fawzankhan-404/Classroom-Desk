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
