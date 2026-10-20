import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { V2_BETA_SCOPES } from "./v2/scopes.js";

const root = process.cwd();

describe("V2 feature boundaries", () => {
  it("does not ship a separate beta Worker route or storage binding", () => {
    const config = JSON.parse(fs.readFileSync(path.join(root, "wrangler.example.jsonc"), "utf8")) as { name: string; main: string; routes?: Array<{ pattern: string }>; workers_dev?: boolean; d1_databases: Array<{ database_id: string }> };
    expect(config.name).toBe("classroom-desk-selfhosted");
    expect(config.main).toBe("src/final-worker.ts");
    expect(config.routes ?? []).toEqual([]);
    expect(config.workers_dev).toBe(false);
    expect(config.d1_databases[0]?.database_id).toBe("00000000-0000-0000-0000-000000000000");
  });

  it("keeps the beta Google grant limited to approved scopes", () => {
    expect(V2_BETA_SCOPES).toContain("https://www.googleapis.com/auth/drive.file");
    expect(V2_BETA_SCOPES).not.toContain("https://www.googleapis.com/auth/drive.readonly");
    expect(V2_BETA_SCOPES.some((scope) => scope.includes("gmail"))).toBe(false);
    expect(V2_BETA_SCOPES.some((scope) => /\.write$|\.courses$/i.test(scope))).toBe(false);
  });

  it("keeps the V1 Worker entry point separate", () => {
    const v1 = fs.readFileSync(path.join(root, "src/worker.ts"), "utf8");
    expect(v1).toContain("createPublicApp");
    expect(v1).not.toContain("createV2BetaServer");
  });

  it("has a beta-origin Picker callback and no fail-closed placeholder route", () => {
    const config = JSON.parse(fs.readFileSync(path.join(root, "wrangler.example.jsonc"), "utf8")) as { vars: { V2_PICKER_CALLBACK_URL?: string } };
    expect(config.vars.V2_PICKER_CALLBACK_URL).toBe("https://your-domain.example/picker/callback");
    expect(fs.readFileSync(path.join(root, "src/v2-worker.ts"), "utf8")).not.toContain("picker_runtime_pending");
  });
});
