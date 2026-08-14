import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { KDriveClient, normalizeKDrivePath, splitKDrivePath } from "../src/kdrive-client.js";

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

test("paths normalize for natural path-first tool inputs", () => {
  assert.equal(normalizeKDrivePath(" Private//Invoices/ "), "/Private/Invoices");
  assert.deepEqual(splitKDrivePath("/Private/Invoices/report.pdf"), {
    parentPath: "/Private/Invoices",
    name: "report.pdf",
  });
  assert.throws(() => normalizeKDrivePath("/Private/../Other"), /cannot contain/);
  assert.throws(() => splitKDrivePath("/"), /root cannot/);
});

test("path resolution walks folders and prefers an exact-case match", async () => {
  const seenPaths: string[] = [];
  const fakeFetch: typeof fetch = async (input) => {
    const url = new URL(String(input));
    seenPaths.push(url.pathname);
    if (url.pathname.endsWith("/files/1")) {
      return Response.json({ result: "success", data: { id: 1, name: "root", path: "/", type: "dir" } });
    }
    if (url.pathname.endsWith("/files/1/files")) {
      return Response.json({ result: "success", data: [{ id: 5, name: "Private", path: "/Private", type: "dir" }] });
    }
    if (url.pathname.endsWith("/files/5/files")) {
      return Response.json({
        result: "success",
        data: [
          { id: 9, name: "report.pdf", path: "/Private/report.pdf", type: "pdf" },
          { id: 10, name: "Report.pdf", path: "/Private/Report.pdf", type: "pdf" },
        ],
      });
    }
    return new Response("not found", { status: 404 });
  };
  const client = new KDriveClient(config, { getAccessToken: async () => "test-token" }, fakeFetch);
  const file = await client.resolvePath(123, "/Private/Report.pdf");
  assert.equal(file.id, 10);
  assert.deepEqual(seenPaths, [
    "/3/drive/123/files/1",
    "/3/drive/123/files/1/files",
    "/3/drive/123/files/5/files",
  ]);
});

test("path resolution accepts one case-insensitive match but rejects ambiguity", async () => {
  const makeClient = (items: Array<{ id: number; name: string; path: string; type: string }>) => new KDriveClient(
    config,
    { getAccessToken: async () => "test-token" },
    async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/files/1/files")) return Response.json({ result: "success", data: items });
      return Response.json({ result: "success", data: { id: 1, name: "root", path: "/", type: "dir" } });
    },
  );

  const unique = await makeClient([{ id: 5, name: "Private", path: "/Private", type: "dir" }]).resolvePath(123, "/private");
  assert.equal(unique.id, 5);
  await assert.rejects(
    makeClient([
      { id: 5, name: "Private", path: "/Private", type: "dir" },
      { id: 6, name: "PRIVATE", path: "/PRIVATE", type: "dir" },
    ]).resolvePath(123, "/private"),
    /ambiguous/,
  );
});
