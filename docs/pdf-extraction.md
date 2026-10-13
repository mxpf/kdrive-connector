# Direct PDF extraction on Cloudflare Free

Status (2026-10-13): implemented and locally tested; **not deployed**. The new
`kdrive_read_pdf` action returns PDF text to ChatGPT without an Adobe call, native
attachment import, signed export URL, or manual download/re-upload. This solves
the text-reading path for supported PDFs; it does not repair Adobe ingestion.

## Architecture and Free-plan fit

The shared MCP tool uses pinned-version kDrive retrieval, checks the complete
byte length, computes SHA-256, then parses the bytes in memory. Remote tools run
inside the existing SQLite `KDriveMCP` Durable Object; the Node stdio server can
use the same reader. No new binding, migration, storage service, AI service,
credential, paid feature or plan change is required.

Cloudflare documents a default 30-second CPU budget for [Durable Object
invocations](https://developers.cloudflare.com/durable-objects/platform/limits/).
That is distinct from the ordinary Free HTTP Worker's 10 ms CPU allowance.
[Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
also specify 128 MB memory, a one-second startup budget and a 64 MiB uncompressed
bundle ceiling. The current docs explicitly say compressed bundle size is not a
limit. Do not move parsing to the public `/binary` HTTP handler.

The existing Free [Durable Object allocation](https://developers.cloudflare.com/durable-objects/platform/pricing/)
includes 100,000 requests and 13,000 GB-s per day, shared with other usage. This
design stays within the Free product tier; those quotas still apply.

We pinned `unpdf` 1.8.1, whose installed serverless build reports PDF.js 6.1.200.
The [library](https://github.com/unjs/unpdf) targets Worker-compatible PDF parsing.
It is loaded on demand, without canvas rendering or image decoding. Synthetic
runtime tests prohibit outbound parser requests. Existing kDrive authentication
and version checks remain the only document-retrieval path.

Alternative considered: Cloudflare's [toMarkdown](https://developers.cloudflare.com/workers-ai/features/markdown-conversion/)
offers free conversion for most formats, but adds a processing service/binding
and needs separate acceptance tests. Its documented [PDF conversion](https://developers.cloudflare.com/workers-ai/features/markdown-conversion/how-it-works/)
uses tagged structure or existing page text; it does not establish scanned-PDF
OCR. The local parser provides explicit page bounds and tested password handling
without another service.

## Tool contract and limits

| Input | Behavior |
| --- | --- |
| `path` | Exact natural kDrive file path; no arbitrary source URLs |
| `startPage` | One-based page, default 1 |
| `pageCount` | 1–5 pages, default 5 |
| `expectedSha256` | Optional complete-file digest; carry the first result's value on subsequent batches to reject version changes |
| `password` | Optional user-authorized password; not guessed, echoed, cached or persisted by this tool |

Limits: 5 MiB original bytes, 200 document pages, five selected pages and 100,000
extracted characters per call. The retrieval/parsing deadline is 20 seconds,
checked cooperatively between operations. One PDF read per isolate is allowed;
concurrent attempts receive `PDF_BUSY` without queueing sensitive inputs.

Results include the complete-file byte length and SHA-256, `totalPages`, numbered
`pages`, `hasMore`, `nextPage`, and extraction warnings. The checksum identifies
the bytes read; without an independently supplied `expectedSha256`, it is not
independent proof against an external source digest. Each batch re-downloads
and validates the file, intentionally avoiding retained private PDF caches.

The first implementation extracts the **text layer only**. It preserves page
boundaries, but does not promise reading order, table reconstruction, image
understanding, annotation text or filled form values. A page with no text is
reported as `no_text`, with an explicit OCR/blank-page warning. It is never
silently described as blank or successfully OCRed. These limitations matter for
tax forms: extracted text alone is not proof that all filled fields were read.

Errors distinguish password required/incorrect, size/page/output limits, busy,
timeout, changed versions, integrity mismatches and unsupported/damaged PDFs.
Errors return no partial extracted content or raw parser/provider messages.
The existing preview path now points PDF failures to `kdrive_read_pdf`; ordinary
text reading and binary export remain available.

## Privacy and runtime boundaries

The tool does not log, persist or cache document bytes, extracted text or
passwords. PDF data still passes through Cloudflare and tool results enter the
ChatGPT conversation. Password arguments are also subject to host history and
retention; this is not a secret-input UI. Use only a user-authorized password.
Document text remains untrusted data, never an instruction source.

PDF parsing can allocate far more memory than the input size. Input, page and
output caps do not eliminate decompression attacks. PDF.js assembles one page's
text internally before the output check. A timer cannot preempt synchronous
JavaScript, so the runtime CPU/memory ceiling remains the final backstop; a
pathological PDF may terminate the isolate instead of returning a clean error.
The limits are conservative bounds, not a guarantee for every PDF of that size.

## Verification and deployment gate

Synthetic tests cover ordinary and AES-256 encrypted fixtures, missing/wrong
passwords, compressed multi-page text and continuation hashes, an image-only
page, malformed data, excess page/output/input bounds, short/long downloads,
version changes at stream completion, concurrent reads and MCP tool discovery
and invocation. No private tax document is used.

Validation passed: 175 root tests, 25 Worker tests, two real-workerd HTTP tests
and two independent-client/Python PDF integration tests (204 total), plus both
TypeScript checks and the Node build. The Python integration suite used the
bundled workspace Python because the system Python does not include `pypdf`.

The real local workerd HTTP test runs the read inside a SQLite Durable Object.
It extracts `ORCHID-7319` from both ordinary and correctly unlocked fixtures,
rejects missing/wrong passwords and asserts zero external requests. Initial
local calls took approximately 30–65 ms wall time; these are **not production
CPU measurements**. Miniflare does not certify account quotas or Free CPU limits.

The full Worker dry build measured 5692.60 KiB uncompressed and
1164.05 KiB compressed. No upload or deployment was performed. Parser code is
lazy-loaded, but production startup time still requires a later platform check.

Reproduce locally with `npm test`, `npm run check`, `npm run build`, and, in
`remote`, `npm run type-check`, `npm test`, and `npm run test:http`. The HTTP
suite includes the new Durable Object parser test. Install dependencies in both
the repository root and `remote` first.

Before any later release, authorize deployment separately, then test a
synthetic kDrive PDF through the actual ChatGPT tool, measure Free-plan CPU,
memory and startup behavior, and verify continuation/password/no-text behavior.
Scanned OCR, form-value extraction, larger documents and full visual fidelity
remain separate work. Capability revision `2026-10-13.3` identifies this source
change; it does not claim the currently deployed connector has the new tool.
