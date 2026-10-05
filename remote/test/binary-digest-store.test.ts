import { env, evictDurableObject, runInDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { expect, it } from "vitest";
import { digestStoreName, type KDriveBinaryDigestStore } from "../src/binary-digest-store";

const identity = { driveId: 42, fileId: 7, versionId: "v1", size: 3 };
const digest = { size_bytes: 3, sha256: "a".repeat(64) };
const store = (owner: string, drive = 42) => env.KDRIVE_BINARY_DIGESTS.getByName(digestStoreName(owner, drive));

it("shares across sessions and eviction, but never across owners or drives", async () => {
  const owner = crypto.randomUUID();
  const first = store(owner);
  await first.putDigest(identity, digest);
  expect(await store(owner).getDigest(identity)).toEqual(digest);
  await evictDurableObject(first);
  expect(await store(owner).getDigest(identity)).toEqual(digest);
  expect(await store(`${owner}-other`).getDigest(identity)).toBeUndefined();
  expect(await store(owner, 43).getDigest(identity)).toBeUndefined();
  for (const change of [{ fileId: 8 }, { versionId: "v2" }, { size: 4 }]) {
    expect(await first.getDigest({ ...identity, ...change })).toBeUndefined();
  }
});

it("keeps absolute expiry and removes expired records with its alarm", async () => {
  const stub = store(crypto.randomUUID());
  await stub.putDigest(identity, digest);
  const expiry = () => runInDurableObject(stub, (_instance, state) =>
    state.storage.sql.exec<{ expires_at: number }>("SELECT expires_at FROM binary_digests").one().expires_at);
  const before = await expiry();
  await stub.getDigest(identity);
  expect(await expiry()).toBe(before);
  await runInDurableObject(stub, (_instance, state) => {
    state.storage.sql.exec("UPDATE binary_digests SET expires_at = 1");
  });
  expect(await runDurableObjectAlarm(stub)).toBe(true);
  expect(await stub.getDigest(identity)).toBeUndefined();
  expect(await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm())).toBeNull();
});

it("bounds storage to 128 entries and promotes recently read entries", async () => {
  const stub = store(crypto.randomUUID());
  for (let fileId = 1; fileId <= 128; fileId++) await stub.putDigest({ ...identity, fileId }, digest);
  await stub.getDigest({ ...identity, fileId: 1 });
  await stub.putDigest({ ...identity, fileId: 129 }, digest);
  expect(await stub.getDigest({ ...identity, fileId: 1 })).toEqual(digest);
  expect(await stub.getDigest({ ...identity, fileId: 2 })).toBeUndefined();
  expect(await runInDurableObject(stub, (_instance, state) =>
    state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM binary_digests").one().n)).toBe(128);
});

it("rejects invalid identities and unverified digest shapes", async () => {
  const stub = store(crypto.randomUUID());
  // Catch inside the object: the pool reports deliberately rejected RPC calls
  // as unhandled Worker errors even when the caller awaits their rejection.
  expect(await runInDurableObject<KDriveBinaryDigestStore, number>(stub, async instance => {
    let rejected = 0;
    try { await instance.putDigest(identity, { ...digest, size_bytes: 4 }); } catch { rejected++; }
    try { await instance.putDigest(identity, { ...digest, sha256: "invalid" }); } catch { rejected++; }
    try { await instance.getDigest({ ...identity, versionId: "" }); } catch { rejected++; }
    return rejected;
  })).toBe(3);
});
