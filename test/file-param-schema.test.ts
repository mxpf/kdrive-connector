import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerBinaryTools } from "../src/binary-tools.js";
import { KDriveClient } from "../src/kdrive-client.js";
import { loadConfig } from "../src/config.js";

test("serialized MCP fileParam is an object; unresolved strings fail before provider access", async () => {
  let calls = 0;
  const provider = new KDriveClient(loadConfig({ INFOMANIAK_DRIVE_ID: "42" }),
    { getAccessToken: async () => "test-token" }, async () => { calls++; throw new Error("unexpected provider request"); });
  const server = new McpServer({ name: "file-schema-test", version: "1" });
  registerBinaryTools(server, provider, { driveId: 42, buildOpenUrl: () => "https://example.com/open" });
  const client = new Client({ name: "schema-test", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(st);
    await client.connect(ct);
    const tool = (await client.listTools()).tools.find(t => t.name === "kdrive_upload_file_ref")!;
    assert.deepEqual(tool._meta?.["openai/fileParams"], ["file_ref"]);
    const schema = tool.inputSchema.properties!.file_ref as { type: string; properties: Record<string, {type: string}>; required: string[] };
    assert.equal(schema.type, "object");
    assert.deepEqual(schema.required.sort(), ["download_url", "file_id"]);
    assert.deepEqual(Object.keys(schema.properties).sort(), ["download_url", "file_id", "file_name", "mime_type"]);
    for (const p of Object.values(schema.properties)) assert.equal(p.type, "string");
    for (const file_ref of ["/mnt/data/fixture.png", "sandbox:/mnt/data/fixture.png", "file_123"]) {
      const result = await client.callTool({ name: tool.name, arguments: { path: "/Private/fixture.png", file_ref } });
      assert.equal(result.isError, true);
    }
    assert.equal(calls, 0);
  } finally { await client.close(); await server.close(); }
});
