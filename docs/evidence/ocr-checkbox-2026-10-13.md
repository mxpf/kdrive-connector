# Checkbox recognition acceptance — 2026-10-13

**Result: all 15 synthetic cases passed in the final live run. Source is not
deployed; OCR remains disabled. Cloudflare Workers Free is unchanged.**

## Root cause and changes

The previous Moondream model omitted or misclassified visible checkbox marks
despite receiving complete rendered pages. Prompt and focused-region diagnostics
had not resolved the failure. The fixed model is now Cloudflare's
[`@cf/qwen/qwen3.8-27b`](https://developers.cloudflare.com/workers-ai/models/qwen3.8-27b/).
One rendered PNG is sent with a fixed transcription prompt requiring a checked,
empty or unreadable state beside each checkbox label. The model receives no
stored fields, filename, source URL or password argument. There is one inference
call per page/region, no automatic retry and no fallback. Response validation
requires one normally completed assistant text choice; malformed, truncated,
refused or tool-call responses fail closed.

An additional fixture exposed a provenance problem in PDF.js 6.1.200: its
checkbox parser can replace raw `/V` with `/AS`, and both its field-tree and
widget views then expose the same normalized value. Agreement between those
views does not independently verify raw storage. Checkbox fields now explicitly
return `valueSource: "pdfjs_checkbox_state"`, `status: "review_required"` and
`CHECKBOX_RAW_VALUE_UNVERIFIED`. OCR remains separate and never overwrites parsed
fields. Text and choice values retain the existing consistency checks.

The stale fixture has raw resident `/Off` and nonresident `/Yes`, independently
checked with pypdf, while its appearances show the opposite. Both PDF.js and OCR
report the visible pair, but the parser output now carries the correct caveat.
A separate flattened form is rasterized with Poppler and rebuilt with no form
fields, establishing recognition of the image rather than substitution of data.

## Final live results

The [original final report](ocr-checkbox-2026-10-13.json) preserves each request's
model, prompt, digest, image preparation, parsed fields, provider response,
usage and timing. All requests returned HTTP 200 with `finish_reason: "stop"`.
Every expected phrase matched, including amounts, punctuation and checkbox
states; no form-value or provenance checks failed. The replay regression also
requires exactly one correct state per form label, rejecting contradictory
extra states. OCR output still carries `review_required`.

| Case | Result | Wall time (ms) |
| --- | --- | ---: |
| Ordinary scan | Pass | 3,946 |
| Rotated scan | Pass | 5,445 |
| Mixed text/image | Pass | 2,950 |
| Small print | Pass | 3,979 |
| German/French | Pass | 18,232 |
| Form: checked/empty | Pass | 8,904 |
| Form: empty/checked | Pass | 5,360 |
| Form: both empty | Pass | 1,689 |
| Form: both checked | Pass | 1,507 |
| Flattened form scan | Pass | 1,537 |
| Form with stale raw values | Pass | 1,855 |
| Password-protected scan | Pass | 2,570 |
| Independent sideways scan | Pass | 1,807 |
| Independent upside-down scan | Pass | 2,721 |
| Explicit small-print region | Pass | 1,277 |

The live runner uses the production download verification, parser, renderer and
model adapter with a fixture-backed kDrive client and the Workers AI REST API.
This verifies real inference, not the deployed AI binding or a live private
kDrive download. Only fabricated documents were processed; no tax records were
accessed. Fixture generation and exact invocation are in the
[test guide](../../test/fixtures/ocr/README.md).

## Retained failures, timing and Free usage

[Diagnostic evidence](ocr-checkbox-diagnostics-qwen-2026-10-13.json) includes the
initial successful probe, both interrupted suites and a separate reversed-form
check. The first suite stopped at `forms-reversed` after 20,004 ms. OCR's bounded
wall-clock deadline was increased to 45 seconds; ordinary reads retain 20
seconds. A second suite stopped at `small-print` after 45,003 ms. The independent
reversed-form check subsequently passed in 1,555 ms.

The final complete run passed in 1.28–18.23 seconds per case. Its REST test
client closes each HTTP connection to isolate requests. The cause of the earlier
network/provider delays is unproven; this change is not a demonstrated cure for
timeouts and does not alter the production AI binding. Failures remain failures
in the records. These were explicit diagnostic/retest runs, not automatic
retries. Cancellation cannot guarantee upstream inference stops.

The final 15 calls reported **548.23 neurons**. All 28 checkbox-investigation
attempts together reported **1,014.18 neurons**, excluding usage unavailable for
two timed-out requests. Actual total usage is therefore unknown; these figures
are not an account-wide meter. The account's Free plan was verified during this
session and no plan setting was changed. Cloudflare's
[Free allocation](https://developers.cloudflare.com/workers-ai/platform/pricing/)
is 10,000 neurons/day shared with other account usage; exhaustion fails requests
without a paid fallback.

## Local regression and deployment status

All **227 local tests passed**: 197 root tests, 25 Worker tests, three real local
workerd HTTP tests and two independent HTTP-client/Python PDF integration tests.
Both TypeScript checks and the Node build passed. Coverage includes real parser
disagreement between `/V` and `/AS`, ordinary/encrypted rendering, strict model
contracts and replay of all 15 captured responses. Historical Moondream failures
remain recorded as regression comparisons.

No Worker was uploaded or deployed. The checked-in OCR flag remains false and
there is no AI binding. Production CPU/memory/startup limits, the actual AI
binding and quota behavior, and the complete ChatGPT-to-kDrive flow remain
release gates requiring separately authorized production validation. Fifteen
synthetic successes do not guarantee arbitrary scan or checkbox accuracy.
