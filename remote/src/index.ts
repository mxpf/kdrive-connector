import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import type { AppConfig } from "../../src/config.js";
import { KDriveClient } from "../../src/kdrive-client.js";
import { KDRIVE_SERVER_INSTRUCTIONS } from "../../src/kdrive-instructions.js";
import { createBinaryExport } from "../../src/binary-export.js";
import { createOpenPayload, signKDrivePayload } from "../../src/operation-token.js";
import { GitHubHandler } from "./github-handler";
import { registerKDriveTools } from "./kdrive-tools";
import type { Props } from "./utils";
import { withoutStandaloneNotifications } from "./mcp-transport";
import { CONNECTOR_VERSION, connectorDiagnostics } from "../../src/connector-diagnostics.js";
export { KDriveOperationNonceStore } from "./operation-nonce-store";
export { KDriveBinaryDigestStore } from "./binary-digest-store";
import { digestStoreName } from "./binary-digest-store";

function positiveInteger(value: string, name: string): number {
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) {
		throw new Error(`${name} must be a positive integer.`);
	}
	return parsed;
}

export class KDriveMCP extends McpAgent<Env, Record<string, never>, Props> {
	server = new McpServer(
		{ name: "kdrive-connector", version: CONNECTOR_VERSION },
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
		const sharedNonceStore = this.env.KDRIVE_OPERATION_NONCES.getByName(
			`${this.props.login.toLowerCase()}:${driveId}`,
		);
		const nonceStore = {
			issue: (jti: string, expiresAt: number) => sharedNonceStore.issue(jti, expiresAt),
			consume: (jti: string, now: number) => sharedNonceStore.consume(jti, now),
		};
		const connectorBaseUrl = new URL(this.env.KDRIVE_CONNECTOR_BASE_URL).origin;
		const subject = this.props.login;
		const digestStore = this.env.KDRIVE_BINARY_DIGESTS.getByName(digestStoreName(subject, driveId));

		registerKDriveTools(this.server, client, {
			digestCache: { get: (identity) => digestStore.getDigest(identity), set: (identity, digest) => digestStore.putDigest(identity, digest) },
			driveId,
			maxReadBytes,
			maxUploadBytes,
			operationSecret: this.env.KDRIVE_OPERATION_SECRET,
			maxBinaryBytes: positiveInteger(this.env.KDRIVE_MAX_BINARY_BYTES, "KDRIVE_MAX_BINARY_BYTES"),
			binarySourceHosts: this.env.KDRIVE_BINARY_SOURCE_HOSTS.split(",").map((host) => host.trim().toLowerCase()).filter(Boolean),
			buildBinaryExport: (file, versionId, digest) => createBinaryExport(this.env.KDRIVE_OPERATION_SECRET, connectorBaseUrl, subject, driveId, file, versionId, digest),
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
					connector: connectorDiagnostics({ buildId: this.env.KDRIVE_WORKER_VERSION?.id ?? "unknown-worker-build", binaryExport: true, digestCacheScope: "authenticated_owner_drive",
						maxReadBytes, maxUploadBytes, maxBinaryBytes: positiveInteger(this.env.KDRIVE_MAX_BINARY_BYTES, "KDRIVE_MAX_BINARY_BYTES") }),
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
	apiHandler: withoutStandaloneNotifications(KDriveMCP.serve("/mcp")),
	apiRoute: "/mcp",
	authorizeEndpoint: "/authorize",
	clientRegistrationEndpoint: "/register",
	defaultHandler: GitHubHandler as ExportedHandler<Env>,
	tokenEndpoint: "/token",
});
