# Local direct transfers

The local `kdrive-transfer` command bypasses Cloudflare for file bytes. It is a
Node CLI for local Codex execution, not a new remote MCP tool or public service.
The Worker stays on Free with its current remote limits. No new upload host,
public bucket, billing subscription, or authorization grant is introduced.

## Setup

1. Use this checkout and run `npm run build` after source updates.
2. Configure `INFOMANIAK_DRIVE_ID` in the existing local `.env`.
3. Reuse the connector's local API token in macOS Keychain, or its existing local
   OAuth token store. `INFOMANIAK_ACCESS_TOKEN` is also supported by the existing
   configuration, but never put credentials in command arguments or chat.
4. If local credentials do not exist, obtain user approval for local credential
   setup using the existing `npm run token:save` or `npm run auth` workflow.
   Remote ChatGPT authentication does not provision local credentials; do not
   extract Worker secrets to work around this boundary.

`npm run transfer -- --help` lists the supported commands. The installed binary
entrypoint is `kdrive-transfer`; the npm command optionally loads the local `.env`.
Use Node 20.19+ (or a current supported Node LTS) for the optional env-file flag.
The installed `kdrive-transfer` entrypoint does not load `.env` itself; supply
configuration through its environment or use the npm command from this checkout.

When moving to another computer, configure that computer separately. A copied
checkout or authenticated remote ChatGPT connection does not provision local
credentials. Check local configuration before attempting a transfer; do not
copy Worker secrets as a substitute for local setup.

## Upload and verify

```bash
npm run transfer -- upload --source "/absolute/path/file.zip" --path "/Private/00 Inbox/file.zip"
```

Optional `--size BYTES --sha256 HEX` validates the source against a manifest
before starting an upload. The source must be a nonempty regular file, at most
1 GiB. Final-component symlinks are rejected. An open file descriptor and
before/after metadata checks detect source edits during the snapshot; a private
snapshot insulates the upload from later source edits. A manifest checksum is
recommended when identifying an exact externally supplied artifact.

The destination parent folder must already exist; the CLI does not create it.

The provider enforces `conflict:error` at session creation. Chunk hashes and a
whole-file hash are checked before finalization. Successful finalization is not
enough: the CLI resolves the destination, requires the returned file ID to match
the committed upload, and directly downloads its pinned version to compare the
entire byte stream with the snapshot. Success returns `uploaded:true` and
`verified:true`, path, file ID, filename, MIME type, size, SHA-256, and version.

An upload that committed but failed readback returns `UPLOADED_NOT_VERIFIED`,
with `uploaded:true`, `verified:false`, file ID, size, checksum, and a sanitized
verification error. The file remains on kDrive. Retry only verification:

```bash
npm run transfer -- verify --path "/Private/00 Inbox/file.zip" --size 12345 --sha256 "<source-sha256>"
```

An ambiguous provider finalization returns `UPLOAD_COMMIT_UNKNOWN`; inspect the
destination before retrying. The CLI never silently retries uploads, creates a
renamed duplicate, replaces existing content, deletes source files, or deletes a
committed destination after a failed check. Keep originals until verification.

## Download

```bash
npm run transfer -- download --path "/Private/00 Inbox/file.zip" --sha256 "<known-sha256>"
```

This produces a mode-0600 file inside a private mode-0700 temporary directory.
Only a completed size/version-checked file is returned as `local_path`. The hash
is computed incrementally. `checksum_matched:true` means a supplied expected
hash matched; otherwise the hash is newly computed, not independently attested.
The shared client checks the version before and after reading; version drift
fails closed rather than silently substituting content. A missing historical
version is not reconstructed.

The returned path is usable only by tools that can access this local machine or
have a supported local-file adapter. This does not make arbitrary ChatGPT Library
IDs downloadable or fix downstream tools' incompatible file-reference formats.

## Limits and security

- Local cap: 1 GiB; operation deadline: 30 minutes; uploads use existing 4 MiB
  chunks with bounded memory. Upload snapshots require disk space of roughly the
  file size; independent verification hashes the download without retaining it.
  The transfer deadline starts after initial credential loading. Authentication
  and provider-session cleanup are not included in that 30-minute budget.
- Only the standard Infomaniak API/token origins are accepted by this CLI.
  Existing provider upload-host and download redirect/DNS controls are reused;
  API credentials are not forwarded to signed-download CDN URLs.
- Credentials retain their existing permissions; this adds no grant. Operation
  scope is one explicit source/destination, not recursive synchronization.
- Errors are sanitized. No file contents, signed URLs, or authorization headers
  are emitted. Metadata includes user-requested paths and filenames.
- SIGINT/SIGTERM cancel streaming; handled failures remove owned temporary
  snapshots/partials. Abrupt kill or power loss can leave temporary files.
  Successful downloads remain until deliberately cleaned up by their owner.
- No persistent resumable job store yet. Interrupted uncommitted uploads must
  restart; ambiguous or committed uploads require inspection/verification first.

## Tests

`node --import tsx --test test/local-transfer.test.ts` exercises a 269,000,000-byte
stream, independent checksums, private file permissions, Unicode names, source
snapshot isolation, corrupt/truncated/version-changed downloads, oversized input,
symlink rejection, aborts, conflicts, and committed-but-unverified receipts.
Provider upload security and chunk validation are also covered by the existing
binary transport suite. Mock tests alone are not proof of live transfers; record
live byte length, checksum, pinned version, and verification outcome separately.

### Live verification — 2026-10-11 (America/New_York)

A synthetic **269,000,000-byte** binary was uploaded using the local CLI and
existing macOS Keychain authentication. The command independently streamed all
bytes back from kDrive and returned `uploaded:true, verified:true`.
This live test ran on the source machine before the Yantra continuation; it was
not repeated during migration or the documentation update.

- File: `direct-269MB.bin`, MIME `application/octet-stream`.
- kDrive file ID: `527673`; verified version: `37f1de910489eb8a`.
- SHA-256: `5eaa8f837744810f30325250e0b5257b9ed16cb45c9ccdfa05a727886d88b3da`.
- Isolated destination: `/Private/00 Inbox/Connector Local Transfer QA 2026-10-12T00-45-00-904Z/`.
- Source snapshot and full direct-provider readback matched exactly. No Worker
  export, base64 payload, new permission, or Cloudflare plan change was involved.
- A separate CLI download produced a private local file with the same full size
  and SHA-256 (`checksum_matched:true`). Independent `shasum -a 256` and `cmp`
  checks confirmed the local original and download were byte-for-byte identical.
  Both temporary local test copies were then removed; the cloud fixture remains.
- A repeat upload returned `DESTINATION_CONFLICT`. A subsequent listing contained
  exactly one file with the same ID, byte length, and version; no duplicate or
  overwrite occurred.
- Local tests: 141 passed, including 12 local-transfer tests. Worker tests: 21
  passed. Type checks and local build passed.

This establishes one live 269 MB round trip, not a guarantee for all files up to
the configured 1 GiB ceiling or all network conditions. Existing user files were
not replaced or removed. The synthetic cloud test file is retained for audit.

### Yantra readiness — 2026-10-11

The recovered implementation passed the same 141 root tests, 21 Worker tests,
both type checks, and root build locally on Yantra. The runtime, dependencies,
built CLI, and `.env` were present, but the expected Keychain API-token entry and
default OAuth token file were absent. Alternate credential configuration and
live authentication were not checked. Local credential setup or verification
remains a prerequisite for live transfers on that computer.
