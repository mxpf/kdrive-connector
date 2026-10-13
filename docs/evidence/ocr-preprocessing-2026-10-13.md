# OCR orientation and small-text follow-up — 2026-10-13

**Result: scan improvements implemented; OCR still disabled and undeployed.**
The final run matched nine of ten cases. Filled-form visual checkbox recognition
remains unreliable; all stored AcroForm values were correct.

## What changed

The previous whole-page image included large blank margins. Removing only
fully opaque pure-white margins, without removing any nonwhite pixel, made the
small-print fixture readable to the model. This supports the explanation that
the model lost detail when text occupied too little of the submitted image;
it does not establish the model's internal resizing behavior.

Rendering still obeys the two-million-pixel bound. It adds no sharpening,
thresholding, invented detail or additional inference. New optional controls:

- `ocrRotation`: explicit clockwise correction, after the PDF's display rotation.
- `ocrRegion`: a bounded rectangle in displayed-page fractions before correction.
  The response identifies region scope and never claims it covers the full page.

Both require `ocr=true`. The connector does not guess orientation or automatically
try multiple regions. Every call still verifies the complete source bytes and
preserves original text/stored fields separately. All OCR output requires review.

## Final live run

The production prompt, renderer and adapter were exercised against Cloudflare AI
with a fixture-backed kDrive client. Every response was HTTP 200 with `stop`.

| Case | Preparation | Result | Wall time |
| --- | --- | --- | --- |
| Ordinary scan | White margins removed | All expected text/marks matched | 1,964 ms |
| PDF-rotated scan | Explicit 270° correction, margins removed | Previously incorrect amounts now matched | 2,855 ms |
| Mixed text/image | Margins removed | Both content sources matched | 2,110 ms |
| 7-point small print | Margins removed; 399 × 245 output | All amounts, punctuation, dates and bracketed marks matched | 1,572 ms |
| German/French | Margins removed | Accents and formatted amount matched | 943 ms |
| Filled form | Margins removed | Text and all five stored fields matched; visual checkbox states omitted | 910 ms |
| AES-256 protected scan | Authorized synthetic password, margins removed | Expected text/marks matched | 2,037 ms |
| Independent sideways scan | Image rotated, no PDF rotation flag; explicit 90° correction | New values and opposite bracketed selections matched | 1,691 ms |
| Independent upside-down scan | Explicit 180° correction | New values and marks matched | 1,052 ms |
| Independent small-text region | Off-white background; explicit bottom-right rectangle | Region text/marks matched; outside heading excluded | 795 ms |

The final run used **286.8182 neurons**. All work in this follow-up used **23
requests / 653.7909 neurons**, including failed diagnostics. Combined with the
earlier session's nine calls, recorded task usage was about **917 neurons**.
Other account usage is not included. Workers Free remains the plan; there was
no upgrade, automatic retry, paid fallback or deployment. The documented
[Free allocation](https://developers.cloudflare.com/workers-ai/platform/pricing/)
is 10,000 neurons/day.

## Failed checkbox investigations

A more explicit mark-formatting prompt misclassified the empty box as selected
and omitted other form content. The original prompt retained the form text but
omitted selection marks. A shorter prompt and a tightly cropped checkbox region
also failed. None justified a production prompt change. The final code retains
the original transcription prompt and separate stored values.

The test checker requires both `[X] Resident` and `[ ] Nonresident`; labels alone
cannot pass. Its nonzero live-run exit is intentional. A 90% fixture match is not
a reliability guarantee or permission to enable OCR.

## Evidence and limits

- [Original final response report](ocr-preprocessing-2026-10-13.json): all ten
  fixture hashes, preparation metadata, transcripts, model prompt, envelopes,
  timing and usage. Contains only fictional data, no account identity or secrets.
- [Diagnostic evidence](ocr-checkbox-diagnostics-2026-10-13.json): the form
  results from the first experiment and three focused trials, plus their total
  request counts/usage. The first experiment's passing scan cases are omitted
  from this compact diagnostic record; their usage is included.
- Local tests cover lossless rotation, faint edge pixels, blank/off-white pages,
  coordinate rounding, invalid options, real PDF rendering, MCP scope/integrity,
  and the same transformations in local workerd with zero outbound requests.
- Captured-response regression tests replay the successes and **continue to
  reject** visual form marks. Local test success is not live OCR acceptance.

Production resource limits, actual Worker binding behavior and the deployed
ChatGPT conversation remain unverified. Explicit corrections were selected from
known fixture layout/orientation; automatic detection is outside this change.
