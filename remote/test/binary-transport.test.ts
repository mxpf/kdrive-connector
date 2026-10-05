import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { hashBinary, BINARY_CHUNK_BYTES } from "../../src/binary-transport";
import { createBinaryExport, serveBinaryExport } from "../../src/binary-export";
import { generateOperationSecret } from "../../src/operation-token";
import { registerBinaryTools } from "../../src/binary-tools";
import type { KDriveClient } from "../../src/kdrive-client";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

describe("binary transport in the Worker runtime", () => {
  it("reuses verified digests within a registration but still resolves every export", async () => {
    let reads = 0;
    let resolutions = 0;
    let version = "v1";
    const secret = generateOperationSecret();
    const client = {
      resolveBinaryVersion: async () => {
        resolutions++;
        return { file: { id: 7, name: "file.pdf", type: "file", size: 3 }, versionId: version };
      },
      downloadVersionStream: async () => { reads++; return new Response(new Uint8Array([1, 2, 3])); },
    } as unknown as KDriveClient;
    const register = () => {
      let handler!: (input: { path: string }) => Promise<any>;
      const server = { registerTool(name: string, _options: unknown, fn: typeof handler) { if (name === "kdrive_export_file") handler = fn; } } as unknown as Pick<McpServer, "registerTool">;
      registerBinaryTools(server, client, { driveId: 42, buildOpenUrl: () => "unused",
        buildBinaryExport: (file, id, digest) => createBinaryExport(secret, "https://connector.example.com", "owner", 42, file, id, digest) });
      return () => handler({ path: "/Private/file.pdf" });
    };
    const run = register();
    const first = await run();
    const second = await run();
    expect(first.isError).toBeUndefined();
    expect(second.isError).toBeUndefined();
    expect(reads).toBe(1);
    expect(resolutions).toBe(2);
    expect(second.structuredContent.sha256).toBe(first.structuredContent.sha256);
    version = "v2";
    await run();
    expect(reads).toBe(2);
    await register()();
    expect(reads).toBe(3);
  });
  it("incrementally hashes a 50 MiB lazy stream", async () => {
    const size = 50 * 1024 * 1024;
    let emitted = 0;
    const sourceHash = createHash("sha256");
    const stream = new ReadableStream<Uint8Array>({ pull(controller) {
      if (emitted === size) { controller.close(); return; }
      const chunk = new Uint8Array(Math.min(65536, size - emitted)).fill(emitted / 65536 % 251);
      sourceHash.update(chunk); emitted += chunk.length; controller.enqueue(chunk);
    } });
    const result = await hashBinary(stream, size, AbortSignal.timeout(30000));
    expect(result.size_bytes).toBe(size);
    expect(result.sha256).toBe(sourceHash.digest("hex"));
    expect(BINARY_CHUNK_BYTES).toBeLessThan(size);
  });

  it("serves signed raw bytes and headers without a browser OAuth session", async () => {
    const bytes = new TextEncoder().encode("%PDF-fixture");
    const secret = generateOperationSecret();
    const ref = await createBinaryExport(secret, "https://connector.example.com", "owner", 42,
      { id: 7, name: "file.pdf", type: "pdf", mime_type: "application/pdf" }, 8,
      { size_bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
    const response = await serveBinaryExport(new Request(ref.download_url), ref.download_url.split("/binary/")[1], {
      secret, subject: "owner", driveId: 42,
      client: { downloadVersionStream: async () => new Response(bytes) },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(new TextDecoder().decode(await response.arrayBuffer())).toBe("%PDF-fixture");
  });
});
