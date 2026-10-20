import { describe, expect, it } from "vitest";
import fs from "node:fs";

describe("self-hosted Worker configuration", () => {
  it("uses placeholders and has no live route or production database binding", () => {
    const config = JSON.parse(fs.readFileSync(new URL("../wrangler.example.jsonc", import.meta.url), "utf8")) as {
      name: string; routes?: Array<{ pattern: string }>; workers_dev?: boolean; services?: unknown[]; hyperdrive?: unknown[];
      durable_objects?: unknown; migrations?: unknown[];
      d1_databases?: Array<{ binding: string; database_name: string; database_id: string; migrations_dir: string }>;
      secrets?: { required?: string[] }; vars?: Record<string, string>;
    };
    expect(config.name).toBe("classroom-desk-selfhosted");
    expect(config.workers_dev).toBe(false);
    expect(config.routes ?? []).toEqual([]);
    expect(config.durable_objects ?? {}).toEqual({});
    expect(config.d1_databases).toEqual([{ binding: "DB", database_name: "replace-with-your-own-database", database_id: "00000000-0000-0000-0000-000000000000", migrations_dir: "migrations" }]);
    expect(config.services ?? []).toHaveLength(0);
    expect(config.hyperdrive ?? []).toHaveLength(0);
    expect(config.vars?.V2_PUBLIC_APP_ORIGIN).toBe("https://your-domain.example");
    expect(config.vars?.SAAS_BILLING_UI_ENABLED).toBe("false");
    expect(config.vars?.SAAS_RECONCILIATION_ENABLED).toBe("false");
    expect(config.vars?.SAAS_TEACHER_FEATURES_ENABLED).toBe("false");
    expect(config.secrets?.required ?? []).toHaveLength(0);
  });

  it("uses one D1 adapter for request and scheduled database work", () => {
    const source = fs.readFileSync(new URL("./final-worker.ts", import.meta.url), "utf8");
    expect(source).toContain('import { D1SqlDatabase } from "./public/d1-database.js"');
    expect(source).toContain("const database = new D1SqlDatabase(bindings.DB)");
    expect(source).not.toContain("NeonWorkerDatabase");
    expect(source).not.toContain("HYPERDRIVE");
    expect(source).not.toContain("NEON_DATABASE_URL");
    expect(source).not.toContain("LEGACY_MCP");
    expect(source).not.toContain("/v2-runtime");
  });

  it("uses one Google OAuth client for website and MCP callbacks", () => {
    const source = fs.readFileSync(new URL("./final-worker.ts", import.meta.url), "utf8");
    expect(source).toContain("clientId: bindings.V2_GOOGLE_OAUTH_CLIENT_ID");
    expect(source).toContain("clientSecret: bindings.V2_GOOGLE_OAUTH_CLIENT_SECRET");
    expect(source).not.toContain("WEBSITE_GOOGLE_OAUTH_CLIENT_ID");
    expect(source).not.toContain("WEBSITE_GOOGLE_OAUTH_CLIENT_SECRET");
  });

  it("keeps scheduled billing reconciliation behind its own kill switch", () => {
    const source = fs.readFileSync(new URL("./final-worker.ts", import.meta.url), "utf8");
    expect(source).toContain("isSaaSReconciliationEnabled(bindings)");
    expect(source).not.toContain('bindings.SAAS_BILLING_UI_ENABLED === "true" || bindings.SAAS_RECONCILIATION_ENABLED === "true"');
  });

  it("keeps teacher draft operations behind the feature flag and explicit expanded scope", () => {
    const source = fs.readFileSync(new URL("./final-worker.ts", import.meta.url), "utf8");
    expect(source).toContain("teacherWriteScopes = V2_TEACHER_WRITE_SCOPES");
    expect(source).toContain("teacherWriteGrantValidator = isExactV2TeacherWriteGrant");
    expect(source).toContain("hasTeacherMcpEntitlement(saasStore, userId, config.saasFlags?.teacherFeatures === true)");
    expect(source).toContain("teacherEntitled");
    expect(source).not.toContain("saasStore.entitlement(userId)");
    expect(source).toContain("isExactV2TeacherWriteGrant(scopes)");
    expect(source).toContain("createTeacherCourseworkDraft");
    expect(source).not.toContain("updateTeacherCourseworkDraft");
  });

  it("does not enable real teacher draft writes in the self-hosting example", () => {
    const config = JSON.parse(fs.readFileSync(new URL("../wrangler.example.jsonc", import.meta.url), "utf8")) as {
      vars?: Record<string, string>;
    };
    expect(config.vars?.SAAS_TEACHER_DRAFT_WRITES_ENABLED).not.toBe("true");
  });

  it("keeps the Classroom grant limited to the established read-only scopes", () => {
    const source = fs.readFileSync(new URL("../src/scopes.ts", import.meta.url), "utf8");
    expect(source).toContain("classroom.courses.readonly");
    expect(source).toContain("classroom.student-submissions.me.readonly");
    expect(source).not.toContain("drive.readonly");
    expect(source).not.toContain("gmail");
    expect(source).not.toContain("coursework.create");
  });
});
