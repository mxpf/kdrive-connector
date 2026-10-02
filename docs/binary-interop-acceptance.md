# Binary interoperability: live acceptance

Evidence dates: 2026-09-29 and 2026-10-01. This records observed results, not universal host guarantees.

## Large PDF referenced download: passed in Codex (2026-10-01)

- Exact source: `/Private/05 Reference/Reading/Philosophy & Spirituality/The Wisdom of Laotse -- Lin Yu Tang -- 1948 -- 1ea6020c997b6cd39ff0e447aa33f542 -- Anna’s Archive.pdf`.
- Existing `kdrive_export_file` returned a raw reference without embedded bytes: `application/pdf`, **27002376 bytes**, resolved version `8cd4803d9ff8ef4d`, SHA-256 `a488df9b943079da2c4e4960430c163a4bc5f2d6c90d8157e919cb17a602bf1a`.
- A streamed local download independently matched size/hash. The new `materializeBinaryReference` helper then repeated that successful download, publishing a private local file only after integrity verification.
- The original reference subsequently returned HTTP 410 after its five-minute expiry. A refreshed export retained the same resolved version/hash and downloaded successfully.
- Poppler `pdfinfo` read the downloaded file as a 358-page, unencrypted PDF 1.5; rendering its first page succeeded. This proves a downstream local PDF tool can consume the reference through automated materialization without manual re-upload.
- Codex's native file adapter passed the downloaded file to Acrobat `pdf_to_markdown`, but Acrobat returned a generic processing failure (request `68750873-167e-4654-a9cb-2098d8686fe7`). No successful Acrobat extraction or universal ChatGPT-native import is claimed.
- No source PDF or other existing kDrive file was modified. The 2 MiB inline read limit was not increased. Local verified temporary downloads remain available to the host.
- The local helper/CLI, expanded export description and clearer HTTP 410 guidance are included in this release. The already-deployed export endpoint supplied the live references during acceptance. Local validation: 72 Node tests, 15 Worker tests and both type checks passed.

## ChatGPT-native PNG upload: source-policy and DNS fixes verified (2026-10-01)

- ChatGPT's native fileParams adapter supplied the exact host `oaisdmntprnorthcentralus.blob.core.windows.net`. A temporary hostname-only diagnostic identified it without printing the signed URL; that broader diagnostic was removed afterward.
- Public DNS and credential-free TLS checks passed. Only that exact host was allowlisted; other Azure accounts, nested subdomains and lookalike domains remain denied.
- Live workerd DNS inspection revealed CNAME strings alongside terminal IP answers. The validator now skips syntactically valid alias names, requires at least one actual IP, and rejects any private IP, malformed answer, or alias-only result. No private-network exception was introduced.
- Deployed fix: `5d498ddf-b5ed-4ea1-a838-928d1870c612`.
- Following the requested native ChatGPT retry, `/Private/00 Inbox/connector-qa-20261001-chatgpt-native-final.png` exists with `image/png`, **377 bytes**. Independent export/download verification matched the original conversation-reported SHA-256 `2b51102b025b60da6a4907c0435c34afdf9f37714b09af432138ab0d52993c17`; resolved export version `64914e7877ec3375`.
- The ChatGPT conversation confirmed its executed sequence: destination metadata check → native fileParams upload → resulting metadata → export. This was not delegated to Codex; independent returned-byte verification was subsequently performed in Codex.
- The PNG is retained. No overwrite, cleanup, authentication or permission change was performed. New host regions can still require individually verified allowlist entries.

## Generated PNG upload and round trip: passed in Codex (2026-10-01)

- Deployed Worker: `2c686fea-e68f-4feb-88ec-e7d314539e64`.
- Source: genuine generated RGB PNG, uploaded through the Codex host-managed `kdrive_upload_file_ref` adapter. No base64 in model context, manually constructed source URL, or intermediary storage.
- Destination (confirmed absent before upload): `/Private/00 Inbox/connector-qa-20261001-fileparam-redirectfix.png`.
- Upload returned `image/png`, 881567 bytes and SHA-256 `b5f80d3e4e10129e25db57ef2449502258ef3ee2d3a82dd33c870a0c1dedcb00`; upload version was explicitly null.
- Export returned resolved ETag `041ab9778f5c974d`. The original local bytes and exported HTTP body were independently streamed through SHA-256: both were 881567 bytes and matched the digest above. Export metadata also matched.
- The QA PNG is retained. No existing file, including the Keepinghaus target, was overwritten or changed. An earlier failed finish left a potentially unfinished session for `connector-qa-20261001-fileparam-e6c95ce0.png`; no completed file was visible at that path and the provider's session expiry was left in place.

Root causes corrected: exact OpenAI source hosts omitted from policy; workerd's rejection of `redirect:error`; treating the provider's origin-only `upload_url` as a complete chunk endpoint; unsupported `etag,version` expansions on finish. The observed HTTP 302 was a web-app redirect caused by POSTing to `/`, not a necessary binary handoff. Chunk requests now use the validated host plus the exact documented drive/session route. Redirects remain blocked and are never automatically followed with credentials or bytes.

This is a Codex/Work result, not proof of direct ChatGPT-runtime compatibility. The host selected additional regions during retries; only observed, DNS/TLS-checked exact hosts were added. Unknown regions still fail closed. ChatGPT metadata refresh was not completed.

## Working route: kDrive to Acrobat in Codex

1. Call `kdrive_export_file` with the exact file path.
2. Download the fresh signed reference to a private temporary file, streaming bytes outside model context. Never log or publish the signed URL.
3. Independently verify byte length and SHA-256 against export metadata. Stop on mismatch or incomplete download.
4. Pass the absolute local file path to the Codex-exposed Acrobat `assets` input **only when its host schema explicitly accepts local paths**. Codex uploads the file through its host-managed bridge.
5. Invoke `pdf_to_markdown` and confirm extraction. Do not substitute the human-facing `openUrl` or inline base64.

After user-completed Acrobat reauthentication, this route extracted text from `Zen Mind, Beginner's Mind.pdf` (487461 bytes, SHA-256 `b53119f56608725562ec08d05b97a1062e407c4a73e5e67d14a5b1cd41af3a14`, resolved ETag `82a8e20c13c98fd3`). No kDrive file was modified. The upload is an intended disclosure to Acrobat, not a public link. Authentication refresh was necessary for this run, not proven necessary for every transfer.

## ChatGPT route: blocked

The existing **Export PDF metadata** conversation ran a separate test:

- Fresh export succeeded with the same connector-reported metadata; that run did not independently hash locally.
- Direct custom HTTPS to Acrobat previously returned `MISMATCHED_INPUT_STORAGE_TYPE` (400).
- A later Adobe `asset_openai_file_upload` bridge attempt returned `files.0: Invalid input: expected object, received string`. The conversation reported a string input exposed to the model versus a structured native file object expected by the underlying validator. This is reported runtime evidence, not inspection of Adobe's server implementation.
- The runtime reported that its Files materializer requires an existing native file ID; arbitrary HTTPS-to-native-file import was not established.
- Two one-time materialization approvals occurred. Their causal relationship to export calls, host import, and retries remains untraced.
- No PDF extraction occurred in that ChatGPT test, and no kDrive data/settings changed. A separate Adobe/ChatGPT support report is retained locally.

## Generated EPUB upload: blocked at source validation

A synthetic EPUB was generated locally in Codex using `test/binary-fixtures.ts`; it was not generated in ChatGPT. Size: **505201 bytes**. Original SHA-256: `c892238cfe07c123ca13a8f54656e29899d74e767519b38961c45d113d1a1656`.

The native `kdrive_upload_file_ref` tool was called with the local file path through Codex's documented host adapter, plus expected size/digest. Destination: `/Private/00 Inbox/connector-qa-20260929-Zf0KsP.epub`. Metadata checks found no file there both before and after the call.

The call returned `INVALID_ARGUMENT`: `Binary source is not an approved public HTTPS host. Use a host-issued file reference or ask the administrator to approve its exact trusted download host.` No successful upload or round trip is claimed. Source URL validation occurs before starting the provider upload session. The exact host-issued URL was not exposed by this invocation, so the precise rejected URL condition/hostname remains unknown. No allowlist or security restriction was broadened.

Next: obtain a sanitized, correlated diagnostic for the failing URL validation (hostname and rejection category only; no signed query, credentials, or file content). Review the exact host against the trust policy before changing configuration. Do not use wildcard allowlists or bypass SSRF checks. Retry once resolved with a new non-existing QA filename, then export and independently compare digest and length. Do not blindly retry ambiguous upload finalization failures.

## Still unverified

- ChatGPT-generated EPUB → kDrive native-reference upload.
- Live 25–50 MiB transfer and timing; mocked streaming tests do not prove host limits.
- General cross-plugin compatibility, repeated materialization approval cause, and old-conversation restrictions.

No live QA EPUB remains at the September destination. The successful October QA PNG is retained at the path above. Local temporary fixtures are not repository source and were retained; no unrelated cleanup was performed.
