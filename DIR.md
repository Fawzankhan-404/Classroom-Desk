# Classroom Desk repository index

Classroom Desk connects Google Classroom with ChatGPT through an authenticated
website and MCP service. The repository contains the server-rendered website,
Google OAuth and Classroom integrations, subscription support, and isolated
synthetic demonstrations.

## Source map

- `src/public/` — public OAuth, MCP, storage adapters, and provider interfaces.
- `src/saas/` — website routes, sessions, account data, administration, billing,
  referrals, and account recovery.
- `migrations/` — versioned database changes. Review and rehearse migrations
  before applying them to production.
- `docs/` — setup, architecture, security, release, and feature documentation.
- `scripts/` — reviewed operational and local verification tools.
- `wrangler*.jsonc` — Worker configurations; inspect bindings and target names
  before running Wrangler commands.

## Account recovery

The owner-reviewed legacy-account recovery flow and its manual evidence
standard are documented in
[`docs/release/LEGACY_ACCOUNT_RECOVERY.md`](docs/release/LEGACY_ACCOUNT_RECOVERY.md).
The recovery flow is an additive release candidate and requires migrations
0013–0014. It has not been applied to production. Existing Worker compatibility,
encrypted-record compatibility, and coordinated recovery remain separate
production release gates. See
[`docs/release/PRODUCTION_RELEASE_PREFLIGHT.md`](docs/release/PRODUCTION_RELEASE_PREFLIGHT.md)
for the release checks.

The encrypted-record verifier procedure is in
[`docs/release/ENCRYPTED_RECORD_VERIFICATION.md`](docs/release/ENCRYPTED_RECORD_VERIFICATION.md).
It has not been run against production records. Never put keys, tokens, account
data, or production ciphertext in source control or diagnostic output.

## Validation

Run `npm test`, `npm run check`, and `npm run build` for local validation.
Synthetic and local Worker tests do not establish live Google OAuth, production
encryption compatibility, or production deployment safety.
