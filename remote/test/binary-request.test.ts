import { expect, it } from "vitest";
import { KDriveClient } from "../../src/kdrive-client";
import { loadConfig } from "../../src/config";

it("reproduces workerd rejection of redirect:error without network access", () => {
  expect(() => new Request("https://api.infomaniak.com/", { method: "POST", redirect: "error" })).toThrow();
  expect(() => new Request("https://api.infomaniak.com/", { method: "POST", redirect: "manual" })).not.toThrow();
});

it("binary session requests construct in workerd and reject redirects without following", async () => {
  let calls = 0;
  const client = new KDriveClient(loadConfig({ ...process.env, INFOMANIAK_API_BASE_URL: "https://api.infomaniak.com", INFOMANIAK_DRIVE_ID: "42" }),
    { getAccessToken: async () => "test-only" }, async (url, init) => {
      calls++;
      const request = new Request(url, init);
      expect(request.redirect).toBe("manual");
      return new Response(null, { status: 302, headers: { location: "https://untrusted.invalid/" } });
    });
  await expect(client.uploadBinary(42, { body: new Response("x").body!, size: 1, fileName: "qa.png", directoryId: 7,
    signal: AbortSignal.timeout(1000) })).rejects.toThrow("session start (HTTP 302)");
  expect(calls).toBe(1);
});

it("uploads from an origin-only session URL using the exact chunk route in workerd", async () => {
  const paths: string[] = [];
  const client = new KDriveClient(loadConfig({ ...process.env, INFOMANIAK_API_BASE_URL: "https://api.infomaniak.com", INFOMANIAK_DRIVE_ID: "42" }),
    { getAccessToken: async () => "test-only" }, async (url, init) => {
      const request = new Request(url, init);
      const parsed = new URL(request.url);
      paths.push(parsed.pathname);
      expect(request.redirect).toBe("manual");
      if (parsed.pathname.endsWith("/start")) return Response.json({ result: "success", data: {
        token: "test-session", upload_url: "https://1-14-v3-12.upload.kdrive.infomaniak.com/",
      } });
      if (parsed.pathname.endsWith("/chunk")) {
        expect(parsed.pathname).toBe("/3/drive/42/upload/session/test-session/chunk");
        expect(new Uint8Array(await request.arrayBuffer())).toEqual(new TextEncoder().encode("png-fixture"));
        return Response.json({ result: "success", data: { status: "ok" } });
      }
      expect(parsed.pathname).toBe("/3/drive/42/upload/session/test-session/finish");
      expect(parsed.searchParams.get("with")).toBe("path");
      return Response.json({ result: "success", data: { result: true, file: { id: 1, name: "qa.png", type: "file", size: 11 } } });
    });
  const result = await client.uploadBinary(42, { body: new Response("png-fixture").body!, size: 11,
    fileName: "qa.png", directoryId: 7, signal: AbortSignal.timeout(1000) });
  expect(result.size_bytes).toBe(11);
  expect(paths).toHaveLength(3);
});
