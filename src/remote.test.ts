import { describe, expect, it, vi } from "vitest";
import { createAuthenticatedServer } from "./remote.js";

describe("remote authentication boundary", () => {
  it("rejects missing and malformed authorization before token or grant lookup", async () => {
    const verifier = { verifyBearer: vi.fn() };
    const grants = { googleAuthForUser: vi.fn() };
    await expect(createAuthenticatedServer(undefined, verifier, grants)).rejects.toThrow("Unauthorized");
    await expect(createAuthenticatedServer("Basic abc", verifier, grants)).rejects.toThrow("Unauthorized");
    expect(verifier.verifyBearer).not.toHaveBeenCalled();
    expect(grants.googleAuthForUser).not.toHaveBeenCalled();
  });

  it("never resolves a grant after invalid authorization", async () => {
    const grants = { googleAuthForUser: vi.fn() };
    await expect(createAuthenticatedServer("Bearer opaque", { verifyBearer: async () => { throw new Error("private token details"); } }, grants)).rejects.toThrow("Unauthorized");
    expect(grants.googleAuthForUser).not.toHaveBeenCalled();
  });
});
