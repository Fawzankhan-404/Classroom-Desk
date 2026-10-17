# Self-hosting

Classroom Desk can be self-hosted by an operator who can configure Google OAuth, an authorization database, encrypted token storage, and a supported Worker runtime.

## Required setup

1. Create a Google Cloud project and enable the Google Classroom API.
2. Configure an OAuth Web client with the callback URL for your own installation. Keep local, staging, and production clients separate.
3. Configure `PUBLIC_APP_ORIGIN`, the MCP resource URL, OAuth client values, an authorization store, and a securely generated 32-byte encryption key.
4. Apply the schema migrations to a new, isolated database in order.
5. Validate OAuth, account linking, token refresh, and read-only course listing using a dedicated test account.
6. Configure your own domain and TLS. Do not reuse Classroom Desk's production domain, Worker, database, or credentials.

Use a non-production deployment configuration with `workers_dev` disabled unless the operator has explicitly approved a temporary endpoint. Never point a development configuration at customer data.

## Deployment safety

Use the sanitized `wrangler.example.jsonc` template, replace its placeholders with resources you control, and review every binding before deploying. A Wrangler dry run checks bundling and configuration syntax; it does not establish database compatibility, key validity, OAuth acceptance, or rollback safety.

Do not point a self-hosted deployment at customer data until source provenance, encryption compatibility, migration sequence, and rollback target have been verified.
