import assert from "node:assert/strict";
import test from "node:test";
import { transferFetch, waitForRetry } from "../src/transfer-network.js";
import { requestTokens } from "../src/token-store.js";

test("safe reads retry bounded transient responses and honor Retry-After", async () => {
  let calls = 0; const waits: number[] = [];
  const fetcher = transferFetch(async () => ++calls === 3 ? new Response("ok") : new Response("retry", { status: 429, headers: { "retry-after": "2" } }),
    { wait: async ms => { waits.push(ms); } });
  assert.equal(await (await fetcher("https://example.test")).text(), "ok");
  assert.equal(calls, 3); assert.deepEqual(waits, [2000, 2000]);
});

test("writes, auth failures, long waits and partial response failures never replay", async () => {
  for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
    let calls = 0;
    const fetcher = transferFetch(async () => { calls++; return new Response(null, { status: 503 }); });
    await fetcher("https://example.test", { method }); assert.equal(calls, 1);
  }
  for (const status of [401, 403, 404, 409, 429]) {
    let calls = 0;
    const fetcher = transferFetch(async () => { calls++; return new Response(null, { status, headers: { "retry-after": "60" } }); });
    await fetcher("https://example.test"); assert.equal(calls, 1);
  }
  let calls = 0;
  const fetcher = transferFetch(async () => { calls++; return new Response(new ReadableStream({ start(c) { c.error(new Error("interrupted")); } })); });
  await assert.rejects((await fetcher("https://example.test")).text()); assert.equal(calls, 1);
});

test("network retries stop at three attempts and cancellation interrupts backoff", async () => {
  let calls = 0;
  const fetcher = transferFetch(async () => { calls++; throw new TypeError("network"); }, { wait: async () => {} });
  await assert.rejects(fetcher("https://example.test")); assert.equal(calls, 3);
  const controller = new AbortController();
  const wait = waitForRetry(5000, controller.signal); controller.abort(); await assert.rejects(wait);
  let invoked = false;
  await assert.rejects(transferFetch(async () => { invoked = true; return new Response(); })("https://example.test", { signal: AbortSignal.abort() }));
  assert.equal(invoked, false);
});

test("authentication deadline covers stalled fetch and stalled JSON body", async () => {
  const config = { tokenUrl: "https://example.test/token", clientId: "id", clientSecret: "secret", redirectUri: "https://example.test" };
  for (const fetcher of [async () => new Promise<Response>(() => {}), async () => new Response(new ReadableStream())]) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20);
    try { await assert.rejects(requestTokens(config, {}, fetcher, controller.signal)); }
    finally { clearTimeout(timer); }
  }
});
