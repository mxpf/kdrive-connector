import { expect, it, vi } from "vitest";
import { env, SELF } from "cloudflare:test";
import { createHash } from "node:crypto";
import { createBinaryExport, serveBinaryExport } from "../../src/binary-export";

const secret = "test-only-operation-secret-for-discovery";

it("binary route serves GET and HEAD without OAuth and rejects unsupported methods", async () => {
  const bytes = new TextEncoder().encode("synthetic complete bytes");
  const ref = await createBinaryExport(secret, "https://local.test", env.ALLOWED_GITHUB_LOGIN, 42,
    { id: 7, name: "synthetic.pdf", type: "file", mime_type: "application/pdf" }, 8,
    { size_bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
  const upstream = vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
    expect(String(input)).toBe("https://api.infomaniak.com/2/drive/42/files/7/versions/8/download");
    return new Response(bytes);
  });
  try {
    const response = await SELF.fetch(ref.download_url);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe(String(bytes.length));
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("www-authenticate")).toBeNull();
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    const head = await SELF.fetch(ref.download_url, { method: "HEAD" });
    expect(head.headers.get("content-length")).toBe(String(bytes.length));
    expect((await head.arrayBuffer()).byteLength).toBe(0);
    const post = await SELF.fetch(ref.download_url, { method: "POST" });
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET, HEAD");
    expect(upstream).toHaveBeenCalledTimes(1);
  } finally { upstream.mockRestore(); }
});

it.each([0, 1, 131072])("fixed-length stream preserves integrity and zero-byte handling: %i bytes", async size => {
  const bytes = new Uint8Array(size).fill(7);
  const ref = await createBinaryExport(secret, "https://local.test", "owner", 42,
    { id: 7, name: "synthetic.bin", type: "file" }, 8,
    { size_bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
  for (const corrupt of [false, true]) {
    const response = await serveBinaryExport(new Request(ref.download_url), new URL(ref.download_url).pathname.slice(8), {
      secret: secret, subject: "owner", driveId: 42,
      client: { downloadVersionStream: async () => new Response(corrupt ? new Uint8Array(size || 1) : bytes) },
    });
    if (corrupt && size === 0) expect(response.status).toBe(502);
    else if (corrupt) await expect(response.arrayBuffer()).rejects.toThrow();
    else expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  }
});
