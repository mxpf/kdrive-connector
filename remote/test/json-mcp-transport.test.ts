import { expect, it } from "vitest";
import { JsonMcpTransport } from "../src/json-mcp-transport";
import { MAX_MCP_RESPONSE_BYTES, readBoundedBody, encodeMcpResponse } from "../src/mcp-rpc";

const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-session-id": "synthetic" };
const request = (id: number, method = "tools/list") => new Request("https://synthetic.test/mcp", {
  method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id, method, ...(method === "initialize" ? { params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "synthetic", version: "1" } } } : {}) }),
});
async function initialized() {
  const transport = new JsonMcpTransport({ sessionIdGenerator: () => "synthetic", onsessionclosed: () => {} });
  transport.onmessage = message => { if ("id" in message && message.id !== undefined) void transport.send({ jsonrpc: "2.0", id: message.id, result: {} }); };
  const init = request(0, "initialize"); init.headers.delete("mcp-session-id");
  // The HTTP transport validates JSON-RPC; protocol negotiation is covered by SDK client tests.
  expect((await transport.handleRequest(init)).status).toBe(200);
  return transport;
}

it("releases completed JSON responses without disturbing concurrent requests", async () => {
  const transport = await initialized();
  const state = transport as any;
  for (let i = 1; i <= 100; i++) {
    expect((await transport.handleRequest(request(i))).status).toBe(200);
    expect(state._streamMapping.size).toBe(0);
    expect(state._requestToStreamMapping.size).toBe(0);
    expect(state._requestResponseMap.size).toBe(0);
  }
  let started!: () => void;
  const pendingStarted = new Promise<void>(r => { started = r; });
  transport.onmessage = message => {
    if ("id" in message && message.id === 101) started();
    else if ("id" in message && message.id !== undefined) void transport.send({ jsonrpc: "2.0", id: message.id, result: {} });
  };
  const pending = transport.handleRequest(request(101)); await pendingStarted;
  expect((await transport.handleRequest(request(102))).status).toBe(200);
  expect(state._streamMapping.size).toBe(1);
  await transport.send({ jsonrpc: "2.0", id: 101, result: { complete: true } });
  expect((await pending).status).toBe(200);
  expect(state._streamMapping.size).toBe(0);
  await transport.close();
});

it("DELETE settles pending requests once, never replays mutations and ignores late completions", async () => {
  const transport = await initialized();
  let calls = 0; let started!: () => void;
  const pendingStarted = new Promise<void>(r => { started = r; });
  transport.onmessage = () => { calls++; started(); };
  const pending = transport.handleRequest(request(1, "tools/call")); await pendingStarted;
  const deleted = await transport.handleRequest(new Request("https://synthetic.test/mcp", { method: "DELETE", headers }));
  expect(deleted.status).toBe(200);
  const interrupted = await pending;
  expect(interrupted.status).toBe(409);
  expect(await interrupted.text()).toContain("CONNECTOR_SESSION_CLOSED");
  await transport.send({ jsonrpc: "2.0", id: 1, result: { mutationCompleted: true } });
  expect(calls).toBe(1);
  for (const key of ["_streamMapping", "_requestToStreamMapping", "_requestResponseMap"]) expect((transport as any)[key].size).toBe(0);
  expect((await transport.handleRequest(request(2))).status).toBe(404);
  expect(calls).toBe(1);
});

it("bounded RPC bodies cancel overflow and preserve empty responses and exact bytes", async () => {
  let canceled = false;
  const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(5)); }, cancel() { canceled = true; } });
  await expect(readBoundedBody(body, 4)).rejects.toThrow("MCP body limit");
  expect(canceled).toBe(true);
  expect(await encodeMcpResponse(new Response(null, { status: 202 }))).toEqual({ status: 202, headers: [], body: null });
  const bytes = new TextEncoder().encode('synthetic 🌱');
  const encoded = await encodeMcpResponse(new Response(bytes, { status: 200, headers: { "mcp-session-id": "synthetic" } }));
  expect(encoded.body).toEqual(bytes);
  expect(encoded.headers).toContainEqual(["mcp-session-id", "synthetic"]);
  const oversizedResponse = new Response(new ReadableStream({start(c) { c.enqueue(new Uint8Array(MAX_MCP_RESPONSE_BYTES + 1)); c.close(); }}));
  await expect(encodeMcpResponse(oversizedResponse)).rejects.toThrow("MCP body limit");
});
