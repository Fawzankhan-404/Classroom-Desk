import type { OAuth2Client } from "googleapis-common";
import { createClients } from "./classroom.js";
import { createServer } from "./server.js";

type VerifiedIdentity = { userId: string };
type BearerVerifier = { verifyBearer(token: string): Promise<VerifiedIdentity> };
type GrantResolver = { googleAuthForUser(userId: string): Promise<OAuth2Client> };

/** Shared fail-closed factory retained for callers outside the HTTP transport. */
export async function createAuthenticatedServer(authorization: string | undefined, verifier: BearerVerifier, grants: GrantResolver) {
  const match = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/.exec(authorization ?? "");
  if (!match?.[1]) throw new Error("Unauthorized");
  let identity: VerifiedIdentity;
  try { identity = await verifier.verifyBearer(match[1]); }
  catch { throw new Error("Unauthorized"); }
  if (!identity || typeof identity.userId !== "string" || !identity.userId) throw new Error("Unauthorized");
  const auth = await grants.googleAuthForUser(identity.userId);
  return createServer(createClients(auth), { publicV1: true });
}
