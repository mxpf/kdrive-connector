# 0.3.1 binary export interoperability investigation

Date: 2026-10-13. Capability revision: `2026-10-13.1`.

## Outcome and scope

Raw binary delivery is verified independently. The supported route in this Codex
host is export → verified local materialization → the host's native file adapter →
Adobe extraction. It needs no manual download/re-upload. This is **not** a claim
that every ChatGPT runtime can import an arbitrary HTTPS URL into a native file.
The direct ChatGPT-to-Adobe storage-type mismatch remains a host/Adobe integration
boundary, not something an MCP server can repair by inventing file IDs.

No tax documents, credentials, signed URLs, or extracted private contents are
included in this report or its fixtures. No kDrive uploads, deployments, plan
changes, or live security-policy changes were performed. Adobe tests sent only
synthetic PDFs through the explicitly supported host adapter.

## Root causes and changes

1. **Text preview is not binary retrieval.** `kdrive_read_file(mode="text")`
   calls kDrive's text preview/conversion endpoints. An unindexed, unsupported,
   scanned, or encrypted document may have no preview while its original bytes
   remain downloadable. Previously, a missing preview could surface the provider's
   misleading `File search content not found`, or a binary conversion response
   could be decoded as UTF-8. The client now rejects binary/HTML conversion responses
   before buffering them, avoids an unnecessary third download for known binaries,
   and returns `TEXT_PREVIEW_UNAVAILABLE` with `next_tool: kdrive_export_file`.
   Authentication, access-denial, rate-limit, and genuine text-size failures remain
   distinct. Ordinary text reads and valid provider conversions remain supported.

2. **Some independent clients encounter an edge denial.** Against the same fresh
   synthetic reference, Python's default `Python-urllib/3.9` User-Agent received
   HTTP 403 from Cloudflare. Changing only that header to
   `kdrive-interop-test/0.3.1` allowed both GET and HEAD. Node and curl also worked.
   The specific edge rule was not inspected; this does not establish that the
   connector rejected authentication or that the link expired. The local
   materializer now identifies itself explicitly, and a bare HTTP 403 has a
   distinct `DOWNLOAD_ACCESS_DENIED` diagnostic. No edge controls were disabled.

3. **GET byte length was lost at the Worker HTTP boundary.** Live HEAD included
   `Content-Length: 414`, while the successful streamed GET omitted it. The
   implementation supplied a header on an ordinary JavaScript stream, which
   [Cloudflare documents as insufficient](https://developers.cloudflare.com/workers/runtime-apis/response/).
   The Worker now uses `FixedLengthStream` downstream of its size/hash validation.
   The last data chunk remains withheld until integrity succeeds. Empty exports
   validate upstream EOF before producing a zero-length response. Other methods
   return 405 with `Allow: GET, HEAD`. The signature, five-minute expiry, version
   pinning, private/no-store policy, and Free-plan limits are preserved.
   This header repair improves HTTP compatibility; it is not evidence that
   Adobe's storage-type mismatch was caused by a missing length.

4. **Adobe file ingestion has a separate input contract.** The earlier
   `MISMATCHED_INPUT_STORAGE_TYPE` and structured-file/string schema mismatch are
   recorded in [the bridge report](adobe-chatgpt-file-bridge-report.md). A valid
   kDrive HTTPS bearer URL is not automatically an Adobe asset or OpenAI file ID.
   This session's Adobe adapter explicitly accepts an absolute local path and
   performs the native upload. That route worked. The ordinary ChatGPT URL-only
   route was not retested or repaired by this host-only test.

5. **Encrypted PDF bytes can be valid but unreadable without a password.** Adobe
   extraction rejected the AES-256 fixture with a generic processing error. Local
   parsing rejected a wrong password, accepted the correct synthetic password,
   and extracted the expected phrase. Adobe then extracted the same phrase from
   a private unlocked copy. This is consistent with
   [Adobe's encrypted-document restrictions](https://developer.adobe.com/document-services/docs/overview/security).
   Transport does not decrypt files. The connector does not collect or persist
   PDF passwords; any unlocking must use a supported reader and the user's
   authorized password. A decrypted derivative has its own bytes/hash and must
   never be mistaken for the original verified export.

## Live read-only evidence

The existing `Transfer QA 2026-10-09/probe.pdf` synthetic fixture was located by
filename search, exported, and downloaded without a browser cookie or OAuth
Authorization header. Its full private folder path and bearer URL are omitted.

- Size: **414 bytes**.
- SHA-256: `680cde6bcc0a32b813f26deb4a36272a1f86f6e32b88114dde48945602e58231`.
- Pinned version: `baae5106e8f518e3`.
- Node materializer, curl, and identified Python client independently received
  all bytes with the exact hash. No redirects or manual uploads were needed.
- HEAD: 200, PDF MIME, attachment disposition, size 414, hash ETag,
  `Cache-Control: private, no-store`, `Accept-Ranges: none`.
- Tampered signature: 410 with `REFERENCE_INVALID_OR_EXPIRED`.
- After the recorded expiry: 410 with the same sanitized classification.
- Host adapter → Adobe accepted the verified local file, returning empty text
  because this old fixture has no text. Request:
  `6fc4e5c3-cca4-4b4e-8ee2-19b54d2a7a33`.

This proves live kDrive location/export/download and adapter ingestion. It does
not prove extraction of meaningful text from that blank fixture. Text extraction
was tested separately with the new fixtures below; no new live kDrive upload was
performed to join those stages into a new nonempty cloud roundtrip.

## Synthetic PDF evidence

The committed [fixtures](../test/fixtures/pdf/README.md) contain one page each:

> kDrive binary handoff regression fixture
>
> Synthetic data only. No personal or financial records.
>
> Verification phrase: ORCHID-7319

- Ordinary PDF → Adobe host adapter → exact text above.
  Request: `eaeb3c29-c046-4cb3-9b7c-f3822de7fa6b`.
- Protected PDF → same adapter → processing error, not a claimed successful read.
  Request: `0bcd31f2-5c34-4be6-890e-154697b2bf70`.
- Known-password unlocked synthetic copy → Adobe → exact text above.
  Request: `280eb85d-2ee7-4750-a955-969b70dad6a3`.
- The ordinary page was rendered and visually inspected.

The automated integration suite serves both real PDFs through the production
signed-export handler over loopback HTTP. Node, curl, and Python receive complete
matching bytes. An independent pypdf parser reads the received files and checks
text, encryption, wrong-password rejection, and correct-password extraction.
Tests also exercise tampering, expiry, unsupported methods, and corrupted bytes.
These loopback tests do not claim production TLS, Cloudflare Free CPU headroom,
or third-party availability. The separate live probe verifies production HTTPS.

## Reproduce without live credentials

Local results: **165 root tests, 25 Worker tests, 2 independent-client PDF tests,
and 1 real workerd HTTP test passed**. Both TypeScript checks and the build passed.
The HTTP-header test was also run with the fixed-length wrapper temporarily
removed: it failed on the missing length, confirming that it detects the defect.
The wrapper was restored before the final passing run.

```sh
npm ci
npm run check
npm test
npm run build
python3 -m venv /tmp/kdrive-pdf-tests
/tmp/kdrive-pdf-tests/bin/python -m pip install -r test/integration/requirements.txt
KDRIVE_TEST_PYTHON=/tmp/kdrive-pdf-tests/bin/python npm run test:pdf
npm ci --prefix remote
npm run type-check --prefix remote
npm test --prefix remote
npm run test:http --prefix remote
```

The last command crosses a real local workerd HTTP boundary to check PDF response
lengths, rather than inspecting only an in-memory Response. CI includes these
checks on Ubuntu and macOS. Python/pypdf are test dependencies only.

## Operational handoff

1. Locate the exact path, then call `kdrive_export_file`.
2. Send the returned reference JSON privately over stdin to
   `node dist/download-cli.js`. This host helper streams the five-minute URL,
   verifies length/SHA-256, and publishes a private local path only after success.
3. Pass that path only to a host adapter whose current schema explicitly accepts
   local files. This session's Acrobat adapter does; a plain ChatGPT runtime may
   not. Do not substitute `openUrl`, fabricate file IDs, or put PDF bytes in model
   context as base64. Reuse the verified local file within the task.
4. If the document is encrypted, obtain/use its authorized password through the
   reader's supported mechanism before extraction. Use OCR for scanned documents
   when appropriate. An ingestion success alone does not establish extraction.
5. On expiry, export again and compare `resolved_version`. On a bare 403, inspect
   client/edge compatibility rather than treating it as proof of expiry.

## Deployment and acceptance boundary

**Not deployed. Cloudflare Free retained.** Local passing tests do not establish
that the new Worker code is live. The previously observed large-file Free CPU
limit remains; this change adds no paid service and makes no new size guarantee.

The host-assisted route is verified in stages with synthetic data. Universal
ChatGPT-only acceptance remains unproven until that target runtime exposes a
working arbitrary-HTTPS/native-file ingestion bridge, or Adobe supports this
export URL type. A server-side URL cannot supply that missing host capability.
