import { access, stat, statfs, readFile, readdir } from "node:fs/promises";
import { constants } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import { fileURLToPath } from "node:url";
import type { AppConfig } from "./config.js";
import { LOCAL_MAX_BYTES } from "./local-transfer.js";

export async function transferDoctor(config: AppConfig, options: {
  nodeVersion?: string; temporaryRoot?: string; buildFile?: string | URL;
  hasKeychainToken?: () => boolean; onlineCheck?: () => Promise<void>;
} = {}) {
  const checks: Record<string, unknown> = {};
  const packageInfo = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const revision = spawnSync("git", ["rev-parse", "--short", "HEAD"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8", timeout: 2000,
  }).stdout?.trim();
  const build = { package_version: packageInfo.version as string,
    revision: revision && /^[a-f0-9]{7,40}$/.test(revision) ? revision : "unknown" };
  const next_steps: string[] = [];
  checks.runtime = Number((options.nodeVersion ?? process.versions.node).split(".")[0]) >= 24;
  if (!checks.runtime) next_steps.push("Use Node.js 24 or newer.");
  checks.drive_configured = Boolean(config.driveId);
  if (!checks.drive_configured) next_steps.push("Set INFOMANIAK_DRIVE_ID in the local configuration.");
  checks.trusted_origins = config.apiBaseUrl === "https://api.infomaniak.com" && config.tokenUrl === "https://login.infomaniak.com/token";
  if (!checks.trusted_origins) next_steps.push("Restore the standard Infomaniak API and token origins.");
  const tokenFile = await stat(config.tokenFile).then(s => s.isFile()).catch(() => false);
  const keychain = options.hasKeychainToken ?? (() => process.platform === "darwin" && spawnSync("security",
    ["find-generic-password", "-a", "runtime", "-s", "kdrive-connector.api-token"], { stdio: "ignore", timeout: 5000 }).status === 0);
  const credentials = config.accessToken ? "environment" : tokenFile ? "token_file" : keychain() ? "keychain" : "missing";
  checks.credentials = credentials;
  if (credentials === "missing") next_steps.push("Set up a local token using npm run token:save or the existing OAuth workflow.");
  checks.build_present = await stat(options.buildFile ?? new URL("../dist/transfer-cli.js", import.meta.url)).then(s => s.isFile()).catch(() => false);
  if (!checks.build_present) next_steps.push("Run npm run build from the checkout.");
  else if (!options.buildFile) {
    const sourceRoot = new URL("../src/", import.meta.url);
    const sourceTimes = await Promise.all((await readdir(sourceRoot)).filter(name => name.endsWith(".ts"))
      .map(name => stat(new URL(name, sourceRoot)).then(info => info.mtimeMs)));
    const builtAt = (await stat(new URL("../dist/transfer-cli.js", import.meta.url))).mtimeMs;
    checks.build_current = sourceTimes.every(time => time <= builtAt);
    if (!checks.build_current) next_steps.push("Rebuild with npm run build; source files changed after the last build.");
  }
  try {
    const temporaryRoot = options.temporaryRoot ?? os.tmpdir();
    await access(temporaryRoot, constants.W_OK);
    const space = await statfs(temporaryRoot, { bigint: true });
    checks.temporary_space_bytes = Number(space.bavail * space.bsize);
    checks.temporary_directory_writable = true;
    checks.space_for_maximum_file = Number(checks.temporary_space_bytes) >= LOCAL_MAX_BYTES;
  } catch {
    checks.temporary_directory_writable = false;
    next_steps.push("Make a writable temporary directory available for snapshots and downloads.");
  }
  let connection = "not_checked";
  if (options.onlineCheck && checks.drive_configured && checks.trusted_origins && credentials !== "missing") {
    try { await options.onlineCheck(); connection = "verified"; }
    catch { connection = "failed"; next_steps.push("Local connection failed; check token validity and drive access."); }
  }
  return { ready: next_steps.length === 0, build, checks, connection, credential_validity: connection === "verified" ? "verified" : "not_verified", next_steps };
}
