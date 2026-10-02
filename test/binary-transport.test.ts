import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { BINARY_CHUNK_BYTES, binaryChunks, fetchBinarySource, hashBinary, isPublicAddress, sourceSize, validateSourceUrl } from "../src/binary-transport.js";
import { createBinaryExport, serveBinaryExport } from "../src/binary-export.js";
import { loadConfig } from "../src/config.js";
import { KDriveClient } from "../src/kdrive-client.js";
import { generateOperationSecret } from "../src/operation-token.js";
import { generatedEpub } from "./binary-fixtures.js";
import { DEFAULT_BINARY_SOURCE_HOSTS } from "../src/binary-tools.js";

const config = loadConfig({ INFOMANIAK_API_BASE_URL: "https://api.infomaniak.com", INFOMANIAK_DRIVE_ID: "42" });
const deadline = () => AbortSignal.timeout(10_000);
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const envelope = (data: unknown) => Response.json({ result: "success", data });

function uploadHarness(options: { failChunk?: boolean; failFinish?: boolean; redirectChunk?: string; uploadUrl?: string } = {}) {
  const chunks: Uint8Array[] = [];
  let finalized = 0;
  let canceled = 0;
  let declaredSize = 0;
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(init?.redirect, "manual");
    if (url.pathname.endsWith("/start")) {
      const body = JSON.parse(String(init?.body));
      assert.equal(body.conflict, "error");
      assert.equal(body.file_id, undefined);
      declaredSize = body.total_size;
      assert.equal(body.total_chunks, Math.ceil(declaredSize / BINARY_CHUNK_BYTES));
      return envelope({ token: "test-session", upload_url: options.uploadUrl ?? "https://1-14-v3-12.upload.kdrive.infomaniak.com/" });
    }
    if (url.pathname.endsWith("/chunk")) {
      assert.equal(url.pathname, "/3/drive/42/upload/session/test-session/chunk");
      if (options.redirectChunk) return new Response(null, { status: 302, headers: { location: options.redirectChunk } });
      assert.ok(init?.body instanceof Uint8Array);
      const bytes = new Uint8Array(init.body);
      assert.equal(url.searchParams.get("chunk_hash"), `sha256:${sha(bytes)}`);
      assert.equal(Number(url.searchParams.get("chunk_number")), chunks.length + 1);
      assert.equal(Number(url.searchParams.get("chunk_size")), bytes.length);
      chunks.push(bytes);
      return envelope({ status: options.failChunk ? "error" : "ok" });
    }
    if (init?.method === "DELETE") { canceled++; return envelope(true); }
    if (url.pathname.endsWith("/finish")) {
      assert.equal(url.searchParams.get("with"), "path");
      finalized++;
      if (options.failFinish) throw new Error("private source credential must not escape");
      return envelope({ result: true, file: { id: 99, name: "fixture.epub", type: "file", etag: "new-version", size: declaredSize } });
    }
    throw new Error("Unexpected provider request");
  };
  return { client: new KDriveClient(config, { getAccessToken: async () => "private-api-token" }, fakeFetch), chunks,
    finalized: () => finalized, canceled: () => canceled };
}

test("500 KB generated artifact uploads and exports with identical bytes and digest", async () => {
  const bytes = generatedEpub();
  assert.ok(bytes.length > 500_000 && bytes.length < 520_000);
  const h = uploadHarness();
  const uploaded = await h.client.uploadBinary(42, { body: new Response(bytes).body!, size: bytes.length,
    fileName: "fixture.epub", directoryId: 7, expectedSha256: sha(bytes), signal: deadline() });
  assert.equal(h.finalized(), 1);
  assert.equal(h.canceled(), 0);
  assert.equal(uploaded.sha256, sha(bytes));
  const secret = generateOperationSecret();
  const ref = await createBinaryExport(secret, "https://connector.example.com", "owner", 42,
    { ...uploaded.file, mime_type: "application/epub+zip" }, 123, uploaded);
  const raw = await serveBinaryExport(new Request(ref.download_url), ref.download_url.split("/binary/")[1], {
    secret, subject: "owner", driveId: 42,
    client: { downloadVersionStream: async (_drive, file, version) => {
      assert.equal(file, 99); assert.equal(version, 123);
      return new Response(new Uint8Array(Buffer.concat(h.chunks)));
    } },
  });
  assert.equal(raw.status, 200);
  assert.equal(raw.headers.get("content-type"), "application/epub+zip");
  assert.match(raw.headers.get("content-disposition")!, /fixture.epub/);
  const returned = new Uint8Array(await raw.arrayBuffer());
  assert.deepEqual(returned, bytes);
  assert.equal(sha(returned), ref.sha256);
  assert.equal(returned.length, ref.size_bytes);
});

test("50 MiB streams incrementally with backpressure, never as a full-file buffer", async () => {
  const size = 50 * 1024 * 1024;
  let generated = 0;
  let uploaded = 0;
  let calls = 0;
  let maxAhead = 0;
  const sourceHash = createHash("sha256");
  const uploadHash = createHash("sha256");
  const body = new ReadableStream<Uint8Array>({ pull(controller) {
    if (generated === size) { controller.close(); return; }
    const chunk = new Uint8Array(Math.min(64 * 1024, size - generated)).fill(generated / 65536 % 251);
    generated += chunk.length; sourceHash.update(chunk);
    maxAhead = Math.max(maxAhead, generated - uploaded); controller.enqueue(chunk);
  } });
  const fakeFetch: typeof fetch = async (url, init) => {
    if (String(url).includes("/start")) return envelope({ token: "large", upload_url: "https://api.kdrive.infomaniak.com/" });
    if (String(url).includes("/chunk")) {
      assert.ok(init?.body instanceof Uint8Array);
      assert.ok(init.body.length <= BINARY_CHUNK_BYTES);
      uploadHash.update(init.body); uploaded += init.body.length; calls++;
      return envelope({ status: "ok" });
    }
    assert.equal(uploaded, size);
    return envelope({ result: true, file: { id: 1, name: "large.bin", type: "file", size } });
  };
  const client = new KDriveClient(config, { getAccessToken: async () => "token" }, fakeFetch);
  const result = await client.uploadBinary(42, { body, size, fileName: "large.bin", directoryId: 7, signal: deadline() });
  assert.equal(calls, 13);
  assert.ok(maxAhead <= BINARY_CHUNK_BYTES + 65536, `Read ahead ${maxAhead} bytes`);
  assert.equal(result.sha256, sourceHash.digest("hex"));
  assert.equal(result.sha256, uploadHash.digest("hex"));
});

for (const kind of ["digest", "short", "long", "chunk"] as const) {
  test(`${kind} failure cancels the upload session without finalizing`, async () => {
    const h = uploadHarness({ failChunk: kind === "chunk" });
    const bytes = new Uint8Array(100).fill(7);
    await assert.rejects(() => h.client.uploadBinary(42, {
      body: new Response(bytes).body!, size: kind === "short" ? 101 : kind === "long" ? 99 : 100,
      fileName: "bad.bin", directoryId: 7, signal: deadline(), expectedSha256: kind === "digest" ? "0".repeat(64) : undefined,
    }));
    assert.equal(h.finalized(), 0); assert.equal(h.canceled(), 1);
  });
}

test("upload URL accepts the exact session route and rejects drift or credential-bearing URLs", async () => {
  const base = "https://1-14-v3-12.upload.kdrive.infomaniak.com";
  const route = "/3/drive/42/upload/session/test-session/chunk";
  const valid = uploadHarness({ uploadUrl: base + route });
  await valid.client.uploadBinary(42, { body: new Response("x").body!, size: 1, fileName: "fixture.bin", directoryId: 7, signal: deadline() });
  assert.equal(valid.finalized(), 1);
  for (const uploadUrl of [base + "/app", base + route.replace("42", "43"), base + route.replace("test-session", "other-session"), base + "/?token=SECRET", base + "/#SECRET", "https://user:SECRET@1-14-v3-12.upload.kdrive.infomaniak.com/"]) {
    const h = uploadHarness({ uploadUrl });
    await assert.rejects(() => h.client.uploadBinary(42, { body: new Response("x").body!, size: 1, fileName: "fixture.bin", directoryId: 7, signal: deadline() }));
    assert.equal(h.chunks.length, 0);
    assert.equal(h.finalized(), 0);
    assert.equal(h.canceled(), 1);
  }
});

test("binary redirect diagnostics redact credentials, paths and queries and do not follow", async () => {
  const h = uploadHarness({ redirectChunk: "https://user:SECRET@api.infomaniak.com/3/drive/PRIVATE/upload/session/TOKEN/chunk?signature=SECRET" });
  await assert.rejects(() => h.client.uploadBinary(42, { body: new Response("x").body!, size: 1,
    fileName: "fixture.bin", directoryId: 7, signal: deadline() }), (error: Error) => {
    assert.match(error.message, /redirect rejected/);
    assert.doesNotMatch(error.message, /SECRET|PRIVATE|TOKEN|signature|user:/);
    return true;
  });
  assert.equal(h.finalized(), 0);
  assert.equal(h.canceled(), 1);
});

test("provider failures never expose credentials in upload errors", async () => {
  const h = uploadHarness({ failFinish: true });
  await assert.rejects(() => h.client.uploadBinary(42, { body: new Response(new Uint8Array(1)).body!, size: 1,
    fileName: "fixture.bin", directoryId: 7, signal: deadline() }), (error: Error) => {
    assert.doesNotMatch(error.message, /private source credential/);
    assert.match(error.message, /during finalization/); return true;
  });
});

test("SSRF policy rejects schemes, local/private/metadata/IP and nonapproved hosts", () => {
  for (const value of ["file:///etc/passwd", "http://files.oaiusercontent.com/a", "https://localhost/a", "https://127.0.0.1/a",
    "https://10.0.0.1/a", "https://172.16.0.1/a", "https://192.168.1.1/a", "https://169.254.169.254/latest/meta-data",
    "https://[::1]/a", "https://[::ffff:127.0.0.1]/a", "https://2130706433/a", "https://0x7f000001/a",
    "https://metadata.google.internal/a", "https://files.oaiusercontent.com.evil.com/a", "https://user:secret@files.oaiusercontent.com/a",
    "https://files.oaiusercontent.com:8443/a", "https://files.oaiusercontent.com./a"]) {
    assert.throws(() => validateSourceUrl(value, ["files.oaiusercontent.com"]), undefined, value);
  }
  for (const address of ["127.0.0.1", "10.0.0.1", "172.31.1.2", "192.168.0.1", "169.254.169.254", "100.100.100.200", "::1", "fe80::1", "fc00::1", "::ffff:10.0.0.1"]) assert.equal(isPublicAddress(address), false);
  assert.equal(isPublicAddress("1.1.1.1"), true);
  assert.equal(isPublicAddress("2606:4700:4700::1111"), true);
});

test("redirects are manual, limited and revalidated without source credentials", async () => {
  const hosts = ["files.oaiusercontent.com"];
  const noDns = async () => {};
  let requests = 0;
  const looping: typeof fetch = async (_url, init) => {
    requests++; assert.equal(init?.redirect, "manual");
    assert.equal(new Headers(init?.headers).get("authorization"), null);
    return new Response(null, { status: 302, headers: { location: "/again" } });
  };
  await assert.rejects(() => fetchBinarySource("https://files.oaiusercontent.com/a", hosts, deadline(), looping, noDns), /redirect limit/);
  assert.equal(requests, 4);
  await assert.rejects(() => fetchBinarySource("https://files.oaiusercontent.com/a", hosts, deadline(),
    async () => new Response(null, { status: 302, headers: { location: "https://169.254.169.254/" } }), noDns), /approved public HTTPS/);
});

test("observed native file host is accepted exactly, not as a wildcard", async () => {
  for (const host of ["sdmntprsoutheastus3.oaiusercontent.com", "sdmntpreastus2.oaiusercontent.com"]) {
    assert.equal(validateSourceUrl(`https://${host}/file`, DEFAULT_BINARY_SOURCE_HOSTS).hostname, host);
    assert.throws(() => validateSourceUrl(`https://evil.${host}/file`, DEFAULT_BINARY_SOURCE_HOSTS));
    assert.throws(() => validateSourceUrl(`https://${host}.evil.example/file`, DEFAULT_BINARY_SOURCE_HOSTS));
  }
  const pngHost = "sdmntprnorthcentralus.oaiusercontent.com";
  assert.equal(validateSourceUrl(`https://${pngHost}/file?sig=private`, DEFAULT_BINARY_SOURCE_HOSTS).hostname, pngHost);
  for (const host of [`evil.${pngHost}`, `${pngHost}.evil.example`]) {
    assert.throws(() => validateSourceUrl(`https://${host}/file`, DEFAULT_BINARY_SOURCE_HOSTS));
  }
  const host = "sdmntprcentralus.oaiusercontent.com";
  assert.equal(validateSourceUrl(`https://${host}/file?sig=private`, DEFAULT_BINARY_SOURCE_HOSTS).hostname, host);
  for (const other of [`${host}.evil.example`, `evil.${host}`, "unverified.oaiusercontent.com"]) {
    assert.throws(() => validateSourceUrl(`https://${other}/file?sig=private`, DEFAULT_BINARY_SOURCE_HOSTS));
  }
  let fetched = 0;
  await assert.rejects(() => fetchBinarySource(`https://${host}/file`, DEFAULT_BINARY_SOURCE_HOSTS, deadline(),
    async () => { fetched++; return new Response("never"); },
    async () => { throw new Error("private DNS rejected"); }), /private DNS/);
  assert.equal(fetched, 0);
});

test("file-adapter failures and host-policy failures are distinct and redact URL data", () => {
  for (const input of ["/mnt/data/private.png", "sandbox:/mnt/data/private.png", "file_private", "file:///private.png"]) {
    assert.throws(() => validateSourceUrl(input, DEFAULT_BINARY_SOURCE_HOSTS), (e: Error) => {
      assert.match(e.message, /not resolved/);
      assert.doesNotMatch(e.message, /private/);
      return true;
    });
  }
  assert.throws(() => validateSourceUrl("https://unverified.oaiusercontent.com/private.png?sig=SECRET", DEFAULT_BINARY_SOURCE_HOSTS), (e: Error) => {
    assert.match(e.message, /OpenAI file host.*allowlist/);
    assert.doesNotMatch(e.message, /unverified|private.png|SECRET/);
    return true;
  });
});

test("regional rejection exposes hostname only without granting trust", () => {
  assert.throws(() => validateSourceUrl("https://sdmnt-region.oaiusercontent.com/PRIVATE?sig=SECRET", []), (e: Error) => {
    assert.match(e.message, /Rejected hostname: sdmnt-region\.oaiusercontent\.com/);
    assert.doesNotMatch(e.message, /PRIVATE|SECRET|https:/);
    return true;
  });
});

test("non-regional adapter host diagnostics do not fetch or expose signed URL data", async () => {
  let fetched = false;
  await assert.rejects(() => fetchBinarySource("https://files.example.com/private/file.png?sig=SECRET", [], deadline(), async () => {
    fetched = true;
    return new Response("unused");
  }), (e: Error) => {
    assert.doesNotMatch(e.message, /files\.example\.com/);
    assert.doesNotMatch(e.message, /\/private\/|file\.png|SECRET|https:/);
    return true;
  });
  assert.equal(fetched, false);
});

test("observed ChatGPT Azure file host is trusted exactly, never as a shared-domain wildcard", () => {
  const host = "oaisdmntprnorthcentralus.blob.core.windows.net";
  assert.equal(validateSourceUrl(`https://${host}/file?sig=private`, DEFAULT_BINARY_SOURCE_HOSTS).hostname, host);
  for (const other of ["anotheraccount.blob.core.windows.net", `evil.${host}`, `${host}.evil.example`, "oaisdmntprnorthcentralus-evil.blob.core.windows.net"]) {
    assert.throws(() => validateSourceUrl(`https://${other}/file`, DEFAULT_BINARY_SOURCE_HOSTS));
  }
});

test("size checks reject missing length, header mismatch, advertised and streamed oversize", async () => {
  assert.throws(() => sourceSize(new Response(""), undefined, 100), /requires/);
  assert.throws(() => sourceSize(new Response("", { headers: { "content-length": "101" } }), undefined, 100), /limit/);
  assert.throws(() => sourceSize(new Response("", { headers: { "content-length": "10" } }), 11, 100), /match/);
  await assert.rejects(() => hashBinary(new Response(new Uint8Array(101)).body!, 100, deadline()), /size limit/);
});

test("stalled binary reader is canceled on timeout", async () => {
  let canceled = false;
  const controller = new AbortController();
  const body = new ReadableStream<Uint8Array>({ cancel() { canceled = true; } });
  const pending = (async () => { for await (const _ of binaryChunks(body, 100, controller.signal)) {} })();
  controller.abort();
  await assert.rejects(() => pending);
  assert.equal(canceled, true);
});

test("export rejects tampered, expired, cross-user and cross-drive references without provider calls", async () => {
  const secret = generateOperationSecret();
  const file = { id: 1, name: "private.pdf", type: "pdf", mime_type: "application/pdf" };
  const digest = { size_bytes: 1, sha256: sha(new Uint8Array(1)) };
  const ref = await createBinaryExport(secret, "https://connector.example.com", "owner", 42, file, 2, digest);
  const expired = await createBinaryExport(secret, "https://connector.example.com", "owner", 42, file, 2, digest, Date.now() - 400_000);
  const token = ref.download_url.split("/binary/")[1];
  const client = { downloadVersionStream: async () => { throw new Error("Must not fetch"); } };
  for (const params of [{ token: token + "x", subject: "owner", driveId: 42 }, { token, subject: "other", driveId: 42 },
    { token, subject: "owner", driveId: 43 }, { token: expired.download_url.split("/binary/")[1], subject: "owner", driveId: 42 }]) {
    const response = await serveBinaryExport(new Request(ref.download_url), params.token, { ...params, client, secret });
    assert.equal(response.status, 410);
  }
});

test("PDF path resolves to a pinned raw reference consumable without base64", async () => {
  const path = "/Private/05 Reference/Reading/Philosophy & Spirituality/Zen Mind, Beginner's Mind.pdf";
  const names = path.slice(1).split("/");
  const bytes = new TextEncoder().encode("%PDF-1.4\n1 0 obj << /Length 23 >> stream\nBT (Fixture text) Tj ET\nendstream\nendobj\n%%EOF");
  const file = { id: 6, name: names.at(-1)!, path, type: "pdf", mime_type: "application/pdf", size: bytes.length, etag: "v1" };
  const requests: string[] = [];
  const client = new KDriveClient(config, { getAccessToken: async () => "token" }, async (input) => {
    const url = new URL(String(input)); requests.push(url.pathname);
    if (url.pathname.endsWith("/versions")) return envelope([]);
    if (url.pathname.endsWith("/download")) { assert.match(url.pathname, /\/files\/6\/download$/); return new Response(bytes); }
    const match = url.pathname.match(/\/files\/(\d+)(\/files)?$/)!;
    const id = Number(match[1]);
    if (!match[2]) return envelope(id === 6 ? file : { id, name: "root", type: "dir" });
    return envelope([id === 5 ? file : { id: id + 1, name: names[id - 1], type: "dir" }]);
  });
  const pinned = await client.resolveBinaryVersion(42, path, deadline());
  assert.equal(pinned.versionId, "v1");
  const response = await client.downloadVersionStream(42, file.id, pinned.versionId, deadline());
  const digest = await hashBinary(response.body!, 10000, deadline());
  const secret = generateOperationSecret();
  const ref = await createBinaryExport(secret, "https://connector.example.com", "owner", 42, pinned.file, pinned.versionId, digest);
  // Raw HTTP consumer contract; not a claim that live Acrobat accepted this fixture.
  const downloaded = await serveBinaryExport(new Request(ref.download_url), ref.download_url.split("/binary/")[1], { client, driveId: 42, subject: "owner", secret });
  const text = await downloaded.text();
  assert.match(text, /^%PDF/); assert.match(text, /Fixture text/);
  assert.equal(ref.file_name, names.at(-1));
  assert.equal(ref.resolved_version, "v1");
  assert.equal("content" in ref, false);
  assert.ok(requests.every((request) => !request.endsWith("/preview")));
  assert.ok(requests.every((request) => !request.endsWith("/versions")));
});

test("changed ETag or size fails closed during resolution", async () => {
  for (const sizeChanges of [false, true]) {
    let reads = 0;
    const client = new KDriveClient(config, { getAccessToken: async () => "token" }, async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/files")) return envelope([{ id: 2, name: "file.pdf", type: "pdf" }]);
      if (url.pathname.endsWith("/1")) return envelope({ id: 1, name: "root", type: "dir" });
      ++reads;
      return envelope({ id: 2, name: "file.pdf", type: "pdf", size: sizeChanges ? reads : 5, etag: sizeChanges ? "fixed" : String(reads) });
    });
    await assert.rejects(() => client.resolveBinaryVersion(42, "/file.pdf", deadline()), /metadata changed/);
  }
});

test("current ETag exports reject drift before and during streaming", async () => {
  for (const phase of ["before", "during"] as const) {
    let reads = 0;
    let downloads = 0;
    const client = new KDriveClient(config, { getAccessToken: async () => "token" }, async (input) => {
      if (String(input).endsWith("/download")) { downloads++; return new Response(new Uint8Array([1, 2])); }
      reads++;
      return envelope({ id: 2, type: "file", size: 2, etag: phase === "before" || reads > 1 ? "changed" : "fixed" });
    });
    const secret = generateOperationSecret();
    const ref = await createBinaryExport(secret, "https://connector.example.com", "owner", 42,
      { id: 2, name: "file.bin", type: "file" }, "fixed", { size_bytes: 2, sha256: sha(new Uint8Array([1, 2])) });
    const response = await serveBinaryExport(new Request(ref.download_url), ref.download_url.split("/binary/")[1], {
      client, secret, subject: "owner", driveId: 42,
    });
    if (phase === "before") { assert.equal(response.status, 410); assert.equal(downloads, 0); }
    else { await assert.rejects(() => response.arrayBuffer(), /integrity/); assert.equal(downloads, 1); }
  }
});

test("historical version IDs remain supported without resolving the current path", async () => {
  const client = new KDriveClient(config, { getAccessToken: async () => "token" }, async (input) => {
    assert.match(String(input), /\/files\/2\/versions\/77\/download$/);
    return new Response(new Uint8Array([3]));
  });
  const response = await client.downloadVersionStream(42, 2, 77, deadline());
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), new Uint8Array([3]));
});

test("download stream errors rather than silently returning changed bytes", async () => {
  const secret = generateOperationSecret();
  const ref = await createBinaryExport(secret, "https://connector.example.com", "owner", 42,
    { id: 1, name: "file.bin", type: "file" }, 2, { size_bytes: 1, sha256: sha(new Uint8Array([1])) });
  const response = await serveBinaryExport(new Request(ref.download_url), ref.download_url.split("/binary/")[1], {
    secret, subject: "owner", driveId: 42, client: { downloadVersionStream: async () => new Response(new Uint8Array([2])) },
  });
  await assert.rejects(() => response.body!.getReader().read(), /integrity/);
});

test("unavailable version returns a well-formed error, not stale binary headers", async () => {
  const secret = generateOperationSecret();
  const ref = await createBinaryExport(secret, "https://connector.example.com", "owner", 42,
    { id: 1, name: "file.bin", type: "file" }, 2, { size_bytes: 1, sha256: sha(new Uint8Array([1])) });
  const response = await serveBinaryExport(new Request(ref.download_url), ref.download_url.split("/binary/")[1], {
    secret, subject: "owner", driveId: 42, client: { downloadVersionStream: async () => { throw new Error("private token"); } },
  });
  assert.equal(response.status, 410);
  assert.equal(response.headers.get("content-length"), null);
  assert.match(response.headers.get("content-type")!, /text\/plain/);
  assert.doesNotMatch(await response.text(), /private token/);
});
