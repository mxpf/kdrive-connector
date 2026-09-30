# Binary transport implementation notes

## Contracts and sources

- Native upload schema: [OpenAI file inputs](https://developers.openai.com/plugins/reference#define-file-inputs). `download_url` and `file_id` are required; `mime_type` and `file_name` are declared but optional. `_meta["openai/fileParams"]` names the top-level `file_ref` field.
- [Infomaniak upload-session start](https://developer.infomaniak.com/docs/api/post/3/drive/%7Bdrive_id%7D/upload/session/start), [chunk](https://developer.infomaniak.com/docs/api/post/3/drive/%7Bdrive_id%7D/upload/session/%7Bsession_token%7D/chunk), [finish](https://developer.infomaniak.com/docs/api/post/3/drive/%7Bdrive_id%7D/upload/session/%7Bsession_token%7D/finish), and [cancel](https://developer.infomaniak.com/docs/api/delete/3/drive/%7Bdrive_id%7D/upload/session/%7Bsession_token%7D).
- [Version list](https://developer.infomaniak.com/docs/api/get/3/drive/%7Bdrive_id%7D/files/%7Bfile_id%7D/versions) and [version-specific download](https://developer.infomaniak.com/docs/api/get/2/drive/%7Bdrive_id%7D/files/%7Bfile_id%7D/versions/%7Bversion_id%7D/download).

## Upload

The host supplies a native reference or caller supplies a trusted HTTPS asset URL. The server resolves the destination folder (never implicitly creates it), fetches the source once, obtains the expected length, and starts a `conflict=error` session. It reads with backpressure into one 4 MiB upload buffer, hashes the whole stream incrementally, and sends numbered chunks with individual SHA-256 checksums. It calls finish only after EOF, exact byte-length validation, and optional whole-file SHA-256 validation. The final metadata includes the provider ETag when returned (`resolved_version: null` explicitly means unavailable), size, digest and Open in kDrive link.

No source ref, URL credentials, or source bytes are persisted by the connector. Infomaniak holds uncommitted chunks. Failures before finish attempt session cancellation; the provider expires unfinished sessions after four hours if cancellation fails. A timeout during finish has an ambiguous outcome: do not blindly retry or delete the destination. Inspect it first. New binary session POSTs are not automatically replayed after a 401. Existing overwrite/move/rename/trash safety protocols are unchanged.

Length must be known from Content-Length or `expected_size`; compressed HTTP source bodies and partial HTTP responses are rejected. `expected_sha256` is 64 hexadecimal characters, without an algorithm prefix. No replacement response or alternate file is fetched on failure. The URL's single response is the input snapshot; callers needing identity with a prior artifact should provide its size and SHA-256.

## Export

Resolve the exact file ID and capture its current ETag/size, checking metadata again before accepting it. Version history is not a current-version locator: the reported PDF returned an empty history despite stable, readable current bytes. New exports therefore use the current ETag as `resolved_version`, not a guessed historical version ID. Both the initial hash read and later handoff check that ETag before and after streaming the current file by ID. The signed link binds the owner, drive, file ID, ETag, name, MIME, byte length, SHA-256 and five-minute expiry; it contains no provider access token. The handoff additionally verifies the signed digest and length, withholding the final chunk until validation completes. No path is re-resolved and no changed content is accepted as a complete download.

This is a fail-closed content reference, not retained storage: if the file changes or disappears before redemption, export again. It does not guarantee old bytes remain downloadable for the whole expiry window. Previously issued numeric historical-version links still use the version-specific endpoint and never fall back to current content. Missing ETags, metadata drift, length mismatch or digest mismatch fail closed.

Export is read-only but reads bytes once for hashing and again for handoff; this trades bandwidth for a digest available before downstream download. `GET /binary/:token` streams raw bytes with attachment, MIME, length, digest ETag, no-store and no-referrer headers; `HEAD` returns signed metadata. Range requests are not implemented (a full 200 response is returned). Streaming digest/length errors terminate the response; consumers must reject incomplete downloads and should verify the supplied SHA-256. Already-delivered bytes cannot be recalled.

The signed link is deliberately usable without the ChatGPT OAuth session by the intended consumer. Anyone possessing it can use it until expiration. Revoking the ChatGPT connection does not individually revoke outstanding five-minute capabilities; changing the signing secret or allowed owner invalidates them. Do not publish links, paste them into tickets, or log their full URLs. Cloudflare/request-log access must be treated as sensitive. Native MCP `resource_link` is returned alongside the URL, but an OpenAI-owned `file_id` cannot be fabricated; actual host materialization and cross-plugin ingestion require live verification.

## SSRF and limits

- HTTPS only, default port only, no URL userinfo or fragments. Reject all literal IP addresses, localhost/internal host forms, private/link-local/metadata destinations, and unapproved domains.
- `KDRIVE_BINARY_SOURCE_HOSTS` is a comma-separated **exact trusted-host allowlist**, initially `files.oaiusercontent.com,sandbox.openai.com`. Redirect targets must also be approved. Add only verified file-provider hostnames from actual host-issued references. No `*.blob.core.windows.net` or other shared-domain wildcard. Other hosts fail closed; do not broaden automatically.
- Public A/AAAA checks run for every hop, in addition to the allowlist. DNS preflight is not address pinning: an administrator must never approve attacker-controlled/rebinding DNS or a host exposing an internal proxy. The portable Workers fetch API does not provide a pinned-address dialer. Arbitrary-public-URL support would require a hardened egress proxy; it is intentionally not claimed here.
- Three redirects maximum; no source Authorization/Cookie/Referer forwarding. Provider credentials are used only on fixed/validated Infomaniak API upload hosts, not source or CDN downloads.
- 100 MiB binary limit, separate from the existing inline limits. Worker setting: `KDRIVE_MAX_BINARY_BYTES`. Source response must identify its size or caller supplies `expected_size`. Streaming byte counts enforce the limit even if the source lies.
- Two-minute binary transfer deadline, bounded chunk buffers and sequential upload backpressure. Tool/host/platform limits may end a transfer sooner. This is not a promise of unlimited transfers.

Remote exports require the HTTPS Worker endpoint. Stdio exposes the export tool with an actionable unsupported-endpoint error; native/URL uploads work with its trusted-host configuration and 100 MiB limit.

## Automated verification versus live acceptance

`npm test` runs without credentials. Contract tests cover the requested PDF path against mock provider responses, raw HTTP handoff, a locally generated ~500 KB EPUB ZIP round trip, 50 MiB lazy-stream upload with measured bounded read-ahead, digest/size mismatches, failed chunks, version drift, signed-link scoping/expiry/tampering, redirects, size caps, and forbidden URLs. The EPUB contains an uncompressed mimetype entry, container, package, navigation and XHTML chapter; this tests transport, not a third-party EPUB conformance validator or ChatGPT generation. A PDF-shaped fixture tests raw delivery, **not live Acrobat extraction**. Worker tests exercise streaming/hash code in workerd.

Live acceptance remains a release gate; do not mark it passed from unit tests:

1. Deploy the reviewed implementation and rescan ChatGPT metadata. Confirm all three new tools and the native file-input schema are present. No reauthorization should be needed merely for new descriptions/tools; observe actual host behavior.
2. Export `/Private/05 Reference/Reading/Philosophy & Spirituality/Zen Mind, Beginner's Mind.pdf`. Send the raw ref/URL directly to Acrobat `pdf_to_markdown` through its supported ingestion interface. Confirm readable extracted text without user re-upload. If Acrobat cannot ingest HTTPS/MCP resource links, record its required asset contract rather than claiming success.
3. Generate a valid EPUB of roughly 500 KB in ChatGPT. Record original size and SHA-256 using a file tool, not model-encoded bytes. Upload its native host ref to a newly agreed, non-existing QA path. Export it back; compare byte length and SHA-256 with the original. Never overwrite the user's named reading file for QA.
4. Repeat with a 25–50 MiB lazy-generated binary and an agreed new destination. Record timing, memory/chunk behavior, and byte-for-byte identity. Confirm no base64 content appears in tool arguments/results.
5. Attempt forbidden source URLs and mismatched digests. Verify no successful finalization and no completed destination file. Confirm an existing destination cannot be overwritten. Test expiry and deletion of the pinned version (only with an explicitly disposable fixture).
6. Preserve evidence without signed URLs or credentials. Cleanup of QA files requires explicit scope; do not delete real user files.

No live uploads, private PDF disclosures to downstream tools, deployment, or plugin refresh are performed by the automated suite.
