# Nonblank OCR timeout investigation — 2026-10-14

Status: **local fix, not deployed**. Workers Free remains the authorized plan.
Production remains on the previously restored OCR-enabled release; no deployment,
upload to kDrive, original-document modification, new binding or plan change was
performed for this follow-up. Source capability revision is `2026-10-14.1`.

## Cause and scope of evidence

The old reader gives resolution, download, integrity checking, parsing, rendering
and model inference one 45-second synchronous deadline. A dense nonblank page
can need longer for generation alone. The generic `PDF_TIMEOUT` message did
not identify which stage exhausted that budget. This is independent of the
white-raster optimization; there is no evidence that skipping inference on a
white page caused the nonblank-page failure.

Read-only diagnostics used the already-synced affected PDF after matching its
previously verified checksum. No private filename, path, checksum, image,
transcription, form values or amounts are included in this record or fixtures.

- Native extraction took 69 ms; bounded rendering took 171 ms.
- A nonstreaming diagnostic with a 90-second overall allowance still timed out
  in inference after approximately 89.8 seconds. This failure is retained.
- A separate streaming diagnostic of the same model/prompt/input bounds received
  its first chunk after 645 ms, but completed only after **45,566 ms**, returning
  4,722 characters with normal `stop` termination and no reasoning output.
  The successful diagnostic used approximately 544.57 neurons.
- Streaming was diagnostic only. The production adapter still requests one
  nonstreaming completion. The original production timeout did not record a
  stage, so these replays establish a timing problem without proving its exact
  production timing or certifying production CPU/memory limits.

## Local fix

Remote `kdrive_read_pdf(ocr=true)` starts an in-memory job in the existing
authenticated MCP Durable Object. It waits up to 1.5 seconds, then returns a
pending job ID if still running. `kdrive_get_pdf_ocr_result` waits up to 10
seconds per poll and returns either pending, the normal verified PDF result,
or a sanitized error. Polling does not restart download or inference.

The job has one absolute 180-second deadline, with an abort signal sent through
the reader and AI adapter. Timeout errors include `resolve`, `download`,
`integrity`, `extract`, `render` or `inference`. One job per session and the
existing isolate busy guard bound concurrent work. Up to four completed results
remain in session memory for three minutes, then expire; they are never written
to durable storage. Lost/restarted sessions fail explicitly with
`PDF_JOB_NOT_FOUND`, without automatic reprocessing.

The existing Durable Object's [waitUntil](https://developers.cloudflare.com/durable-objects/api/state/#waituntil)
owns the pending promise after the initial response. Cloudflare documents this
as preventing normal eviction until the promise settles, up to 15 minutes; our
deadline is substantially shorter. This does not prevent deployment/restart
loss, raise CPU/memory limits or bypass Free request/duration/AI quotas.
Synchronous parsing/rendering can delay timers; cancellation cannot guarantee
the provider has stopped computation.

The model, prompt, 4,096-token output cap, image/source limits, one-page scope
and review warnings are unchanged. No retry, parallel model call, paid fallback,
new storage service or PDF export is introduced. Ordinary text/form reads retain
their existing path. The blank-page fix still bypasses inference for a verified
opaque-white rendered selection.

## Test evidence

- **207 root tests**, **25 Worker tests**, **4 real workerd HTTP tests** and
  **2 independent-client/Python interoperability tests** pass (238 total).
  Both TypeScript checks and the Node build pass; the changed diagnostics tests
  were rerun after their additional assertions. Root tests used concurrency 2.
- Six new job regressions cover completion beyond 45 seconds, absolute deadline
  despite polling, cancellation, recovery, safe errors, session isolation,
  retention/eviction, failed lifetime registration, and actual MCP pending/result
  exchanges with one download and one inference.
- A local SQLite Durable Object continues a **46-second mocked inference**
  across independent HTTP requests, with no request held open for that duration.
  It verifies duplicate suppression, cross-session rejection, a deliberately
  shortened hanging-provider deadline, abort propagation, recovery, and an
  encrypted PDF's white-region fast path. The complete test took 51.6 seconds;
  outbound network calls were zero. The 180-second production deadline is also
  tested with a controlled clock, without waiting three minutes in CI.
- A new image-only synthetic fixture contains 48 fabricated rows and over 4,700
  expected characters. Through **real `env.AI.run` via a temporary development
  proxy**, the local job completed in **44,541 ms**, with one download and one
  inference. Its initial response took 1,517 ms, four pending polls took about
  10 seconds each, and the final poll took 2,991 ms. Every expected line matched;
  checksum verification passed, 4,757 OCR characters returned, and usage was
  approximately **691.50 neurons**. See the [synthetic-only JSON report](ocr-dense-job-2026-10-14.json).
  This run fits narrowly inside the old budget; the separate 46-second runtime
  regression establishes behavior beyond it. No inference retry was used.
- A final read-only replay of the affected nonblank page used the patched job
  reader and unchanged nonstreaming adapter through Cloudflare's REST endpoint.
  It completed in **32,781 ms**, with one local source read and one inference,
  returning 4,722 OCR characters against 4,750 native-text characters. All **10
  distinct monetary values** found in the native text were also present in OCR.
  Complete-file checksum verification passed; the source checksum, size and
  modification time remained unchanged. Usage was approximately 544.86 neurons.
  Only these metrics were retained, without private content. This successful
  replay was faster than the earlier failures and does not establish an upper
  bound on inference latency or replace the future ChatGPT acceptance gate.

The first dense-fixture preparation stopped on a local character-count assertion
before any AI call. Extending the fabricated rows corrected the fixture; it is
not counted as an inference failure or discarded model result.

## Before release

Changes remain local and uncommitted; CI has not run for this patch. After review,
commit/push and check CI. Deployment requires authorization. Then refresh the
ChatGPT tool catalog and verify `pdf_ocr_jobs=true` on the expected build.

Repeat the two-page acceptance gate through ChatGPT: page 4 must return empty
text with renderer provenance and no inference; the pinned nonblank page must
complete through pending-job polling, retain the complete-file digest and return
review-marked OCR. Check key values against the native text without publishing
private values. Preserve the original PDF and use the existing rollback procedure
if either check fails. Local job/runtime validation is not a deployed ChatGPT pass.
