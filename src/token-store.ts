import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { AuthenticationError } from "./errors.js";

const KEYCHAIN_SERVICE = "kdrive-connector.oauth";
const API_TOKEN_KEYCHAIN_SERVICE = "kdrive-connector.api-token";
const API_TOKEN_KEYCHAIN_ACCOUNT = "runtime";

export interface TokenRecord {
  access_token: string;
  token_type?: string;
  refresh_token?: string;
  expires_in?: number;
  expires_at?: number;
  scope?: string;
  client_id?: string;
  redirect_uri?: string;
}

export class FileTokenStore {
  constructor(readonly filename: string) {}

  async read(): Promise<TokenRecord | undefined> {
    try {
      const raw = await fs.readFile(this.filename, "utf8");
      const parsed = JSON.parse(raw) as TokenRecord;
      if (!parsed.access_token) return undefined;
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async write(record: TokenRecord): Promise<void> {
    await fs.mkdir(path.dirname(this.filename), { recursive: true, mode: 0o700 });
    const temporary = `${this.filename}.${process.pid}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    await fs.chmod(temporary, 0o600);
    await fs.rename(temporary, this.filename);
  }
}

export function saveClientSecretToKeychain(clientId: string, clientSecret: string): boolean {
  if (process.platform !== "darwin") return false;
  try {
    execFileSync(
      "security",
      ["add-generic-password", "-U", "-a", clientId, "-s", KEYCHAIN_SERVICE, "-w", clientSecret],
      { stdio: "ignore" },
    );
    return true;
  } catch {
    return false;
  }
}

export function readClientSecretFromKeychain(clientId: string): string | undefined {
  if (process.platform !== "darwin") return undefined;
  try {
    return execFileSync(
      "security",
      ["find-generic-password", "-a", clientId, "-s", KEYCHAIN_SERVICE, "-w"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
  } catch {
    return undefined;
  }
}

export function saveAccessTokenToKeychain(accessToken: string): boolean {
  if (process.platform !== "darwin") return false;
  try {
    execFileSync(
      "security",
      [
        "add-generic-password",
        "-U",
        "-a",
        API_TOKEN_KEYCHAIN_ACCOUNT,
        "-s",
        API_TOKEN_KEYCHAIN_SERVICE,
        "-w",
        accessToken,
      ],
      { stdio: "ignore" },
    );
    return true;
  } catch {
    return false;
  }
}

export function readAccessTokenFromKeychain(): string | undefined {
  if (process.platform !== "darwin") return undefined;
  try {
    return execFileSync(
      "security",
      [
        "find-generic-password",
        "-a",
        API_TOKEN_KEYCHAIN_ACCOUNT,
        "-s",
        API_TOKEN_KEYCHAIN_SERVICE,
        "-w",
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
  } catch {
    return undefined;
  }
}

export interface TokenEndpointConfig {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export async function requestTokens(
  config: TokenEndpointConfig,
  form: Record<string, string>,
  fetchImpl: typeof fetch = fetch,
): Promise<TokenRecord> {
  const response = await fetchImpl(config.tokenUrl, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      ...form,
    }),
  });
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok || typeof payload.access_token !== "string") {
    const reason = typeof payload.error_description === "string"
      ? payload.error_description
      : typeof payload.error === "string"
        ? payload.error
        : `HTTP ${response.status}`;
    throw new AuthenticationError(`Infomaniak token request failed: ${reason}`);
  }
  const expiresIn = typeof payload.expires_in === "number" ? payload.expires_in : undefined;
  return {
    access_token: payload.access_token,
    token_type: typeof payload.token_type === "string" ? payload.token_type : "Bearer",
    refresh_token: typeof payload.refresh_token === "string" ? payload.refresh_token : undefined,
    expires_in: expiresIn,
    expires_at: expiresIn ? Date.now() + expiresIn * 1000 : undefined,
    scope: typeof payload.scope === "string" ? payload.scope : undefined,
  };
}

export class TokenProvider {
  constructor(
    private readonly options: {
      accessToken?: string;
      clientId?: string;
      clientSecret?: string;
      tokenUrl: string;
      redirectUri: string;
      store: FileTokenStore;
      fetchImpl?: typeof fetch;
    },
  ) {}

  async getAccessToken(forceRefresh = false): Promise<string> {
    if (this.options.accessToken) return this.options.accessToken;

    const record = await this.options.store.read();
    if (!record) {
      throw new AuthenticationError(
        "kDrive is not authenticated. Run `npm run auth` or set INFOMANIAK_ACCESS_TOKEN.",
      );
    }

    const stillValid = !record.expires_at || record.expires_at > Date.now() + 60_000;
    if (!forceRefresh && stillValid) return record.access_token;
    if (!record.refresh_token) {
      if (stillValid) return record.access_token;
      throw new AuthenticationError("The kDrive access token expired and no refresh token is available. Run `npm run auth` again.");
    }

    const clientId = this.options.clientId ?? record.client_id;
    const clientSecret = this.options.clientSecret ?? (clientId ? readClientSecretFromKeychain(clientId) : undefined);
    if (!clientId || !clientSecret) {
      throw new AuthenticationError(
        "Refreshing the kDrive token requires INFOMANIAK_CLIENT_ID and INFOMANIAK_CLIENT_SECRET. On macOS, rerun `npm run auth` to save the secret in Keychain.",
      );
    }

    const refreshed = await requestTokens(
      {
        tokenUrl: this.options.tokenUrl,
        clientId,
        clientSecret,
        redirectUri: record.redirect_uri ?? this.options.redirectUri,
      },
      { grant_type: "refresh_token", refresh_token: record.refresh_token },
      this.options.fetchImpl,
    );
    const next: TokenRecord = {
      ...record,
      ...refreshed,
      refresh_token: refreshed.refresh_token ?? record.refresh_token,
      client_id: clientId,
      redirect_uri: record.redirect_uri ?? this.options.redirectUri,
    };
    await this.options.store.write(next);
    return next.access_token;
  }
}
