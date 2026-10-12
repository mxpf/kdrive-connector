import assert from "node:assert/strict";
import test from "node:test";
import { fetchBinarySource, sourceSize, validateSourceUrl, classifyBinaryFailure } from "../src/binary-transport.js";
import { DEFAULT_BINARY_SOURCE_HOSTS } from "../src/binary-tools.js";
import { KDriveApiError } from "../src/errors.js";

const host = "sdmntprbrazilsouth.oaiusercontent.com";
const code = (expected: string) => (error: any) => {
  assert.equal(error.code, expected);
  assert.ok(!error.message.includes("PRIVATE_SIGNATURE"));
  return true;
};
test("observed native adapter region is exact-only; no suffix or arbitrary Azure trust", () => {
  assert.equal(validateSourceUrl(`https://${host}/file?sig=PRIVATE_SIGNATURE`, DEFAULT_BINARY_SOURCE_HOSTS).hostname, host);
  const libraryHost = "sdmntprsouthcentralus.oaiusercontent.com";
  assert.equal(validateSourceUrl(`https://${libraryHost}/file`, DEFAULT_BINARY_SOURCE_HOSTS).hostname, libraryHost);
  assert.equal(validateSourceUrl("https://sdmntprwestus.oaiusercontent.com/file", DEFAULT_BINARY_SOURCE_HOSTS).hostname, "sdmntprwestus.oaiusercontent.com");
  assert.equal(validateSourceUrl("https://sdmntprnortheu.oaiusercontent.com/file", DEFAULT_BINARY_SOURCE_HOSTS).hostname, "sdmntprnortheu.oaiusercontent.com");
  for (const denied of [`evil.${host}`, `${host}.evil.com`, "attacker.blob.core.windows.net", "sdmntunknown.oaiusercontent.com"]) {
    assert.throws(() => validateSourceUrl(`https://${denied}/file?sig=PRIVATE_SIGNATURE`, DEFAULT_BINARY_SOURCE_HOSTS), code("SOURCE_HOST_DENIED"));
  }
});
test("expired native URL is rejected before DNS or provider access", async () => {
  await assert.rejects(fetchBinarySource(`https://${host}/file?se=2000-01-01T00:00:00Z&sig=PRIVATE_SIGNATURE`, DEFAULT_BINARY_SOURCE_HOSTS,
    AbortSignal.timeout(1000), async () => { throw new Error("unexpected fetch"); }, async () => { throw new Error("unexpected DNS"); }), code("SOURCE_URL_EXPIRED"));
});
for (const [status, expected] of [[401,"SOURCE_AUTHENTICATION_FAILED"],[403,"SOURCE_ACCESS_DENIED"],[404,"SOURCE_NOT_FOUND"],[410,"SOURCE_NOT_FOUND"]] as const) {
  test(`source HTTP ${status} yields safe ${expected}`, async () => {
    await assert.rejects(fetchBinarySource(`https://${host}/file?sig=PRIVATE_SIGNATURE`, DEFAULT_BINARY_SOURCE_HOSTS, AbortSignal.timeout(1000),
      async () => new Response("PRIVATE_SIGNATURE", {status}), async () => {}), code(expected));
  });
}
test("size and destination conflict failures are distinct", () => {
  assert.throws(() => sourceSize(new Response("x", {headers:{"content-length":"101"}}), undefined, 100), code("SIZE_LIMIT_EXCEEDED"));
  assert.throws(() => sourceSize(new Response("x"), undefined, 100), code("SOURCE_SIZE_REQUIRED"));
  assert.throws(() => sourceSize(new Response("x", {headers:{"content-length":"2"}}), 3, 100), code("INTEGRITY_MISMATCH"));
  assert.equal(classifyBinaryFailure(new KDriveApiError("PRIVATE_SIGNATURE",409)),"DESTINATION_CONFLICT");
});
