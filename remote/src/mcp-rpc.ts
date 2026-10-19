// Keep the RPC boundary value-only. Request/Response bodies carry remote stream
// capabilities whose lifetime otherwise extends past successful HTTP delivery.
export interface McpRpcRequest {
  method: "POST" | "DELETE";
  headers: [string, string][];
  body: Uint8Array | null;
}
export interface McpRpcResponse {
  status: number;
  headers: [string, string][];
  body: Uint8Array | null;
}
// Existing 10 MiB inline uploads expand to ~14 MiB as base64 JSON. Both limits
// remain below Cloudflare's 32 MiB serialized RPC ceiling; binary URLs stream
// through their separate route and are not buffered here.
export const MAX_MCP_REQUEST_BYTES = 16 * 1024 * 1024;
export const MAX_MCP_RESPONSE_BYTES = 16 * 1024 * 1024;

export async function readBoundedBody(body: ReadableStream<Uint8Array> | null, limit: number): Promise<Uint8Array | null> {
  if (!body) return null;
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > limit) { await reader.cancel(); throw new RangeError("MCP body limit exceeded."); }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

export async function encodeMcpResponse(response: Response): Promise<McpRpcResponse> {
  return { status: response.status, headers: [...response.headers],
    body: await readBoundedBody(response.body, MAX_MCP_RESPONSE_BYTES) };
}
