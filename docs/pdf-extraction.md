# Direct PDF extraction on Cloudflare Free

Status (2026-10-13, capability revision `2026-10-13.5`): **source implemented;
not deployed**. `kdrive_read_pdf` returns text and stored AcroForm values directly
to ChatGPT. Optional scanned-page OCR is implemented but **disabled by default**;
the live model contract is verified, but rotation, small print and visual
checkbox accuracy failed acceptance. No Adobe file import, export URL, manual download or re-upload is needed by this
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
closed; only the observed `stop` marker is accepted. A normal generation stop
does not establish accurate or complete transcription.

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

Validation passed: 188 root tests, 25 Worker tests, three local workerd HTTP
tests and two independent-client/Python integration tests (218 total), both
TypeScript checks and the Node build. The earlier local dry build produced
11,261.08 KiB uncompressed (3,652.14 KiB gzip), below the documented Free bundle
limit. Local tests are not production CPU, startup or memory measurements.

Run root `npm run check`, `npm test`, `npm run build`, `npm run test:pdf`; then
remote `npm run type-check`, `npm test`, `npm run test:http`. Python integration
requires `pypdf`; `KDRIVE_TEST_PYTHON` can select the bundled workspace Python.
Install both root and remote dependencies. CI runs on macOS and Ubuntu and does
not deploy. No Worker upload or deployment was performed.

### Live synthetic acceptance: 2026-10-13

After explicit authorization and sign-in, the Cloudflare dashboard confirmed
Workers Free as the current plan, including 10,000 AI neurons/day. Nine synthetic
page requests used approximately 263.21 neurons in total, including two
response-contract diagnostics. No private tax documents were used.

The first request exposed an adapter bug: the model returns a nested
`{result: {answer, finish_reason, ...}, usage: ...}` object inside the REST API's
outer result. The adapter previously expected `answer` directly. It now supports
both shapes, with regression coverage using the actual captured responses and
a local workerd test using the nested shape. All seven subsequent cases returned
HTTP 200 and `finish_reason: "stop"`.

**Recognition acceptance failed.** Ordinary scans, mixed text/images,
German/French text and the password-protected scan matched the expected phrases.
The rotated page changed amounts; the small-print page changed amounts and
omitted labels. The interactive form's stored values and checkbox states were
correct, but OCR omitted the visual checkbox states. The original phrase matcher
mistakenly counted the form's labels alone as sufficient. Its fixture now requires
selected/unselected marks, and any missing expected text causes a nonzero runner
exit. OCR results always retain `review_required`, including matching cases.

See the [case-by-case evidence](evidence/ocr-live-2026-10-13.md) and original
synthetic responses. The full seven-case run used about 202.90 neurons and
1.15–2.42 seconds per case on the local client; these are not production Worker
CPU measurements. No automatic retry or paid fallback was used.

Fixtures and the explicit runner are documented in
[the synthetic test guide](../test/fixtures/ocr/README.md). Local preparation also
fixed a single-choice field comparison: PDF.js can represent the same choice as
a scalar in the field tree and a singleton array on its widget. The reader
normalizes those representations for comparison while preserving the returned
selection array and continuing to flag conflicting values.

### Remaining release gates

OCR stays disabled. Investigate explicit orientation correction and bounded
region rendering for small text, then repeat synthetic accuracy checks with
independent examples; the current model is not reliable enough for unreviewed
tax amounts or visual checkbox interpretation. Stored AcroForm values remain
separate and do not become OCR-derived guesses.

After accuracy passes, production Free CPU/memory/startup, the real AI binding,
quota handling and the actual ChatGPT-to-kDrive tool flow still need validation.
Direct REST tests use a fixture-backed kDrive client and do not establish those
production behaviors. Deployment requires separate authorization; account plan,
remote configuration and the checked-in disabled flag remain unchanged.
