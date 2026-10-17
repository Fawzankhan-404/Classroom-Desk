import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createServer } from "./server.js";
import type { ClassroomClients } from "./classroom.js";

describe("MCP tool contract", () => {
  it("exposes a continuation token for public course pages", async () => {
    const requests: Array<{ pageToken?: string; pageSize?: number }> = [];
    const clients = { classroom: { courses: { list: async (params: { pageToken?: string; pageSize?: number }) => {
      requests.push(params);
      return { data: params.pageToken === "next"
        ? { courses: [{ id: "course-b", name: "Second page" }] }
        : { courses: [{ id: "course-a", name: "First page" }], nextPageToken: "next" } };
    } } } } as unknown as ClassroomClients;
    const server = await createServer(clients, { publicV1: true });
    const client = new Client({ name: "pagination-test", version: "1" });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
      const first = await client.callTool({ name: "list_courses", arguments: {} });
      expect(JSON.parse((first.content as Array<{ text: string }>)[0].text)).toMatchObject({ courses: [{ name: "First page" }], nextPageToken: "next" });
      const second = await client.callTool({ name: "list_courses", arguments: { pageToken: "next" } });
      expect(JSON.parse((second.content as Array<{ text: string }>)[0].text)).toMatchObject({ courses: [{ name: "Second page" }] });
      expect(requests.map((request) => request.pageToken)).toEqual([undefined, "next"]);
    } finally { await client.close(); await server.close(); }
  });
  it("advertises only read-only, nondestructive tools with valid input schemas", async () => {
    const server = await createServer({} as ClassroomClients);
    const client = new Client({ name: "contract-test", version: "1" });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(12);
      for (const tool of tools) {
        expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: true });
        expect(tool.inputSchema.type).toBe("object");
      }
    } finally {
      await client.close();
      await server.close();
    }
  });
});
