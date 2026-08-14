# kDrive Connector

A private MCP plugin that gives ChatGPT Work and Codex safety-first read/write access to Infomaniak kDrive.

The connector uses Infomaniak's documented API-token or OAuth 2 authentication
and the kDrive REST API. It does not send file contents to a second AI service.
The host model decides which tool to call; this server performs exact API
operations.

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

## 2. Configure the drive

Copy the example configuration and set the numeric drive ID shown in the kDrive
browser URL:

```bash
cp .env.example .env
```

The local `.env` is ignored by Git and is loaded automatically by the MCP
server.

## 3. Authenticate with an API token

Create a token in Infomaniak Manager with only the `drive` scope. Copy it, then
pipe it into the setup command so it is never present in shell history:

```bash
pbpaste | npm run token:save
```

On macOS, the token is stored in Keychain. On other platforms, it is stored in
the same user-only configuration directory as OAuth tokens. It is never written
to this project.

## Optional: OAuth application flow

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

## 4. Run locally

```bash
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

The automated tests use local mock HTTP responses. Live kDrive calls require
your Infomaniak credentials and are intentionally not run during the normal
test suite.
