# kDrive Connector

<p align="center">
  <img src="assets/kdrive-connector-logo.png?v=3" width="240" alt="kDrive Connector logo">
</p>

A path-first [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) connector
that gives ChatGPT Work, [Codex](https://openai.com/codex/), and other MCP clients
natural, controlled read/write access to [Infomaniak kDrive](https://www.infomaniak.com/en/ksuite/kdrive).

The connector uses Infomaniak's documented
[API-token or OAuth 2 authentication](https://developer.infomaniak.com/getting-started)
and [REST API](https://developer.infomaniak.com/docs/api). It does not send file
contents to a second AI service. The host model decides which tool to call; this
server performs exact API operations.

## Why this exists

This project grew out of my interest in diversifying my personal technology
stack away from an exclusively US-based ecosystem, and especially from making
Google Drive the default home for every document. Infomaniak is a Swiss
provider, and kDrive gives me a credible European-hosted file workspace; the
missing piece was a first-class AI workflow comparable to the integrations
available for the largest US platforms.

The goal is not to argue that every US service is undesirable. It is to reduce
vendor and jurisdiction concentration, preserve meaningful provider choice,
and demonstrate that open protocols can give independent storage platforms an
equally natural agent experience. MCP is central to that approach: the file
provider, AI host, authentication layer, and workflow instructions remain
separable instead of becoming one closed stack.

Using this connector does not by itself create data sovereignty. A file's
contents are shared with the AI host when the user explicitly asks the host to
read or process that file. The connector does, however, avoid routing those
contents through an additional AI service, keeps the kDrive credential out of
the model, and limits every operation to the tools and permissions described
below.

## Included tools

- Check the selected drive connection
- Browse folders and retrieve file details by natural path
- Search filenames and supported document content with short previews and an inline result card containing private Open in kDrive buttons
- Read files as converted text or base64
- Compute SHA-256 digests of original file bytes by path for duplicate audits
- Create folders and upload new files without overwriting existing names
- Rename, move, overwrite, and trash items through one normal host approval
- Restore recoverable items from trash

The connector accepts paths such as `/Private/Projects/brief.docx`; its public tool schemas contain no file IDs, folder IDs, or ETags. Sensitive changes use short-lived, one-use signed operation tokens bound to the resolved target, requested action, current file version, and exact replacement content when applicable. The token exchange stays internal while the host presents one ordinary approval. Permanent deletion and empty-trash operations are deliberately not exposed.

## Result contract and duplicate audits

`structuredContent` is the canonical machine-readable result. Text content is a
short outcome with at most one open link; it does not repeat file contents,
complete directory JSON, or a link appendix. Directory/search items, previews,
pagination, and open URLs remain in structured data and the existing result UI.
Callers needing links for every item can render those URLs when requested.
Base64 reads retain their explicit attachment resource link. Text-only clients
must consume structured results to obtain complete data.

Use `kdrive_digest_file({ path })` for each candidate file and compare both
`digest` and `byteLength`. The result declares `algorithm: "sha256"` and
`digestEncoding: "base64url"`. It hashes original bytes, never converted text or
an ETag. It requires an unchanged file identity and ETag across the read, refuses
folders or missing versions, and uses the existing bounded download limit.
The connector still downloads bytes from kDrive internally; it does not transfer
those bytes to the model. Results describe the versions read, not an atomic
snapshot of multiple paths or a promise that those paths will never change.

Prepare and undo tokens remain in structured results because existing write
calls require them. They are omitted from human-readable text; hosts must keep
these machine protocol handles out of user-facing conversation. Credentials and
raw version bindings are not added to result fields. Removing handles from model
context entirely would require a separate host/server protocol migration.

## Architecture

The repository contains two runtimes built on the same kDrive client, tool
definitions, workflow instructions, and safety rules:

- The root package is a local stdio MCP server. It reads its Infomaniak token
  from macOS Keychain or a user-only token file.
- [`remote/`](remote/) is an OAuth 2.1-protected Streamable HTTP server on
  [Cloudflare Workers](https://developers.cloudflare.com/workers/). GitHub
  verifies the connecting user, an allowlist limits access to the owner, and the
  Infomaniak token stays in Cloudflare's encrypted secret store.

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

The repository includes `.mcp.json` for clients that launch the local stdio
server directly. Build before registering that local server. The optional
legacy workflow package uses a remote app mapping through `.app.json`; it does
not copy a local `.env` or token into the package. See the migration note below
before using that mapping.

## Remote runtime for ChatGPT Work

The remote server exposes Streamable HTTP at `/mcp` and implements OAuth
discovery, dynamic client registration, PKCE, bearer-token validation, and
GitHub identity verification. See [`remote/README.md`](remote/README.md) for the
deployment and ChatGPT connection guide.

## Current ChatGPT connection

Use **kDrive Connector**, the authenticated remote app with the black **k**
icon. This is the single connection to select with `@` in ChatGPT. It connects
directly to the existing Cloudflare Worker; a separate instruction plugin is
not required. The server already supplies the core path-based workflow and
prepare/write safety instructions.

On September 25, 2026, the replacement connection was authenticated and verified
with a read-only `kdrive_digest_file` call against
`/Private/03 Projects/Keepinghaus/Keepinghaus — Manifesto.md` (3,126 bytes at the
time of verification). The old app named **kDrive Connection** was then retired.
This was a ChatGPT app registration and branding change, not a new server or a
change to kDrive files, permissions, or credentials.

For a new setup, register your remote `/mcp` endpoint, choose the connector icon
when creating the app, and sign in with the allowlisted GitHub account. Refresh
the app's tools after server updates and verify them in a new conversation.
Use `kdrive_digest_file` for byte comparisons without returning file contents.
The current deployment is owner-only; this repository is not a universally
available hosted kDrive service.

### Optional legacy workflow package

The repository retains the earlier package sources for development:

- `.codex-plugin/plugin.json` contains package metadata and starter prompts.
- `.app.json` contains the earlier remote app mapping.
- `skills/manage-kdrive-files/` contains supplementary workflow guidance.
- `assets/` preserves the connector icon and logo artwork.

The separate local instruction package was removed from the owner's catalog to
avoid a second kDrive choice. Do not reinstall it for the current ChatGPT setup.
The checked-in `.app.json` still references the retired app; developers who
choose to use this optional package must replace that ID with their own active
remote app ID before installation. The supported local stdio server remains
available independently of this package.

## Safety behavior

- Read/search tools run directly.
- New folders and new-file uploads are non-destructive writes and never overwrite on name conflict.
- Writes use MCP annotations so ChatGPT or another host can show its native approval UI. The recommended app permission is **Allow read actions**, which asks once before each write.
- Rename and move resolve exact paths and fail safely on name conflicts.
- Rename, move, overwrite, and trash require a short-lived one-use operation token that binds the target and readable arguments. The model prepares and supplies it internally; the user never copies a phrase or token.
- Overwrite binds and enforces the current file version and an exact digest of the replacement bytes, preventing a stale or substituted write.
- Trash is recoverable through an opaque undo token; permanent-delete API operations are not available.
- Results contain private, expiring Open in kDrive redirect links instead of public share links. Search adds bounded text previews when conversion is supported and a concise type/size preview otherwise. ChatGPT-compatible hosts also receive a native MCP Apps result card with clickable Open in kDrive buttons; structured data, resource links, and Markdown remain available as fallbacks.
- Inline reads default to 2 MiB and inline uploads to 10 MiB. Override with `KDRIVE_MAX_READ_BYTES` and `KDRIVE_MAX_UPLOAD_BYTES`. Reference-based transfers have a separate 100 MiB default limit.

The included `manage-kdrive-files` skill teaches compatible hosts when to select kDrive, how to run the internal prepare/write protocol, how to present previews and readable links, and how to keep connector internals out of normal conversation. The legacy package needs an active app mapping before use, as described above. If a user asks only to preview a change, the skill prevents both prepare and write tools from running. These core workflow safeguards are also supplied by the server, so the current remote app does not depend on the separate skill package.

## Binary interoperability

For binary files, use **native file reference first, signed HTTPS fallback, inline base64 only for small files**. The model exchanges references and metadata, not file bytes.

| Direction | Action | Transport |
| --- | --- | --- |
| kDrive → another tool | `kdrive_export_file(path)` | Pinned-version raw HTTPS download plus MCP `resource_link` |
| ChatGPT attachment/generated file → kDrive | `kdrive_upload_file_ref(path, file_ref)` | Host-supplied `{file_id, download_url, mime_type?, file_name?}` |
| HTTPS asset → kDrive | `kdrive_upload_from_url(path, source_url, expected_size?, expected_sha256?)` | Server-side chunked transfer |

Export returns `file_name`, `mime_type`, `size_bytes`, `sha256`, `resolved_version`, `expires_at`, and `download_url`. Unlike `openUrl`, the five-minute download URL serves actual bytes without a browser login. It is a private bearer capability: give it only to the intended downstream tool. The connector does not mint an OpenAI file ID; hosts may materialize the MCP resource link, otherwise pass the HTTPS URL to a URL-capable consumer. A tool that accepts only its own proprietary asset IDs still needs that tool's ingestion step.

Native inputs use OpenAI's documented `_meta["openai/fileParams"]` contract. A bare `file_id`, `/mnt/data/...`, or `sandbox:/...` string is **not** a remote file reference. The host must supply its temporary `download_url`. Reference upload never looks up another file by name. Existing destinations fail safely; these tools do not overwrite or automatically rename.

Uploads use an Infomaniak upload session, bounded 4 MiB buffers, incremental SHA-256, and per-chunk provider checksums. Size and optional expected SHA-256 are checked **before finalization**. No full-file buffering, base64 transport, new storage service, or source-URL persistence is involved. Supply `expected_size` if the source lacks Content-Length. Empty files can still use the inline action.

**Live status (2026-10-01):** The 27 MB *Wisdom of Laotse* PDF exported and streamed to a verified local file with matching size/SHA-256, and a downstream PDF tool opened and rendered it. Acrobat accepted the host-file handoff but failed processing that document; universal cross-plugin compatibility is not claimed. Both Codex-generated and ChatGPT-generated PNG uploads now have independently verified kDrive download hashes. Unknown file-host regions still fail closed. See the [live acceptance evidence and working routes](docs/binary-interop-acceptance.md).

For files larger than the inline read limit, use **`kdrive_export_file`**, not `kdrive_read_file(mode="base64")`. Its `download_url` serves bytes; `openUrl` opens a human-facing page. If a downstream tool needs a local/native file rather than an HTTPS URL, the Node host bridge in [`src/binary-materialize.ts`](src/binary-materialize.ts) streams and verifies the export before returning `local_path`. The CLI (`npm run build`, then `node dist/download-cli.js`) accepts the reference JSON on **stdin** and outputs bounded metadata plus the verified local path. Never paste signed URLs into shell arguments or logs. Pass that path only to a downstream host adapter that explicitly accepts local files. ChatGPT runtimes without such a bridge cannot be made compatible by inventing a `file_id`.

See [binary transport implementation and acceptance plan](docs/binary-transport.md) for security boundaries, configuration, limits, and automated versus live acceptance coverage.

Repeated exports of an unchanged binary within the same warm authenticated session
reuse a verified digest for up to ten minutes, avoiding a redundant full-file hash
download. Each export still checks current access and version; each download still
verifies the version, length, and SHA-256. First-time exports are unchanged.

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
