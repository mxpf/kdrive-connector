# kDrive Connector

A private MCP plugin that gives ChatGPT Work and Codex safety-first read/write access to Infomaniak kDrive.

The connector uses Infomaniak's documented OAuth 2 authorization-code flow and kDrive REST API. It does not send file contents to a second AI service. The host model decides which tool to call; this server performs exact API operations.

## Included tools

- Check the selected drive connection
- Browse folders and retrieve file metadata
- Search filenames and supported document content
- Read files as converted text or base64
- Create folders and upload new files without overwriting existing names
- Prepare and execute rename, move, overwrite, and trash operations
- Restore recoverable items from trash

Rename, move, overwrite, and trash require an exact, target-bound confirmation phrase returned by `kdrive_prepare_sensitive_change`. MCP destructive-action annotations provide an additional host approval boundary. Permanent deletion and empty-trash operations are deliberately not exposed.

## 1. Install dependencies and build

```bash
npm install
npm run build
npm test
```

Node.js 20 or newer is required.

## 2. Register an Infomaniak OAuth application

Create an OAuth application in Infomaniak Manager and register this redirect URI exactly:

```text
http://127.0.0.1:53682/callback
```

Infomaniak documents the authorization endpoint as `https://login.infomaniak.com/authorize`, the token endpoint as `https://login.infomaniak.com/token`, and the kDrive product scope as `drive`.

## 3. Authenticate

Set the application credentials only for the setup command:

```bash
export INFOMANIAK_CLIENT_ID="..."
export INFOMANIAK_CLIENT_SECRET="..."
export INFOMANIAK_DRIVE_ID="..."
npm run auth
```

The browser opens Infomaniak's consent screen. Tokens are saved in a user-only file outside this repository. On macOS, the client secret is stored in Keychain for refreshes. It is never written to this project.

As an alternative for a personal proof of concept, set `INFOMANIAK_ACCESS_TOKEN` to a manually generated, appropriately scoped Infomaniak API token and skip `npm run auth`.

The numeric drive ID appears after `/drive/` in the kDrive browser URL.

## 4. Run locally

```bash
export INFOMANIAK_DRIVE_ID="..."
npm start
```

The plugin manifest points to `dist/server.js` through `.mcp.json`. Build before installing or opening it in ChatGPT/Codex.

## Safety behavior

- Read/search tools run without confirmation.
- New folders and new-file uploads are non-destructive writes and never overwrite on name conflict.
- Rename, move, overwrite, and trash require a separate preparation step plus the exact user-approved phrase.
- Overwrite additionally requires the reviewed ETag, preventing a stale write over a newer version.
- Trash is recoverable; permanent-delete API operations are not available.
- Reads default to 2 MiB and uploads to 10 MiB. Override with `KDRIVE_MAX_READ_BYTES` and `KDRIVE_MAX_UPLOAD_BYTES`.

## Development checks

```bash
npm run check
npm test
npm run build
```

The automated tests use local mock HTTP responses. Live kDrive calls require your OAuth credentials and are intentionally not run during the normal test suite.
