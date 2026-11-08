import { createServer as createNetServer } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { createPublicApp } from "../public/http.js";
import { MemoryPublicAuthStore } from "../public/store.js";
import { MCP_OFFLINE_SCOPE, MCP_SCOPE, PublicOAuthProvider } from "../public/oauth.js";
import { PUBLIC_CLASSROOM_SCOPES } from "../config.js";
import { createV2CombinedServer } from "../v2/server.js";
import type { V2Clients } from "../v2/workflow.js";

const subject = "9f0102e3-12a3-4b56-8d90-123456789012";
const fullNames = [
  "check_account_activation", "classroom_desk_help", "classroom_desk_status", "get_assignment_workspace",
  "get_course", "get_coursework", "link_website_account", "list_announcements", "list_course_materials",
  "list_courses", "list_coursework", "list_topics", "my_submissions", "prepare_teacher_attachment",
  "read_teacher_attachment", "recent_activity", "search_classroom", "student_classroom_overview",
  "teacher_classroom_courses", "teacher_course_roster", "teacher_coursework", "teacher_coursework_submissions",
  "upcoming_deadlines", "verify_assignment_submission",
];
const studentNames = fullNames.filter((name) => !name.startsWith("teacher_"));

async function fixture() {
  const probe = createNetServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  const origin = new URL(`http://127.0.0.1:${port}`);
  const legacyResource = new URL("/mcp", origin);
  const studentResource = new URL("/mcp/student", origin);
  const store = new MemoryPublicAuthStore();
  const now = Date.now();
  for (const [token, resource] of [["full-token", legacyResource], ["student-token", studentResource]] as const) {
    await store.putAccess({ token, clientId: "test-client", userId: subject, scopes: [MCP_SCOPE, MCP_OFFLINE_SCOPE], resource, expiresAt: now + 60_000 });
  }
  await store.putGrant({ userId: subject, refreshToken: "synthetic-google-refresh", scopes: [...PUBLIC_CLASSROOM_SCOPES], createdAt: now, updatedAt: now });

  const teacherCalls = vi.fn();
  const classroom = {
    courses: {
      list: vi.fn(async () => ({ data: { courses: [] } })),
      courseWork: {
        list: vi.fn(async () => ({ data: { courseWork: [] } })),
        get: vi.fn(async () => ({ data: {} })),
        create: vi.fn(async () => { teacherCalls("create"); return { data: {} }; }),
        patch: vi.fn(async () => { teacherCalls("patch"); return { data: {} }; }),
        studentSubmissions: { list: vi.fn(async () => ({ data: { studentSubmissions: [] } })) },
      },
      students: { list: vi.fn(async () => ({ data: { students: [] } })) },
      announcements: { list: vi.fn(async () => ({ data: { announcements: [] } })) },
      courseWorkMaterials: { list: vi.fn(async () => ({ data: { courseWorkMaterial: [] } })) },
      topics: { list: vi.fn(async () => ({ data: { topic: [] } })) },
    },
  };
  const clients = { classroom, drive: {}, subject } as unknown as V2Clients;
  const provider = new PublicOAuthProvider(store, {
    origin, mcpResource: legacyResource, studentMcpResource: studentResource,
    googleClientId: "test-client", googleClientSecret: "test-secret", googleCallbackUrl: new URL("/oauth/google/callback", origin).href,
  });
  const { app, closeSessions } = createPublicApp({
    origin, mcpResource: legacyResource, studentMcpResource: studentResource,
    googleClientId: "test-client", googleClientSecret: "test-secret", googleCallbackUrl: new URL("/oauth/google/callback", origin).href,
    production: false, port, storeKind: "memory", operatorName: "Test", supportEmail: "test@example.com",
    saasFlags: { billingUi: false, teacherFeatures: false, teacherDraftWrites: false, referralRewards: false, enforceEntitlements: false },
  }, store, provider, undefined, undefined, {
    entitlementCheck: async () => ({ allowed: true, reason: "synthetic_test" }),
    mcpFactory: async (_auth, userId, catalogMode) => createV2CombinedServer({ ...clients, subject: userId }, {
      catalogMode,
      linkWebsiteAccount: async () => true,
      accountStatus: async () => ({ state: "ACTIVE", message: "Ready", activationUrl: "", billingUrl: "", settingsUrl: "", plan: "student", expiresAt: null }),
      teacherDraftWritesEnabled: catalogMode === "student",
    }),
  });
  const server = app.listen(port, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));

  const send = (path: string, token: string, body: unknown, sessionId?: string) => fetch(new URL(path, origin), {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`, "content-type": "application/json",
      accept: "application/json, text/event-stream", ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
    body: JSON.stringify(body), signal: AbortSignal.timeout(5_000),
  });
  const initialize = async (path: string, token: string) => {
    const response = await send(path, token, {
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "student-route-test", version: "1" } },
    });
    return { response, sessionId: response.headers.get("mcp-session-id") };
  };
  return {
    origin, studentResource, send, initialize, teacherCalls, classroom,
    close: async () => {
      await closeSessions();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

describe("student-only MCP endpoint security", () => {
  it("keeps /mcp's 24 tools and returns only the exact 20-tool student catalog", async () => {
    const ctx = await fixture();
    try {
      const metadata = await fetch(new URL("/.well-known/oauth-protected-resource/mcp/student", ctx.origin));
      expect(metadata.status).toBe(200);
      expect(await metadata.json()).toMatchObject({ resource: ctx.studentResource.href });

      const legacy = await ctx.initialize("/mcp", "full-token");
      expect(legacy.response.status).toBe(200);
      expect(legacy.sessionId).toBeTruthy();
      const legacyList = await ctx.send("/mcp", "full-token", { jsonrpc: "2.0", id: 2, method: "tools/list" }, legacy.sessionId!);
      const legacyBody = await legacyList.json() as { result: { tools: Array<{ name: string }> } };
      expect(legacyBody.result.tools.map((tool) => tool.name).sort()).toEqual([...fullNames].sort());

      const student = await ctx.initialize("/mcp/student", "student-token");
      expect(student.response.status).toBe(200);
      expect(student.sessionId).toBeTruthy();
      const studentList = await ctx.send("/mcp/student", "student-token", { jsonrpc: "2.0", id: 3, method: "tools/list" }, student.sessionId!);
      const studentBody = await studentList.json() as { result: { tools: Array<{ name: string; annotations?: { readOnlyHint?: boolean } }> } };
      const names = studentBody.result.tools.map((tool) => tool.name).sort();
      expect(names).toEqual([...studentNames].sort());
      expect(names).toHaveLength(20);
      expect(names.some((name) => name.startsWith("teacher_") || name.includes("draft"))).toBe(false);
      expect(studentBody.result.tools.find((tool) => tool.name === "link_website_account")?.annotations?.readOnlyHint).toBe(false);
    } finally {
      await ctx.close();
    }
  });

  it("rejects cross-resource tokens and prevents session reuse across endpoint catalogs", async () => {
    const ctx = await fixture();
    try {
      const full = await ctx.initialize("/mcp", "full-token");
      const student = await ctx.initialize("/mcp/student", "student-token");
      expect(full.response.status).toBe(200);
      expect(student.response.status).toBe(200);
      expect((await ctx.send("/mcp", "student-token", { jsonrpc: "2.0", id: 2, method: "tools/list" })).status).toBe(401);
      expect((await ctx.send("/mcp/student", "full-token", { jsonrpc: "2.0", id: 3, method: "tools/list" })).status).toBe(401);
      expect((await ctx.send("/mcp/student", "student-token", { jsonrpc: "2.0", id: 4, method: "tools/list" }, full.sessionId!)).status).toBe(404);
      expect((await ctx.send("/mcp", "full-token", { jsonrpc: "2.0", id: 5, method: "tools/list" }, student.sessionId!)).status).toBe(404);
    } finally { await ctx.close(); }
  });

  it("rejects teacher-only tool names and aliases in a batch without invoking Classroom operations", async () => {
    const ctx = await fixture();
    try {
      const session = await ctx.initialize("/mcp/student", "student-token");
      const names = [
        "teacher_classroom_courses", "teacher_coursework", "teacher_course_roster", "teacher_coursework_submissions",
        "teacher_coursework_drafts", "teacher_create_coursework_draft", "teacher_update_coursework_draft",
        "teacher_course_details", "teacher_list_coursework", "get_teacher_submissions",
      ];
      const body = names.map((name, index) => ({
        jsonrpc: "2.0", id: index + 10, method: "tools/call",
        params: { name, arguments: { courseId: "synthetic-course", courseWorkId: "synthetic-work", confirmation: "CREATE_UNPUBLISHED_DRAFT" } },
      }));
      const response = await ctx.send("/mcp/student", "student-token", body, session.sessionId!);
      expect(response.status).toBe(200);
      const results = await response.json() as Array<{ id: number; error?: unknown; result?: { isError?: boolean } }>;
      expect(results).toHaveLength(names.length);
      expect(results.every((item) => item.error || item.result?.isError)).toBe(true);
      expect(ctx.teacherCalls).not.toHaveBeenCalled();
      expect(ctx.classroom.courses.courseWork.create).not.toHaveBeenCalled();
      expect(ctx.classroom.courses.courseWork.patch).not.toHaveBeenCalled();
    } finally { await ctx.close(); }
  });
});
