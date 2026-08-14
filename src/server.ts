#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig, requireDriveId } from "./config.js";
import { KDriveClient } from "./kdrive-client.js";
import { KDRIVE_SERVER_INSTRUCTIONS } from "./kdrive-instructions.js";
import { registerKDriveTools } from "./kdrive-tools.js";
import { FileTokenStore, readAccessTokenFromKeychain, TokenProvider } from "./token-store.js";

const config = loadConfig();
const tokenStore = new FileTokenStore(config.tokenFile);
const accessToken = config.accessToken ?? readAccessTokenFromKeychain();
const tokenProvider = new TokenProvider({
  accessToken,
  clientId: config.clientId,
  clientSecret: config.clientSecret,
  tokenUrl: config.tokenUrl,
  redirectUri: config.redirectUri,
  store: tokenStore,
});
const client = new KDriveClient(config, tokenProvider);
const driveId = requireDriveId(config);
const server = new McpServer(
  { name: "kdrive-connector", version: "0.2.0" },
  { instructions: KDRIVE_SERVER_INSTRUCTIONS },
);

registerKDriveTools(server, client, {
  driveId,
  maxReadBytes: config.maxReadBytes,
  maxUploadBytes: config.maxUploadBytes,
  connectionStatus: async () => {
    const token = await tokenStore.read();
    const authentication = accessToken ? "API access token" : token ? "OAuth token store" : "not authenticated";
    return { connected: true, authentication, drive: await client.getDrive(driveId) };
  },
});

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport());
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
