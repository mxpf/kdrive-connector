import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createBinaryExport, serveBinaryExport } from "../../src/binary-export.js";
import { materializeBinaryReference } from "../../src/binary-materialize.js";
import { generateOperationSecret } from "../../src/operation-token.js";

const exec = promisify(execFile);
const sha = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
const python = process.env.KDRIVE_TEST_PYTHON ?? "python3";
const origin = "https://connector.example.test";

for (const name of ["ordinary", "password-protected"]) test(`real HTTP bytes → independent clients → PDF parser: ${name}`, async () => {
  const bytes = await readFile(new URL(`../fixtures/pdf/${name}.pdf`, import.meta.url));
  const secret = generateOperationSecret();
  const ref = await createBinaryExport(secret, origin, "owner", 42,
    { id: 7, name: `${name}.pdf`, type: "file", mime_type: "application/pdf" }, "v1",
    { size_bytes: bytes.length, sha256: sha(bytes) });
  const directory = await mkdtemp(join(tmpdir(), "kdrive-interop-test-"));
  let corrupt = false;
  const server = createServer(async (req, res) => {
    try {
      const response = await serveBinaryExport(new Request(origin + req.url, { method: req.method }), req.url!.slice(8), {
        secret, subject: "owner", driveId: 42, client: { downloadVersionStream: async () => new Response(corrupt ? Buffer.from(bytes).fill(0, 0, 1) : bytes) },
      });
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream), res);
      else res.end();
    } catch { res.destroy(); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  // Loopback HTTP is confined to this test. Production references and the live
  // acceptance probe use HTTPS; this adapter does not change the host bridge.
  const local = `http://127.0.0.1:${address.port}`;
  const url = local + new URL(ref.download_url).pathname;
  const fetcher: typeof fetch = (input, init) => fetch(local + new URL(String(input)).pathname, init);
  try {
    const head = await fetch(url, { method: "HEAD" });
    assert.equal(head.status, 200); assert.equal((await head.arrayBuffer()).byteLength, 0);
    assert.equal(head.headers.get("content-length"), String(bytes.length));
    assert.equal(head.headers.get("cache-control"), "private, no-store");
    assert.equal(head.headers.get("content-type"), "application/pdf");
    assert.equal(head.headers.get("accept-ranges"), "none");
    assert.equal(head.headers.get("etag"), `"sha256-${ref.sha256}"`);
    assert.match(head.headers.get("content-disposition")!, /attachment/);
    const file = await materializeBinaryReference(ref, { origin, directory, fetcher });
    assert.deepEqual(await readFile(file.local_path), bytes);
    const curl = await exec("curl", ["--fail", "--silent", "--show-error", "--max-time", "10", url], { encoding: "buffer" });
    assert.equal(sha(curl.stdout), ref.sha256); assert.equal(curl.stdout.length, bytes.length);
    const independent = await exec(python, ["-c", "import sys,urllib.request;sys.stdout.buffer.write(urllib.request.urlopen(sys.argv[1],timeout=10).read())", url], { encoding: "buffer" });
    assert.deepEqual(independent.stdout, bytes);
    const received = join(directory, "independent.pdf");
    await writeFile(received, independent.stdout, { mode: 0o600 });
    await exec(python, ["test/integration/pdf-parser.py", received, name === "ordinary" ? "ordinary" : "encrypted"]);
    assert.equal((await fetch(url + "x")).status, 410);
    const expired = await createBinaryExport(secret, origin, "owner", 42, { id: 7, name: "expired.pdf", type: "file" }, "v1", { size_bytes: bytes.length, sha256: ref.sha256 }, Date.now() - 301_000);
    assert.equal((await fetch(local + new URL(expired.download_url).pathname)).status, 410);
    const method = await fetch(url, { method: "POST" });
    assert.equal(method.status, 405); assert.equal(method.headers.get("allow"), "GET, HEAD");
    corrupt = true;
    await assert.rejects(materializeBinaryReference(ref, { origin, directory, fetcher }));
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
