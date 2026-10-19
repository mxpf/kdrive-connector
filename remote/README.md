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
- Public tools accept paths and filenames; file IDs, folder IDs, and ETags stay server-side.
- Tools use MCP read/write and destructive annotations for one native host approval per write.
- Rename, move, overwrite, and trash require short-lived, one-use signed operation tokens stored in a separate Durable Object scoped to the authenticated owner and drive.
- Open in kDrive results use expiring signed redirect links and an inline MCP Apps result card, so tool output does not expose internal IDs or create public shares.
- Permanent deletion is not exposed.

## Sessions and Free quota recovery

Capability revision `2026-10-19.4` uses JSON Streamable HTTP responses and
memory-only MCP sessions. Initialization, discovery, status and directory reads
perform no session SQL/KV writes. The transport no longer uses the Agents
WebSocket bridge, response replay or standalone SSE streams; authenticated
`GET /mcp`, including `Last-Event-ID` resumptions, returns 405. OAuth still runs
first and unauthenticated requests return 401 with a Bearer challenge.

Session IDs are signed, owner-bound and expire after 12 hours. Deployment,
eviction or explicit termination can end a session sooner. A stale session
returns 404: initialize once, then retry a read. Never automatically repeat a
file-changing operation after an ambiguous result. Old Agents session IDs also
return 404. OCR jobs remain in session memory with bounded `waitUntil` lifetime;
losing a session never restarts inference automatically.

A best-effort, per-Worker-isolate guard allows 30 new sessions per minute and
returns 429 with `Retry-After` above that limit. Existing sessions remain usable.
This is not an account-wide rate limit. Confirmation nonces and verified binary
digests retain their separate durable stores and existing safeguards.

Recognized Durable Objects Free row-read/write quota errors return
`CLOUDFLARE_QUOTA_EXCEEDED`, a trace ID, the next UTC-midnight reset time,
`retry_after_seconds` and `requires_reauthentication: false`. Tool calls return
an MCP error result; initialization returns HTTP 503 with `Retry-After`.
Reconnecting cannot replenish a daily quota. See the
[incident and release evidence](../docs/evidence/work-mode-quota-2026-10-19.md).

## JSON session cleanup and RPC lifetimes

Deployed capability `2026-10-19.4` uses byte values across the internal RPC
boundary, cleans completed JSON response entries, and returns an explicit 409
if a session closes during a pending request. File-changing calls are never
replayed. JSON request/response bodies are bounded at 16 MiB; the existing
10 MiB decoded inline upload limit is unchanged. Larger JSON requests should
use the binary-reference route. The pinned SDK cleanup workaround and the
production verification results are documented in the
[RPC investigation](../docs/evidence/rpc-disconnects-2026-10-19.md).

## Deploy

Use Node.js 24 or newer. Install dependencies in both the repository root and
`remote` (shared source resolves the PDF parser from the root). From `remote`,
install and create the OAuth state namespace:

```bash
(cd .. && npm ci)
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
npx wrangler secret put KDRIVE_OPERATION_SECRET
npm run deploy
```

`COOKIE_ENCRYPTION_KEY` and `KDRIVE_OPERATION_SECRET` should each be independent
random values such as the output of `openssl rand -hex 32`. The Infomaniak token
should have only the `drive` scope. Set `KDRIVE_CONNECTOR_BASE_URL` in
`wrangler.jsonc` to the Worker's public origin.

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
5. Set the plugin permission to **Allow read actions** so searches and reads are
   seamless while every write receives one ordinary approval.

Never put `.dev.vars`, API tokens, OAuth client secrets, or cookie encryption
keys in Git. The included `.gitignore` excludes local secret files.

## Binary handoff

October 19 release status: deployed on Workers Free; both binary upload routes
passed live readback. ChatGPT OCR acceptance still requires sign-in/tool refresh.
See the [combined release record](../docs/evidence/combined-release-2026-10-19.md).

Source revision `2026-10-13.7` also adds `kdrive_read_pdf` for direct text reading
inside the existing SQLite MCP Durable Object, bypassing Adobe and native file
import. It supports 5 MiB PDFs, up to 200 pages, in batches of five pages. It also
extracts stored AcroForm values with consistency warnings. Optional one-page
Workers AI OCR uses Qwen 3.8 27B for checkbox-aware transcription and was enabled
in the authorized October 13 deployment. Parsed checkbox states carry explicit
source/review warnings. Rotation and region selection preserve scope in results.
The deployed configuration has an `AI` binding and `KDRIVE_PDF_OCR_ENABLED="true"`; each call still defaults to `ocr=false`. Workers Free is unchanged. Unit tests disable remote bindings and OCR, and require no Cloudflare credentials. See [design and test evidence](../docs/pdf-extraction.md).

Deployed capability revision `2026-10-19.2` adds bounded OCR jobs. Slow reads return a job ID; `kdrive_get_pdf_ocr_result` polls the same
job in the authenticated MCP session. `DurableObjectState.waitUntil` keeps the
work alive after the initial reply, up to the connector's three-minute deadline.
Results expire from memory three minutes after completion; no storage migration,
new binding or plan change is required. Refresh the ChatGPT tool catalog after
deployment so the polling tool is available. Check
`pdf_ocr_jobs=true` and `limits.pdf_ocr_job` in connection diagnostics.

The remote server includes `kdrive_export_file`, `kdrive_upload_file_ref`, and
`kdrive_upload_from_url`. The `/binary/:token` endpoint serves raw, version-pinned
bytes via a five-minute signed bearer link; `/open/:token` remains a human-facing
kDrive navigation link. No new storage binding is required.

`KDRIVE_MAX_BINARY_BYTES` defaults to 104857600 (100 MiB). This does not raise the
inline/base64 limits. `KDRIVE_BINARY_SOURCE_HOSTS` lists exact trusted source and
redirect hostnames. Unlisted hosts fail closed, including new host-issued file
download domains until explicitly reviewed. Never add arbitrary domains or
wildcards to make a failed fetch succeed.

After deploying, refresh the tool catalog to expose the native file-ref schema.
See [implementation notes and live acceptance gates](../docs/binary-transport.md).

### Current Free-plan limitation (verified 2026-10-09)

The deployed account is on Workers Free. A near-limit 99 MiB upload and separate
server-side digest verification succeeded, but full download-back requests were
terminated with `exceededCpu`. Small-file checks passed; no universal reliable
file-size cutoff has been established. The 100 MiB configuration is a maximum
accepted size, not an end-to-end reliability guarantee.

Workers Free allows 10 ms CPU per request. Network waiting and the connector's
120-second transfer deadline are separate from that allowance. Cloudflare
rejected a proposed `limits.cpu_ms: 5000` deployment with code `100328` because
configurable CPU limits require Workers Paid. The setting was removed; the
running deployment and account plan were unchanged. See [Cloudflare CPU
limits](https://developers.cloudflare.com/workers/platform/limits/#cpu-time).

Do not remove checksum/version checks or increase inline/base64 limits to mask
this failure. Keep Cloudflare Free and use the
[local direct-transfer CLI](../docs/local-transfer.md) for large files available
on the local computer. It uploads, downloads, and verifies bytes directly against
kDrive using local credentials. One 269 MB live round trip passed; the configured
1 GiB ceiling is not a verified maximum. It does not require a Worker deployment
or billing change. The older signed-reference materialization helper still
downloads through this Worker and therefore does not bypass its CPU limit. See the [local-path
distinction and connector limitations](../README.md#local-codex-transfer-direct-large-file-path).

## Compact file results

The current source serves a compact v4 result panel: five initial rows, one shared
folder label, expandable paths/previews, and Show more for remaining returned
items. All result metadata remains available to the host. v2/v3 resource aliases
serve the same layout for cached clients. This UI change takes effect remotely
only after an authorized deployment and host resource refresh; committing or
pushing the source does not deploy it.
