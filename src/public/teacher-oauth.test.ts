import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ options: undefined as Record<string, unknown> | undefined, tokens: undefined as Record<string, unknown> | undefined, payload: undefined as Record<string, unknown> | undefined }));
vi.mock("googleapis-common", () => ({
  OAuth2Client: class {
    generateAuthUrl(options: Record<string, unknown>) { fake.options = options; return "https://accounts.google.com/o/oauth2/v2/auth?test=1"; }
    async getToken() { return { tokens: fake.tokens }; }
    async verifyIdToken() { return { getPayload: () => fake.payload }; }
  },
}));

import { PublicOAuthProvider } from "./oauth.js";
import { MemoryPublicAuthStore } from "./store.js";
import { V2_BETA_SCOPES, isExactV2GoogleGrant } from "../v2/scopes.js";
import { TEACHER_CLASSROOM_SCOPES } from "../scopes.js";

const userId = "mcp-user-1";
const state = "12345678901234567890123456789012";
const verifier = "1234567890123456789012345678901234567890123";
const callback = "https://classroom.jarvis404.com/auth/google/callback";

async function setup() {
  const store = new MemoryPublicAuthStore();
  await store.putGrant({ userId, googleSubject: "google-subject-1", refreshToken: "existing-refresh", scopes: [...V2_BETA_SCOPES], createdAt: 1, updatedAt: 2 });
  const provider = new PublicOAuthProvider(store, {
    origin: new URL("https://classroom.jarvis404.com"), googleClientId: "client-id", googleClientSecret: "client-secret",
    googleCallbackUrl: "https://classroom.jarvis404.com/oauth/google/callback", mcpResource: new URL("https://classroom.jarvis404.com/mcp"),
    googleGrantValidator: isExactV2GoogleGrant,
  });
  return { store, provider };
}

describe("explicit teacher OAuth scope upgrade", () => {
  beforeEach(() => { fake.options = undefined; fake.tokens = undefined; fake.payload = undefined; });

  it("requests only the existing grant plus read-only teacher scopes with state and S256 PKCE", async () => {
    const { provider } = await setup();
    await expect(provider.beginTeacherAuthorization(userId, state, verifier, callback)).resolves.toContain("accounts.google.com");
    const options = fake.options!;
    expect(options.state).toBe(state);
    expect(options.nonce).toBe(state);
    expect(options.code_challenge_method).toBe("S256");
    expect(options.code_challenge).toBe(createHash("sha256").update(verifier).digest("base64url"));
    expect(options.scope).toEqual(expect.arrayContaining([...V2_BETA_SCOPES, ...TEACHER_CLASSROOM_SCOPES, "openid", "email", "profile"]));
    expect(options.scope).not.toContain("https://www.googleapis.com/auth/classroom.coursework.students");
    expect(options.scope).not.toContain("https://www.googleapis.com/auth/classroom.rosters");
  });

  it("persists verified teacher read scopes without replacing a missing new refresh token", async () => {
    const { store, provider } = await setup();
    fake.tokens = { id_token: "synthetic-id-token", scope: [...V2_BETA_SCOPES, ...TEACHER_CLASSROOM_SCOPES].join(" ") };
    fake.payload = { sub: "google-subject-1", nonce: state };
    await provider.completeTeacherAuthorization(userId, state, "synthetic-code", verifier, callback);
    await expect(store.getGrant(userId)).resolves.toMatchObject({
      googleSubject: "google-subject-1", refreshToken: "existing-refresh",
      scopes: expect.arrayContaining([...V2_BETA_SCOPES, ...TEACHER_CLASSROOM_SCOPES]),
    });
  });

  it("accepts Google's exact canonical read-only grant variant after incremental authorization", async () => {
    const { store, provider } = await setup();
    const canonical = [...new Set([...V2_BETA_SCOPES.filter(scope => scope !== "https://www.googleapis.com/auth/classroom.coursework.me.readonly"), ...TEACHER_CLASSROOM_SCOPES])];
    fake.tokens = { id_token: "synthetic-id-token", scope: canonical.join(" ") };
    fake.payload = { sub: "google-subject-1", nonce: state };
    await expect(provider.completeTeacherAuthorization(userId, state, "synthetic-code", verifier, callback)).resolves.toBeUndefined();
    await expect(store.getGrant(userId)).resolves.toMatchObject({ scopes: expect.arrayContaining([...TEACHER_CLASSROOM_SCOPES]) });
  });

  it("rejects a different Google identity without changing the existing grant", async () => {
    const { store, provider } = await setup();
    fake.tokens = { id_token: "synthetic-id-token", scope: [...V2_BETA_SCOPES, ...TEACHER_CLASSROOM_SCOPES].join(" "), refresh_token: "must-not-store" };
    fake.payload = { sub: "different-google-subject", nonce: state };
    await expect(provider.completeTeacherAuthorization(userId, state, "synthetic-code", verifier, callback)).rejects.toThrow("google_identity_mismatch");
    await expect(store.getGrant(userId)).resolves.toMatchObject({ refreshToken: "existing-refresh", scopes: [...V2_BETA_SCOPES] });
  });

  it("rejects missing teacher scopes and leaves the current grant untouched", async () => {
    const { store, provider } = await setup();
    fake.tokens = { id_token: "synthetic-id-token", scope: [...V2_BETA_SCOPES, TEACHER_CLASSROOM_SCOPES[0]].join(" ") };
    fake.payload = { sub: "google-subject-1", nonce: state };
    await expect(provider.completeTeacherAuthorization(userId, state, "synthetic-code", verifier, callback)).rejects.toThrow("teacher_scope_mismatch");
    await expect(store.getGrant(userId)).resolves.toMatchObject({ refreshToken: "existing-refresh", scopes: [...V2_BETA_SCOPES] });
  });
});
