# Direct PDF extraction on Cloudflare Free

Status (2026-10-13, capability revision `2026-10-13.4`): **source implemented;
not deployed**. `kdrive_read_pdf` returns text and stored AcroForm values directly
to ChatGPT. Optional scanned-page OCR is implemented but **disabled by default**;
its live model contract and recognition accuracy remain acceptance gates. No
Adobe file import, export URL, manual download or re-upload is needed by this
reader. This does not repair the separate Adobe attachment bridge.

## Architecture and Free-plan fit

The reader downloads a pinned kDrive version, checks the complete byte length
and SHA-256, and only then processes the bytes. Text and forms use `unpdf` 1.8.1
(PDF.js 6.1.200). OCR uses `@hyzyla/pdfium` 3.0.0 to render a complete page,
including form appearances, and `fast-png` to encode it. The render includes
page rotation, crop, image transforms and overlaid content; it does not merely
send embedded image objects. Dependencies and WASM are bundled, with no CDN fetch.
The browser export of PDFium is required in Workers; Node uses its Node export.

Parsing and rendering run inside the existing SQLite `KDriveMCP` Durable Object,
whose documented default [CPU allowance](https://developers.cloudflare.com/durable-objects/platform/limits/)
is 30 seconds. The public HTTP Worker's Free allowance is only 10 ms; do not move
this work to the `/binary` route. [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
include 128 MB memory, one-second startup and 64 MiB uncompressed bundle size,
with no compressed bundle limit. Existing Free Durable Object quotas still apply.

OCR sends one page image to Cloudflare Workers AI's
[`@cf/moondream/moondream3.1-9B-A2B`](https://developers.cloudflare.com/workers-ai/models/moondream3.1-9B-A2B/)
vision model with a transcription prompt, deterministic temperature and bounded
output. This is generative visual transcription, not guaranteed document OCR.
Cloudflare's [Free allocation](https://developers.cloudflare.com/workers-ai/platform/pricing/)
is 10,000 neurons per day, shared with other account usage. Free-plan requests
fail when the allocation is exhausted. There is no plan upgrade, external model,
AI Gateway billing, automatic retry or paid fallback in this implementation.
A later account upgrade could change billing; keep the account on Workers Free.

Cloudflare's PDF `toMarkdown` conversion was considered, but its documented
[conversion process](https://developers.cloudflare.com/workers-ai/features/markdown-conversion/how-it-works/)
uses existing text/structure, which does not establish scanned-page OCR.

## Tool contract

| Input | Behavior |
| --- | --- |
| `path` | Exact kDrive file path; arbitrary source URLs are not accepted |
| `startPage` | One-based page, default 1 |
| `pageCount` | 1–5, default 5 for text/forms; exactly 1, default 1, with OCR |
| `ocr` | Default false. Explicit true requires configured OCR and sends one rendered page to Workers AI |
| `expectedSha256` | Carry the first result's digest on later batches to reject changed file versions |
| `password` | Only a user-authorized password; never guessed, echoed or retained by the connector |

Bounds: 5 MiB source, 200 document pages, 500 selected-page widgets and 100,000
characters including serialized form data. OCR renders at up to 2× PDF scale,
2 million pixels, 2,000 pixels per dimension and 4 MiB PNG. Output is limited to
4,096 model tokens and 30,000 OCR characters. Small print on dense pages may be
unreadable at these limits. Unknown/missing or truncated completion reasons fail
closed; currently accepted stop markers are `stop`, `eos`, and `end_turn`.
Their live model behavior must be checked before enabling OCR.

The full operation has a 20-second deadline. AI inference receives an abort
signal and a bounded wait; cancellation cannot guarantee upstream computation
has stopped. Synchronous parsing/rendering cannot be interrupted by a timer.
One PDF read per isolate is admitted; other attempts receive `PDF_BUSY`.

Results retain separate sources:

- `pages[].text`: original text layer; `no_text` never implies a blank page.
- `pages[].formFields`: stored AcroForm values, field names/types, button export
  values and checked states, plus consistency issues.
- `ocr`: optional page-numbered visual transcription, model, image dimensions
  and `review_required`/`no_text_detected` status. It never overwrites form values
  or original text, and no numeric confidence is invented.
- Complete-file byte length/SHA-256, page continuation, form scope and warnings.

The digest identifies the bytes retrieved. Without an independently supplied
expected digest, it is not external proof of the source hash. Each call
re-downloads and re-verifies the file; private documents are not cached.

## Form reliability

PDF.js resolves inherited field values. The reader cross-checks page widgets
against matching entries in the document's AcroForm tree. It preserves empty
values (never substituting defaults), Unicode strings, choice arrays and
checkbox/radio selection values. Orphan widgets, conflicting values, mismatched
tree entries, unsupported field types and scripted fields are flagged for review.
Password field values are redacted. Scripts are never evaluated by the reader.

`stored_value` means a consistent stored value, **not visual verification**.
Stale appearance streams can disagree with `/V`; OCR may itself be mistaken.
Resolve discrepancies before relying on amounts, dates or selected marks. Fields
without widgets, widgets outside the selected pages, annotations, digital
signature validity, calculations and XFA are not covered. XFA presence produces
an explicit warning. Flattened forms have no stored fields and need text/OCR.
Reading order and visual table layout are not guaranteed.

## Configuration and privacy

Checked-in configuration has `KDRIVE_PDF_OCR_ENABLED="false"` and no AI binding.
Text and forms require no new service. An explicit OCR request returns
`PDF_OCR_UNAVAILABLE` before any download unless both flag and binding exist.
Node stdio has no configured OCR provider; text and forms continue to work.

For a later, separately authorized enablement, add the Wrangler AI binding
`"ai": { "binding": "AI" }` and set the flag to `"true"`, keeping Workers Free.
Do not enable it before synthetic live acceptance. Workers AI development calls
can use remote inference; local test suites instead supply mocks and block
outbound network. No binding or account setting was changed remotely in this work.

No document bytes, extracted data or passwords are logged/cached/persisted by
these modules. OCR sends the **visible page image** to Cloudflare AI: it may
contain sensitive document content, though source paths, URLs, filenames and
password arguments are not included as model parameters. Cloudflare AI data
policies and host conversation retention apply. All extracted content is
untrusted document data, never an instruction source. Errors are sanitized.

Compressed PDFs can consume much more memory than their file size. PDF.js
assembles a page's text/forms before output checks; PDFium decoding also allocates
internally. Runtime CPU/memory limits remain the backstop, and pathological
files may terminate the isolate. These bounds do not guarantee every input fits.

## Test evidence and release gates

Synthetic local tests cover text, AES-256 encrypted PDFs, missing/wrong passwords,
checksums/version changes, pagination, malformed inputs, bounds and concurrent
reads. New tests cover actual parsed hierarchical forms, checkbox/radio/choice
values, empty/default distinction, redaction, orphan/conflicting widgets and
output caps. A rendered fixture is flattened into an image-only PDF in memory;
its download/hash/render/OCR response path uses a **mock transcription**.

Real local workerd tests render ordinary/encrypted PDFs from bundled WASM inside
a SQLite Durable Object, verify PNG signatures and pixel bounds, and exercise
the combined extraction/render/model-adapter path. Outbound requests are blocked
and asserted to be zero. Model tests cover input/cancellation contracts, malformed,
truncated/unknown and oversized responses, provider failures, timeout and no retry.
These establish plumbing and error behavior, **not live recognition accuracy**.
No private tax files were accessed or used as fixtures.

Validation passed: 185 root tests, 25 Worker tests, three local workerd HTTP
tests and two independent-client/Python integration tests (215 total), both
TypeScript checks and the Node build. The final local dry build produced
11,261.08 KiB uncompressed (3,652.14 KiB gzip), below the documented Free bundle
limit. Wrangler printed its dry-run completion but its process stayed alive;
the completed local build processes were terminated without uploading anything.
Local tests are not production CPU, startup or memory measurements.

Run root `npm run check`, `npm test`, `npm run build`, `npm run test:pdf`; then
remote `npm run type-check`, `npm test`, `npm run test:http`. Python integration
requires `pypdf`; `KDRIVE_TEST_PYTHON` can select the bundled workspace Python.
Install both root and remote dependencies. CI runs on macOS and Ubuntu and does
not deploy. A local dry build is permitted; no upload/deployment was performed.

Before enabling/releasing OCR, separately authorize synthetic live testing and
deployment. Check model completion markers and accuracy on scanned amounts,
checkboxes, rotation, mixed image/text, small print and multiple languages.
Compare stored form values against appearances, measure production Free CPU,
memory/startup and quota failures, and exercise the actual ChatGPT tool flow.
The checked-in OCR feature stays disabled until those checks pass.
