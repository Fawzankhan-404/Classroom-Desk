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
  it("serves exactly 20 student tools and excludes teacher tools even when teacher writes are enabled", async () => {
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
        announcements: { list: vi.fn(async () => ({ data: { announcements: [] } })) },
        courseWorkMaterials: { list: vi.fn(async () => ({ data: { courseWorkMaterial: [] } })) },
        topics: { list: vi.fn(async () => ({ data: { topic: [] } })) },
      },
    };
    const clients = { classroom, drive: {}, subject: "synthetic-subject" } as unknown as V2Clients;
    const server = await createV2CombinedServer(clients, {
      catalogMode: "student",
      linkWebsiteAccount: vi.fn(async () => true),
      accountStatus: vi.fn(async () => ({ state: "ACTIVE", message: "Ready", activationUrl: "", billingUrl: "", settingsUrl: "", plan: null, expiresAt: null })),
      teacherAuthorizationUrl: "https://example.test/teacher",
      teacherWriteAuthorizationUrl: "https://example.test/teacher-write",
      teacherDraftWritesEnabled: true,
    });
    registerMcpOnboarding(server, async () => ({ allowed: true, reason: "active" }), "https://classroom.jarvis404.com");
    const client = new Client({ name: "student-catalog-test", version: "1" });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
      const { tools } = await client.listTools();
      const names = tools.map((tool) => tool.name).sort();
      expect(names).toEqual([
        "check_account_activation", "classroom_desk_help", "classroom_desk_status", "get_assignment_workspace",
        "get_course", "get_coursework", "link_website_account", "list_announcements", "list_course_materials",
        "list_courses", "list_coursework", "list_topics", "my_submissions", "prepare_teacher_attachment",
        "read_teacher_attachment", "recent_activity", "search_classroom", "student_classroom_overview",
        "upcoming_deadlines", "verify_assignment_submission",
      ]);
      expect(new Set(names).size).toBe(20);
      expect(names.some((name) => name.startsWith("teacher_") || name.includes("draft"))).toBe(false);
      expect(tools.find((tool) => tool.name === "link_website_account")?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
      for (const tool of tools.filter((item) => item.name !== "link_website_account")) {
        expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
      }

      const teacherToolNames = [
        "teacher_classroom_courses", "teacher_coursework", "teacher_course_roster", "teacher_coursework_submissions",
        "teacher_coursework_drafts", "teacher_create_coursework_draft", "teacher_update_coursework_draft",
        "teacher_course_details", "teacher_list_coursework",
      ];
      for (const name of teacherToolNames) {
        const denied = await client.callTool({ name, arguments: { courseId: "synthetic-course", courseWorkId: "synthetic-work", confirmation: "CREATE_UNPUBLISHED_DRAFT" } });
        expect(denied.isError, name).toBe(true);
      }
      expect(teacherCalls).not.toHaveBeenCalled();
      expect(classroom.courses.courseWork.create).not.toHaveBeenCalled();
      expect(classroom.courses.courseWork.patch).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await server.close();
    }
  });

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

  it("omits unrelated Classroom categories from assignment-focused views", async () => {
    const classroom = {
      courses: {
        list: vi.fn(async () => ({ data: { courses: [{ id: "synthetic-course", name: "Synthetic course", courseState: "ACTIVE" }] } })),
        courseWork: {
          list: vi.fn(async () => ({ data: { courseWork: [{ id: "synthetic-work", title: "Past assignment", dueDate: { year: 2020, month: 1, day: 1 }, dueTime: { hours: 0, minutes: 0 } }] } })),
          studentSubmissions: { list: vi.fn(async () => ({ data: { studentSubmissions: [] } })) },
        },
        announcements: { list: vi.fn(async () => ({ data: { announcements: [{ id: "synthetic-announcement", text: "Unrelated announcement" }] } })) },
        courseWorkMaterials: { list: vi.fn(async () => ({ data: { courseWorkMaterial: [{ id: "synthetic-material", title: "Unrelated material", materials: [{ driveFile: { driveFile: { id: "synthetic-file", title: "Attachment metadata" } } }] }] } })) },
        topics: { list: vi.fn(async () => ({ data: { topic: [{ topicId: "synthetic-topic", name: "Unrelated topic" }] } })) },
      },
    };
    const clients = { classroom, drive: {}, subject: "synthetic-subject" } as unknown as V2Clients;
    const server = await createV2CombinedServer(clients);
    const client = new Client({ name: "assignment-focused-view-test", version: "1" });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
      const result = await client.callTool({ name: "student_classroom_overview", arguments: { view: "missing", limit: 1 } });
      const overview = JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
      expect(overview.assignments).toHaveLength(1);
      expect(overview.announcements).toEqual([]);
      expect(overview.courseMaterials).toEqual([]);
      expect(overview.topics).toEqual([]);
      expect(overview.recentActivity).toEqual([]);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
