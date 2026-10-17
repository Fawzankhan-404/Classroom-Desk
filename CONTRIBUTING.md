# Contributing

Thanks for helping improve Classroom Desk. Keep changes focused, protect student privacy, and describe what you tested.

## Before opening a change

- Read [SECURITY.md](SECURITY.md) and the relevant architecture notes.
- Do not include real Classroom records, student names, assignment answers, database exports, OAuth data, or secrets in code, tests, screenshots, logs, or issues.
- Use synthetic fixtures for assessment and account tests.
- Preserve OAuth state, PKCE, account isolation, and Google permission checks.
- Keep teacher demo approval separate from real grades. Gradebook writeback remains disabled in the current demo.
- Do not add a public application hostname or production binding without an approved architecture change.

## Development checks

```bash
npm ci
npm run check
npm test
npm run build
```

For Worker changes, run the documented Wrangler dry run using a non-production configuration. Do not run live OAuth, Drive, billing, or production smoke scripts as part of routine contribution checks.

## Pull requests

Include:

1. A short description of the behavior changed.
2. Focused tests for security and user-visible behavior.
3. Commands run and their results.
4. Any migration, Google scope, or deployment implications.

Do not rewrite existing history to make a change appear older or newer.
