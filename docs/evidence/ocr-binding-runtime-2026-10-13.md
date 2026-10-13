# Real AI binding and runtime validation — 2026-10-13

**The real AI binding, connector timeout and recovery checks passed. No connector
deployment or OCR enablement was performed. Cloudflare Workers Free is unchanged.**
Production resource enforcement and the complete ChatGPT flow remain unverified.

## What ran

The connector's existing PDF download verification, parser, renderer and OCR
adapter ran inside a local workerd SQLite Durable Object. Its `env.AI.run`
binding connected to the real Cloudflare model through Wrangler's temporary
development proxy, using the documented
[local development binding connection](https://developers.cloudflare.com/workers/local-development/).
This replaces the previous test harness's direct REST request. It does not
publish the connector, change its production bindings, or run kDrive uploads.
The development sessions were disposed after the tests.

Only fabricated PDFs were used. External fixture bytes were pinned to the
reviewed synthetic checksums; no kDrive credentials were available to the harness.
Wrangler's earlier AI-only login could not authenticate the development proxy
(HTTP 403). Max explicitly authorized adding Workers Scripts: Write to the
existing Account Read, User Read and Workers AI Write scopes. The browser and
CLI confirmed that limited sign-in; no additional service permissions or plan
upgrade were selected.

## Real binding evidence

All four representative cases matched their expected text and marks. Each used
one binding invocation. Actual responses used the `choices` contract already
accepted by the connector; no production code fix was needed.

| Synthetic case | Result | Local client wall time |
| --- | --- | ---: |
| Scan | Pass | 4,430 ms |
| Reversed checkbox pair | Pass | 2,612 ms |
| Stale raw checkbox values | Pass | 1,999 ms |
| Password-protected scan | Pass | 22,848 ms |

[Original binding report](ocr-binding-live-2026-10-13.json) records hashes, output,
image preparation, parser provenance, binding response keys and model usage.
The four calls reported 159.62 neurons. This is a binding compatibility check,
not a replacement for the earlier 15-case accuracy suite or a ChatGPT test.

## Timeout, errors and recovery

The [local fault report](ocr-runtime-local-2026-10-13.json) exercises the complete
read path with the unchanged production 45-second deadline:

- A deliberately non-returning provider caused `PDF_TIMEOUT` at **45,036 ms**.
  The signal was aborted and the provider was invoked exactly once.
- A concurrent read returned `PDF_BUSY` in 7 ms without reaching the provider.
- The next read succeeded after the timeout, confirming the busy guard released.
- An injected quota error became sanitized `PDF_OCR_FAILED` with one invocation
  and no private diagnostic text in the response. This was a simulation; the
  account's real daily allocation was not deliberately exhausted.

The [real cancellation report](ocr-binding-cancellation-2026-10-13.json) separately
uses a test-only 100 ms deadline starting at binding invocation. Rendering and
the deadline together returned `PDF_TIMEOUT` in 599 ms with an aborted signal.
A subsequent real scan completed in 2,938 ms and reported 46.51 neurons.
No automatic retry or alternate model was used. The production deadline was not
shortened for this test.

Across these two live runs there were six binding invocations, with **206.13
reported neurons** and one cancelled call whose usage was not returned. Actual
total usage is unknown. Cancellation bounds the connector's wait and discards
late output; it does not establish that Cloudflare stops computation or charging
quota for the cancelled request.

## Resource checks and their limits

The [full production bundle startup report](ocr-bundle-startup-2026-10-13.json)
was generated from a dry-run build, with local synthetic bindings and outbound
network denied. It loaded the full bundle and returned valid OAuth metadata.

| Check | Observed | What this establishes |
| --- | --- | --- |
| Full JS + WASM bundle | 11,538,837 bytes (about 11.0 MiB) | Below the documented 64 MiB Free bundle limit |
| Full-bundle local ready time | 1,322 ms | Includes local process setup/compilation; **not** Cloudflare startup CPU measurement |
| First local metadata request | 94 ms, HTTP 200 | Full-bundle local initialization succeeds |
| 15 PDF cases in local DO | All passed; mock transcription only | Actual parsing, rendering, hashes and response path work locally |
| Sampled local active time | About 0.15–2.88 s per PDF | DevTools sampling diagnostic, not Cloudflare billed CPU or worst-case cost |
| Largest post-request JS heap sample | 13.70 MiB | A sampled heap size, not peak process/isolate memory |
| Largest post-request backing storage sample | 35.18 MiB | Separate DevTools diagnostic; does not certify all native/WASM allocation |
| Unexpected outbound requests | Zero | Local test code did not reach arbitrary network destinations |

Local CPU samples ran on the user's machine, partly alongside another test
process. They are not benchmarks of Cloudflare hardware. Snapshots taken after
requests cannot establish peak memory. Small synthetic PDFs do not cover every
compressed or malicious input permitted by the file-size limit.

Cloudflare documents a [30-second default Durable Object CPU allowance](https://developers.cloudflare.com/durable-objects/platform/limits/)
and [128 MB isolate memory, one-second startup and 10 ms public Free Worker CPU](https://developers.cloudflare.com/workers/platform/limits/).
Network waiting is distinct from CPU use. The parsing/rendering stays inside the
Durable Object; no paid `cpu_ms` override was added. A local ready time greater
than one second is neither proof of violating nor satisfying the production
startup limit. Actual edge enforcement, peak memory and public Worker overhead
still require a separately authorized deployed test.

## Regression and remaining gates

All 31 focused PDF regression tests and the root TypeScript check passed after
validation. The previous complete 227-test suite and Ubuntu/macOS CI had already
passed for the unchanged production implementation (`aee6f38`). New harnesses
passed JavaScript syntax checks. The production source/configuration is unchanged.
A [fresh-generation reproduction](ocr-runtime-reproduction-2026-10-13.json) also
passed all 15 local cases and the four fault/recovery checks. It generated its
own fixtures from committed source rather than depending on the earlier
temporary PDFs. Fixture generation needed more than the harness's initial
30-second allowance on this machine; its preparation allowance is now 120
seconds, without changing any connector deadline.

The real binding gate is now satisfied for local development with remote AI.
What remains is deployment authorization, edge resource/quota validation, adding
the production AI binding and flag, and refreshing/testing the actual ChatGPT
tool flow. Checked-in `KDRIVE_PDF_OCR_ENABLED` remains false and no AI binding was
added. OCR output continues to require review.

See the [reproduction guide](../../remote/scripts/README.md). The test harness's
initial optional forced-GC diagnostic was unsupported by the local inspector;
it was removed rather than treating a failed diagnostic as a memory measurement.
