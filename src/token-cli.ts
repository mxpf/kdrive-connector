#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { FileTokenStore, saveAccessTokenToKeychain } from "./token-store.js";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  if (process.stdin.isTTY) {
    throw new Error("Pipe the token to this command; do not pass it as a command-line argument.");
  }

  const accessToken = (await readStdin()).trim();
  if (accessToken.length < 24 || /\s/.test(accessToken)) {
    throw new Error("Input does not look like an Infomaniak API token.");
  }

  if (saveAccessTokenToKeychain(accessToken)) {
    process.stdout.write("Infomaniak API token saved to macOS Keychain.\n");
    return;
  }

  const config = loadConfig({ ...process.env, INFOMANIAK_ACCESS_TOKEN: undefined });
  await new FileTokenStore(config.tokenFile).write({ access_token: accessToken, scope: "drive" });
  process.stdout.write(`Infomaniak API token saved securely at ${config.tokenFile}.\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
