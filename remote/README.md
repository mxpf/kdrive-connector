# Authenticated remote kDrive MCP server

This Cloudflare Worker exposes the kDrive connector as an OAuth-protected
Streamable HTTP MCP endpoint at `/mcp`. It is designed for ChatGPT Work and
other remote MCP clients.

## Security model

- The Worker is its own OAuth authorization server for MCP clients.
- GitHub OAuth authenticates the human approving the connection.
- `ALLOWED_GITHUB_LOGIN` restricts authorization to one GitHub username.
- The GitHub access token is used only to fetch that username and is then
  discarded; it is not embedded in the MCP token.
- The Infomaniak API token and drive ID are Cloudflare Worker secrets.
- Tools use MCP read/write and destructive annotations for the host's native approval boundary.
- Paths are resolved server-side, and overwrite requests enforce the file's current ETag.
- Permanent deletion is not exposed.

## Deploy

Install dependencies and create the OAuth state namespace:

```bash
npm ci
npx wrangler kv namespace create OAUTH_KV
```

Put the returned namespace ID in `wrangler.jsonc`. Set the public
`ALLOWED_GITHUB_LOGIN` variable to the GitHub account that may authorize the
connector.

Create a GitHub OAuth App with these values:

```text
Homepage URL: https://<worker-name>.<workers-subdomain>.workers.dev
Authorization callback URL: https://<worker-name>.<workers-subdomain>.workers.dev/callback
```

Load credentials without adding them to a file:

```bash
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
npx wrangler secret put COOKIE_ENCRYPTION_KEY
npx wrangler secret put KDRIVE_ACCESS_TOKEN
npx wrangler secret put KDRIVE_DRIVE_ID
npm run deploy
```

`COOKIE_ENCRYPTION_KEY` should be a new random value such as the output of
`openssl rand -hex 32`. The Infomaniak token should have only the `drive` scope.

## Verify

An unauthenticated MCP request should return `401` with a `WWW-Authenticate`
header pointing to protected-resource metadata:

```bash
curl -i -X POST "https://<worker-host>/mcp" \
  -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"check","version":"1.0.0"}}}'
```

OAuth metadata is published at:

```text
/.well-known/oauth-protected-resource/mcp
/.well-known/oauth-authorization-server
```

## Connect ChatGPT Work

1. Enable Developer mode in **Settings → Security and login**.
2. Open **ChatGPT Plugins**, select **+**, and enter a name, description, and
   `https://<worker-host>/mcp`.
3. Approve the connector's consent page and sign in with the allowlisted GitHub
   account.
4. Review the discovered tools before enabling the connection. After an update,
   scan or refresh the tools so ChatGPT receives the latest path-first schemas
   and server instructions.

Never put `.dev.vars`, API tokens, OAuth client secrets, or cookie encryption
keys in Git. The included `.gitignore` excludes local secret files.
