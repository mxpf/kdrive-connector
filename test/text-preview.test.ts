import assert from "node:assert/strict";
import test from "node:test";
import { KDriveClient } from "../src/kdrive-client.js";
import { loadConfig } from "../src/config.js";
import { KDriveApiError, TextPreviewUnavailableError } from "../src/errors.js";
import { downloadResponseError } from "../src/download-diagnostics.js";

const config = loadConfig({ INFOMANIAK_API_BASE_URL: "https://api.infomaniak.com", INFOMANIAK_DRIVE_ID: "42" });
const file = { id: 7, name: "synthetic.pdf", type: "file", mime_type: "application/pdf", size: 50_000_000 };
for (const type of ["application/pdf", "text/html"]) test(`unavailable previews reject ${type} before reading binary bytes`, async () => {
  let calls = 0, canceled = 0;
  const client = new KDriveClient(config, { getAccessToken: async () => "test" }, async input => {
    const url = new URL(String(input));
    calls++;
    assert.equal(url.searchParams.get("as"), "text");
    assert.match(url.pathname, /^\/2\/drive\/42\/files\/7\/(preview|download)$/);
    if (calls === 1) return Response.json({ result: "error", error: { description: "File search content not found PRIVATE" } }, { status: 404 });
    return new Response(new ReadableStream({ cancel() { canceled++; } }), { headers: { "content-type": type, "content-length": String(file.size) } });
  });
  await assert.rejects(client.downloadText(42, 7, { file, maxBytes: 1024 }), (e: unknown) => {
    assert.ok(e instanceof TextPreviewUnavailableError);
    assert.equal(e.code, "TEXT_PREVIEW_UNAVAILABLE");
    assert.equal(e.nextTool, "kdrive_read_pdf");
    assert.match(e.message, /kdrive_export_file/);
    assert.doesNotMatch(e.message, /PRIVATE|search content not found|read limit/);
    return true;
  });
  assert.equal(calls, 2); assert.equal(canceled, 1);
});

test("a binary preview can fall back to a valid text conversion", async () => {
  let canceled = false;
  const client = new KDriveClient(config, { getAccessToken: async () => "test" }, async input => {
    if (String(input).includes("/preview")) return new Response(new ReadableStream({ cancel() { canceled = true; } }), { headers: { "content-type": "application/pdf" } });
    return new Response("ORCHID-7319", { headers: { "content-type": "text/plain" } });
  });
  assert.equal(new TextDecoder().decode((await client.downloadText(42, 7, { file })).bytes), "ORCHID-7319");
  assert.equal(canceled, true);
});

for (const status of [401, 403, 429]) test(`preview HTTP ${status} is not misclassified as missing text`, async () => {
  let calls = 0;
  const client = new KDriveClient(config, { getAccessToken: async () => "test" }, async () => {
    calls++; return Response.json({ result: "error", error: { description: "Denied" } }, { status });
  });
  await assert.rejects(client.downloadText(42, 7, { file }), (e: unknown) => e instanceof KDriveApiError && e.status === status);
  assert.ok(calls <= 2); // Existing 401 token-refresh attempt remains supported.
});

test("edge HTTP 403 has a distinct diagnostic without leaking its body", () => {
  const error = downloadResponseError(new Response("PRIVATE", { status: 403 }));
  assert.equal(error.code, "DOWNLOAD_ACCESS_DENIED");
  assert.match(error.message, /does not prove the link expired/);
  assert.doesNotMatch(error.message, /PRIVATE/);
});
