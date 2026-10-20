import { beforeEach, describe, expect, it, vi } from "vitest";
import { completeWebsiteGoogleLogin } from "./website-auth.js";

const { getTokenMock, verifyIdTokenMock } = vi.hoisted(() => ({ getTokenMock: vi.fn(), verifyIdTokenMock: vi.fn() }));

vi.mock("googleapis-common", () => ({
  OAuth2Client: class {
    getToken = getTokenMock;
    verifyIdToken = verifyIdTokenMock;
  },
}));

describe("website Google identity nonce", () => {
  const config = { clientId: "client-id", clientSecret: "client-secret", callbackUrl: "https://classroom.example/auth/google/callback", origin: "https://classroom.example" };

  beforeEach(() => {
    vi.clearAllMocks();
    getTokenMock.mockResolvedValue({ tokens: { id_token: "synthetic-id-token" } });
    verifyIdTokenMock.mockResolvedValue({ getPayload: () => ({ sub: "google-subject", email: "user@example.test", email_verified: true, name: "Synthetic User", nonce: "expected-nonce" }) });
  });

  it("requires a matching nonce from the verified ID token before linking identity", async () => {
    const upsertGoogleIdentity = vi.fn(async () => ({ id: "account-1" }));
    await expect(completeWebsiteGoogleLogin(config, { upsertGoogleIdentity } as never, "code", "verifier", "expected-nonce"))
      .resolves.toMatchObject({ id: "account-1" });
    expect(verifyIdTokenMock).toHaveBeenCalledWith({ idToken: "synthetic-id-token", audience: "client-id" });
    expect(upsertGoogleIdentity).toHaveBeenCalledWith(expect.objectContaining({ googleSubject: "google-subject", email: "user@example.test" }));
  });

  it("rejects mismatched or absent nonce before account lookup", async () => {
    const upsertGoogleIdentity = vi.fn();
    verifyIdTokenMock.mockResolvedValueOnce({ getPayload: () => ({ sub: "google-subject", email: "user@example.test", email_verified: true, nonce: "another-nonce" }) });
    await expect(completeWebsiteGoogleLogin(config, { upsertGoogleIdentity } as never, "code", "verifier", "expected-nonce")).rejects.toThrow("Verified Google identity required");
    verifyIdTokenMock.mockResolvedValueOnce({ getPayload: () => ({ sub: "google-subject", email: "user@example.test", email_verified: true }) });
    await expect(completeWebsiteGoogleLogin(config, { upsertGoogleIdentity } as never, "code", "verifier", "expected-nonce")).rejects.toThrow("Verified Google identity required");
    expect(upsertGoogleIdentity).not.toHaveBeenCalled();
  });
});
