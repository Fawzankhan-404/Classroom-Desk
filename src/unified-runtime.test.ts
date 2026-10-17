import { describe, expect, it } from "vitest";
import fs from "node:fs";

describe("public self-hosting configuration", () => {
  it("contains no production route, database identifier, or service binding", () => {
    const config = JSON.parse(fs.readFileSync(new URL("../wrangler.example.jsonc", import.meta.url), "utf8")) as {
      name: string; routes?: unknown[]; workers_dev?: boolean; services?: unknown[];
      hyperdrive?: unknown[]; d1_databases?: Array<{ binding: string; database_name: string; database_id: string }>;
      vars?: Record<string, string>;
    };
    expect(config.name).toBe("classroom-desk-selfhosted");
    expect(config.workers_dev).toBe(false);
    expect(config.routes).toEqual([]);
    expect(config.services ?? []).toHaveLength(0);
    expect(config.hyperdrive ?? []).toHaveLength(0);
    expect(config.d1_databases).toEqual([expect.objectContaining({ binding: "DB", database_name: "replace-with-your-own-database", database_id: "00000000-0000-0000-0000-000000000000" })]);
    expect(config.vars?.SAAS_ENFORCE_ENTITLEMENTS).toBe("true");
  });
});
