import os from "node:os";
import path from "node:path";
import { ConfigurationError } from "./errors.js";

const DEFAULT_API_BASE_URL = "https://api.infomaniak.com";
const DEFAULT_AUTHORIZE_URL = "https://login.infomaniak.com/authorize";
const DEFAULT_TOKEN_URL = "https://login.infomaniak.com/token";
const DEFAULT_REDIRECT_URI = "http://127.0.0.1:53682/callback";

export interface AppConfig {
  apiBaseUrl: string;
  authorizeUrl: string;
  tokenUrl: string;
  driveId?: number;
  clientId?: string;
  clientSecret?: string;
  accessToken?: string;
  redirectUri: string;
  oauthScope: string;
  tokenFile: string;
  maxReadBytes: number;
  maxUploadBytes: number;
}

function optionalPositiveInteger(value: string | undefined, name: string): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new ConfigurationError(`${name} must be a positive integer.`);
  }
  return parsed;
}

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  return optionalPositiveInteger(value ?? String(fallback), name) ?? fallback;
}

function defaultTokenFile(): string {
  if (process.env.XDG_CONFIG_HOME) {
    return path.join(process.env.XDG_CONFIG_HOME, "kdrive-connector", "tokens.json");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "kdrive-connector", "tokens.json");
  }
  return path.join(os.homedir(), ".config", "kdrive-connector", "tokens.json");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    apiBaseUrl: env.INFOMANIAK_API_BASE_URL ?? DEFAULT_API_BASE_URL,
    authorizeUrl: env.INFOMANIAK_AUTHORIZE_URL ?? DEFAULT_AUTHORIZE_URL,
    tokenUrl: env.INFOMANIAK_TOKEN_URL ?? DEFAULT_TOKEN_URL,
    driveId: optionalPositiveInteger(env.INFOMANIAK_DRIVE_ID, "INFOMANIAK_DRIVE_ID"),
    clientId: env.INFOMANIAK_CLIENT_ID,
    clientSecret: env.INFOMANIAK_CLIENT_SECRET,
    accessToken: env.INFOMANIAK_ACCESS_TOKEN,
    redirectUri: env.INFOMANIAK_REDIRECT_URI ?? DEFAULT_REDIRECT_URI,
    oauthScope: env.INFOMANIAK_OAUTH_SCOPE ?? "drive",
    tokenFile: env.KDRIVE_TOKEN_FILE ?? defaultTokenFile(),
    maxReadBytes: positiveInteger(env.KDRIVE_MAX_READ_BYTES, 2 * 1024 * 1024, "KDRIVE_MAX_READ_BYTES"),
    maxUploadBytes: positiveInteger(env.KDRIVE_MAX_UPLOAD_BYTES, 10 * 1024 * 1024, "KDRIVE_MAX_UPLOAD_BYTES"),
  };
}

export function requireDriveId(config: AppConfig): number {
  if (!config.driveId) {
    throw new ConfigurationError(
      "INFOMANIAK_DRIVE_ID is not configured. Copy the numeric ID after /drive/ from your kDrive browser URL.",
    );
  }
  return config.driveId;
}
