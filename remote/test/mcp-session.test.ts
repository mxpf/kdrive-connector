import { createExecutionContext, env, runInDurableObject, evictDurableObject, SELF } from "cloudflare:test";
import { expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { encodeMcpResponse, MAX_MCP_REQUEST_BYTES } from "../src/mcp-rpc";
import { createMcpHandler, issueSession, validSession } from "../src/mcp-session";

const props = { login: env.ALLOWED_GITHUB_LOGIN, name: null, email: null };
const context = () => Object.assign(createExecutionContext(), { props });
const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: {
  protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "synthetic-churn", version: "1" },
} };
const request = (body: unknown, session?: string) => new Request("https://local.test/mcp", {
  method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream",
    ...(session ? { "mcp-session-id": session } : {}) }, body: JSON.stringify(body),
});

it("repeated discovery uses JSON, one initialization each, and no session SQL/KV writes", async () => {
  const handler = createMcpHandler();
  for (let n = 0; n < 12; n++) {
    const client = new Client({ name: "synthetic-discovery", version: "1" });
    let initializations = 0; let id: string | undefined;
    const transport = new StreamableHTTPClientTransport(new URL("https://local.test/mcp"), {
      fetch: async (input, init) => {
        const req = new Request(input, init);
        if (req.method === "POST" && (await req.clone().json() as { method?: string }).method === "initialize") initializations++;
        const response = await handler.fetch(req, env, context());
        if (response.status === 200 && req.method === "POST") expect(response.headers.get("content-type")).toContain("application/json");
        id = response.headers.get("mcp-session-id") ?? id;
        return response;
      },
    });
    await client.connect(transport, { timeout: 3000 });
    for (let i = 0; i < 3; i++) expect((await client.listTools()).tools.length).toBe(18);
    expect(initializations).toBe(1); expect(id).toBeTruthy();
    const stub = env.MCP_OBJECT.getByName(`json:${props.login}:${id}`);
    const storage = await runInDurableObject(stub, async (_instance, state) => ({
      keys: (await state.storage.list()).size,
      tables: state.storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '_cf_%'").toArray(),
      alarm: await state.storage.getAlarm(),
      responseEntries: (_instance as any).transport._streamMapping.size,
      requestEntries: (_instance as any).transport._requestToStreamMapping.size,
    }));
    expect(storage).toEqual({ keys: 0, tables: [], alarm: null, responseEntries: 0, requestEntries: 0 });
    await transport.terminateSession(); await client.close();
  }
}, 30000);

it("signed sessions bind the owner, reject tampering and expire without creating objects", async () => {
  const token = await issueSession(env.KDRIVE_OPERATION_SECRET, props.login);
  expect(await validSession(token, env.KDRIVE_OPERATION_SECRET, props.login)).toBe(true);
  expect(await validSession(token, env.KDRIVE_OPERATION_SECRET, "other-owner")).toBe(false);
  expect(await validSession(token + "0", env.KDRIVE_OPERATION_SECRET, props.login)).toBe(false);
  expect(await validSession(token, env.KDRIVE_OPERATION_SECRET, props.login, Date.now() + 43_200_001)).toBe(false);
  const getByName = vi.fn();
  const response = await createMcpHandler().fetch(request({ jsonrpc: "2.0", id: 2, method: "tools/list" }, "old-agent-session"),
    { ...env, MCP_OBJECT: { getByName } } as unknown as Env, context());
  expect(response.status).toBe(404); expect(getByName).not.toHaveBeenCalled();
});

it("evicted sessions return 404 instead of reconstructing schema or replaying a mutation", async () => {
  const handler = createMcpHandler();
  const response = await handler.fetch(request(initialize), env, context());
  const id = response.headers.get("mcp-session-id")!;
  await response.json();
  await evictDurableObject(env.MCP_OBJECT.getByName(`json:${props.login}:${id}`));
  const lost = await handler.fetch(request({ jsonrpc: "2.0", id: 2, method: "tools/list" }, id), env, context());
  expect(lost.status).toBe(404); expect(await lost.text()).toContain("do not automatically repeat");
});

it("caps rapid initialization without durable counters; never blocks established sessions", async () => {
  const handler = createMcpHandler();
  const invoke = vi.fn(async () => encodeMcpResponse(Response.json({ ok: true })));
  const fakeEnv = { ...env, MCP_OBJECT: { getByName: () => ({ handleMcpRequest: invoke }) } } as unknown as Env;
  for (let i = 0; i < 30; i++) expect((await handler.fetch(request(initialize), fakeEnv, context())).status).toBe(200);
  const limited = await handler.fetch(request(initialize), fakeEnv, context());
  expect(limited.status).toBe(429); expect(limited.headers.get("retry-after")).toBeTruthy();
  expect(await limited.text()).toContain("CONNECTOR_SESSION_RATE_LIMIT"); expect(invoke).toHaveBeenCalledTimes(30);
  const token = await issueSession(env.KDRIVE_OPERATION_SECRET, props.login);
  expect((await handler.fetch(request({ jsonrpc: "2.0", id: 2, method: "tools/list" }, token), fakeEnv, context())).status).toBe(200);
});

it.each(["initialize", "tools/call"])("reports pre-handler quota errors for %s with reset and trace", async method => {
  const invoke = vi.fn(async () => { throw new Error("SQL query failed: Exceeded allowed rows written in Durable Objects free tier."); });
  const fakeEnv = { ...env, MCP_OBJECT: { getByName: () => ({ handleMcpRequest: invoke }) } } as unknown as Env;
  const token = method === "initialize" ? undefined : await issueSession(env.KDRIVE_OPERATION_SECRET, props.login);
  const response = await createMcpHandler().fetch(request(method === "initialize" ? initialize : {
    jsonrpc: "2.0", id: 9, method, params: { name: "kdrive_connection_status", arguments: {} },
  }, token), fakeEnv, context());
  expect(response.status).toBe(method === "initialize" ? 503 : 200);
  expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
  const body = await response.json() as any;
  const detail = body.error?.data ?? body.result.structuredContent;
  expect(detail.error_code).toBe("CLOUDFLARE_QUOTA_EXCEEDED");
  expect(detail.requires_reauthentication).toBe(false); expect(detail.retry_at).toMatch(/T00:00:00.000Z$/);
  expect(detail.trace_id).toBeTruthy(); if (method === "tools/call") expect(body.result.isError).toBe(true);
});

it("preserves OAuth challenges and declines all GET streams without allocating sessions", async () => {
  const unauth = await SELF.fetch("https://local.test/mcp");
  expect(unauth.status).toBe(401); expect(unauth.headers.get("www-authenticate")).toContain("Bearer");
  const getByName = vi.fn(); const fakeEnv = { ...env, MCP_OBJECT: { getByName } } as unknown as Env;
  for (const headers of [new Headers(), new Headers({ "last-event-id": "old-replay-event" })]) {
    const response = await createMcpHandler().fetch(new Request("https://local.test/mcp", { headers }), fakeEnv, context());
    expect(response.status).toBe(405);
  }
  expect(getByName).not.toHaveBeenCalled();
});

it("rejects malformed and oversized requests before session allocation and redacts unexpected errors", async () => {
  const getByName = vi.fn();
  const fakeEnv = { ...env, MCP_OBJECT: { getByName } } as unknown as Env;
  const handler = createMcpHandler();
  for (const body of [[initialize], { ...initialize, params: {} }, { method: "tools/list" }]) {
    expect((await handler.fetch(request(body), fakeEnv, context())).status).toBe(400);
  }
  const oversized = request(initialize);
  oversized.headers.set("content-length", String(MAX_MCP_REQUEST_BYTES + 1));
  expect((await handler.fetch(oversized, fakeEnv, context())).status).toBe(413);
  expect(getByName).not.toHaveBeenCalled();
  getByName.mockReturnValue({ handleMcpRequest: async () => { throw new Error("private-path and secret-token"); } });
  const response = await handler.fetch(request(initialize), fakeEnv, context());
  expect(response.status).toBe(500);
  const text = await response.text();
  expect(text).toContain("CONNECTOR_TRANSPORT_ERROR");
  expect(text).not.toMatch(/private-path|secret-token/);
});

it("passes byte values and protocol headers only, including a supported 10 MiB inline upload", async () => {
  const input = { jsonrpc: "2.0", id: 3, method: "tools/call", params: {
    name: "kdrive_upload_file", arguments: { path: "/synthetic.bin", encoding: "base64", content: "A".repeat(Math.ceil(10 * 1024 * 1024 / 3) * 4 - 2) + "==" },
  } };
  const token = await issueSession(env.KDRIVE_OPERATION_SECRET, props.login);
  const req = request(input, token);
  req.headers.set("authorization", "Bearer synthetic-secret");
  req.headers.set("cookie", "synthetic-cookie");
  req.headers.set("mcp-protocol-version", "2025-11-25");
  const invoke = vi.fn(async (message: any) => {
    expect(message).not.toBeInstanceOf(Request);
    expect(message.body).toBeInstanceOf(Uint8Array);
    expect(Object.keys(message).sort()).toEqual(["body", "headers", "method"]);
    const headers = new Headers(message.headers);
    expect(headers.has("authorization")).toBe(false); expect(headers.has("cookie")).toBe(false);
    expect(headers.get("mcp-protocol-version")).toBe("2025-11-25");
    const decoded = JSON.parse(new TextDecoder().decode(message.body));
    expect(decoded.params.arguments.content.length).toBe(input.params.arguments.content.length);
    return encodeMcpResponse(Response.json({ ok: true }));
  });
  const fakeEnv = { ...env, MCP_OBJECT: { getByName: () => ({ handleMcpRequest: invoke }) } } as unknown as Env;
  expect((await createMcpHandler().fetch(req, fakeEnv, context())).status).toBe(200);
  expect(invoke).toHaveBeenCalledTimes(1);
});
