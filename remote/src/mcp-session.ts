import { isInitializeRequest, InitializeRequestSchema, JSONRPCMessageSchema } from "@modelcontextprotocol/sdk/types.js";
import { quotaErrorDetails } from "../../src/quota-errors.js";
import type { Props } from "./utils";
import { MAX_MCP_REQUEST_BYTES, readBoundedBody, type McpRpcRequest } from "./mcp-rpc";

const SESSION_MS = 12 * 60 * 60 * 1000;
const encoder = new TextEncoder();
const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, "0")).join("");
async function sessionKey(secret: string) {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
export async function issueSession(secret: string, owner: string, now = Date.now()) {
  const payload = `${crypto.randomUUID()}.${now + SESSION_MS}`;
  const signature = await crypto.subtle.sign("HMAC", await sessionKey(secret), encoder.encode(`kdrive-mcp-session-v1:${owner}:${payload}`));
  return `${payload}.${hex(signature)}`;
}
export async function validSession(token: string, secret: string, owner: string, now = Date.now()) {
  const match = /^([a-f0-9-]{36})\.(\d{13})\.([a-f0-9]{64})$/.exec(token);
  if (!match || Number(match[2]) <= now || Number(match[2]) > now + SESSION_MS) return false;
  const signature = Uint8Array.from(match[3]!.match(/../g)!, s => parseInt(s, 16));
  return crypto.subtle.verify("HMAC", await sessionKey(secret), signature, encoder.encode(`kdrive-mcp-session-v1:${owner}:${match[1]}.${match[2]}`));
}
export function rpcError(status: number, message: string, id: string | number | null = null, data?: Record<string, unknown>) {
  return Response.json({ jsonrpc: "2.0", id, error: { code: status === 404 ? -32001 : -32000, message, ...(data ? { data } : {}) } },
    { status, headers: { "Cache-Control": "no-store" } });
}
export const sessionNotFound = () => rpcError(404, "MCP session expired or unavailable. Initialize a new session once; do not automatically repeat a file-changing tool call.");

/** Authenticated boundary. No SQL, event replay, websocket bridge or storage writes. */
export function createMcpHandler() {
  // Best-effort per-isolate admission control; no quota-consuming counter storage.
  let initWindowStart = 0; let initCount = 0;
  return { async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (new URL(request.url).pathname !== "/mcp") return new Response("Not found", { status: 404 });
    const props = ctx.props as Props | undefined;
    const owner = props?.login;
    if (typeof owner !== "string" || owner.toLowerCase() !== env.ALLOWED_GITHUB_LOGIN.toLowerCase()) {
      return rpcError(403, "This account is not authorized for the connector. Reconnect using the authorized account.", null,
        { error_code: "CONNECTOR_ACCOUNT_DENIED", requires_reauthentication: true });
    }
    if (!["POST", "DELETE"].includes(request.method)) return new Response(null, {
      status: 405, headers: { Allow: "POST, DELETE", "Cache-Control": "no-store" },
    });
    let id: string | number | null = null;
    let method: string | undefined;
    try {
      let session = request.headers.get("mcp-session-id");
      if (session && !await validSession(session, env.KDRIVE_OPERATION_SECRET, owner.toLowerCase())) return sessionNotFound();
      let bytes: Uint8Array | null = null;
      if (request.method === "POST") {
        const accept = request.headers.get("accept") ?? "";
        if (!accept.includes("application/json") || !accept.includes("text/event-stream")) return rpcError(406, "Accept must include application/json and text/event-stream.");
        if (!request.headers.get("content-type")?.includes("application/json")) return rpcError(415, "Content-Type must be application/json.");
        if (Number(request.headers.get("content-length")) > MAX_MCP_REQUEST_BYTES) return rpcError(413, "MCP request exceeds 16 MiB; use a binary upload reference for larger files.");
        try { bytes = await readBoundedBody(request.body, MAX_MCP_REQUEST_BYTES); }
        catch (error) {
          if (error instanceof RangeError) return rpcError(413, "MCP request exceeds 16 MiB; use a binary upload reference for larger files.");
          throw error;
        }
        let body: Record<string, unknown>;
        try { body = JSON.parse(new TextDecoder().decode(bytes ?? new Uint8Array())); }
        catch { return rpcError(400, "Invalid JSON."); }
        if (!JSONRPCMessageSchema.safeParse(body).success) return rpcError(400, "Expected one JSON-RPC 2.0 message.");
        id = typeof body.id === "string" || typeof body.id === "number" ? body.id : null;
        method = typeof body.method === "string" ? body.method : undefined;
        if (isInitializeRequest(body as never)) {
          if (!InitializeRequestSchema.safeParse(body).success) return rpcError(400, "Invalid initialization parameters.", id);
          if (session) return rpcError(400, "Initialization must not include a session ID.", id);
          const now = Date.now();
          if (now - initWindowStart >= 60_000) { initWindowStart = now; initCount = 0; }
          if (initCount >= 30) {
            const retry = Math.max(1, Math.ceil((initWindowStart + 60_000 - now) / 1000));
            const response = rpcError(429, "Too many new MCP sessions. Reuse the current session; pause reconnection attempts before trying again.", id,
              { error_code: "CONNECTOR_SESSION_RATE_LIMIT", retry_after_seconds: retry, requires_reauthentication: false });
            response.headers.set("Retry-After", String(retry)); return response;
          }
          initCount++;
          session = await issueSession(env.KDRIVE_OPERATION_SECRET, owner.toLowerCase());
        } else if (!session) return rpcError(400, "Mcp-Session-Id required. Initialize the connection before calling tools.", id);
      }
      if (!session) return rpcError(400, "Mcp-Session-Id required.");
      // OAuth has already checked identity; never forward credentials, URLs,
      // streams or AbortSignals through the internal RPC boundary.
      const headers: [string, string][] = [];
      for (const key of ["content-type", "accept", "mcp-session-id", "mcp-protocol-version"]) {
        const value = request.headers.get(key);
        if (value !== null) headers.push([key, value]);
      }
      const input: McpRpcRequest = { method: request.method as "POST" | "DELETE", headers, body: bytes };
      const stub = env.MCP_OBJECT.getByName(`json:${owner.toLowerCase()}:${session}`);
      const result = await stub.handleMcpRequest(input, props!, session);
      return new Response(result.body, { status: result.status, headers: result.headers });
    } catch (error) {
      const traceId = crypto.randomUUID();
      const quota = quotaErrorDetails(error, traceId);
      console.error(JSON.stringify({ event: "kdrive.mcp.failed", traceId, errorCategory: quota ? "cloudflare_quota" : "transport_error" }));
      if (quota) {
        const headers = { "Cache-Control": "no-store", "Retry-After": String(quota.retry_after_seconds) };
        if (method === "tools/call" && id !== null) return Response.json({ jsonrpc: "2.0", id,
          result: { isError: true, structuredContent: quota, content: [{ type: "text", text: JSON.stringify(quota) }] } }, { headers });
        const response = rpcError(503, quota.message, id, quota);
        response.headers.set("Retry-After", String(quota.retry_after_seconds));
        return response;
      }
      return rpcError(500, "Connector transport failed. Report the trace ID; do not automatically retry file changes.", id,
        { error_code: "CONNECTOR_TRANSPORT_ERROR", trace_id: traceId });
    }
  } };
}
