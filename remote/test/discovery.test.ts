import { createExecutionContext, env, SELF } from "cloudflare:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { expect, it, vi } from "vitest";
import { KDriveMCP } from "../src/index";
import { withoutStandaloneNotifications } from "../src/mcp-transport";

it.each([false, true])("discovers all tools and resources with notification mitigation=%s", async (mitigated) => {
  const original = KDriveMCP.serve("/mcp");
  const handler = mitigated ? withoutStandaloneNotifications(original) : original;
  const client = new Client({ name: "local-discovery-regression", version: "1.0.0" });
  let getRequests = 0;
  const transport = new StreamableHTTPClientTransport(new URL("https://local.test/mcp"), {
    fetch: async (input, init) => {
      const request = new Request(input, init);
      if (request.method === "GET") getRequests++;
      // This test enters after OAuth, with a synthetic owner. No real tokens or
      // external API calls are needed to enumerate the catalog.
      const ctx = Object.assign(createExecutionContext(), { props: { login: env.ALLOWED_GITHUB_LOGIN } });
      return handler.fetch(request, env, ctx);
    },
  });
  try {
    await client.connect(transport, { timeout: 3000 });
    const [tools, resources, templates] = await Promise.all([
      client.listTools(undefined, { timeout: 3000 }),
      client.listResources(undefined, { timeout: 3000 }),
      client.listResourceTemplates(undefined, { timeout: 3000 }),
    ]);
    expect(getRequests).toBeGreaterThan(0);
    expect(tools.tools).toHaveLength(17);
    expect(tools.tools.map(tool => tool.name)).toEqual(expect.arrayContaining([
      "kdrive_export_file", "kdrive_upload_file_ref", "kdrive_upload_from_url",
    ]));
    expect(resources.resources).toHaveLength(2);
    expect(templates.resourceTemplates).toHaveLength(0);
  } finally {
    await client.close();
  }
}, 15000);

it("declines only standalone GET and preserves POST, DELETE and resume requests", async () => {
  const fetch = vi.fn(async () => new Response("delegated"));
  const handler = withoutStandaloneNotifications({ fetch });
  const ctx = createExecutionContext();
  const idle = await handler.fetch(new Request("https://local.test/mcp"), env, ctx);
  expect(idle.status).toBe(405);
  expect(idle.headers.get("allow")).toBe("POST, DELETE");
  expect(fetch).not.toHaveBeenCalled();
  for (const init of [{ method: "POST" }, { method: "DELETE" }, { headers: { "last-event-id": "resume-event" } }]) {
    const response = await handler.fetch(new Request("https://local.test/mcp", init), env, ctx);
    expect(await response.text()).toBe("delegated");
  }
  expect(fetch).toHaveBeenCalledTimes(3);
});

it("keeps OAuth in front of the standalone GET mitigation", async () => {
  const response = await SELF.fetch("https://local.test/mcp", {
    headers: { accept: "text/event-stream" },
  });
  expect(response.status).toBe(401);
  expect(response.headers.get("www-authenticate")).toContain("Bearer");
});
