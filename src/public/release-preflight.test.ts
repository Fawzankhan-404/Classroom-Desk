import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { evaluateReleasePreflight, PRODUCTION_EXPECTATIONS, readCandidateMigrationNames } from "../../scripts/production-release-preflight.mjs";

const migrationNames = ["0001_test.sql", "0002_test.sql", "0003_test.sql"];

const goodConfig = () => ({
  name: PRODUCTION_EXPECTATIONS.workerName,
  routes: [{ pattern: PRODUCTION_EXPECTATIONS.route }],
  d1_databases: [{ binding: "DB", database_name: PRODUCTION_EXPECTATIONS.d1Name, database_id: PRODUCTION_EXPECTATIONS.d1Id }],
  compatibility_date: PRODUCTION_EXPECTATIONS.compatibilityDate,
  compatibility_flags: [...PRODUCTION_EXPECTATIONS.compatibilityFlags],
  keep_vars: true,
  workers_dev: false,
  preview_urls: false,
  secrets: { required: [...PRODUCTION_EXPECTATIONS.secrets] },
});

const goodMetadata = () => ({
  workerName: PRODUCTION_EXPECTATIONS.workerName,
  activeVersionId: PRODUCTION_EXPECTATIONS.activeVersionId,
  trafficPercentage: 100,
  route: PRODUCTION_EXPECTATIONS.route,
  compatibilityDate: PRODUCTION_EXPECTATIONS.compatibilityDate,
  compatibilityFlags: [...PRODUCTION_EXPECTATIONS.compatibilityFlags],
  d1: {
    name: PRODUCTION_EXPECTATIONS.d1Name,
    id: PRODUCTION_EXPECTATIONS.d1Id,
    migrations: { verified: true, source: "wrangler d1 migrations list", applied: [...migrationNames], pending: [] },
  },
  secretNames: [...PRODUCTION_EXPECTATIONS.secrets],
  plainTextBindingNames: [...PRODUCTION_EXPECTATIONS.plainTextBindings],
  rateLimitBindingNames: [...PRODUCTION_EXPECTATIONS.rateLimitBindings],
  workersDev: false,
  previewUrls: false,
  keepVars: true,
});

const goodEvidence = () => ({
  productionEncryptionCompatibility: true,
  productionSourceBehaviorCompatibility: true,
  syntheticD1MigrationAndTimeTravelRestore: true,
  protectedProductionBackupRestore: true,
  coordinatedRollback: true,
  productionOAuthAndMcpAcceptance: true,
  billingAuthorization: true,
  checksAndSecurity: true,
  ownerDeploymentApproval: true,
  d1MigrationRehearsal: {
    syntheticOnly: true,
    testedMigrationNames: [...migrationNames],
    restoreBeforeMigrationName: "0002_test.sql",
    timeTravelRestorePassed: true,
    reappliedMigrationNames: ["0003_test.sql"],
    dataPreservationPassed: true,
  },
  rollbackPrerequisites: {
    previousWorkerVersionId: PRODUCTION_EXPECTATIONS.activeVersionId,
    previousWorkerVersionRetained: true,
    isolatedWorkerRollbackPassed: true,
    protectedD1BackupRestorePassed: true,
    postRestoreMigrationReplayPassed: true,
    postRollbackSmokePassed: true,
  },
});

describe("production release preflight", () => {
  it("reads only ordered SQL migration filenames from the configured candidate directory", async () => {
    const configPath = fileURLToPath(new URL("../../wrangler.production-candidate.jsonc", import.meta.url));
    const config = JSON.parse(await readFile(configPath, "utf8"));
    const migrations = await readCandidateMigrationNames(configPath, config);
    expect(migrations).toHaveLength(13);
    expect(migrations[0]).toBe("0001_classroom_desk.sql");
    expect(migrations.at(-1)).toBe("0013_legacy_account_recovery.sql");
  });

  it("rejects a migration directory that escapes the candidate configuration directory", async () => {
    const configPath = fileURLToPath(new URL("../../wrangler.production-candidate.jsonc", import.meta.url));
    const base = goodConfig();
    const config = { ...base, d1_databases: [{ ...base.d1_databases[0]!, migrations_dir: "../../outside" }] };
    await expect(readCandidateMigrationNames(configPath, config)).rejects.toThrow("must stay within the config directory");
  });

  it("returns GO only when metadata, config, gates, and explicit owner approval all match", () => {
    expect(evaluateReleasePreflight({ config: goodConfig(), metadata: goodMetadata(), evidence: goodEvidence(), candidateMigrationNames: migrationNames }).decision).toBe("GO");
  });

  it("reports each release gate once, even when labels differ only by punctuation", () => {
    const report = evaluateReleasePreflight({ config: goodConfig(), metadata: goodMetadata(), evidence: goodEvidence(), candidateMigrationNames: migrationNames });
    const normalized = report.checks.map(({ gate }) => gate.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim());
    expect(new Set(normalized).size).toBe(normalized.length);
  });

  it("blocks when owner approval is missing even if all technical gates pass", () => {
    const evidence = goodEvidence();
    evidence.ownerDeploymentApproval = false;
    const result = evaluateReleasePreflight({ config: goodConfig(), metadata: goodMetadata(), evidence, candidateMigrationNames: migrationNames });
    expect(result.decision).toBe("NO-GO");
    expect(result.checks.find((check) => check.gate === "explicit deployment approval")?.status).toBe("BLOCKED");
  });

  it("blocks production identifiers, public endpoint exposure, and binding drift", () => {
    const config = goodConfig();
    config.d1_databases[0]!.database_id = "wrong-database";
    config.workers_dev = true;
    const metadata = goodMetadata();
    metadata.secretNames.pop();
    const result = evaluateReleasePreflight({ config, metadata, evidence: goodEvidence(), candidateMigrationNames: migrationNames });
    expect(result.decision).toBe("NO-GO");
    expect(result.checks.filter((check) => check.status === "BLOCKED").map((check) => check.gate)).toEqual(expect.arrayContaining([
      "candidate D1 binding identity", "candidate public endpoints disabled", "observed secret binding names",
    ]));
  });

  it("does not report GO when metadata or evidence is absent", () => {
    expect(evaluateReleasePreflight({ config: goodConfig() }).decision).toBe("NO-GO");
  });

  it("blocks when the migration ledger is missing, inconsistent, or has pending migrations", () => {
    const metadata = goodMetadata();
    metadata.d1.migrations.pending = ["0003_test.sql"];
    metadata.d1.migrations.applied.pop();
    const result = evaluateReleasePreflight({ config: goodConfig(), metadata, evidence: goodEvidence(), candidateMigrationNames: migrationNames });
    expect(result.decision).toBe("NO-GO");
    expect(result.checks.find((check) => check.gate === "D1 migration ledger matches the candidate")?.status).toBe("BLOCKED");
    expect(evaluateReleasePreflight({ config: goodConfig(), metadata: goodMetadata(), evidence: goodEvidence() }).decision).toBe("NO-GO");
  });

  it("blocks if rollback evidence omits isolated restore, migration replay, or the exact retained Worker version", () => {
    const evidence = goodEvidence();
    evidence.rollbackPrerequisites.previousWorkerVersionId = "not-the-observed-v22-version";
    evidence.rollbackPrerequisites.postRestoreMigrationReplayPassed = false;
    const result = evaluateReleasePreflight({ config: goodConfig(), metadata: goodMetadata(), evidence, candidateMigrationNames: migrationNames });
    expect(result.decision).toBe("NO-GO");
    expect(result.checks.find((check) => check.gate === "coordinated rollback evidence")?.status).toBe("BLOCKED");
  });

  it("rejects migration rehearsal records that are not synthetic or do not reapply the post-restore suffix", () => {
    const evidence = goodEvidence();
    evidence.d1MigrationRehearsal.syntheticOnly = false;
    evidence.d1MigrationRehearsal.reappliedMigrationNames = ["0002_test.sql"];
    const result = evaluateReleasePreflight({ config: goodConfig(), metadata: goodMetadata(), evidence, candidateMigrationNames: migrationNames });
    expect(result.decision).toBe("NO-GO");
  });

  it("rejects metadata fields that could carry binding values", () => {
    const metadata = { ...goodMetadata(), secretValues: { RAZORPAY_KEY_SECRET: "not-accepted" } };
    const result = evaluateReleasePreflight({ config: goodConfig(), metadata, evidence: goodEvidence(), candidateMigrationNames: migrationNames });
    expect(result.decision).toBe("NO-GO");
    expect(result.checks.find((check) => check.gate === "metadata contains names and settings only")?.status).toBe("BLOCKED");
  });

  it.each([
    ["workers.dev", "workersDev", true],
    ["preview URLs", "previewUrls", true],
    ["variable retention", "keepVars", false],
  ])("blocks observed metadata when %s settings contradict the production candidate", (_label, key, value) => {
    const metadata = goodMetadata();
    Object.assign(metadata, { [key]: value });
    const result = evaluateReleasePreflight({ config: goodConfig(), metadata, evidence: goodEvidence(), candidateMigrationNames: migrationNames });
    expect(result.decision).toBe("NO-GO");
    expect(result.checks.find((check) => check.gate === "observed public endpoint and variable retention settings")?.status).toBe("BLOCKED");
  });
});
