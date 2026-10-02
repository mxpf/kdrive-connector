import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { resolve4, resolve6 } from "node:dns/promises";

export const BINARY_CHUNK_BYTES = 4 * 1024 * 1024;
export const BINARY_MAX_BYTES = 100 * 1024 * 1024;
export const BINARY_TIMEOUT_MS = 120_000;
export const EXPORT_TTL_MS = 5 * 60_000;

export class BinaryTransferError extends Error {}

async function withinDeadline<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort: () => void = () => {};
  const canceled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new BinaryTransferError("Binary transfer timed out."));
    signal.addEventListener("abort", abort, { once: true });
  });
  try { return await Promise.race([promise, canceled]); }
  finally { signal.removeEventListener("abort", abort); }
}

export function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 192 && b === 0) || (a === 192 && b === 88 && c === 99)
      || (a === 198 && [18, 19, 51].includes(b)) || (a === 203 && b === 0 && c === 113));
  }
  // Conservative global-unicast subset; reject mapped, local and transition space.
  return isIP(address) === 6 && /^[23][0-9a-f]{3}:/i.test(address)
    && !/^200[12]:/i.test(address);
}

export async function assertPublicDns(host: string, resolvers: {
  ipv4: (host: string) => Promise<string[]>;
  ipv6: (host: string) => Promise<string[]>;
} = { ipv4: resolve4, ipv6: resolve6 }): Promise<void> {
  const resolve = async (family: (host: string) => Promise<string[]>) => {
    try { return await family(host); } catch (error) {
      // workerd reports an absent AAAA record as ENOTFOUND where Node uses
      // ENODATA. Absence is allowed only if the other family supplies public
      // addresses; neither empty DNS nor other resolution errors are accepted.
      const code = (error as { code?: string } | null)?.code;
      if (code === "ENODATA" || code === "ENOTFOUND") return [];
      throw new BinaryTransferError("Could not verify the binary source network destination.");
    }
  };
  const answers = (await Promise.all([resolve(resolvers.ipv4), resolve(resolvers.ipv6)])).flat();
  // workerd can include CNAME targets in resolve4/resolve6 results. They are
  // aliases, not addresses. Validate actual IPs; alias-only answers still fail.
  const addresses: string[] = [];
  for (const answer of answers) {
    if (isIP(answer)) { addresses.push(answer); continue; }
    const name = answer.endsWith(".") ? answer.slice(0, -1) : answer;
    if (name.length > 253 || !name.includes(".") || !name.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) {
      throw new BinaryTransferError("Could not verify the binary source network destination.");
    }
  }
  if (!addresses.length || addresses.some((address) => !isPublicAddress(address))) {
    throw new BinaryTransferError("Binary source resolves to a non-public network destination.");
  }
}

// Exact administrator-controlled hosts only. Never accept suffix wildcards or
// arbitrary user-supplied domains: a DNS preflight alone is vulnerable to rebinding.
export function validateSourceUrl(value: string, trustedHosts: readonly string[]): URL {
  if (/^(?:\/|sandbox:|file:|file[_-])/i.test(value)) {
    throw new BinaryTransferError("File reference was not resolved to an HTTPS download URL. Select the conversation file through the host file-parameter adapter; do not retry with a local path, sandbox URI, or bare file ID.");
  }
  let url: URL;
  try { url = new URL(value); } catch { throw new BinaryTransferError("Invalid binary source URL."); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password || url.hash || (url.port && url.port !== "443")
    || host.startsWith("[") || isIP(host) || !host.includes(".") || host.endsWith(".")
    || /(?:^|\.)(?:localhost|local|internal|localdomain|test|invalid)$/.test(host)
    || host === "metadata.google.internal") {
    throw new BinaryTransferError("Binary source is not an approved public HTTPS host. Use a host-issued file reference or ask the administrator to approve its exact trusted download host.");
  }
  if (!trustedHosts.includes(host)) {
    // No URL path, query, credentials, or user-supplied file ID in diagnostics.
    // Report only a bounded regional OpenAI hostname, never arbitrary host data.
    // This is diagnostic evidence, not automatic permission to fetch it.
    const diagnosticHost = /^sdmnt[a-z0-9-]{1,48}\.oaiusercontent\.com$/.test(host) ? ` Rejected hostname: ${host}.` : "";
    const provider = host.endsWith(".oaiusercontent.com") ? "OpenAI file host" : "source host";
    throw new BinaryTransferError(`Binary ${provider} is not on the exact trusted-host allowlist.${diagnosticHost} The file adapter supplied an HTTPS URL, but source policy rejected it. Ask the administrator to verify its hostname privately; do not construct another URL or retry with a local path.`);
  }
  return url;
}

export async function fetchBinarySource(
  value: string, trustedHosts: readonly string[], signal: AbortSignal, fetcher: typeof fetch = fetch,
  checkDns: (host: string) => Promise<void> = assertPublicDns,
): Promise<Response> {
  let url = validateSourceUrl(value, trustedHosts);
  for (let redirects = 0; redirects <= 3; redirects++) {
    signal.throwIfAborted();
    await withinDeadline(checkDns(url.hostname), signal);
    signal.throwIfAborted();
    let response: Response;
    try {
      response = await fetcher(url.href, {
        redirect: "manual", signal, headers: { accept: "application/octet-stream", "accept-encoding": "identity" },
      });
    } catch { throw new BinaryTransferError("Binary source request failed or timed out."); }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get("location");
      if (!location || redirects === 3) throw new BinaryTransferError("Binary source exceeded its redirect limit.");
      url = validateSourceUrl(new URL(location, url).href, trustedHosts);
      continue;
    }
    if (response.status !== 200 || !response.body || (response.headers.get("content-encoding") ?? "identity") !== "identity") {
      await response.body?.cancel();
      throw new BinaryTransferError("Binary source must return an uncompressed complete HTTP 200 file.");
    }
    return response;
  }
  throw new BinaryTransferError("Binary source exceeded its redirect limit.");
}

export function sourceSize(response: Response, expectedSize: number | undefined, maxBytes: number): number {
  const header = response.headers.get("content-length");
  const length = header !== null && /^\d+$/.test(header) ? Number(header) : undefined;
  const size = expectedSize ?? length;
  if (!Number.isSafeInteger(size) || size === undefined || size < 1 || size > maxBytes) {
    throw new BinaryTransferError("Binary upload requires a positive Content-Length or expected_size within the configured limit.");
  }
  if (length !== undefined && length !== size) throw new BinaryTransferError("Binary source size does not match expected_size.");
  return size;
}

// Backpressure: at most one upload-sized buffer plus the source's current chunk.
// Reader cancellation also handles a stalled source when the deadline expires.
export async function* binaryChunks(body: ReadableStream<Uint8Array>, maxBytes: number, signal: AbortSignal): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", abort, { once: true });
  let total = 0;
  let buffer = new Uint8Array(BINARY_CHUNK_BYTES);
  let used = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new BinaryTransferError("Binary source exceeds its size limit.");
      for (let offset = 0; offset < value.byteLength;) {
        const count = Math.min(buffer.byteLength - used, value.byteLength - offset);
        buffer.set(value.subarray(offset, offset + count), used);
        offset += count;
        used += count;
        if (used === buffer.byteLength) {
          yield buffer;
          buffer = new Uint8Array(BINARY_CHUNK_BYTES);
          used = 0;
        }
      }
    }
    if (used) yield buffer.subarray(0, used);
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export async function hashBinary(body: ReadableStream<Uint8Array>, maxBytes: number, signal: AbortSignal) {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of binaryChunks(body, maxBytes, signal)) { hash.update(chunk); size += chunk.byteLength; }
  return { size_bytes: size, sha256: hash.digest("hex") };
}

export interface BinaryExportReference {
  file_name: string;
  mime_type: string;
  size_bytes: number;
  sha256: string;
  download_url: string;
  expires_at: string;
  resolved_version: string;
}
