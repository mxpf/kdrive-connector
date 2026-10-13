# OCR predeployment validation

These scripts never deploy the connector. Production configuration remains
unchanged. They use local workerd with a SQLite Durable Object and bundled WASM.
They accept no kDrive access token or arbitrary document URL.

Install root and remote dependencies first. Fixture generation requires Python
with ReportLab, Pillow, pypdf[crypto], and Poppler `pdftoppm` on PATH. Set
`KDRIVE_TEST_PYTHON` if the required Python is not `python3`.

## Local pipeline, resource diagnostics and faults

From the repository root:

```sh
node remote/scripts/validate-ocr-runtime.mjs --report /tmp/ocr-runtime-local.json
```

The script generates fabricated fixtures from committed code in a temporary
directory, then removes them. All 15 pages are parsed/rendered; transcription is
mocked and no AI calls are made. It verifies a real 45-second timeout, concurrent
read rejection, sanitized simulated quota errors and recovery. The deadline
test deliberately takes at least 45 seconds. Preparation has its own bounded
120-second allowance, independent of the connector's PDF deadline.

Optional `--fixtures DIRECTORY` reuses the exact bytes from the recorded checkbox
suite and rejects mismatching hashes. Newly generated encrypted PDFs normally
have different hashes because encryption uses randomness; omit this option to
generate a fresh suite safely.

## Real binding

Only run after authorization for synthetic inference, with a verified Workers
Free account and a Wrangler login having Account Read, User Read, Workers AI
Write and Workers Scripts Write. The latter lets Wrangler establish its
temporary development proxy; it is not permission to deploy the connector.

```sh
node remote/scripts/validate-ocr-runtime.mjs \
  --report /tmp/ocr-binding-live.json \
  --live --free-plan-verified --account ACCOUNT_ID

node remote/scripts/validate-ocr-runtime.mjs \
  --report /tmp/ocr-binding-cancellation.json \
  --live --cancel-only --free-plan-verified --account ACCOUNT_ID
```

The first command makes at most four binding calls. The second makes one
deliberately cancelled call and one recovery call. They stop on assertion
failure, never retry automatically, and dispose development sessions. Cancelled
inference may continue upstream and consume unreported quota. Credentials and
proxy connection strings are never written to the evidence. The reports contain
synthetic extracted content, usage and diagnostic memory samples.

## Full bundle startup

Create a **dry-run-only** bundle with Wrangler into a temporary output directory,
then pass that directory to:

```sh
node remote/scripts/validate-bundle-startup.mjs \
  /tmp/kdrive-dry-build /tmp/ocr-bundle-startup.json
```

This loads the full bundle, using only local bindings, verifies its size and
reads public OAuth metadata locally with outbound network denied. Local ready
time includes process setup and compilation; it does not measure Cloudflare's
production startup CPU limit. Neither script certifies production CPU or peak
native/WASM memory. Do not infer that ChatGPT has discovered or tested OCR from
these results.
