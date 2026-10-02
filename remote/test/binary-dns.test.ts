import { expect, it } from "vitest";
import { assertPublicDns } from "../../src/binary-transport";

const absent = (code: string) => async () => { throw Object.assign(new Error("DNS failure"), { code }); };
const publicV4 = async () => ["93.184.216.34"];
const publicV6 = async () => ["2606:4700:4700::1111"];

it.each(["ENODATA", "ENOTFOUND"])("accepts public single-stack DNS with %s for the other family", async code => {
  await expect(assertPublicDns("download.example.com", { ipv4: publicV4, ipv6: absent(code) })).resolves.toBeUndefined();
  await expect(assertPublicDns("download.example.com", { ipv4: absent(code), ipv6: publicV6 })).resolves.toBeUndefined();
});

it("rejects absent, private, mixed-private, and indeterminate DNS", async () => {
  for (const resolvers of [
    { ipv4: absent("ENOTFOUND"), ipv6: absent("ENOTFOUND") },
    { ipv4: async () => [], ipv6: async () => [] },
    { ipv4: async () => ["127.0.0.1"], ipv6: absent("ENOTFOUND") },
    { ipv4: async () => ["93.184.216.34", "10.0.0.1"], ipv6: publicV6 },
    { ipv4: publicV4, ipv6: async () => ["::1"] },
    { ipv4: publicV4, ipv6: absent("ETIMEOUT") },
    { ipv4: publicV4, ipv6: absent("ESERVFAIL") },
  ]) await expect(assertPublicDns("download.example.com", resolvers)).rejects.toThrow();
});

it("handles workerd CNAME answers but requires public terminal addresses", async () => {
  const alias = "storage-alias.example.com.";
  await expect(assertPublicDns("download.example.com", {
    ipv4: async () => [alias, "20.209.39.160"], ipv6: async () => [alias],
  })).resolves.toBeUndefined();
  for (const answers of [[alias], [alias, "10.0.0.1"], [alias, "20.209.39.160", "127.0.0.1"],
    [alias, "20.209.39.160", "::ffff:127.0.0.1"], ["malformed alias", "20.209.39.160"]]) {
    await expect(assertPublicDns("download.example.com", {
      ipv4: async () => answers, ipv6: async () => [alias],
    })).rejects.toThrow();
  }
});
