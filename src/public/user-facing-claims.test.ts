import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { createPublicApp } from "./http.js";
import { PublicOAuthProvider } from "./oauth.js";
import { MemoryPublicAuthStore } from "./store.js";
import { V2_TEACHER_SCOPES, V2_TEACHER_WRITE_SCOPES, V2_UNIFIED_SCOPES } from "../v2/scopes.js";

async function withPublicApp(run: (baseUrl: string) => Promise<void>, withFlow = false): Promise<void> {
  const origin = new URL("http://127.0.0.1");
  const store = new MemoryPublicAuthStore();
  if (withFlow) {
    await store.putFlow({
      id: "synthetic-oauth-flow",
      client: { client_id: "synthetic-mcp-client", client_name: "Synthetic MCP client", redirect_uris: ["http://127.0.0.1/callback"] } as never,
      params: { state: "synthetic-client-state", scopes: ["mcp:tools"], codeChallenge: "synthetic-challenge", redirectUri: "http://127.0.0.1/callback" },
      userId: "synthetic-user",
      googleState: "synthetic-google-state",
      googleVerifier: "synthetic-google-verifier",
      googleNonce: "synthetic-google-nonce",
      expiresAt: Date.now() + 60_000,
      started: false,
    });
  }
  const config = {
    origin,
    mcpResource: new URL("/mcp", origin),
    googleCallbackUrl: new URL("/oauth/google/callback", origin).href,
    googleClientId: "synthetic-client-id",
    googleClientSecret: "synthetic-client-secret",
    port: 0,
    production: false,
  };
  const provider = new PublicOAuthProvider(store, {
    ...config,
    googleScopes: V2_UNIFIED_SCOPES,
    teacherScopes: V2_TEACHER_SCOPES,
    teacherWriteScopes: V2_TEACHER_WRITE_SCOPES,
  });
  const { app } = createPublicApp(config, store, provider);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await run(baseUrl);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

describe("public authorization and privacy disclosures", () => {
  it("serves the single canonical landing page instead of a duplicate legacy route", async () => {
    await withPublicApp(async baseUrl => {
      const response = await fetch(`${baseUrl}/`);
      const html = await response.text();
      expect(response.status).toBe(200);
      expect(html).toContain("data-home-stage");
      expect(html).toContain("Illustrative only");
      expect(html).not.toContain('class="hero"');
    });
  });

  it("serves the current connection guide from the single /connect route", async () => {
    await withPublicApp(async baseUrl => {
      const response = await fetch(`${baseUrl}/connect`);
      const html = await response.text();
      expect(response.status).toBe(200);
      expect(html).toContain("Connection guide");
      expect(html).toContain("https://classroom.jarvis404.com/mcp");
      expect(html).toContain("verified Google identity binding");
      expect(html).not.toContain("account-pairing guide");
      expect(html).not.toContain("MCP installation wizard");
    });
  });

  it("describes Classroom reads, file-scoped Drive, and separately consented teacher actions", async () => {
    await withPublicApp(async baseUrl => {
      const response = await fetch(`${baseUrl}/connect/google?flow=synthetic-oauth-flow`);
      const html = await response.text();
      expect(response.status).toBe(200);
      expect(html).toContain("file-scoped drive.file permission");
      expect(html).toContain("see, create, edit, and delete specific Drive files");
      expect(html).toContain("Teacher roster and submission reads need separate consent");
      expect(html).toContain("server verification of teacher membership");
      expect(html).toContain("classroom.coursework.students permission");
      expect(html).toContain("management of coursework and grades in classes you teach");
      expect(html).toContain("create an unpublished draft or update an existing unpublished draft");
      expect(html).toContain("does not change published coursework, submit student work, publish drafts, or write grades");
      expect(html).toContain("No gradebook writes");
      expect(html).not.toContain("No write access");
    }, true);
  });

  it("keeps privacy and terms aligned with encrypted storage and explicit write boundaries", async () => {
    await withPublicApp(async baseUrl => {
      const privacy = await (await fetch(`${baseUrl}/privacy`)).text();
      const terms = await (await fetch(`${baseUrl}/terms`)).text();
      const home = await (await fetch(`${baseUrl}/`)).text();
      expect(privacy).toContain("Google token material is encrypted before persistent storage");
      expect(privacy).toContain("file-scoped <code>drive.file</code> permission");
      expect(privacy).toContain("see, create, edit, and delete specific Google Drive files");
      expect(privacy).toContain("classroom.coursework.students");
      expect(privacy).toContain("create an unpublished draft or update an existing unpublished draft");
      expect(privacy).toContain("Generated-PDF transfer to Drive is currently unavailable");
      expect(privacy).not.toContain("it uploads only that confirmed file");
      expect(privacy).not.toContain("PostgreSQL-backed production storage");
      expect(terms).toContain("create an unpublished assignment draft");
      expect(terms).toContain("explicitly confirm");
      expect(terms).toContain("does not change published coursework, publish drafts, submit student work, or write grades");
      expect(terms).toContain("Generated-PDF transfer to Drive is currently unavailable");
      expect(terms).not.toContain("Drive saves also require explicit confirmation");
      expect(home).toContain("Download a generated PDF and attach it yourself");
      expect(home).not.toContain("Confirm the Drive save");
      expect(home).not.toContain("Confirmed PDF saves to your Drive");
    });
  });
});
