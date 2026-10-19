import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DurableObject } from "cloudflare:workers";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { AppConfig } from "../../src/config.js";
import { KDriveClient } from "../../src/kdrive-client.js";
import { KDRIVE_SERVER_INSTRUCTIONS } from "../../src/kdrive-instructions.js";
import { createBinaryExport } from "../../src/binary-export.js";
import { createOpenPayload, signKDrivePayload } from "../../src/operation-token.js";
import { GitHubHandler } from "./github-handler";
import { registerKDriveTools } from "./kdrive-tools";
import type { Props } from "./utils";
import { createMcpHandler, sessionNotFound } from "./mcp-session";
import { CONNECTOR_VERSION, connectorDiagnostics } from "../../src/connector-diagnostics.js";
export { KDriveOperationNonceStore } from "./operation-nonce-store";
export { KDriveBinaryDigestStore } from "./binary-digest-store";
import { digestStoreName } from "./binary-digest-store";
import { cloudflareOcrProvider } from "../../src/pdf-ocr.js";
import { renderPdfOcrPage } from "../../src/pdf-render.js";
import pdfiumWasm from "@hyzyla/pdfium/pdfium.wasm";

function positiveInteger(value: string, name: string): number {
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) {
		throw new Error(`${name} must be a positive integer.`);
	}
	return parsed;
}

export class KDriveMCP extends DurableObject<Env> {
	private props?: Props;
	private transport?: WebStandardStreamableHTTPServerTransport;
	private ready?: Promise<void>;
	private closed = false;

	static serve(_path: string) { return createMcpHandler(); }

	async handleMcpRequest(request: Request, props: Props, sessionId: string): Promise<Response> {
		if (typeof props?.login !== "string" || props.login.toLowerCase() !== this.env.ALLOWED_GITHUB_LOGIN.toLowerCase()) {
			return new Response("Unauthorized account", { status: 403 });
		}
		if (this.closed || (!this.ready && request.headers.has("mcp-session-id"))) return sessionNotFound();
		if (!this.ready) {
			this.props = props;
			this.transport = new WebStandardStreamableHTTPServerTransport({
				sessionIdGenerator: () => sessionId, enableJsonResponse: true,
				onsessionclosed: () => { this.closed = true; },
			});
			this.ready = this.init().then(() => this.server.connect(this.transport!));
		}
		await this.ready;
		const response = await this.transport!.handleRequest(request);
		response.headers.set("Cache-Control", "no-store");
		return response;
	}
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
		const binarySourceHosts = this.env.KDRIVE_BINARY_SOURCE_HOSTS.split(",").map((host) => host.trim().toLowerCase()).filter(Boolean);
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
			pdfJobOptions: { keepAlive: promise => this.ctx.waitUntil(promise) },
			pdfOcrRuntime: String(this.env.KDRIVE_PDF_OCR_ENABLED) === "true" && this.env.AI ? {
				provider: cloudflareOcrProvider(this.env.AI),
				render: (bytes, page, password, options) => renderPdfOcrPage(bytes, page, password, options, pdfiumWasm),
			} : undefined,
			digestCache: { get: (identity) => digestStore.getDigest(identity), set: (identity, digest) => digestStore.putDigest(identity, digest) },
			driveId,
			maxReadBytes,
			maxUploadBytes,
			operationSecret: this.env.KDRIVE_OPERATION_SECRET,
			maxBinaryBytes: positiveInteger(this.env.KDRIVE_MAX_BINARY_BYTES, "KDRIVE_MAX_BINARY_BYTES"),
			binarySourceHosts,
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
					connector: connectorDiagnostics({ memoryOnlyMcp: true, buildId: this.env.KDRIVE_WORKER_VERSION?.id ?? "unknown-worker-build", binaryExport: true, pdfOcr: String(this.env.KDRIVE_PDF_OCR_ENABLED) === "true" && Boolean(this.env.AI), digestCacheScope: "authenticated_owner_drive",
						pdfOcrJobs: String(this.env.KDRIVE_PDF_OCR_ENABLED) === "true" && Boolean(this.env.AI),
						maxReadBytes, maxUploadBytes, binarySourceHosts, maxBinaryBytes: positiveInteger(this.env.KDRIVE_MAX_BINARY_BYTES, "KDRIVE_MAX_BINARY_BYTES") }),
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
