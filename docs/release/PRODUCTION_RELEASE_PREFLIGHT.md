# Production release preflight

`node scripts/production-release-preflight.mjs <candidate-config> <metadata-names-only.json> <release-evidence.json>` is a read-only guard. It does not call Cloudflare or deploy. It prints `GO` only when the candidate matches the recorded production target, sanitized metadata matches the Worker, every release gate has affirmative evidence, and owner deployment approval is recorded.

The metadata input must contain only the worker name, active version ID and traffic percentage, route, compatibility date and flags, D1 name and ID, secret binding **names**, plain-text variable **names**, and rate-limit binding **names**. Do not include values. Secret values are neither needed nor read.

The evidence input must set these booleans only after the named checks are actually complete: `productionEncryptionCompatibility`, `productionSourceBehaviorCompatibility`, `syntheticD1MigrationAndTimeTravelRestore`, `protectedProductionBackupRestore`, `coordinatedRollback`, `productionOAuthAndMcpAcceptance`, `billingAuthorization`, `checksAndSecurity`, and `ownerDeploymentApproval`. Missing, false, or malformed evidence remains `NO-GO`.

The committed expectations currently describe Worker `classroom-desk` v22 and its observed D1, route, and runtime. Update the expectations only after new Cloudflare metadata is independently verified. The script is an additional guard, not proof of source parity or data compatibility.
