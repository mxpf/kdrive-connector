#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig, requireDriveId } from "./config.js";
import { KDriveClient } from "./kdrive-client.js";
import { KDRIVE_SERVER_INSTRUCTIONS } from "./kdrive-instructions.js";
import { registerKDriveTools } from "./kdrive-tools.js";
import { generateOperationSecret, MemoryOperationNonceStore } from "./operation-token.js";
import { logOperationalError, operationalErrorFields } from "./operational-logging.js";
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
  { name: "kdrive-connector", version: "0.3.0" },
  { instructions: KDRIVE_SERVER_INSTRUCTIONS },
);

registerKDriveTools(server, client, {
  driveId,
  maxReadBytes: config.maxReadBytes,
  maxUploadBytes: config.maxUploadBytes,
  operationSecret: generateOperationSecret(),
  nonceStore: new MemoryOperationNonceStore(),
  buildOpenUrl: (file) => `https://ksuite.infomaniak.com/all/kdrive/app/drive/${driveId}/files/${file.id}`,
  connectionStatus: async () => {
    const token = await tokenStore.read();
    const authentication = accessToken ? "API access token" : token ? "OAuth token store" : "not authenticated";
    const drive = await client.getDrive(driveId);
    return {
      connected: true,
      authentication,
      drive: {
        name: drive.name,
        status: drive.status,
        role: drive.role,
        size: drive.size,
        usedSize: drive.used_size,
        quota: drive.quota,
      },
    };
  },
});

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport());
}

main().catch((error) => {
  logOperationalError({
    event: "kdrive.server.failed",
    stage: "startup",
    ...operationalErrorFields(error),
  });
  process.exitCode = 1;
});
