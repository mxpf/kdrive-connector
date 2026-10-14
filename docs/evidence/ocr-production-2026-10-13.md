# Production OCR and ChatGPT acceptance — 2026-10-13

**Accepted: OCR remains enabled. All 15 synthetic OCR cases and four
negative/control checks passed. Workers Free remains the current plan.**

Max explicitly authorized deployment, OCR enablement, synthetic-PDF uploads and
ChatGPT testing, with Workers Free preserved and OCR to be disabled on a failed
check. This superseded the earlier no-deployment/no-upload constraint for this
test only. No private tax documents were accessed or uploaded.

## Deployed release

- Source: `6aa1d18f56dde34db7484dad4b09f204e142c3ec`, package `0.3.1`, capability
  revision `2026-10-13.7`.
- Worker: `kdrive-connector-mcp`; MCP endpoint
  `https://kdrive-connector-mcp.maxpfennighaus.workers.dev/mcp`.
- Live version: `9dd6d9ed-d4a2-467f-9c97-89b9261d0e0f`, created
  `2026-10-14T03:13:10.128531Z` (October 13 in America/New_York).
- Added the real `AI` binding and set `KDRIVE_PDF_OCR_ENABLED="true"`.
  Existing OAuth, secrets, KV and Durable Object bindings were preserved.
  No migration, paid CPU override, plan upgrade or paid fallback was added.
- Wrangler reported **75 ms startup**, 11,268.40 KiB uncompressed upload and
  3,654.48 KiB gzip. The authenticated connector returned the exact live version
  and `pdf_text_extraction=true`, `pdf_form_values=true`, `pdf_ocr=true`.
- The Cloudflare dashboard was checked after deployment: **Free, $0, Current
  plan**; Paid still displayed Upgrade. Its AI allowance was 10,000 neurons/day.
  No upgrade control was used. The limited CLI token could not read account
  subscriptions (403); the dashboard supplied plan verification without adding
  permissions.

## CI and the deployment configuration fix

Implementation CI was already green. Adding the AI binding exposed an offline
test configuration defect: Vitest inherited the binding and attempted to open
a remote proxy without credentials. Run `38504664668` failed before Worker tests
started. This was corrected with `remoteBindings: false` and an explicit
`KDRIVE_PDF_OCR_ENABLED="false"` test binding. No Cloudflare credentials were
added to CI.

[Release CI](https://github.com/mxpf/kdrive-connector/actions/runs/38504949676)
then passed on both Ubuntu and macOS: 197 root tests, 25 Worker tests, three
workerd HTTP tests, two independent-client PDF tests, both TypeScript checks and
the build. Local Worker checks and HTTP tests also passed. The exact production
configuration passed a dry-run build before upload. CI itself never deploys.

## Synthetic uploads and actual ChatGPT flow

The 15 PDFs were pinned against the previously reviewed fixture hashes before
upload. Only those PDFs were uploaded, totaling **357,459 bytes**, into
`/Private/OCR QA 2026-10-13`. Every upload was independently downloaded and checked
for matching size and SHA-256 by the local transfer CLI. No PNG intermediates,
JSON manifests, credentials, passwords, or private documents were uploaded.
The [sanitized upload record](ocr-production-upload-2026-10-13.json) omits private
receipt locations and internal file IDs.

ChatGPT's existing kDrive plugin was refreshed with **Refresh tools**. Its
existing OAuth connection and permission settings were preserved. The actual
[ChatGPT acceptance conversation](https://chatgpt.com/c/6acef390-90d0-83e9-a5b5-349ee6ea86f2)
first checked connection status, listed only the QA folder, found the scan and
called `kdrive_read_pdf` with `ocr=true` and an independently pinned hash.
The scan returned 38,458 bytes and the expected complete SHA-256, amounts, date
and selected/unselected marks; see the [host response](ocr-chatgpt-scan-2026-10-13.md).

The other 14 PDFs were then read sequentially, once each, with their independent
hashes and explicit rotation/region options. The synthetic encrypted fixture
used only its known test password. ChatGPT reported no unexpected tool errors
and matching hashes for all 15 cases. OCR remained `review_required`; form data
was kept separate. No Adobe invocation, export URL, user download/re-upload,
automatic retry or file mutation was used by these reads.

The [host-reported release record](ocr-chatgpt-release-record-2026-10-13.md)
was compared independently against the pre-upload fixture manifest. The
[comparison results](ocr-chatgpt-comparison-2026-10-13.json) pass all 15 cases:
expected phrases (including exact numbers, punctuation and checkbox marks),
byte length, SHA-256, rotation, scope, parsed field values, checkbox provenance
and flattened-form absence of fields. Only Markdown escaping and the existing
whitespace/case normalization were removed for phrase comparison. Expected
document text was not supplied in the ChatGPT test prompts. The host rendering
and comparison are not raw MCP transport captures or a universal accuracy claim.

Four additional sequential checks passed:

| Check | Actual result |
| --- | --- |
| Encrypted scan, no password, OCR off | `PDF_PASSWORD_REQUIRED` |
| Encrypted scan, deliberately wrong synthetic password, OCR off | `PDF_PASSWORD_INCORRECT` |
| Scan, deliberately incorrect SHA-256, OCR off | `PDF_INTEGRITY_MISMATCH` |
| Forms PDF, correct SHA-256, OCR off | Text and parsed fields returned; `ocr=null` |

These deliberate rejections are passing negative checks, not unexpected failures.
No additional OCR calls were made to produce the human-readable release record.

## Limits and disable procedure

Successful production reads establish that these small synthetic fixtures fit
the deployed Free runtime. They do not measure peak native/WASM memory or certify
worst-case CPU/memory for arbitrary PDFs. Daily quota exhaustion was not induced;
there is no exact account-wide usage figure in this evidence. The prior
[binding/runtime tests](ocr-binding-runtime-2026-10-13.md) cover the unchanged
45-second deadline, cancellation, busy rejection, simulated quota errors and
recovery. They remain distinct from the production acceptance cases.

OCR is generative transcription. Review amounts, dates and marks, especially for
private financial documents. Parsed checkbox states are PDF.js normalized
appearance states, not independently verified raw `/V`; the source and
`CHECKBOX_RAW_VALUE_UNVERIFIED` warnings remain. Region output covers only its
requested region. Dense, arbitrary, rotated or malformed documents are not
guaranteed accurate by these tests.

To disable only OCR, set `KDRIVE_PDF_OCR_ENABLED="false"`, deploy the same source,
then verify `pdf_ocr=false` and `PDF_OCR_UNAVAILABLE` for an OCR request. Text and
form extraction remain available. If the whole release must be rolled back, the
previous version is `bb024983-2feb-4610-ae8a-b547707a9826`; that also removes the
new direct PDF reader. No rollback has been performed.
