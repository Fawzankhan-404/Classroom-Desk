# Security policy

## Reporting

Do not open a public issue for a suspected vulnerability or include private Classroom content. Contact the project maintainer at the support address listed on [classroom.jarvis404.com/support](https://classroom.jarvis404.com/support). Include a concise description, affected version or commit, and safe reproduction steps. Do not send passwords, OAuth codes, refresh tokens, encryption keys, or student records.

## Scope and protections

Classroom Desk handles Google OAuth, MCP authorization, account linking, and Classroom data. Changes must preserve state and PKCE validation, single-use authorization codes, refresh-token rotation, secure session handling, same-origin mutation checks, account isolation, and server-verified Google permissions.

Selecting Teacher is a dashboard preference, not an authorization grant. The current teacher assessment is synthetic-only. Gradebook writeback is disabled.

## Sensitive files

Never commit `.env`, `.dev.vars`, OAuth client JSON, token files, database backups, Cloudflare credentials, or production diagnostics containing personal data. Review Git history as well as the working tree before publishing a repository.
