import { describe, expect, it, vi } from "vitest";
import type { SqlDatabase } from "../public/postgres.js";
import { AccountLinkService } from "./linking.js";

describe("D1 account linking", () => {
  it("consumes a pairing token and writes its connection in one atomic batch", async () => {
    const query = vi.fn(async () => ({ rows: [{ user_id: "user-1" }] }));
    const batch = vi.fn(async () => [{ rows: [{ token_hash: "claimed" }] }, { rows: [{ website_user_id: "user-1" }] }]);
    const service = new AccountLinkService({ query, batch } as unknown as SqlDatabase);
    expect(await service.consume("abcdefghijklmnopqrstuvwx", "google-subject", new Date("2026-10-14T00:00:00Z"))).toBe(true);
    expect(batch).toHaveBeenCalledTimes(1);
    const statements = batch.mock.calls[0]![0];
    expect(statements).toHaveLength(2);
    expect(statements[0]!.sql).toContain("consumed_by=$3");
    expect(statements[0]!.sql).toContain("used_at IS NULL");
    expect(statements[1]!.sql).toContain("FROM classroom_desk_link_tokens");
    expect(statements[1]!.sql).toContain("ON CONFLICT (website_user_id)");
  });

  it("rejects a token another request already claimed", async () => {
    const query = vi.fn(async () => ({ rows: [{ user_id: "user-1" }] }));
    const batch = vi.fn(async () => [{ rows: [] }, { rows: [] }]);
    const service = new AccountLinkService({ query, batch } as unknown as SqlDatabase);
    expect(await service.consume("abcdefghijklmnopqrstuvwx", "google-subject")).toBe(false);
  });
});
