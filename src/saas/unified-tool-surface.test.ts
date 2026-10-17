import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../server.js";
import { createV2CombinedServer } from "../v2/server.js";

describe("unified authentication tool surface", () => {
  for (const version of ["v1", "v2"] as const) it(`exposes no manual account-linking tool on ${version}`, async () => {
    const server = version === "v1" ? await createServer({} as never, { publicV1: true }) : await createV2CombinedServer({ subject: "synthetic" } as never, { name: "synthetic", version: "1" });
    const client = new Client({ name: "unified-tool-acceptance", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport); await client.connect(clientTransport);
    try {
      const result = await client.listTools();
      expect(result.tools.some(tool => tool.name === "list_courses")).toBe(true);
      expect(result.tools.some(tool => /pair|link_website_account/i.test(tool.name + " " + (tool.description ?? "")))).toBe(false);
    } finally { await client.close(); await server.close(); }
  });
});
