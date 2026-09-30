import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { hashBinary, BINARY_CHUNK_BYTES } from "../../src/binary-transport";
import { createBinaryExport, serveBinaryExport } from "../../src/binary-export";
import { generateOperationSecret } from "../../src/operation-token";

describe("binary transport in the Worker runtime", () => {
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
