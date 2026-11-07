import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { createV2CombinedServer } from "./server.js";
import type { V2Clients } from "./workflow.js";
import { registerMcpOnboarding } from "../saas/mcp-access.js";

async function productionCatalog() {
  const classroom = {
    courses: {
      list: vi.fn(async () => ({ data: { courses: [] } })),
      courseWork: {
        list: vi.fn(async () => ({ data: { courseWork: [] } })),
        studentSubmissions: { list: vi.fn(async () => ({ data: { studentSubmissions: [] } })) },
      },
      announcements: { list: vi.fn(async () => ({ data: { announcements: [] } })) },
      courseWorkMaterials: { list: vi.fn(async () => ({ data: { courseWorkMaterial: [] } })) },
      topics: { list: vi.fn(async () => ({ data: { topic: [] } })) },
    },
  };
  const clients = { classroom, drive: {}, subject: "synthetic-subject" } as unknown as V2Clients;
  const server = await createV2CombinedServer(clients, {
    linkWebsiteAccount: vi.fn(async () => true),
    accountStatus: vi.fn(async () => ({ state: "ACTIVE", message: "Ready", activationUrl: "", billingUrl: "", settingsUrl: "", plan: null, expiresAt: null })),
    teacherAuthorizationUrl: "https://example.test/teacher",
    teacherWriteAuthorizationUrl: "https://example.test/teacher-write",
    teacherDraftWritesEnabled: false,
  });
  registerMcpOnboarding(server, async () => ({ allowed: true, reason: "active" }), "https://classroom.jarvis404.com");
  const client = new Client({ name: "combined-catalog-test", version: "1" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  const { tools } = await client.listTools();
  return { tools, close: async () => { await client.close(); await server.close(); } };
}

describe("combined V1/V2 server pagination isolation", () => {
  it("exposes exactly the 24 intended production tools", async () => {
    const catalog = await productionCatalog();
    try {
      expect(catalog.tools.map((tool) => tool.name).sort()).toEqual([
        "check_account_activation", "classroom_desk_help", "classroom_desk_status", "get_assignment_workspace",
        "get_course", "get_coursework", "link_website_account", "list_announcements", "list_course_materials",
        "list_courses", "list_coursework", "list_topics", "my_submissions", "prepare_teacher_attachment",
        "read_teacher_attachment", "recent_activity", "search_classroom", "student_classroom_overview",
        "teacher_classroom_courses", "teacher_course_roster", "teacher_coursework", "teacher_coursework_submissions",
        "upcoming_deadlines", "verify_assignment_submission",
      ]);
    } finally { await catalog.close(); }
  });

  it("contains no duplicate names or obsolete tools", async () => {
    const catalog = await productionCatalog();
    try {
      const names = catalog.tools.map((tool) => tool.name);
      expect(new Set(names).size).toBe(names.length);
      expect(names).not.toContain("get_activation_guidance");
      expect(names).not.toContain("save_assignment_pdf");
      expect(names).not.toContain("teacher_coursework_drafts");
      expect(names).not.toContain("teacher_create_coursework_draft");
      expect(names).not.toContain("teacher_update_coursework_draft");
    } finally { await catalog.close(); }
  });

  it("marks website account pairing as a user-visible action", async () => {
    const catalog = await productionCatalog();
    try {
      expect(catalog.tools.find((tool) => tool.name === "link_website_account")?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: false,
      });
    } finally { await catalog.close(); }
  });

  it("keeps every other production tool read-only and non-destructive", async () => {
    const catalog = await productionCatalog();
    try {
      for (const tool of catalog.tools.filter((item) => item.name !== "link_website_account")) {
        expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
      }
    } finally { await catalog.close(); }
  });

  it("publishes schemas, descriptions, and OAuth security for every tool", async () => {
    const catalog = await productionCatalog();
    const oauth = [{ type: "oauth2", scopes: ["mcp:tools"] }];
    try {
      for (const tool of catalog.tools) {
        expect(tool.description?.trim().length).toBeGreaterThan(0);
        expect(tool.inputSchema).toBeDefined();
        expect(tool._meta?.securitySchemes).toEqual(oauth);
      }
    } finally { await catalog.close(); }
  });

  it("preserves full course pagination for the V2 student overview", async () => {
    const courseRequests: Array<string | undefined> = [];
    const classroom = {
      courses: {
        list: vi.fn(async (params: { pageToken?: string }) => {
          courseRequests.push(params.pageToken);
          return { data: params.pageToken === "page-2"
            ? { courses: [{ id: "course-2", name: "Second page course", courseState: "ACTIVE" }] }
            : { courses: [{ id: "course-1", name: "First page course", courseState: "ACTIVE" }], nextPageToken: "page-2" } };
        }),
        courseWork: {
          list: vi.fn(async () => ({ data: { courseWork: [] } })),
          studentSubmissions: { list: vi.fn(async () => ({ data: { studentSubmissions: [] } })) },
        },
        announcements: { list: vi.fn(async () => ({ data: { announcements: [] } })) },
        courseWorkMaterials: { list: vi.fn(async () => ({ data: { courseWorkMaterial: [] } })) },
        topics: { list: vi.fn(async () => ({ data: { topic: [] } })) },
      },
    };
    const clients = { classroom, drive: {}, subject: "synthetic-subject" } as unknown as V2Clients;
    const server = await createV2CombinedServer(clients);
    const client = new Client({ name: "combined-pagination-test", version: "1" });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
      const result = await client.callTool({ name: "student_classroom_overview", arguments: { courseQuery: "Second page course" } });
      const overview = JSON.parse((result.content as Array<{ text: string }>)[0]!.text) as { courses: Array<{ id: string }> };

      expect(overview.courses).toMatchObject([{ id: "course-2", name: "Second page course", state: "ACTIVE" }]);
      expect(courseRequests).toEqual([undefined, "page-2"]);
      expect((clients as V2Clients & { publicPageLimit?: number }).publicPageLimit).toBeUndefined();
    } finally {
      await client.close();
      await server.close();
    }
  });
});
