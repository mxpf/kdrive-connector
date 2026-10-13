# Direct PDF extraction on Cloudflare Free

Status (2026-10-13, capability revision `2026-10-13.7`): **source implemented;
not deployed**. `kdrive_read_pdf` returns text and stored AcroForm values directly
to ChatGPT. Optional scanned-page OCR is implemented but **disabled by default**;
OCR now uses a different Cloudflare vision model to address the prior checkbox
failures. Explicit rotation correction, margin removal and region scope remain
unchanged. See the latest checkbox evidence below. No Adobe file import, export URL, manual download or re-upload is needed by this
reader. This does not repair the separate Adobe attachment bridge.

## Architecture and Free-plan fit

The reader downloads a pinned kDrive version, checks the complete byte length
and SHA-256, and only then processes the bytes. Text and forms use `unpdf` 1.8.1
(PDF.js 6.1.200). OCR uses `@hyzyla/pdfium` 3.0.0 to render a complete page,
including form appearances, and `fast-png` to encode it. The render includes
PDF display rotation, image transforms and overlaid content; it does not merely
send embedded image objects. After rendering, OCR removes only fully opaque,
pure-white outer margins, preserving every nonwhite pixel and 24 pixels of
padding where available. It performs no thresholding, smoothing or invented
upscaling. An explicit region is cropped before any additional clockwise
rotation. Original text/form extraction is unaffected. Dependencies and WASM are bundled, with no CDN fetch.
The browser export of PDFium is required in Workers; Node uses its Node export.

Parsing and rendering run inside the existing SQLite `KDriveMCP` Durable Object,
whose documented default [CPU allowance](https://developers.cloudflare.com/durable-objects/platform/limits/)
is 30 seconds. The public HTTP Worker's Free allowance is only 10 ms; do not move
this work to the `/binary` route. [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
include 128 MB memory, one-second startup and 64 MiB uncompressed bundle size,
with no compressed bundle limit. Existing Free Durable Object quotas still apply.

OCR sends one page image to Cloudflare Workers AI's
[`@cf/qwen/qwen3.8-27b`](https://developers.cloudflare.com/workers-ai/models/qwen3.8-27b/)
vision model with an image-only user message, a fixed transcription prompt,
temperature 0 and bounded output. Thinking is disabled, reasoning effort is low,
and `store` is false. The model must distinguish a visible check/cross from an
empty colored box. Only one assistant text choice with `finish_reason="stop"`
is accepted; refusals, tool calls, missing completion markers and truncation
fail closed. This is a fixed model replacement, not a fallback or second call. This is generative visual transcription, not guaranteed document OCR.
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
| `ocrRotation` | Optional clockwise correction: 0, 90, 180 or 270, after PDF display rotation; orientation is never guessed |
| `ocrRegion` | Optional `{x,y,width,height}` fractions of the displayed page, top-left origin, before correction; width/height at least 0.01, rectangle entirely inside page |
| `expectedSha256` | Carry the first result's digest on later batches to reject changed file versions |
| `password` | Only a user-authorized password; never guessed, echoed or retained by the connector |

Bounds: 5 MiB source, 200 document pages, 500 selected-page widgets and 100,000
characters including serialized form data. OCR renders at up to 2× PDF scale,
2 million pixels, 2,000 pixels per dimension and 4 MiB PNG. Output is limited to
4,096 model tokens and 30,000 OCR characters. Small print on dense pages may be
unreadable at these limits. Unknown/missing or truncated completion reasons fail
closed; only the observed `stop` marker is accepted. A normal generation stop
does not establish accurate or complete transcription.

Image preparation retains the same two-million-pixel ceiling. There is still
one model call per requested page/region, with no automatic orientation search,
tilings or retries. A later region call re-downloads the source; carry
`expectedSha256` to ensure it is the same version. OCR options require `ocr=true`.

Ordinary text/form reads have a 20-second deadline; OCR reads have a 45-second
wall-clock deadline to accommodate observed inference latency. A live request
exceeded the former 20-second limit, and another exceeded 45 seconds; both are
retained as failures. The final suite passed without automatic retries. This
changes the bounded asynchronous wait, not the Worker CPU quota. AI inference receives an abort
signal and a bounded wait; cancellation cannot guarantee upstream computation
has stopped. Synchronous parsing/rendering cannot be interrupted by a timer.
One PDF read per isolate is admitted; other attempts receive `PDF_BUSY`.

Results retain separate sources:

- `pages[].text`: original text layer; `no_text` never implies a blank page.
- `pages[].formFields`: parsed AcroForm values, field names/types, button export
  values and checked states, plus provenance and consistency issues.
- `ocr`: optional page-numbered visual transcription, model, image dimensions
  and `review_required`/`no_text_detected` status. `preparation` records full-page
  versus region scope, requested region, source dimensions, pixel crop and
  clockwise correction. A region result never claims full-page coverage. It
  never overwrites form values
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

Checkboxes need a specific caveat: PDF.js 6.1.200 normalizes checkbox
`fieldValue` from `/AS` when present, and its tree view uses that same normalized
value. Comparing the two cannot independently verify raw `/V`. Checkbox fields
therefore include `valueSource="pdfjs_checkbox_state"`,
`status="review_required"` and `CHECKBOX_RAW_VALUE_UNVERIFIED`.
Their `checked` state remains available, but is not described as verified raw
storage. `forms.source` is `acroform_parsed_values`; OCR continues to come only
from rendered pixels and never overwrites parser output.

For other supported fields, `stored_value` means a consistent parsed stored
value, **not visual verification**.
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

Validation passed: 197 root tests, 25 Worker tests, three local workerd HTTP
tests and two independent-client/Python integration tests (227 total), both
TypeScript checks and the Node build. The earlier local dry build produced
11,261.08 KiB uncompressed (3,652.14 KiB gzip), below the documented Free bundle
limit. Local tests are not production CPU, startup or memory measurements.

Run root `npm run check`, `npm test`, `npm run build`, `npm run test:pdf`; then
remote `npm run type-check`, `npm test`, `npm run test:http`. Python integration
requires `pypdf`; `KDRIVE_TEST_PYTHON` can select the bundled workspace Python.
Install both root and remote dependencies. CI runs on macOS and Ubuntu and does
not deploy. No Worker upload or deployment was performed.

### Initial live synthetic acceptance: 2026-10-13

After explicit authorization and sign-in, the Cloudflare dashboard confirmed
Workers Free as the current plan, including 10,000 AI neurons/day. Nine synthetic
page requests used approximately 263.21 neurons in total, including two
response-contract diagnostics. No private tax documents were used.

The first request exposed an adapter bug: the model returns a nested
`{result: {answer, finish_reason, ...}, usage: ...}` object inside the REST API's
outer result. The original adapter expected `answer` directly; that revision
added support for both shapes. These historical response records are retained
for regression comparison; the current Qwen adapter uses chat-completion choices. All seven subsequent cases returned
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

### Orientation and small-text follow-up: 2026-10-13

Lossless pixel preparation fixes the tested scan failures without changing the
model, adding paid services or increasing inference count. The final ten-case
live run matched nine cases: the original scans (including rotation, small
print, mixed content, multilingual and encrypted data), two new image-rotated
scans with independent values, and a small-text region on an off-white page.
Rotations were supplied explicitly, not automatically detected. Every expected
amount, date, negative sign and bracketed mark matched in these cases.

The filled form's text and all five stored field values still match, but its
visual checkbox states are omitted. Separate prompt and focused-region trials
either omitted or misclassified the empty checkbox; these were not promoted as
fixes. That revision retained the original transcription prompt. Structured AcroForm values
continue to carry the correct selected states and never become OCR guesses.

The final run used 286.82 neurons; the entire follow-up, including unsuccessful
diagnostics, used 653.79 neurons over 23 calls. See
[the follow-up evidence](evidence/ocr-preprocessing-2026-10-13.md), with original
responses and a replay regression. Normal generation termination is not an
accuracy guarantee. The live runner correctly exits nonzero for the remaining
form failure, while the local regression suite passes by detecting that failure.

### Checkbox follow-up: 2026-10-13

Moondream's repeated checkbox omissions/misclassifications were a model accuracy
problem, not missing file bytes or missing appearances. Qwen 3.8 27B correctly
read the original checked/empty pair in the initial probe on Workers Free. The
expanded suite adds reversed, both-empty, both-checked, independently rasterized
and stale-state forms to the existing scan tests. **All 15 cases passed in the
final live run**, including each checked and empty state. Earlier timeout failures
are retained rather than discarded. See the
[checkbox evidence](evidence/ocr-checkbox-2026-10-13.md) for complete results,
usage, timings and retained failures.

The stale fixture independently proves that raw `/V` can disagree with both
PDF.js views. The runner now requires the explicit source/review marker for
checkbox fields instead of falsely accepting them as independent stored values.
Visual recognition is still assessed against actual rendered marks, including
on a flattened PDF that has no stored fields.

### Remaining release gates

The [binding/runtime validation](evidence/ocr-binding-runtime-2026-10-13.md)
now passes through the real `env.AI.run` development binding: four synthetic
reads plus a deliberate cancellation and successful recovery. All 15 PDFs also
passed the local rendering pipeline; the 45-second deadline, busy guard and
simulated quota errors were verified. No production implementation change was
needed. Full-bundle startup and resource diagnostics are local measurements.

OCR stays disabled pending separately authorized deployment and production
validation. Passing synthetic cases does not establish dense-page or arbitrary-scan
accuracy. Explicit region selection needs known layout; orientation correction
needs known orientation. Automatic orientation/region detection is not implemented.

Production Free CPU/memory/startup enforcement, deployed binding configuration,
actual quota exhaustion behavior and the ChatGPT-to-kDrive tool flow still need
validation. Both REST and development-binding tests use a fixture-backed kDrive
client and do not establish those production behaviors.
Deployment requires separate authorization; account plan, remote configuration
and the checked-in disabled flag remain unchanged.
