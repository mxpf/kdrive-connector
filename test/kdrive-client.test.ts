import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { KDriveClient } from "../src/kdrive-client.js";

const config = loadConfig({
  INFOMANIAK_API_BASE_URL: "https://api.example.test",
  INFOMANIAK_DRIVE_ID: "123",
});

test("directory listing sends bearer auth and documented pagination parameters", async () => {
  let seenUrl = "";
  let seenAuthorization = "";
  const fakeFetch: typeof fetch = async (input, init) => {
    seenUrl = String(input);
    seenAuthorization = new Headers(init?.headers).get("authorization") ?? "";
    return new Response(JSON.stringify({ result: "success", data: [{ id: 7, name: "Notes", type: "dir" }], has_more: false }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const client = new KDriveClient(config, { getAccessToken: async () => "test-token" }, fakeFetch);
  const page = await client.listDirectory(123, 1, { limit: 25 });
  const url = new URL(seenUrl);
  assert.equal(url.pathname, "/3/drive/123/files/1/files");
  assert.equal(url.searchParams.get("limit"), "25");
  assert.equal(seenAuthorization, "Bearer test-token");
  assert.equal(page.data[0]?.name, "Notes");
});

test("platform fetch is called without the KDriveClient as its receiver", async () => {
  let seenReceiver: unknown = Symbol("not called");
  const receiverAwareFetch = async function (this: unknown) {
    seenReceiver = this;
    return new Response(JSON.stringify({ result: "success", data: { id: 1, name: "root", type: "dir" } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  } as typeof fetch;

  const client = new KDriveClient(config, { getAccessToken: async () => "test-token" }, receiverAwareFetch);
  await client.getFile(123, 1);

  assert.equal(seenReceiver, undefined);
});

test("plain text reads use raw bytes instead of the document converter", async () => {
  const seenUrls: string[] = [];
  const fakeFetch: typeof fetch = async (input) => {
    const url = String(input);
    seenUrls.push(url);
    if (url.includes("/files/44/download")) {
      return new Response("plain text", { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } });
    }
    return new Response(JSON.stringify({
      result: "success",
      data: { id: 44, name: "note.txt", type: "file", mime_type: "text/plain" },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  const client = new KDriveClient(config, { getAccessToken: async () => "test-token" }, fakeFetch);
  const result = await client.downloadText(123, 44);

  assert.equal(new TextDecoder().decode(result.bytes), "plain text");
  assert.equal(result.textSource, "raw");
  assert.equal(seenUrls.some((url) => url.includes("as=text")), false);
});

test("new uploads default to a conflict-safe request shape", async () => {
  let seenUrl = "";
  let seenBody = "";
  const fakeFetch: typeof fetch = async (input, init) => {
    seenUrl = String(input);
    seenBody = Buffer.from(init?.body as Uint8Array).toString("utf8");
    return new Response(JSON.stringify({ result: "success", data: { id: 9, name: "hello.txt", type: "file" } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const client = new KDriveClient(config, { getAccessToken: async () => "test-token" }, fakeFetch);
  await client.upload(123, {
    bytes: Buffer.from("hello"),
    directoryId: 1,
    fileName: "hello.txt",
    conflict: "error",
  });
  const url = new URL(seenUrl);
  assert.equal(url.pathname, "/3/drive/123/upload");
  assert.equal(url.searchParams.get("total_size"), "5");
  assert.equal(url.searchParams.get("directory_id"), "1");
  assert.equal(url.searchParams.get("file_name"), "hello.txt");
  assert.equal(url.searchParams.get("conflict"), "error");
  assert.equal(seenBody, "hello");
});

test("a 401 triggers one forced token refresh", async () => {
  const refreshFlags: boolean[] = [];
  let calls = 0;
  const fakeFetch: typeof fetch = async () => {
    calls += 1;
    if (calls === 1) return new Response("unauthorized", { status: 401 });
    return new Response(JSON.stringify({ result: "success", data: { id: 1, name: "root", type: "dir" } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const client = new KDriveClient(config, {
    getAccessToken: async (forceRefresh = false) => {
      refreshFlags.push(forceRefresh);
      return forceRefresh ? "new-token" : "old-token";
    },
  }, fakeFetch);
  await client.getFile(123, 1);
  assert.deepEqual(refreshFlags, [false, true]);
});
