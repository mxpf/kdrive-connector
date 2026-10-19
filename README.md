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

## Advantages and current limitations

**Evidence updated: 2026-10-12.** The connector is useful for everyday kDrive work,
but it is not yet a universally reliable large-file bridge between AI tools.
These are recorded observations, not guarantees for every host or account.

| Area | Advantage | Boundary |
| --- | --- | --- |
| Everyday file management | Natural paths, search, metadata, folder creation, and text uploads | Search/text previews depend on provider support; listings may be paginated |
| Change safety | Prepared, version-bound sensitive changes; new-file uploads reject conflicts | Host approval and authentication still matter; permanent deletion is not exposed |
| Presentation | Compact expandable rows and private Open in kDrive links | `openUrl` is a human-facing page, not a raw-file download |
| Binary uploads | Native host file adapter, bounded streaming, checksums, no base64 in model context | Host must resolve the file; exact source-host allowlist can reject newly selected regions |
| Binary exports | Short-lived raw-byte references, pinned version, size and SHA-256 | Downstream tools must support that reference or an explicit import bridge |
| Direct PDF reading | Page-numbered PDF text returned to ChatGPT without Adobe or re-upload | Text and stored forms; 5 MiB, 200 pages; explicit one-page OCR supports rotation/regions and checkbox transcription on Workers Free |
| Local large-file transfers | Direct kDrive upload/download with independent SHA-256 verification, bypassing the Worker | Local credentials and files required; 1 GiB ceiling, with one live 269 MB round trip verified |

Live checks passed for synthetic PNG, SVG, PDF, ZIP-format, and Markdown files,
including independent download/hash comparisons. A 99 MiB upload also completed
and a separate kDrive export re-read matched its source size and digest. However,
repeated 99 MiB download-backs through the Worker were truncated; a correlated
Cloudflare trace reported `exceededCpu`. A retry of an existing upload destination
failed safely without overwriting or creating a renamed duplicate.

The current deployment uses **Cloudflare Workers Free**. The ordinary HTTP Worker's 10 ms CPU allowance
is distinct from the connector's 120-second wall-clock transfer timeout. The
configured 100 MiB binary ceiling is a safety limit, **not a promise of reliable
100 MiB transfers**. There is no measured universal safe file-size cutoff.
Cloudflare rejected an attempted configurable CPU budget because it requires
Workers Paid; no account upgrade was performed. See the official
[CPU limits](https://developers.cloudflare.com/workers/platform/limits/#cpu-time).

The new direct PDF reader runs inside the existing SQLite MCP Durable Object,
which has a separate documented default CPU allowance. It does not run on the
public binary-download route. See [direct PDF extraction](docs/pdf-extraction.md)
for Free-plan limits, local evidence and the remaining deployment checks.

For large files available to local Codex, use the
[direct-transfer CLI](#local-codex-transfer-direct-large-file-path). It keeps
Cloudflare Free and sends file bytes directly between this computer and kDrive.
The recorded October 11 test verified a 269,000,000-byte upload and download,
including SHA-256 and byte-for-byte comparison. The 1 GiB local ceiling has not
been live-tested. This result does not change the remote Worker's limitations.

ChatGPT Library folder names and shared conversation links are not automatically
downloadable file references. Files must be made available through a supported
host selection/attachment mechanism. Tool discovery, conversation restrictions,
reconnect prompts, and materialization approvals also depend on the host; the
connector cannot guarantee or repair those behaviors by itself.

For now, use the connector for everyday operations and verified binary workflows;
do not rely on it as the sole large-file backup path. Keep originals until the
destination bytes have been independently verified.

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

File-management tools accept paths such as `/Private/Projects/brief.docx`, rather than requiring users to look up kDrive IDs or ETags. Binary native-file inputs separately use the host's file-reference contract. Sensitive changes use short-lived, one-use signed operation tokens bound to the resolved target, requested action, current file version, and exact replacement content when applicable. The token exchange stays internal while the host presents one ordinary approval. Permanent deletion and empty-trash operations are deliberately not exposed.

## Result contract and duplicate audits

`structuredContent` is the canonical machine-readable result. Text content is a
short outcome with at most one open link; it does not repeat file contents,
complete directory JSON, or a link appendix. Directory/search items, previews,
pagination, and open URLs remain in structured data and the result UI. The panel
shows five compact rows initially and a shared folder once. Expand a filename
for its full path and preview, or choose Show more for remaining returned items.
Long expanded lists scroll within the panel. No results are filtered by filename.
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

The root package also includes a local `kdrive-transfer` CLI using the shared
kDrive client. It transfers bytes directly with local authentication and does
not add a remote MCP tool or require a Worker deployment.

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

Use Node.js 24 or newer. The checked-in `.nvmrc` and CI use Node 24; CI checks
both Linux and macOS.

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

For reading or summarizing a PDF, the new **`kdrive_read_pdf`** action returns
page-numbered text directly. It bypasses the Adobe attachment handoff. Start with
`path`, follow `nextPage`, and carry the first result's `sha256` as
`expectedSha256` on later calls. Password-protected PDFs accept an optional
user-authorized password. Stored form values now include consistency checks.
Optional `ocr=true` renders one page for Cloudflare Workers AI. It was enabled
with the authorized October 13 deployment on Workers Free. Qwen vision transcription addresses the
previous checkbox failure; explicit rotation correction, pure-white margin
removal and region selection remain supported. Parsed checkbox states include
source/review warnings because PDF.js can normalize them from appearance state. XFA, form appearances and visual table structure
are not guaranteed. See
[limits and verification](docs/pdf-extraction.md).

October 19 release status: deployed on Workers Free; both binary upload routes
passed live readback. ChatGPT OCR acceptance still requires sign-in/tool refresh.
See the [combined release record](docs/evidence/combined-release-2026-10-19.md).

The October 19 release lets remote OCR continue as a bounded
background job. If a read returns `status: "pending"`, use
`kdrive_get_pdf_ocr_result(jobId)` in the same connector session; do not repeat
the read. Polling reuses the original download and inference. The job has a
three-minute deadline; completed results stay only in session memory for up to
three minutes. See [timeout investigation and checks](docs/evidence/ocr-timeout-2026-10-14.md).

For binary files, use **native file reference first, signed HTTPS fallback, inline base64 only for small files**. The model exchanges references and metadata, not file bytes.

| Direction | Action | Transport |
| --- | --- | --- |
| kDrive → another tool | `kdrive_export_file(path)` | Pinned-version raw HTTPS download plus MCP `resource_link` |
| ChatGPT attachment/generated file → kDrive | `kdrive_upload_file_ref(path, file_ref)` | Host-supplied `{file_id, download_url, mime_type?, file_name?}` |
| HTTPS asset → kDrive | `kdrive_upload_from_url(path, source_url, expected_size?, expected_sha256?)` | Server-side chunked transfer |

Export returns `file_name`, `mime_type`, `size_bytes`, `sha256`, `resolved_version`, `expires_at`, and `download_url`. Unlike `openUrl`, the five-minute download URL serves actual bytes without a browser login. It is a private bearer capability: give it only to the intended downstream tool. The connector does not mint an OpenAI file ID; hosts may materialize the MCP resource link, otherwise pass the HTTPS URL to a URL-capable consumer. A tool that accepts only its own proprietary asset IDs still needs that tool's ingestion step.

Native inputs use OpenAI's documented `_meta["openai/fileParams"]` contract. A bare `file_id`, `/mnt/data/...`, or `sandbox:/...` string is **not** a remote file reference. The host must supply its temporary `download_url`. Reference upload never looks up another file by name. Existing destinations fail safely; these tools do not overwrite or automatically rename.

**ChatGPT → Adobe remains blocked in hosts without a file-import adapter.** The
current public contracts do not establish automatic conversion of our export
into a native conversation attachment. The connector now instructs the model to
check for an adapter and stop incompatible retries. This guidance does not add
the missing import capability. See the [October 13 contract investigation and
completion requirements](docs/adobe-chatgpt-file-bridge-report.md#2026-10-13-contract-investigation).

Follow the host's file-selection instructions: Codex may accept a local path as its adapter input, while the raw MCP server requires the resolved object. Do not manually convert between those representations. The deployed upload correction supplies `binary_error_code` and `trace_id`; the client may normalize its generic `error_code`. Unknown source hosts remain blocked and require exact-host review, not alternate URL spellings or public rehosting. See [current limitations](#advantages-and-current-limitations).

The deployed October 19 binary policy correction adds the observed
OpenAI `westus2` and `cacentral` hosts plus Archive.org and three reviewed download
servers. Other Archive mirrors still require review. Connection diagnostics now
expose the effective exact-host list and `binary_error_code` as the authoritative
classification. See [verification and release status](docs/evidence/binary-source-policy-2026-10-19.md).

Uploads use an Infomaniak upload session, bounded 4 MiB buffers, incremental SHA-256, and per-chunk provider checksums. Size and optional expected SHA-256 are checked **before finalization**. No full-file buffering, base64 transport, new storage service, or source-URL persistence is involved. Supply `expected_size` if the source lacks Content-Length. Empty files can still use the inline action.

**Earlier successful examples (2026-10-01):** A 27 MB PDF exported and streamed to a verified local file with matching size/SHA-256, and a downstream PDF tool opened and rendered it. Acrobat accepted the host-file handoff but failed processing that document. Both Codex-generated and ChatGPT-generated PNG uploads had independently verified kDrive download hashes. These examples do not establish universal cross-plugin or large-file reliability; see the [current limitations](#advantages-and-current-limitations) and [historical acceptance evidence](docs/binary-interop-acceptance.md).

For files larger than the inline read limit, use **`kdrive_export_file`**, not `kdrive_read_file(mode="base64")`. Its `download_url` serves bytes; `openUrl` opens a human-facing page. If a downstream tool needs a local/native file rather than an HTTPS URL, the Node host bridge in [`src/binary-materialize.ts`](src/binary-materialize.ts) streams and verifies the export before returning `local_path`. The CLI (`npm run build`, then `node dist/download-cli.js`) accepts the reference JSON on **stdin** and outputs bounded metadata plus the verified local path. Never paste signed URLs into shell arguments or logs. Pass that path only to a downstream host adapter that explicitly accepts local files. ChatGPT runtimes without such a bridge cannot be made compatible by inventing a `file_id`.

See [binary transport implementation and acceptance plan](docs/binary-transport.md) for security boundaries, configuration, limits, and automated versus live acceptance coverage.

**0.3.1 PDF interoperability (2026-10-13):** independent Node, curl, and Python
downloads verified an existing synthetic PDF's complete bytes and SHA-256. New
ordinary and encrypted PDF fixtures cover HTTP delivery and text extraction;
Adobe extraction succeeded through this host's local-file adapter, including a
synthetic copy unlocked with its known password. Source fixes provide an explicit
`TEXT_PREVIEW_UNAVAILABLE` recovery action, identified download clients, clearer
HTTP 403 diagnostics, and Worker streams with a preserved byte-length header.
These fixes shipped with the October 13 deployment. ChatGPT runtimes without a native file-import bridge still
have the Adobe storage-type limitation. See the [investigation and test evidence](docs/binary-interop-0.3.1.md)
for the exact coverage and the remaining acceptance boundary.

Repeated exports of an unchanged binary can reuse a verified digest for up to ten
minutes, avoiding a redundant full-file hash download. The remote cache is isolated
by authenticated owner and drive and survives MCP session changes and Worker
restarts; local stdio uses a per-registration in-memory cache. Each export still
checks current access and version; each download still verifies the version,
length, and SHA-256. First-time exports are unchanged.

### Local Codex transfer: direct large-file path

**Signed-reference helper:** the Node materialization helper downloads a signed export
through the remote Worker, writes to a private temporary file, and checks size
and SHA-256 before returning its local path. Codex can pass that path to a tool
whose native adapter explicitly accepts local files. This avoids binary data in
model context, but **still depends on the Worker's download CPU budget**.

**Direct path:** `kdrive-transfer` uses the shared kDrive client and existing local
credentials to bypass the Worker entirely. It supports uploads, downloads, and
independent verification, with a separate **1 GiB local ceiling** and **30-minute
deadline**. These are safety bounds, not a guarantee of throughput. Cloudflare
Free, remote tool schemas, and remote transfer limits remain unchanged.

Build once with `npm run build`, then use:

```bash
npm run transfer -- upload --source "/absolute/local/archive.zip" --path "/Private/00 Inbox/archive.zip"
npm run transfer -- download --path "/Private/00 Inbox/archive.zip"
npm run transfer -- verify --path "/Private/00 Inbox/archive.zip" --size 269000000 --sha256 "<source-sha256>"
```

The destination parent must already exist. Uploads stream a private local snapshot
into conflict-safe kDrive sessions, then independently download the committed
file ID, checking its version, full byte length, and SHA-256 against that snapshot.
Existing destinations are never overwritten or automatically renamed. There are
no automatic upload retries. `UPLOADED_NOT_VERIFIED` returns a receipt for an existing
upload that needs verification; `UPLOAD_COMMIT_UNKNOWN` means inspect the
destination before attempting anything else. Never delete the source on either
outcome. Replacements are deliberately not supported by this command.

Downloads stream into a private temporary directory and return `local_path`,
filename, MIME type, size, SHA-256, and version. Supply `--sha256` and optionally
`--size` to compare with a trusted source manifest. Without an expected checksum,
the download computes a checksum and checks size/version, but cannot establish
identity against an independent source digest. Partial downloads and upload
snapshots are removed on handled failure/cancellation; successful downloads are
kept for downstream tools and explicit cleanup. Forced process termination or
power loss can leave private temporary directories behind.

Use `npm run transfer -- doctor` for offline readiness checks. Transfers offer
throttled progress, private saved upload receipts, and verification from a receipt.
`batch --manifest /absolute/manifest.json` previews an explicit checksummed file
list; add `--execute` to transfer it sequentially. Safe reads retry briefly, while
writes and uncertain uploads never automatically replay.

See [local transfer setup, safety, and verification](docs/local-transfer.md).
The [dated acceptance record](docs/binary-interop-acceptance.md#local-direct-transfer--2026-10-11)
summarizes the successful 269 MB live round trip and its limits.

```text
kDrive API <-> local authenticated transfer + checksum verification
                          <-> local file <-> supported Codex tool adapter
```

This removes Cloudflare from the binary data path, not security checks. It
requires your computer and local runtime to be available, existing or explicitly
authorized local kDrive credentials, and disk space for a full source snapshot or
download. Remote Worker secrets must not be exported to the model.
Passing a file to another tool may upload it to that tool's service; local
materialization does not mean all downstream processing stays on the computer.
It does not grant access to unselected ChatGPT Library files or make a local
path usable by a remote ChatGPT-only runtime.

## Development checks

```bash
npm run check
npm test
npm run build
npm --prefix remote ci
npm --prefix remote run type-check
npm --prefix remote test
```

The automated tests use local mock HTTP responses. Live kDrive calls require
your Infomaniak credentials and are intentionally not run during the normal
test suite.

On October 11, the recovered implementation passed 141 root tests, 21 Worker
tests, both type checks, and the root build on Yantra. These local checks did not
repeat the earlier live transfer or establish local authentication on Yantra.

The October 12 reliability and compact-results update passed 157 root tests, 21
Worker tests, both type checks, and the root build locally. It adds a Node 24
Linux/macOS CI matrix. The offline readiness check reports missing local
credentials on Yantra; no new live upload or deployment was performed.
