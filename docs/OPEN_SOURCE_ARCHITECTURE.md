# Open-source architecture

## Request path

1. A user signs in to the website with Google OAuth.
2. Classroom Desk stores an account session and links the authorized Google identity server-side.
3. The user selects Student or Teacher. The preference is stored on their own account; it does not change Google roles or scopes.
4. ChatGPT connects to the MCP endpoint using OAuth.
5. MCP requests resolve the authenticated account and use its Google authorization to read supported Classroom resources.

## Components

- `src/final-worker.ts`: Cloudflare Worker entry point and request wiring.
- `src/public/http.ts`: MCP transport, public pages, and public OAuth routes.
- `src/saas/website-routes.ts`: website sign-in, account dashboard, experience preference, and synthetic demo routes.
- `src/saas/store.ts`: account, session, D1/PostgreSQL persistence, authorization policy, and historical billing records.
- `src/saas/unified-oauth.ts`: account-bound MCP authorization flow.
- `src/hackathon/domain.ts`: fixed synthetic rubric and six sample responses.
- `src/hackathon/demo-state.ts`: local synthetic assessment state and approval rules.
- `migrations/`: ordered D1 schema changes.

The Student MCP workflow includes one explicitly confirmed Google Drive file creation action for saving a generated PDF. It does not submit that file to Classroom. Classroom content and gradebook operations remain read-only in the current release candidate.

## Authorization boundaries

The website identity is canonical only after server-side OAuth validation. MCP account binding is based on validated grant and session state, not email matching. User dashboard preference is not a Google role. Real teacher data requires server-verified teacher authorization; the sample dashboard remains synthetic. No demo action invokes Google gradebook APIs.

Before self-hosting, use deployment metadata and reproducible build artifacts to establish the source version and test the database recovery plan.
