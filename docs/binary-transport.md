# Binary transport implementation notes

## Contracts and sources

- Native upload schema: [OpenAI file inputs](https://developers.openai.com/plugins/reference#define-file-inputs). `download_url` and `file_id` are required; `mime_type` and `file_name` are declared but optional. `_meta["openai/fileParams"]` names the top-level `file_ref` field.
- [Infomaniak upload-session start](https://developer.infomaniak.com/docs/api/post/3/drive/%7Bdrive_id%7D/upload/session/start), [chunk](https://developer.infomaniak.com/docs/api/post/3/drive/%7Bdrive_id%7D/upload/session/%7Bsession_token%7D/chunk), [finish](https://developer.infomaniak.com/docs/api/post/3/drive/%7Bdrive_id%7D/upload/session/%7Bsession_token%7D/finish), and [cancel](https://developer.infomaniak.com/docs/api/delete/3/drive/%7Bdrive_id%7D/upload/session/%7Bsession_token%7D).
- [Version list](https://developer.infomaniak.com/docs/api/get/3/drive/%7Bdrive_id%7D/files/%7Bfile_id%7D/versions) and [version-specific download](https://developer.infomaniak.com/docs/api/get/2/drive/%7Bdrive_id%7D/files/%7Bfile_id%7D/versions/%7Bversion_id%7D/download).

## Upload

The host supplies a native reference or caller supplies a trusted HTTPS asset URL. The server resolves the destination folder (never implicitly creates it), fetches the source once, obtains the expected length, and starts a `conflict=error` session. An origin-only provider `upload_url` is completed with `/3/drive/{drive_id}/upload/session/{session_token}/chunk`; a full URL is accepted only if it already matches that exact route. Unexpected paths, queries and fragments are rejected. It reads with backpressure into one 4 MiB upload buffer, hashes the whole stream incrementally, and sends numbered chunks with individual SHA-256 checksums. It calls finish only after EOF, exact byte-length validation, and optional whole-file SHA-256 validation, requesting only the supported `path` expansion. The final metadata includes the provider ETag when returned (`resolved_version: null` explicitly means unavailable), size, digest and Open in kDrive link.

No source ref, URL credentials, or source bytes are persisted by the connector. Infomaniak holds uncommitted chunks. Failures before finish attempt session cancellation; the provider expires unfinished sessions after four hours if cancellation fails. A timeout during finish has an ambiguous outcome: do not blindly retry or delete the destination. Inspect it first. New binary session POSTs are not automatically replayed after a 401. Upload requests use manual redirect mode and reject non-2xx responses without following redirects; the project's workerd runtime rejects `redirect: "error"` before sending a request. A Worker regression test reproduces this and verifies fail-closed HTTP 302 handling. Existing overwrite/move/rename/trash safety protocols are unchanged.

Length must be known from Content-Length or `expected_size`; compressed HTTP source bodies and partial HTTP responses are rejected. `expected_sha256` is 64 hexadecimal characters, without an algorithm prefix. No replacement response or alternate file is fetched on failure. The URL's single response is the input snapshot; callers needing identity with a prior artifact should provide its size and SHA-256.

## Export

Resolve the exact file ID and capture its current ETag/size, checking metadata again before accepting it. Version history is not a current-version locator: the reported PDF returned an empty history despite stable, readable current bytes. New exports therefore use the current ETag as `resolved_version`, not a guessed historical version ID. Both the initial hash read and later handoff check that ETag before and after streaming the current file by ID. The signed link binds the owner, drive, file ID, ETag, name, MIME, byte length, SHA-256 and five-minute expiry; it contains no provider access token. The handoff additionally verifies the signed digest and length, withholding the final chunk until validation completes. No path is re-resolved and no changed content is accepted as a complete download.

This is a fail-closed content reference, not retained storage: if the file changes or disappears before redemption, export again. It does not guarantee old bytes remain downloadable for the whole expiry window. Previously issued numeric historical-version links still use the version-specific endpoint and never fall back to current content. Missing ETags, metadata drift, length mismatch or digest mismatch fail closed.

On a cold export, bytes are read once for hashing and again for handoff; this trades bandwidth for a digest available before downstream download. Repeat exports can reuse the verified digest within the authenticated cache scope described below. `GET /binary/:token` streams raw bytes with attachment, MIME, length, digest ETag, no-store and no-referrer headers; `HEAD` returns signed metadata. Range requests are not implemented (a full 200 response is returned). Streaming digest/length errors terminate the response; consumers must reject incomplete downloads and should verify the supplied SHA-256. Already-delivered bytes cannot be recalled.

### Repeat-export optimization

The remote Worker uses a SQLite-backed Durable Object isolated by authenticated
owner and drive, so verified digests survive MCP session changes and object
eviction. The local stdio server retains a per-registration in-memory cache.
Both use 128 entries, a fixed ten-minute TTL, and least-recently-used eviction.
Keys include drive ID, file ID, exact version/ETag (including its type), and byte
length. Only verified SHA-256 and size are stored—not file bytes, paths,
credentials, file objects, or signed URLs. A storage alarm removes expired
remote entries. There is no cross-account sharing or public cache endpoint.

Deployment requires the `KDRIVE_BINARY_DIGESTS` binding and additive `v3`
`KDriveBinaryDigestStore` migration in `remote/wrangler.jsonc`. Auth and existing
MCP/nonce objects are unchanged. Cache read/write errors fall back to the normal
verified export and produce only a bounded diagnostic code. Cache reads and writes
each have a one-second wait limit, also interrupted by the overall export deadline.
A cache-read timeout falls back to hashing; a cache-write timeout does not prevent
returning verified bytes' reference. An expired overall deadline still fails the
export. Timing out the wait does not cancel remote RPC: late verified writes may
complete, and late failures remain handled without logging their contents.

Every export still resolves the requested path and checks fresh file metadata and
access before consulting the cache. A hit uses current name/MIME metadata and
issues a fresh short-lived reference. Failed or interrupted reads never populate
the cache. Changed version, size, or replacement file ID causes a miss. Cache hits
do not extend cache TTL or bypass limits. Concurrent cold exports may each perform
their own read; this patch does not share cancellable in-flight streams.

Every redemption still downloads bytes and verifies the pinned version, byte
length, and SHA-256; the cache is not used on that delivery path. Even a provider
returning different bytes for the same ETag fails the existing digest check.
First-time transfers are unchanged. An automated 25 MiB fixture proves two exports
plus one redemption use two full provider reads instead of three (25 MiB avoided);
this is a byte-count assertion, not a live latency benchmark.

Safe diagnostic events include `digestCacheHit` and `avoidedDownloadBytes`. Health
reports the cache scope and bounds under `connector.optimizations`. After deployment,
export the same unchanged large file twice across fresh authenticated sessions,
check hit/miss events, and redeem the second reference with full digest
verification. No uploads or mutations are needed for that smoke test.

The previous registration-local implementation produced two live cache misses
on the 27 MB fixture. A subsequent sanitized trace showed distinct MCP sessions;
that is consistent with per-registration cache loss, although those session
events were not individually correlated to export trace IDs. Worker tests now
cover shared digests across registrations and actual Durable Object eviction,
owner/drive isolation, absolute expiry, LRU bounds, and fresh authorization.
Live verification on 2026-10-05 passed after deploying commit `e0fe1f4` as Worker
`f8cd0637-8d56-427f-ae66-0ce9c55a762f` (capability revision `2026-10-05.3`):

- The 27,002,376-byte *Wisdom of Laotse* PDF exported at version `8cd4803d9ff8ef4d`.
- Cold trace `fd2045e8-073b-4f74-a616-72db7959a19b`: cache miss, server duration 6034 ms.
- Warm trace `ed4153a0-fe98-4a19-983a-2b68959dca95`: cache hit, server duration 2369 ms,
  `avoidedDownloadBytes: 27002376`. Sanitized session fingerprints differed between
  these correlated traces, confirming reuse across MCP sessions.
- Redeeming the second reference returned HTTP 200 and exactly 27,002,376 bytes.
  Independently streamed SHA-256 matched the reference:
  `a488df9b943079da2c4e4960430c163a4bc5f2d6c90d8157e919cb17a602bf1a`.
- Authenticated health reported the deployed build and `authenticated_owner_drive`
  scope. No reconnect, permission change, or kDrive mutation was performed.

These timings are one live sample, not a latency guarantee. Restart persistence
and timeout fallback remain automated-test coverage, not live fault-injection claims.
Signed download references and raw session IDs are intentionally not recorded.

The signed link is deliberately usable without the ChatGPT OAuth session by the intended consumer. Anyone possessing it can use it until expiration. Revoking the ChatGPT connection does not individually revoke outstanding five-minute capabilities; changing the signing secret or allowed owner invalidates them. Do not publish links, paste them into tickets, or log their full URLs. Cloudflare/request-log access must be treated as sensitive. Native MCP `resource_link` is returned alongside the URL, but an OpenAI-owned `file_id` cannot be fabricated; actual host materialization and cross-plugin ingestion require live verification.

## SSRF and limits

- HTTPS only, default port only, no URL userinfo or fragments. Reject all literal IP addresses, localhost/internal host forms, private/link-local/metadata destinations, and unapproved domains.
- `KDRIVE_BINARY_SOURCE_HOSTS` is a comma-separated **exact trusted-host allowlist**, defaulting to `files.oaiusercontent.com,sandbox.openai.com,sdmntprcentralus.oaiusercontent.com,sdmntprnorthcentralus.oaiusercontent.com,sdmntprsoutheastus3.oaiusercontent.com,sdmntpreastus2.oaiusercontent.com,oaisdmntprnorthcentralus.blob.core.windows.net`. These hosts were observed in native transfers and individually DNS/TLS checked. This is not proof that every ChatGPT upload uses these hosts. Redirect targets must also be approved. Add only verified file-provider hostnames from actual host-issued references. No `*.blob.core.windows.net` or other shared-domain wildcard. Other hosts fail closed; do not broaden automatically.
- Public A/AAAA checks run for every hop, in addition to the allowlist. DNS preflight is not address pinning: an administrator must never approve attacker-controlled/rebinding DNS or a host exposing an internal proxy. The portable Workers fetch API does not provide a pinned-address dialer. Arbitrary-public-URL support would require a hardened egress proxy; it is intentionally not claimed here.
- Single-stack hosts are supported: an absent family may report `ENODATA` in Node or `ENOTFOUND` in workerd. At least one address must still resolve, every returned address must be public, and all other DNS failures (including timeouts) fail closed. A credential-free workerd probe reproduced public A records plus `ENOTFOUND` for absent AAAA records on the kDrive download CDN.
- Workerd can also include CNAME alias strings in `resolve4`/`resolve6` results. Valid DNS names are excluded from IP classification; at least one terminal IP is still required and every actual IP must be public. Alias-only, malformed, mixed-private and private results are rejected.
- Three redirects maximum; no source Authorization/Cookie/Referer forwarding. Provider credentials are used only on fixed/validated Infomaniak API upload hosts, not source or CDN downloads.
- 100 MiB binary limit, separate from the existing inline limits. Worker setting: `KDRIVE_MAX_BINARY_BYTES`. Source response must identify its size or caller supplies `expected_size`. Streaming byte counts enforce the limit even if the source lies.
- Two-minute binary transfer deadline, bounded chunk buffers and sequential upload backpressure. Tool/host/platform limits may end a transfer sooner. This is not a promise of unlimited transfers.

Remote exports require the HTTPS Worker endpoint. Stdio exposes the export tool with an actionable unsupported-endpoint error; native/URL uploads work with its trusted-host configuration and 100 MiB limit.

## Automated verification versus live acceptance

For observed live outcomes, use the [dated acceptance record](binary-interop-acceptance.md): Codex → Acrobat and a generated PNG → kDrive → independent export/hash round trip passed through the host adapter. Direct ChatGPT → Acrobat remains blocked; the earlier EPUB failure has not been separately retested. The checklist below describes required coverage, not completed results.

`npm test` runs without credentials. Contract tests cover the requested PDF path against mock provider responses, raw HTTP handoff, a locally generated ~500 KB EPUB ZIP round trip, 50 MiB lazy-stream upload with measured bounded read-ahead, digest/size mismatches, failed chunks, version drift, signed-link scoping/expiry/tampering, redirects, size caps, and forbidden URLs. The EPUB contains an uncompressed mimetype entry, container, package, navigation and XHTML chapter; this tests transport, not a third-party EPUB conformance validator or ChatGPT generation. A PDF-shaped fixture tests raw delivery, **not live Acrobat extraction**. Worker tests exercise streaming/hash code in workerd.

Live acceptance remains a release gate; do not mark it passed from unit tests:

1. Deploy the reviewed implementation and rescan ChatGPT metadata. Confirm all three new tools and the native file-input schema are present. No reauthorization should be needed merely for new descriptions/tools; observe actual host behavior.
2. Export `/Private/05 Reference/Reading/Philosophy & Spirituality/Zen Mind, Beginner's Mind.pdf`. Send the raw ref/URL directly to Acrobat `pdf_to_markdown` through its supported ingestion interface. Confirm readable extracted text without user re-upload. If Acrobat cannot ingest HTTPS/MCP resource links, record its required asset contract rather than claiming success.
3. Generate a valid EPUB of roughly 500 KB in ChatGPT. Record original size and SHA-256 using a file tool, not model-encoded bytes. Upload its native host ref to a newly agreed, non-existing QA path. Export it back; compare byte length and SHA-256 with the original. Never overwrite the user's named reading file for QA.
4. Repeat with a 25–50 MiB lazy-generated binary and an agreed new destination. Record timing, memory/chunk behavior, and byte-for-byte identity. Confirm no base64 content appears in tool arguments/results.
5. Attempt forbidden source URLs and mismatched digests. Verify no successful finalization and no completed destination file. Confirm an existing destination cannot be overwritten. Test expiry and deletion of the pinned version (only with an explicitly disposable fixture).
6. Preserve evidence without signed URLs or credentials. Cleanup of QA files requires explicit scope; do not delete real user files.

No live uploads, private PDF disclosures to downstream tools, deployment, or plugin refresh are performed by the automated suite.

## File-parameter investigation (2026-10-01)

The raw MCP declaration already uses an object with `download_url`, `file_id`, optional `mime_type`/`file_name`, and `_meta["openai/fileParams"]: ["file_ref"]`, matching OpenAI's linked file-input contract. Node and Worker discovery regression tests now verify the **serialized `tools/list` response**, not just registration-time Zod objects. Direct MCP string arguments fail schema validation before any provider request.

The host-facing string parameter and the raw MCP object are different layers: Codex explicitly describes its string as a local file path which the host uploads/resolves. ChatGPT may expose a different selection mechanism. A model-facing string by itself is not proof that the MCP declaration lacks the adapter. Do not manually pass an object to a host surface that requires a selection string, and do not invent a file ID or download URL. The remote connector cannot resolve `/mnt/data` itself.

The reported source-policy error is emitted after MCP argument validation, while validating a download URL. It is not the raw-MCP error for passing a string instead of an object. The previous error conflated unapproved hosts, unresolved URIs, and unsafe URLs. New diagnostics distinguish unresolved local/sandbox/file references and an HTTPS host outside the allowlist, without echoing paths, queries, credentials, or arbitrary hostnames. A rejected OpenAI file hostname is classified separately; this classification does not grant it trust.

The exact regional host observed in an earlier successful host transfer has been added to defaults and Worker configuration and deployed on 2026-10-01 as Worker version `e6c95ce0-e65d-490d-9ee4-2a5d0f79ee63`. The Keepinghaus PNG's actual resolved host has not been captured, so this is a concrete compatibility correction, not a verified fix for that specific invocation. The existing Inspector grant returned 401 during a read-only production schema check; no token refresh or authentication change was performed. The browser blocked the attempted settings-page access, so supported client metadata refresh remains unverified. A ChatGPT-native PNG acceptance test was requested in the existing test conversation; its result must be recorded separately from deployment success.

Acceptance: in the source ChatGPT conversation, select the generated PNG through the host file parameter. Use a new agreed QA destination, never overwrite the Keepinghaus image. Record original size/digest outside model context; upload with expected size/digest; verify returned path/name/MIME/length/version; export and independently hash returned bytes. Stop on a host-policy error and inspect only the privately verified source hostname before considering another exact allowlist entry. No wildcard trust, base64 fallback, manual bearer URL, or intermediary storage.

### Post-deployment PNG check (2026-10-01)

The existing ChatGPT test conversation handed execution to Work mode (task `Run kDrive PNG upload acceptance`); this is not a direct ChatGPT-runtime acceptance pass. That task generated an RGB PNG (1254×1254, 881,567 bytes), independently hashed it as `b5f80d3e4e10129e25db57ef2449502258ef3ee2d3a82dd33c870a0c1dedcb00`, verified `/Private/00 Inbox/connector-qa-20261001-fileparam-e6c95ce0.png` was absent, and invoked `kdrive_upload_file_ref` through the host-managed adapter with expected size and digest.

The deployed diagnostic returned: `Binary OpenAI file host is not on the exact trusted-host allowlist. The host adapter supplied an HTTPS URL, but kDrive source policy rejected its hostname.` The task checked the destination again and reported it remained absent. No export/roundtrip was attempted. This isolated a remaining source-host policy mismatch after host resolution. No existing kDrive file was modified.

Follow-up: a bounded hostname-only diagnostic (regional `sdmnt…oaiusercontent.com` names only, never URL paths/queries) identified `sdmntprnorthcentralus.oaiusercontent.com` on a retry of that same generated PNG through the native adapter. Public A/AAAA validation passed and a credential-free HTTPS HEAD verified TLS (the bare root returned HTTP 400). This exact observed hostname was added to defaults and Worker configuration; nested subdomains, suffix lookalikes and other unapproved hosts remain rejected. No wildcard trust or source credentials were added. This is evidence for the Work/Codex native adapter; direct ChatGPT-runtime acceptance still requires its own test.

Further live isolation found a second bug: this workerd version rejects `redirect: "error"` at request construction. Binary provider requests now use `manual` and reject non-2xx statuses without forwarding credentials. Session creation then returned the exact hostname `1-14-v3-12.upload.kdrive.infomaniak.com`; public DNS and TLS checks passed, and this provider-issued hostname was added to the chunk-destination allowlist. Other provider hosts still fail closed.

Intermediate deployment: `cce53d61-ba32-4f8f-8003-38483ebaba88` passed source policy and session creation but failed chunk upload with HTTP 302. No redirect was followed and finalization was not started. This historical failure is superseded by the successful round trip below.

Earlier deployment `2c686fea-e68f-4feb-88ec-e7d314539e64` fixed POSTing chunks to the upload origin's `/` and unsupported `etag,version` finish expansions. The current source-policy/DNS fix deployed as `5d498ddf-b5ed-4ea1-a838-928d1870c612`: one exact ChatGPT Azure hostname was added and workerd CNAME answers are no longer misclassified as private IPs. The ChatGPT QA PNG now exists and its exported bytes independently match the original digest. See the [acceptance record](binary-interop-acceptance.md). No redirect-following permission or wildcard trust was added; unknown hosts still fail closed.

## Large-file host materialization

`kdrive_export_file` is the primary read-only download action; it is not constrained by the inline 2 MiB read limit. Keep its existing name for compatibility. The raw reference carries name, MIME, size, resolved version, hash and expiry; it is not a native ChatGPT `file_id`.

`materializeBinaryReference` in `src/binary-materialize.ts` is an optional **local Node host bridge**, not Worker filesystem access. It streams a reference into an exclusively created private temporary directory, checks size/SHA-256, and returns a local path only after verification. Interrupted, expired, oversized, truncated or corrupt transfers remove their own partial directory. It accepts only the configured connector origin, does not follow redirects, and never returns/logs the signed URL. Files are mode 0600 and directories are private. Successful files remain for the host/task to reuse and later clean up.

After `npm run build`, feed raw reference JSON to `node dist/download-cli.js` through stdin, not a command-line argument. Set `KDRIVE_CONNECTOR_BASE_URL` only for a different trusted connector deployment. The output is bounded metadata and `local_path`; give that path to tools whose native host adapter explicitly accepts local files. A ChatGPT runtime with no supported import bridge remains a separate integration limitation.

The endpoint returns HTTP 410 for invalid/expired/unavailable references. Refresh with `kdrive_export_file` and compare `resolved_version` before resuming a task. It currently advertises `Accept-Ranges: none`; range/chunk retrieval and server-side OCR are intentionally deferred, not silently approximated. Full-stream integrity checks remain in place. OCR/extraction belongs to a downstream PDF tool in this patch.

Transport integration tests exercise lazy 25 MiB PDF-shaped data, image/EPUB/Office/archive payloads, Unicode/space-containing names, expiry/refresh, corruption, truncation and cancellation. These are byte-transport fixtures, not document-format validation. Live evidence uses the actual 27002376-byte *Wisdom of Laotse* PDF, which downloads with the correct digest and opens/renders in Poppler. Acrobat's generic processing error remains unresolved.
# Reliability diagnostics

`kdrive_connection_status` includes an additive `connector` object: package version,
running Worker deployment ID (`build_id`), capability revision, supported transports,
and effective byte/time limits. Stdio reports `unknown-local-build` and no remote
export capability. A deployment ID does not prove that ChatGPT has refreshed its
cached tool catalog; compare actual tool availability separately. The package
version remains 0.3.1; this patch is not a release/version bump.

Binary tool results include `trace_id`. Safe operational events record the operation,
stage, elapsed milliseconds, bytes, and stable error code—not filenames, paths,
file contents, source URLs, signed references, or credentials. New signed exports
carry the export trace ID so the download's `parentTraceId` can correlate the two;
older references without that field remain supported. Download responses include
`X-KDrive-Trace-Id`. Once streaming has started, failures terminate the stream and
are recorded in logs; HTTP status cannot be changed after headers have been sent.

Pre-stream failures distinguish invalid/expired references (410), changed pinned
versions (409), upstream failure (502), and timeout (504), with
`X-KDrive-Error-Code`. Upstream rate limiting uses 429. Authentication and access
failures retain 502 with distinct `UPSTREAM_AUTHENTICATION_FAILED` and
`UPSTREAM_ACCESS_DENIED` codes (not a client OAuth challenge). A missing pinned
file during either metadata check is treated as a version-unavailable failure.
Unknown upstream errors are never echoed. An unconfirmed
upload finalization reports `UPLOAD_COMMIT_UNKNOWN`: inspect the destination before
retrying. A confirmed upload with failed optional Open-in-kDrive link generation
still returns `status: uploaded` and `warning_code: OPEN_URL_UNAVAILABLE`.

Source fetches and upload-session/chunk requests preserve the same authentication,
access, rate-limit, and timeout categories. Once upload finalization has started,
`UPLOAD_COMMIT_UNKNOWN` takes precedence: do not automatically retry a write.

Operational logs use stderr, leaving stdout reserved for the stdio MCP protocol.
The local download bridge and CLI preserve allowlisted error codes and UUID trace
IDs, including traces on interrupted downloads, but never echo upstream bodies,
arbitrary headers, or signed URLs. Failed downloads still remove their private
partial files before returning an error.

CI runs both Node and Worker suites. These local checks do not establish live
ChatGPT file-adapter or downstream Adobe compatibility. After deployment, verify
the health build ID, a read-only export/download trace, and the refreshed tool
catalog. Do not perform live mutation QA without explicit approval.
