import { describe, expect, it } from "vitest";
import fs from "node:fs";

describe("self-hosted Worker example", () => {
  it("uses placeholders with no production route or production database", () => {
    const config = JSON.parse(fs.readFileSync(new URL("../wrangler.example.jsonc", import.meta.url), "utf8")) as {
      name: string; workers_dev?: boolean; routes?: Array<{ pattern: string }>;
      d1_databases?: Array<{ binding: string; database_name: string; database_id: string; migrations_dir: string }>;
      vars?: Record<string, string>;
    };
    expect(config.name).toBe("classroom-desk-selfhosted");
    expect(config.workers_dev).toBe(false);
    expect(config.routes).toEqual([]);
    expect(config.d1_databases).toEqual([expect.objectContaining({ binding: "DB", database_name: "replace-with-your-own-database", database_id: "00000000-0000-0000-0000-000000000000", migrations_dir: "migrations" })]);
    expect(config.vars?.SAAS_ENFORCE_ENTITLEMENTS).toBe("true");
    expect(config.vars?.SAAS_BILLING_UI_ENABLED).toBe("false");
    expect(config.vars?.SAAS_REFERRAL_REWARDS_ENABLED).toBe("false");
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

  it("keeps the Classroom grant limited to the established read-only scopes", () => {
    const source = fs.readFileSync(new URL("../src/scopes.ts", import.meta.url), "utf8");
    expect(source).toContain("classroom.courses.readonly");
    expect(source).toContain("classroom.student-submissions.me.readonly");
    expect(source).not.toContain("drive.readonly");
    expect(source).not.toContain("gmail");
    expect(source).not.toContain("coursework.create");
  });
});
