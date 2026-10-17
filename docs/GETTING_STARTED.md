# Getting started

## Prerequisites

- Node.js 20 or newer
- npm
- A Google Cloud project with the Google Classroom API enabled for live account tests
- A Google OAuth Web client configured for the exact local callback used by the selected runtime

Automated tests use synthetic data and do not need Google credentials.

## Install and verify

```bash
npm ci
npm run check
npm test
npm run build
```

The test suite covers the local application and Worker code paths. A successful build does not prove that production and local Worker bundles match or that an authenticated ChatGPT connection works.

## Configure local authorization

1. Copy `.env.example` to `.env`.
2. Use a dedicated development OAuth client and a loopback callback.
3. Choose an authorization store appropriate for local testing. The in-memory adapter is process-local and loses grants on restart.
4. Supply encryption keys through an ignored environment file or a secret manager.
5. Run only the local authentication scripts described in the [ChatGPT connection guide](CHATGPT_CONNECTION_GUIDE.md).

Never copy production secrets or production database rows into a development environment.

## Dashboard migration

The Student/Teacher preference is account data stored in `classroom_desk_users.dashboard_preference`. Migration `0009_dashboard_preference.sql` adds that nullable field; null means no choice has been saved and Student is the display default. Apply migrations only to a dedicated development database while testing.

The Teacher page uses the six synthetic records in `src/hackathon/domain.ts`. It does not read real Classroom submissions.
