#!/usr/bin/env node
import { readFile } from "node:fs/promises";
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
const keys = (value) => value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value) : [];
const result = (id, pass) => ({ gate: id, status: pass ? "PASS" : "BLOCKED" });

/**
 * Read-only deployment guard. `metadata` must contain binding names and settings
 * only; secret values are neither required nor returned. This function never
 * performs Cloudflare requests or deployment actions.
 */
export function evaluateReleasePreflight({ config, metadata, evidence } = {}) {
  const expected = PRODUCTION_EXPECTATIONS;
  const configSecrets = config?.secrets?.required;
  const configD1 = config?.d1_databases?.find((binding) => binding.binding === "DB");
  const configRouteNames = (config?.routes ?? []).map((route) => route.pattern);
  const checks = [
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
    result("existing production encryption compatibility evidence", evidence?.productionEncryptionCompatibility === true),
    result("production source behavior compatibility evidence", evidence?.productionSourceBehaviorCompatibility === true),
    result("synthetic D1 migration and Time Travel rehearsal", evidence?.syntheticD1MigrationAndTimeTravelRestore === true),
    result("protected production backup restore evidence", evidence?.protectedProductionBackupRestore === true),
    result("coordinated rollback evidence", evidence?.coordinatedRollback === true),
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
  let config, metadata, evidence;
  try {
    [config, metadata, evidence] = await Promise.all(args.map(async (file) => JSON.parse(await readFile(file, "utf8"))));
  } catch {
    process.stdout.write("NO-GO: one or more JSON inputs are unavailable or invalid.\n");
    return 2;
  }
  const report = evaluateReleasePreflight({ config, metadata, evidence });
  process.stdout.write(`${report.decision}\n`);
  for (const check of report.checks) process.stdout.write(`${check.status} ${check.gate}\n`);
  return report.decision === "GO" ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
