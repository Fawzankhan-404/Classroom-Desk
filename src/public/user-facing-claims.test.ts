import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { createPublicApp } from "./http.js";
import { PublicOAuthProvider } from "./oauth.js";
import { MemoryPublicAuthStore } from "./store.js";
import { V2_TEACHER_SCOPES, V2_TEACHER_WRITE_SCOPES, V2_UNIFIED_SCOPES } from "../v2/scopes.js";
import type { SaaSFeatureFlags } from "../saas/flags.js";

const closedFlags: SaaSFeatureFlags = { billingUi: false, teacherFeatures: false, teacherDraftWrites: false, referralRewards: false, enforceEntitlements: true };

async function withPublicApp(run: (baseUrl: string) => Promise<void>, withFlow = false, saasFlags = closedFlags): Promise<void> {
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
    saasFlags,
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
      expect(html).toContain("choose the Google account you use for Classroom");
      expect(html).not.toContain("verified Google identity binding");
      expect(html).not.toContain("account-pairing guide");
      expect(html).not.toContain("MCP installation wizard");
    });
  });

  it("keeps public route descriptions and canonical URLs aligned with each page", async () => {
    const routes = [
      ["/", "Ask ChatGPT about your authorized Google Classroom courses, assignments, announcements, and deadlines."],
      ["/pricing", "Review Classroom Desk plan details, current availability, and Google authorization requirements."],
      ["/support", "Get help connecting Classroom Desk, managing your account, or with a payment question."],
      ["/connect", "Set up Classroom Desk in ChatGPT, choose the Google account you use for Classroom, and review permissions."],
      ["/privacy", "Learn what Classroom information Classroom Desk accesses, stores, and shares with your connected app."],
      ["/terms", "Read the Classroom Desk service terms, authorized-use requirements, and source-code license."],
      ["/refunds", "Information about existing Classroom Desk payments, subscriptions, cancellations, and refund requests."],
    ] as const;
    await withPublicApp(async baseUrl => {
      for (const [path, description] of routes) {
        const response = await fetch(`${baseUrl}${path}`);
        const html = await response.text();
        const canonicalPath = path === "/" ? "/" : path;
        expect(response.status, path).toBe(200);
        expect(html, path).toContain(`<meta name="description" content="${description}">`);
        expect(html, path).toContain(`<link rel="canonical" href="http://127.0.0.1${canonicalPath}">`);
        expect(html, path).not.toMatch(/Lorem ipsum|\bTODO\b|replace this text/i);
      }
    });
  });

  it("describes requested Google access in plain language and preserves the teacher write boundary", async () => {
    await withPublicApp(async baseUrl => {
      const response = await fetch(`${baseUrl}/connect/google?flow=synthetic-oauth-flow`);
      const html = await response.text();
      expect(response.status).toBe(200);
      expect(html).toContain("see, create, edit, and delete specific files you create with it or choose in Google Picker");
      expect(html).toContain("Viewing course rosters and student submissions requires separate consent");
      expect(html).toContain("Google checks that you are a teacher in each course");
      expect(html).toContain("Google’s permission also covers grade management");
      expect(html).toContain("Teacher draft tools need an additional Google permission and your confirmation for each action");
      expect(html).toContain("does not write grades, publish drafts, or submit student work");
      expect(html).toContain("No gradebook writes");
      expect(html).not.toContain("No write access");
    }, true);
  });

  it("keeps privacy and terms aligned with encrypted storage and explicit write boundaries", async () => {
    await withPublicApp(async baseUrl => {
      const privacy = await (await fetch(`${baseUrl}/privacy`)).text();
      const terms = await (await fetch(`${baseUrl}/terms`)).text();
      const home = await (await fetch(`${baseUrl}/`)).text();
      expect(privacy).toContain("Google authorization tokens are encrypted before they are saved");
      expect(privacy).toContain("limited Google Drive access");
      expect(privacy).toContain("files you create with Classroom Desk or select in Google Picker");
      expect(privacy).toContain("Teacher course lists and student submissions require separate consent");
      expect(privacy).toContain("required to create or update an unpublished assignment draft");
      expect(privacy).toContain("Generated-PDF transfer to Drive is currently unavailable");
      expect(privacy).not.toContain("it uploads only that confirmed file");
      expect(privacy).not.toContain("PostgreSQL-backed production storage");
      expect(terms).toContain("creates or updates an unpublished assignment draft");
      expect(terms).toContain("confirm each action");
      expect(terms).toContain("does not change published coursework, publish drafts, submit student work, or write grades");
      expect(terms).toContain("does not transfer generated PDFs to Drive");
      expect(terms).not.toContain("Drive saves also require explicit confirmation");
      expect(home).toContain("If ChatGPT creates a file, download it and attach it in Classroom yourself");
      expect(home).not.toContain("Confirm the Drive save");
      expect(home).not.toContain("Confirmed PDF saves to your Drive");
    });
  });

  it("shows checkout and trial availability from the configured flags and campaign date", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-21T00:00:00Z"));
    try {
      await withPublicApp(async baseUrl => {
        const pricing = await (await fetch(`${baseUrl}/pricing`)).text();
        const home = await (await fetch(`${baseUrl}/`)).text();
        expect(pricing).toContain("Checkout is unavailable right now");
        expect(pricing).toContain("Teacher plan checkout is not available yet");
        expect(pricing).not.toContain('href="/app/billing"');
        expect(home).toContain("Checkout unavailable");
        expect(pricing).toContain('<meta name="description" content="Review Classroom Desk plan details, current availability, and Google authorization requirements.">');
      });
      const enabledFlags: SaaSFeatureFlags = { ...closedFlags, billingUi: true };
      await withPublicApp(async baseUrl => {
        const pricing = await (await fetch(`${baseUrl}/pricing`)).text();
        const home = await (await fetch(`${baseUrl}/`)).text();
        expect(pricing).toContain("Teacher plan checkout is not available yet");
        expect(pricing).toContain("The introductory offer has ended");
        expect(home).toContain("Offer ended");
        expect(pricing).toContain("₹99");
        const teacherCard = pricing.match(/<article class="plan-card"><p class="eyebrow">For teachers([\s\S]*?)<\/article>/)?.[1] ?? "";
        expect(teacherCard).toContain("Teacher plan checkout is not available yet");
        expect(teacherCard).not.toContain("href=");
      }, false, enabledFlags);
    } finally {
      vi.useRealTimers();
    }
  });
});
