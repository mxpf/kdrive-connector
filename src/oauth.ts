import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { URL } from "node:url";
import type { AppConfig } from "./config.js";
import { AuthenticationError, ConfigurationError } from "./errors.js";
import {
  FileTokenStore,
  requestTokens,
  saveClientSecretToKeychain,
  type TokenRecord,
} from "./token-store.js";

export function buildAuthorizationUrl(config: AppConfig, state: string): string {
  if (!config.clientId) throw new ConfigurationError("INFOMANIAK_CLIENT_ID is required for OAuth setup.");
  const url = new URL(config.authorizeUrl);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    scope: config.oauthScope,
    state,
  }).toString();
  return url.toString();
}

function secureEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export async function exchangeAuthorizationCode(
  config: AppConfig,
  code: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TokenRecord> {
  if (!config.clientId || !config.clientSecret) {
    throw new ConfigurationError("INFOMANIAK_CLIENT_ID and INFOMANIAK_CLIENT_SECRET are required for OAuth setup.");
  }
  const token = await requestTokens(
    {
      tokenUrl: config.tokenUrl,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      redirectUri: config.redirectUri,
    },
    {
      grant_type: "authorization_code",
      code,
      redirect_uri: config.redirectUri,
    },
    fetchImpl,
  );
  return {
    ...token,
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    scope: token.scope ?? config.oauthScope,
  };
}

function openBrowser(url: string): void {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.unref();
}

export async function authorizeInteractively(config: AppConfig, options: { open?: boolean } = {}): Promise<TokenRecord> {
  if (!config.clientId || !config.clientSecret) {
    throw new ConfigurationError("Set INFOMANIAK_CLIENT_ID and INFOMANIAK_CLIENT_SECRET before running OAuth setup.");
  }

  const callbackUrl = new URL(config.redirectUri);
  if (callbackUrl.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(callbackUrl.hostname)) {
    throw new ConfigurationError("The local setup command requires an http://127.0.0.1 or http://localhost redirect URI.");
  }
  const state = randomBytes(32).toString("hex");
  const authorizationUrl = buildAuthorizationUrl(config, state);

  const codePromise = new Promise<string>((resolve, reject) => {
    const server = createServer((request, response) => {
      try {
        const incoming = new URL(request.url ?? "/", config.redirectUri);
        if (incoming.pathname !== callbackUrl.pathname) {
          response.writeHead(404).end("Not found");
          return;
        }
        const error = incoming.searchParams.get("error");
        const incomingState = incoming.searchParams.get("state") ?? "";
        const code = incoming.searchParams.get("code");
        if (error) throw new AuthenticationError(`Infomaniak denied authorization: ${error}`);
        if (!secureEqual(incomingState, state)) throw new AuthenticationError("OAuth state did not match; authorization was stopped.");
        if (!code) throw new AuthenticationError("Infomaniak did not return an authorization code.");
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end("<!doctype html><title>kDrive connected</title><h1>kDrive connected</h1><p>You can close this window.</p>");
        resolve(code);
      } catch (error) {
        response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        response.end(error instanceof Error ? error.message : "OAuth failed");
        reject(error);
      } finally {
        server.close();
      }
    });
    server.on("error", reject);
    server.listen(Number(callbackUrl.port || 80), callbackUrl.hostname);
  });

  process.stdout.write(`Open this URL to connect kDrive:\n\n${authorizationUrl}\n\n`);
  if (options.open !== false) openBrowser(authorizationUrl);
  const code = await codePromise;
  const token = await exchangeAuthorizationCode(config, code);
  await new FileTokenStore(config.tokenFile).write(token);

  const secretSaved = saveClientSecretToKeychain(config.clientId, config.clientSecret);
  if (process.platform === "darwin" && !secretSaved) {
    process.stderr.write("Warning: the client secret could not be saved to macOS Keychain; token refresh will require the environment variable.\n");
  }
  return token;
}
