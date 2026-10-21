import { describe, expect, it } from "vitest";
import { evaluateReleasePreflight, PRODUCTION_EXPECTATIONS } from "../../scripts/production-release-preflight.mjs";

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
  d1: { name: PRODUCTION_EXPECTATIONS.d1Name, id: PRODUCTION_EXPECTATIONS.d1Id },
  secretNames: [...PRODUCTION_EXPECTATIONS.secrets],
  plainTextBindingNames: [...PRODUCTION_EXPECTATIONS.plainTextBindings],
  rateLimitBindingNames: [...PRODUCTION_EXPECTATIONS.rateLimitBindings],
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
});

describe("production release preflight", () => {
  it("returns GO only when metadata, config, gates, and explicit owner approval all match", () => {
    expect(evaluateReleasePreflight({ config: goodConfig(), metadata: goodMetadata(), evidence: goodEvidence() }).decision).toBe("GO");
  });

  it("blocks when owner approval is missing even if all technical gates pass", () => {
    const evidence = goodEvidence();
    evidence.ownerDeploymentApproval = false;
    const result = evaluateReleasePreflight({ config: goodConfig(), metadata: goodMetadata(), evidence });
    expect(result.decision).toBe("NO-GO");
    expect(result.checks.find((check) => check.gate === "explicit deployment approval")?.status).toBe("BLOCKED");
  });

  it("blocks production identifiers, public endpoint exposure, and binding drift", () => {
    const config = goodConfig();
    config.d1_databases[0]!.database_id = "wrong-database";
    config.workers_dev = true;
    const metadata = goodMetadata();
    metadata.secretNames.pop();
    const result = evaluateReleasePreflight({ config, metadata, evidence: goodEvidence() });
    expect(result.decision).toBe("NO-GO");
    expect(result.checks.filter((check) => check.status === "BLOCKED").map((check) => check.gate)).toEqual(expect.arrayContaining([
      "candidate D1 binding identity", "candidate public endpoints disabled", "observed secret binding names",
    ]));
  });

  it("does not report GO when metadata or evidence is absent", () => {
    expect(evaluateReleasePreflight({ config: goodConfig() }).decision).toBe("NO-GO");
  });
});
