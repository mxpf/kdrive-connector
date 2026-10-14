# Blank-page fix: production trial and rollback

**Outcome: rolled back. The two-page ChatGPT acceptance gate did not pass.**

The user authorized deploying the fix, testing the previously authorized
private PDF read-only in ChatGPT, preserving Workers Free and the original,
and rolling back on failure. This record intentionally excludes the private
document's name, path, hash, contents and financial values.

## Deployment

- Source: `423e63fe01fc7b1880b8eb81bae85848dccece2d`.
- [CI](https://github.com/mxpf/kdrive-connector/actions/runs/38508238956) passed
  on Ubuntu and macOS; the deployment dry run passed.
- Trial Worker version: `cad48531-f2c1-4a05-8cd1-bb23f7ebc6e3`, created
  2026-10-14 03:53:38 UTC (October 13 in America/New_York).
- Startup: 76 ms; bundle 11,269.24 KiB uncompressed / 3,654.73 KiB gzip.
- Cloudflare's dashboard confirmed Free, $0, Current plan after deployment.
  No plan, model, prompt, limits, dependencies, secrets, bindings or migrations
  were changed by this fix.

## Actual ChatGPT check

The existing private ChatGPT acceptance conversation verified the trial build
and `pdf_ocr=true`, then attempted exactly two sequential `kdrive_read_pdf`
calls with `ocr=true`, one page per call, and the independently verified
complete-file SHA-256. No retry was requested or performed.

1. Page 4: ChatGPT reported the blank-page validations passed. Those checks
   required zero-length text, `no_text_detected`, `source=pdf_render`,
   `model=null`, full-page scope and `allPixelsOpaqueWhite=true`. The host's
   final report did not retain individual raw metadata after the next error;
   this is a host-reported result, not a saved raw response capture.
2. Page 1: `PDF_TIMEOUT`, with the safe message "PDF retrieval or extraction
   exceeded its deadline". No OCR transcription or amount comparison was
   available. This fails the acceptance gate even though the blank-page
   condition was reported successful.

The OCR deadline remains 45 seconds. This error does not identify which phase
consumed the deadline and does not establish that the blank-page branch caused
the timeout. Nonblank-page latency needs investigation before another release
attempt. No timeout increase, automatic retry, paid fallback or new live OCR
attempt was made to turn the failure into a pass.

## Rollback and source protection

Wrangler restored `9dd6d9ed-d4a2-467f-9c97-89b9261d0e0f` to 100% of traffic.
An authenticated connector status call independently confirmed that exact build
and `pdf_ocr=true`. This restores the previous release, including its prior
blank-page behavior; the fix remains committed but is not live.

Metadata and SHA-256 checks before and after matched: original bytes, byte
length, size and modification time were unchanged. No file write, export,
upload, download/re-upload workflow or Adobe processing was used. Cloudflare
Free is unchanged. Follow-up documentation changes do not redeploy the Worker.
