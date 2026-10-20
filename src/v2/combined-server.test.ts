import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { createV2CombinedServer } from "./server.js";
import type { V2Clients } from "./workflow.js";

describe("combined V1/V2 server pagination isolation", () => {
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
