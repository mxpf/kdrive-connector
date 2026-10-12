#!/usr/bin/env node
import { parseArgs } from "node:util";
import { loadConfig, requireDriveId } from "./config.js";
import { FileTokenStore, TokenProvider, readAccessTokenFromKeychain } from "./token-store.js";
import { KDriveClient } from "./kdrive-client.js";
import { AuthenticationError, ConfigurationError } from "./errors.js";
import { classifyBinaryFailure } from "./binary-transport.js";
import { downloadLocalFile, uploadLocalFile, verifyLocalTransfer, LocalTransferError, LOCAL_TIMEOUT_MS } from "./local-transfer.js";

const help = `Local direct kDrive transfer (Cloudflare is not in the byte path).
  upload --source /absolute/local/file --path /exact/kDrive/file
  download --path /exact/kDrive/file [--sha256 HEX] [--size BYTES]
  verify --path /exact/kDrive/file --sha256 HEX --size BYTES
All uploads reject existing destinations and independently verify remote bytes.
Limits: 1 GiB, 30 minutes. Parent folder must already exist. No automatic retries.
Use existing local credentials; never put tokens or signed URLs in arguments.
Downloads return a private temporary local_path. Keep source originals until verified.
`;

try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    source: { type: "string" }, path: { type: "string" }, sha256: { type: "string" }, size: { type: "string" }, help: { type: "boolean" },
  } });
  if (values.help) { process.stdout.write(help); }
  else {
    const action = positionals[0];
    if (positionals.length !== 1 || !["upload", "download", "verify"].includes(action) || !values.path
      || (action === "upload" && !values.source) || (action !== "upload" && values.source)
      || (action === "verify" && (!values.sha256 || !values.size))) throw new LocalTransferError("INVALID_ARGUMENTS");
    const config = loadConfig();
    // This CLI never sends local credentials to configurable third-party origins.
    if (config.apiBaseUrl !== "https://api.infomaniak.com" || config.tokenUrl !== "https://login.infomaniak.com/token") {
      throw new LocalTransferError("UNTRUSTED_API_CONFIGURATION");
    }
    const driveId = requireDriveId(config);
    const tokens = new TokenProvider({ ...config, accessToken: config.accessToken ?? readAccessTokenFromKeychain(),
      store: new FileTokenStore(config.tokenFile) });
    await tokens.getAccessToken();
    const controller = new AbortController();
    const cancel = () => controller.abort();
    process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
    try {
      const options = { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(LOCAL_TIMEOUT_MS)]),
        expectedSize: values.size === undefined ? undefined : Number(values.size), expectedSha256: values.sha256 };
      const client = new KDriveClient(config, tokens);
      const result = action === "upload" ? await uploadLocalFile(client, driveId, values.source!, values.path, options)
        : action === "download" ? await downloadLocalFile(client, driveId, values.path, options)
        : await verifyLocalTransfer(client, driveId, values.path, options);
      process.stdout.write(JSON.stringify(result) + "\n");
    } finally { process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel); }
  }
} catch (error) {
  const filesystemCode = error instanceof Error && "code" in error && typeof error.code === "string"
    && ["ENOENT", "EACCES", "EPERM", "ENOSPC", "ELOOP", "EISDIR", "EMFILE"].includes(error.code) ? error.code : undefined;
  const code = error instanceof LocalTransferError ? error.code
    : error instanceof AuthenticationError ? "LOCAL_AUTHENTICATION_REQUIRED"
    : error instanceof ConfigurationError ? "LOCAL_CONFIGURATION_REQUIRED"
    : filesystemCode ? `LOCAL_FILESYSTEM_${filesystemCode}` : classifyBinaryFailure(error);
  // Never echo provider errors, source URLs, credentials, or file bytes.
  process.stderr.write(JSON.stringify({ error: code, ...(error instanceof LocalTransferError && error.receipt ? { receipt: error.receipt } : {}),
    guidance: code === "UPLOADED_NOT_VERIFIED" || code === "UPLOAD_COMMIT_UNKNOWN"
      ? "Do not re-upload. Verify the destination independently; preserve the original."
      : "Check local configuration and inputs. Use --help. Preserve the original." }) + "\n");
  process.exitCode = 1;
}
