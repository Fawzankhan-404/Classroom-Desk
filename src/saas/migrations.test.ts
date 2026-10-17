import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = (name: string) => readFileSync(new URL(`../../migrations/${name}`, import.meta.url), "utf8");

describe("D1 dashboard preference migration sequence", () => {
  it("adds dashboard_preference once in the migration sequence", () => {
    const unifiedOAuth = migration("0008_unified_oauth_accounts.sql");
    const dashboardPreference = migration("0009_dashboard_preference.sql");
    const additions = [unifiedOAuth, dashboardPreference].filter((sql) => /ALTER\s+TABLE\s+classroom_desk_users\s+ADD\s+COLUMN\s+dashboard_preference/i.test(sql));

    expect(unifiedOAuth).toMatch(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+classroom_desk_oauth_accounts/i);
    expect(additions).toHaveLength(1);
  });
});
