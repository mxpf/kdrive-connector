interface Env {
	OAUTH_PROVIDER: import("@cloudflare/workers-oauth-provider").OAuthHelpers;
	GITHUB_CLIENT_ID: string;
	GITHUB_CLIENT_SECRET: string;
	COOKIE_ENCRYPTION_KEY: string;
	KDRIVE_ACCESS_TOKEN: string;
	KDRIVE_DRIVE_ID: string;
	KDRIVE_OPERATION_SECRET: string;
}
