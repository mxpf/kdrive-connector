#!/usr/bin/env node
import { parseArgs } from "node:util";
import { loadConfig, requireDriveId } from "./config.js";
import { FileTokenStore, TokenProvider, readAccessTokenFromKeychain } from "./token-store.js";
import { KDriveClient } from "./kdrive-client.js";
import { AuthenticationError, ConfigurationError } from "./errors.js";
import { downloadLocalFile, verifyLocalTransfer, LocalTransferError, LOCAL_TIMEOUT_MS, validateExpectations } from "./local-transfer.js";
import { transferFetch, abortable } from "./transfer-network.js";
import { transferDoctor } from "./transfer-doctor.js";
import { progressReporter } from "./transfer-progress.js";
import { readReceipt } from "./transfer-journal.js";
import { uploadWithReceipt, verifyReceipt, readManifest, previewBatch, executeBatch, transferErrorCode } from "./transfer-workflows.js";
import { setOperationalInfoEnabled } from "./operational-logging.js";

const help = `Local direct kDrive transfer (Cloudflare is not in the byte path).
  doctor [--online]                   Offline readiness; optional read-only connection check
  upload --source /absolute/file --path /exact/kDrive/file [--size BYTES --sha256 HEX]
  download --path /exact/kDrive/file [--sha256 HEX] [--size BYTES]
  verify --path /exact/kDrive/file --sha256 HEX --size BYTES
  verify --receipt /absolute/receipt.json
  receipt --receipt /absolute/receipt.json
  batch --manifest /absolute/manifest.json [--execute]
Batch previews by default; requires a version-1 manifest with files: source, path, size, sha256.
All uploads reject existing destinations, save private receipts, and verify remote bytes.
Limits: 1 GiB per file, 30 minutes per invocation including batch. Parent folders must exist.
Safe reads retry at most twice; uploads never automatically retry. Preserve source originals.
--progress shows throttled progress on stderr (automatic in a terminal); --quiet suppresses it.
JSON results use stdout; errors use stderr. Never put credentials in arguments.
`;
setOperationalInfoEnabled(false);
const controller = new AbortController();
const cancel = () => controller.abort();
process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    source: { type: "string" }, path: { type: "string" }, sha256: { type: "string" }, size: { type: "string" },
    receipt: { type: "string" }, manifest: { type: "string" }, execute: { type: "boolean" }, online: { type: "boolean" },
    progress: { type: "boolean" }, quiet: { type: "boolean" }, help: { type: "boolean" },
  } });
  if (values.help) { process.stdout.write(help); }
  else {
    const action = positionals[0];
    const allowed: Record<string, string[]> = {
      doctor: ["online"], upload: ["source", "path", "size", "sha256"], download: ["path", "size", "sha256"],
      verify: ["path", "size", "sha256", "receipt"], receipt: ["receipt"], batch: ["manifest", "execute"],
    };
    if (positionals.length !== 1 || !Object.hasOwn(allowed, action) || Object.keys(values).some(k => ![...allowed[action], "quiet", "progress"].includes(k))
      || (action === "upload" && (!values.path || !values.source)) || (action === "download" && !values.path)
      || (action === "verify" && (values.receipt ? Boolean(values.path || values.sha256 || values.size) : !values.path || !values.sha256 || !values.size))
      || (action === "receipt" && !values.receipt) || (action === "batch" && !values.manifest)) throw new LocalTransferError("INVALID_ARGUMENTS");
    const options = { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(LOCAL_TIMEOUT_MS)]),
      expectedSize: values.size === undefined ? undefined : Number(values.size), expectedSha256: values.sha256,
      onProgress: !values.quiet && (values.progress || process.stderr.isTTY) ? progressReporter(text => process.stderr.write(text)) : undefined };
    validateExpectations(options);
    let result: unknown;
    if (action === "receipt") result = await readReceipt(values.receipt!);
    else if (action === "batch" && !values.execute) result = await previewBatch(await readManifest(values.manifest!), options);
    else {
      const config = loadConfig();
      const client = async () => {
        if (config.apiBaseUrl !== "https://api.infomaniak.com" || config.tokenUrl !== "https://login.infomaniak.com/token") throw new LocalTransferError("UNTRUSTED_API_CONFIGURATION");
        requireDriveId(config);
        const authSignal = AbortSignal.any([options.signal, AbortSignal.timeout(30_000)]);
        const tokens = new TokenProvider({ ...config, accessToken: config.accessToken ?? readAccessTokenFromKeychain(), store: new FileTokenStore(config.tokenFile) });
        await abortable(tokens.getAccessToken(false, authSignal), authSignal);
        // Bound every later credential refresh by both its own deadline and this invocation.
        const provider = { getAccessToken: (force = false) => tokens.getAccessToken(force,
          AbortSignal.any([options.signal, AbortSignal.timeout(30_000)])) };
        return new KDriveClient(config, provider, transferFetch());
      };
      if (action === "doctor") {
        result = await transferDoctor(config, { onlineCheck: values.online ? async () => {
          const ready = await client();
          await ready.getDrive(requireDriveId(config), AbortSignal.any([options.signal, AbortSignal.timeout(30_000)]));
        } : undefined });
        if (!(result as { ready: boolean }).ready) process.exitCode = 1;
      } else {
        // Parse the entire manifest before acquiring credentials or starting transfers.
        const items = action === "batch" ? await readManifest(values.manifest!) : undefined;
        const ready = await client();
        const drive = requireDriveId(config);
        result = action === "upload" ? await uploadWithReceipt(ready, drive, values.source!, values.path!, options)
          : action === "download" ? await downloadLocalFile(ready, drive, values.path!, options)
          : action === "batch" ? await executeBatch(ready, drive, items!, options)
          : values.receipt ? await verifyReceipt(ready, drive, values.receipt, options)
          : await verifyLocalTransfer(ready, drive, values.path!, options);
        if (action === "batch" && !(result as { verified: boolean }).verified) process.exitCode = 1;
      }
    }
    process.stdout.write(JSON.stringify(result) + "\n");
  }
} catch (error) {
  const code = error instanceof AuthenticationError ? "LOCAL_AUTHENTICATION_REQUIRED"
    : error instanceof ConfigurationError ? "LOCAL_CONFIGURATION_REQUIRED"
    : error instanceof SyntaxError || (error instanceof Error && "code" in error && String(error.code).startsWith("ERR_PARSE_ARGS")) ? "INVALID_ARGUMENTS"
    : transferErrorCode(error);
  process.stderr.write(JSON.stringify({ error: code, ...(error instanceof LocalTransferError && error.receipt ? { receipt: error.receipt } : {}),
    guidance: code === "UPLOADED_NOT_VERIFIED" || code === "UPLOAD_COMMIT_UNKNOWN"
      ? "Do not re-upload. Use the saved receipt to verify the destination; preserve the original."
      : code === "LOCAL_AUTHENTICATION_REQUIRED" ? "Run doctor and configure local credentials. Preserve the original."
      : "Check local configuration and inputs. Use --help. Preserve the original." }) + "\n");
  process.exitCode = 1;
} finally { process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel); }
