#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { authorizeInteractively } from "./oauth.js";

async function main(): Promise<void> {
  const config = loadConfig();
  await authorizeInteractively(config, { open: !process.argv.includes("--no-open") });
  process.stdout.write(`Authentication saved securely at ${config.tokenFile}.\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
