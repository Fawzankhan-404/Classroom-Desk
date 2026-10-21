#!/usr/bin/env node
import { readFile, readdir } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

export const PRODUCTION_EXPECTATIONS = Object.freeze({
  workerName: "classroom-desk",
  activeVersionId: "2080fc00-de39-43ac-a4e6-10e7512d46a6",
  d1Name: "classroom-desk-db",
  d1Id: "805f756e-16ea-40e2-a032-335176793b8e",
  route: "classroom.jarvis404.com/*",
  compatibilityDate: "2026-10-02",
  compatibilityFlags: ["nodejs_compat"],
  secrets: [
    "INTERNAL_DELEGATION_SECRET", "MCP_ACCESS_POLICY_SECRET", "MCP_GRANDFATHERED_SUBJECT_HASHES",
    "MCP_HANDOFF_SIGNING_SECRET", "RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET", "RAZORPAY_STUDENT_PLAN_ID",
    "RAZORPAY_TEACHER_PLAN_ID", "RAZORPAY_WEBHOOK_SECRET", "V2_GOOGLE_OAUTH_CLIENT_ID",
    "V2_GOOGLE_OAUTH_CLIENT_SECRET", "V2_PUBLIC_AUTH_ENCRYPTION_KEY_B64",
  ],
  plainTextBindings: [
    "SAAS_BILLING_ALLOWLIST_UUIDS", "SAAS_BILLING_UI_ENABLED", "SAAS_ENFORCE_ENTITLEMENTS",
    "SAAS_RECONCILIATION_ENABLED", "SAAS_REFERRAL_REWARDS_ENABLED", "SAAS_TEACHER_FEATURES_ENABLED",
    "V2_AUTH_TABLE", "V2_PICKER_CALLBACK_URL", "V2_PUBLIC_APP_ORIGIN", "V2_PUBLIC_OPERATOR_NAME",
    "V2_PUBLIC_SUPPORT_EMAIL",
  ],
  rateLimitBindings: ["V2_AUTH_RATE_LIMIT", "V2_PUBLIC_RATE_LIMIT"],
});

const sorted = (values) => [...new Set(values ?? [])].sort();
const same = (a, b) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
const sameOrdered = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const keys = (value) => value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value) : [];
const result = (id, pass) => ({ gate: id, status: pass ? "PASS" : "BLOCKED" });
const MIGRATION_NAME = /^\d{4}_[a-z0-9][a-z0-9_-]*\.sql$/i;

const isNameList = (values) => Array.isArray(values)
  && values.every((value) => typeof value === "string" && MIGRATION_NAME.test(value))
  && new Set(values).size === values.length;

/** Read the candidate migration inventory without contacting Cloudflare. */
export async function readCandidateMigrationNames(configPath, config) {
  const d1 = config?.d1_databases?.find((binding) => binding.binding === "DB");
  if (typeof configPath !== "string" || typeof d1?.migrations_dir !== "string" || !d1.migrations_dir.trim()) {
    throw new Error("candidate migration inventory unavailable");
  }
  const configDirectory = dirname(resolve(configPath));
  const migrationDirectory = resolve(configDirectory, d1.migrations_dir);
  const relativeDirectory = relative(configDirectory, migrationDirectory);
  if (!relativeDirectory || relativeDirectory === ".." || relativeDirectory.startsWith(`..${sep}`) || isAbsolute(relativeDirectory)) {
    throw new Error("candidate migration directory must stay within the config directory");
  }
  const entries = await readdir(migrationDirectory, { withFileTypes: true });
  const names = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name).sort();
  if (names.length === 0 || !isNameList(names)) throw new Error("candidate migration inventory is invalid");
  return names;
}

function hasSafeMetadataShape(metadata) {
  const only = (value, allowed) => value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).every((key) => allowed.includes(key));
  if (!only(metadata, [
    "workerName", "activeVersionId", "trafficPercentage", "route", "compatibilityDate", "compatibilityFlags",
    "d1", "secretNames", "plainTextBindingNames", "rateLimitBindingNames", "workersDev", "previewUrls", "keepVars",
  ])) return false;
  if (!only(metadata.d1, ["name", "id", "migrations"])) return false;
  return only(metadata.d1.migrations, ["verified", "source", "applied", "pending"]);
}

function migrationLedgerMatches(metadata, candidateMigrationNames) {
  const ledger = metadata?.d1?.migrations;
  if (!isNameList(candidateMigrationNames) || !Array.isArray(ledger?.applied) || !Array.isArray(ledger?.pending)
    || !isNameList(ledger.applied) || !isNameList(ledger.pending)) return false;
  if (ledger.verified !== true || ledger.source !== "wrangler d1 migrations list") return false;
  const appliedSet = new Set(ledger.applied);
  const pendingSet = new Set(ledger.pending);
  if (ledger.applied.some((name) => pendingSet.has(name))) return false;
  const expectedApplied = candidateMigrationNames.filter((name) => appliedSet.has(name));
  const expectedPending = candidateMigrationNames.filter((name) => pendingSet.has(name));
  const allKnown = [...ledger.applied, ...ledger.pending].every((name) => candidateMigrationNames.includes(name));
  const complete = ledger.applied.length + ledger.pending.length === candidateMigrationNames.length;
  return allKnown && complete
    && sameOrdered(ledger.applied, expectedApplied)
    && sameOrdered(ledger.pending, expectedPending)
    && ledger.pending.length === 0;
}

function migrationRehearsalPassed(evidence, candidateMigrationNames) {
  const rehearsal = evidence?.d1MigrationRehearsal;
  if (!isNameList(candidateMigrationNames) || !rehearsal || typeof rehearsal !== "object") return false;
  if (rehearsal.syntheticOnly !== true || rehearsal.timeTravelRestorePassed !== true || rehearsal.dataPreservationPassed !== true
    || !sameOrdered(rehearsal.testedMigrationNames, candidateMigrationNames)
    || !candidateMigrationNames.includes(rehearsal.restoreBeforeMigrationName)) return false;
  const restoreIndex = candidateMigrationNames.indexOf(rehearsal.restoreBeforeMigrationName);
  return sameOrdered(rehearsal.reappliedMigrationNames, candidateMigrationNames.slice(restoreIndex + 1));
}

function rollbackPrerequisitesPassed(evidence) {
  const rollback = evidence?.rollbackPrerequisites;
  return rollback?.previousWorkerVersionId === PRODUCTION_EXPECTATIONS.activeVersionId
    && rollback?.previousWorkerVersionRetained === true
    && rollback?.isolatedWorkerRollbackPassed === true
    && rollback?.protectedD1BackupRestorePassed === true
    && rollback?.postRestoreMigrationReplayPassed === true
    && rollback?.postRollbackSmokePassed === true;
}

/**
 * Read-only deployment guard. `metadata` must contain binding names and settings
 * only; secret values are neither required nor returned. This function never
 * performs Cloudflare requests or deployment actions.
 */
export function evaluateReleasePreflight({ config, metadata, evidence, candidateMigrationNames } = {}) {
  const expected = PRODUCTION_EXPECTATIONS;
  const configSecrets = config?.secrets?.required;
  const configD1 = config?.d1_databases?.find((binding) => binding.binding === "DB");
  const configRouteNames = (config?.routes ?? []).map((route) => route.pattern);
  const checks = [
    result("metadata contains names and settings only", hasSafeMetadataShape(metadata)),
    result("candidate worker name", config?.name === expected.workerName),
    result("candidate production route", same(configRouteNames, [expected.route])),
    result("candidate D1 binding identity", configD1?.binding === "DB" && configD1?.database_name === expected.d1Name && configD1?.database_id === expected.d1Id),
    result("candidate runtime compatibility", config?.compatibility_date === expected.compatibilityDate && same(config?.compatibility_flags, expected.compatibilityFlags)),
    result("candidate retains production variables", config?.keep_vars === true && keys(config?.vars).length === 0),
    result("candidate public endpoints disabled", config?.workers_dev === false && config?.preview_urls === false),
    result("candidate required secret names", same(configSecrets, expected.secrets)),
    result("observed worker and active version", metadata?.workerName === expected.workerName && metadata?.activeVersionId === expected.activeVersionId && metadata?.trafficPercentage === 100),
    result("observed route and runtime", metadata?.route === expected.route && metadata?.compatibilityDate === expected.compatibilityDate && same(metadata?.compatibilityFlags, expected.compatibilityFlags)),
    result("observed D1 identity", metadata?.d1?.name === expected.d1Name && metadata?.d1?.id === expected.d1Id),
    result("observed secret binding names", same(metadata?.secretNames, expected.secrets)),
    result("observed retained variable names", same(metadata?.plainTextBindingNames, expected.plainTextBindings)),
    result("observed rate limit binding names", same(metadata?.rateLimitBindingNames, expected.rateLimitBindings)),
    result("observed public endpoint and variable retention settings", metadata?.workersDev === false && metadata?.previewUrls === false && metadata?.keepVars === true),
    result("D1 migration ledger matches the candidate", migrationLedgerMatches(metadata, candidateMigrationNames)),
    result("existing production encryption compatibility evidence", evidence?.productionEncryptionCompatibility === true),
    result("production source behavior compatibility evidence", evidence?.productionSourceBehaviorCompatibility === true),
    result("synthetic D1 migration, Time Travel, and reapplication rehearsal", evidence?.syntheticD1MigrationAndTimeTravelRestore === true && migrationRehearsalPassed(evidence, candidateMigrationNames)),
    result("protected production backup restore evidence", evidence?.protectedProductionBackupRestore === true),
    result("coordinated rollback evidence", evidence?.coordinatedRollback === true && rollbackPrerequisitesPassed(evidence)),
    result("production OAuth and authenticated MCP acceptance evidence", evidence?.productionOAuthAndMcpAcceptance === true),
    result("billing authorization evidence", evidence?.billingAuthorization === true),
    result("final checks and security scan evidence", evidence?.checksAndSecurity === true),
    result("explicit deployment approval", evidence?.ownerDeploymentApproval === true),
  ];
  return { decision: checks.every((check) => check.status === "PASS") ? "GO" : "NO-GO", checks };
}

async function main(args) {
  if (args.length !== 3 || args.includes("--help") || args.includes("-h")) {
    process.stdout.write("Usage: node scripts/production-release-preflight.mjs <candidate-config> <metadata-names-only.json> <release-evidence.json>\n");
    process.stdout.write("The command is read-only and never deploys. Metadata must omit all secret values.\n");
    return args.length === 0 || args.includes("--help") || args.includes("-h") ? 0 : 2;
  }
  let config, metadata, evidence, candidateMigrationNames;
  try {
    [config, metadata, evidence] = await Promise.all(args.map(async (file) => JSON.parse(await readFile(file, "utf8"))));
    candidateMigrationNames = await readCandidateMigrationNames(args[0], config);
  } catch {
    process.stdout.write("NO-GO: an input is invalid or the candidate migration inventory is unavailable.\n");
    return 2;
  }
  const report = evaluateReleasePreflight({ config, metadata, evidence, candidateMigrationNames });
  process.stdout.write(`${report.decision}\n`);
  for (const check of report.checks) process.stdout.write(`${check.status} ${check.gate}\n`);
  return report.decision === "GO" ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
