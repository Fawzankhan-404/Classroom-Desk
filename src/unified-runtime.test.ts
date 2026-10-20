import { describe, expect, it } from "vitest";
import fs from "node:fs";

describe("public repository release boundary", () => {
  it("keeps the public self-hosting manifest isolated from production and staging resources", () => {
    const config = JSON.parse(fs.readFileSync(new URL("../wrangler.example.jsonc", import.meta.url), "utf8")) as {
      name: string;
      main: string;
      workers_dev?: boolean;
      routes?: Array<{ pattern: string; zone_name: string }>;
      services?: unknown[];
      hyperdrive?: unknown[];
      d1_databases?: Array<{ binding: string; database_name: string; database_id: string; migrations_dir?: string }>;
      vars?: Record<string, string>;
      secrets?: { required?: string[] };
    };
    expect(config.name).toBe("classroom-desk-selfhosted");
    expect(config.main).toBe("src/final-worker.ts");
    expect(config.workers_dev).toBe(false);
    expect(config.routes).toEqual([]);
    expect(config.services ?? []).toHaveLength(0);
    expect(config.hyperdrive ?? []).toHaveLength(0);
    expect(config.d1_databases).toEqual([{ binding: "DB", database_name: "replace-with-your-own-database", database_id: "00000000-0000-0000-0000-000000000000", migrations_dir: "migrations" }]);
    expect(config.vars?.V2_PUBLIC_APP_ORIGIN).toBe("https://your-domain.example");
    expect(config.vars?.V2_PICKER_CALLBACK_URL).toBe("https://your-domain.example/picker/callback");
    expect(config.secrets?.required ?? []).toHaveLength(0);
  });
});
