# kDrive Connector

<p align="center">
  <img src="assets/kdrive-connector-logo.png" width="240" alt="kDrive Connector logo">
</p>

A path-first Model Context Protocol connector that gives ChatGPT Work, Codex,
and other MCP clients natural, controlled read/write access to Infomaniak kDrive.

The connector uses Infomaniak's documented API-token or OAuth 2 authentication
and the kDrive REST API. It does not send file contents to a second AI service.
The host model decides which tool to call; this server performs exact API
operations.

## Included tools

- Check the selected drive connection
- Browse folders and retrieve file details by natural path
- Search filenames and supported document content
- Read files as converted text or base64
- Create folders and upload new files without overwriting existing names
- Rename, move, overwrite, and trash items through the host's normal approval flow
- Restore recoverable items from trash

The connector accepts paths such as `/Private/Projects/brief.docx`, keeps IDs and ETags behind the scenes, and uses MCP write/destructive annotations so the host can provide its normal approval boundary. Permanent deletion and empty-trash operations are deliberately not exposed.

## Architecture

The repository contains two runtimes built on the same kDrive client, tool
definitions, workflow instructions, and safety rules:

- The root package is a local stdio MCP server. It reads its Infomaniak token
  from macOS Keychain or a user-only token file.
- [`remote/`](remote/) is an OAuth 2.1-protected Streamable HTTP server on
  Cloudflare Workers. GitHub verifies the connecting user, an allowlist limits
  access to the owner, and the Infomaniak token stays in Cloudflare's encrypted
  secret store.

```text
ChatGPT Work ── MCP OAuth 2.1 ──> Cloudflare Worker ── server-side token ──> kDrive API
                                      │
                                      └── GitHub login + owner allowlist
```

No kDrive credential is sent to ChatGPT or committed to Git. The host model
decides which tool to call; the server performs exact API operations.

## Local runtime

### 1. Install dependencies and build

```bash
npm install
npm run build
npm test
```

Node.js 20 or newer is required.

### 2. Configure the drive

Copy the example configuration and set the numeric drive ID shown in the kDrive
browser URL:

```bash
cp .env.example .env
```

The local `.env` is ignored by Git and is loaded automatically by the MCP
server.

### 3. Authenticate with an API token

Create a token in Infomaniak Manager with only the `drive` scope. Copy it, then
pipe it into the setup command so it is never present in shell history:

```bash
pbpaste | npm run token:save
```

On macOS, the token is stored in Keychain. On other platforms, it is stored in
the same user-only configuration directory as OAuth tokens. It is never written
to this project.

### Optional: Infomaniak OAuth application flow

OAuth is available for Infomaniak applications that have been authorised to
request the required kDrive product scope. Register this redirect URI exactly:

```text
http://127.0.0.1:53682/callback
```

Infomaniak documents the authorization endpoint as `https://login.infomaniak.com/authorize`, the token endpoint as `https://login.infomaniak.com/token`, and the kDrive product scope as `drive`.

Set the application credentials in the ignored `.env`, then authenticate:

```bash
npm run auth
```

The browser opens Infomaniak's consent screen. Tokens are saved in a user-only file outside this repository. On macOS, the client secret is stored in Keychain for refreshes. It is never written to this project.

The numeric drive ID appears after `/drive/` in the kDrive browser URL.

### 4. Run locally

```bash
npm start
```

The plugin manifest points to `dist/server.js` through `.mcp.json`. Build before installing or opening it in ChatGPT/Codex.

## Remote runtime for ChatGPT Work

The remote server exposes Streamable HTTP at `/mcp` and implements OAuth
discovery, dynamic client registration, PKCE, bearer-token validation, and
GitHub identity verification. See [`remote/README.md`](remote/README.md) for the
deployment and ChatGPT connection guide.

## Safety behavior

- Read/search tools run directly.
- New folders and new-file uploads are non-destructive writes and never overwrite on name conflict.
- Writes use MCP annotations so ChatGPT or another host can show its native approval UI when appropriate.
- Rename and move resolve exact paths and fail safely on name conflicts.
- Overwrite fetches and enforces the current ETag immediately before upload, preventing a concurrent stale write.
- Trash is recoverable; permanent-delete API operations are not available.
- Reads default to 2 MiB and uploads to 10 MiB. Override with `KDRIVE_MAX_READ_BYTES` and `KDRIVE_MAX_UPLOAD_BYTES`.

The included `manage-kdrive-files` skill teaches compatible hosts to prefer paths, keep connector internals out of normal conversation, and report concise outcomes. If a user asks only to preview a change, the skill prevents the write tool from running.

## Development checks

```bash
npm run check
npm test
npm run build
cd remote && npm ci && npm run type-check
```

The automated tests use local mock HTTP responses. Live kDrive calls require
your Infomaniak credentials and are intentionally not run during the normal
test suite.
