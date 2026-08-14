import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import type { AppConfig } from "../../src/config.js";
import { KDriveClient } from "../../src/kdrive-client.js";
import { KDRIVE_SERVER_INSTRUCTIONS } from "../../src/kdrive-instructions.js";
import { createOpenPayload, signKDrivePayload } from "../../src/operation-token.js";
import { GitHubHandler } from "./github-handler";
import { registerKDriveTools } from "./kdrive-tools";
import type { Props } from "./utils";

function positiveInteger(value: string, name: string): number {
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) {
		throw new Error(`${name} must be a positive integer.`);
	}
	return parsed;
}

export class KDriveMCP extends McpAgent<Env, Record<string, never>, Props> {
	server = new McpServer(
		{ name: "kdrive-connector", version: "0.3.0" },
		{ instructions: KDRIVE_SERVER_INSTRUCTIONS },
	);

	async init() {
		if (!this.props || this.props.login.toLowerCase() !== this.env.ALLOWED_GITHUB_LOGIN.toLowerCase()) {
			throw new Error("This GitHub account is not authorized to use the kDrive connector.");
		}

		const driveId = positiveInteger(this.env.KDRIVE_DRIVE_ID, "KDRIVE_DRIVE_ID");
		const maxReadBytes = positiveInteger(this.env.KDRIVE_MAX_READ_BYTES, "KDRIVE_MAX_READ_BYTES");
		const maxUploadBytes = positiveInteger(this.env.KDRIVE_MAX_UPLOAD_BYTES, "KDRIVE_MAX_UPLOAD_BYTES");
		const config: AppConfig = {
			apiBaseUrl: "https://api.infomaniak.com",
			authorizeUrl: "",
			tokenUrl: "",
			driveId,
			redirectUri: "",
			oauthScope: "drive",
			tokenFile: "",
			maxReadBytes,
			maxUploadBytes,
		};
		const client = new KDriveClient(config, {
			getAccessToken: async () => this.env.KDRIVE_ACCESS_TOKEN,
		});
		this.sql`CREATE TABLE IF NOT EXISTS kdrive_operation_nonces (
			jti TEXT PRIMARY KEY,
			expires_at INTEGER NOT NULL
		)`;
		const nonceStore = {
			issue: (jti: string, expiresAt: number) => {
				this.sql`DELETE FROM kdrive_operation_nonces WHERE expires_at < ${Date.now()}`;
				this.sql`INSERT INTO kdrive_operation_nonces (jti, expires_at) VALUES (${jti}, ${expiresAt})`;
			},
			consume: (jti: string, now: number) => {
				const consumed = this.sql<{ jti: string }>`
					DELETE FROM kdrive_operation_nonces
					WHERE jti = ${jti} AND expires_at >= ${now}
					RETURNING jti
				`;
				return consumed.length === 1;
			},
		};
		const connectorBaseUrl = new URL(this.env.KDRIVE_CONNECTOR_BASE_URL).origin;

		registerKDriveTools(this.server, client, {
			driveId,
			maxReadBytes,
			maxUploadBytes,
			operationSecret: this.env.KDRIVE_OPERATION_SECRET,
			nonceStore,
			buildOpenUrl: async (file) => {
				const payload = createOpenPayload({
					driveId,
					fileId: file.id,
					path: file.path ?? `/${file.name}`,
				}, 24 * 60 * 60 * 1000);
				const token = await signKDrivePayload(this.env.KDRIVE_OPERATION_SECRET, payload);
				return `${connectorBaseUrl}/open/${token}`;
			},
			connectionStatus: async () => {
				const drive = await client.getDrive(driveId);
				return {
					connected: true,
					authentication: "OAuth-protected remote connector",
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
	}
}

export default new OAuthProvider({
	apiHandler: KDriveMCP.serve("/mcp"),
	apiRoute: "/mcp",
	authorizeEndpoint: "/authorize",
	clientRegistrationEndpoint: "/register",
	defaultHandler: GitHubHandler as ExportedHandler<Env>,
	tokenEndpoint: "/token",
});
