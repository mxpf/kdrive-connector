import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { isJSONRPCErrorResponse, isJSONRPCResultResponse, type JSONRPCMessage, type RequestId } from "@modelcontextprotocol/sdk/types.js";
import type { TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";

// SDK 1.29.0 leaves completed JSON response resolvers in _streamMapping, and
// close() deletes pending resolvers without settling their HTTP responses.
// Keep the workaround isolated to this pinned version and regression-test it.
// https://github.com/modelcontextprotocol/typescript-sdk/issues/2559
interface JsonInternals {
  _streamMapping: Map<string, { cleanup(): void; resolveJson?: (response: Response) => void }>;
  _requestToStreamMapping: Map<RequestId, string>;
  _requestResponseMap: Map<RequestId, JSONRPCMessage>;
}

export class JsonMcpTransport extends WebStandardStreamableHTTPServerTransport {
  private sessionClosed = false;

  constructor(options: { sessionIdGenerator: () => string; onsessionclosed: () => void }) {
    super({ ...options, enableJsonResponse: true });
    const state = this.jsonState();
    if (!(state._streamMapping instanceof Map) || !(state._requestToStreamMapping instanceof Map)
      || !(state._requestResponseMap instanceof Map)) throw new Error("Unsupported MCP JSON transport internals.");
  }

  private jsonState() { return this as unknown as JsonInternals; }

  override async handleRequest(...args: Parameters<WebStandardStreamableHTTPServerTransport["handleRequest"]>): Promise<Response> {
    if (this.sessionClosed) return Response.json({ jsonrpc: "2.0", id: null,
      error: { code: -32001, message: "Session is closed. Initialize a new session; do not replay file changes." },
    }, { status: 404, headers: { "Cache-Control": "no-store" } });
    return super.handleRequest(...args);
  }

  override async send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    // A handler finishing after DELETE must not recreate response mappings.
    if (this.sessionClosed) return;
    const terminal = isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message);
    const state = this.jsonState();
    const requestId = terminal ? message.id : undefined;
    const streamId = requestId !== undefined ? state._requestToStreamMapping.get(requestId) : undefined;
    const stream = streamId ? state._streamMapping.get(streamId) : undefined;
    await super.send(message, options);
    // Only clean up this completed response; concurrent requests stay active.
    if (terminal) stream?.cleanup();
  }

  override async close(): Promise<void> {
    if (this.sessionClosed) return;
    this.sessionClosed = true;
    const state = this.jsonState();
    for (const [id, streamId] of state._requestToStreamMapping) {
      state._streamMapping.get(streamId)?.resolveJson?.(Response.json({
        jsonrpc: "2.0", id, error: { code: -32000,
          message: "Session closed while this request was pending. Its outcome may be unknown; check before repeating any file change.",
          data: { error_code: "CONNECTOR_SESSION_CLOSED", automatic_retry_safe: false },
        },
      }, { status: 409, headers: { "Cache-Control": "no-store" } }));
    }
    state._requestToStreamMapping.clear();
    await super.close();
  }
}
