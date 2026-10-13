# Synthetic OCR acceptance set

`generate.py` creates seven **fabricated** one-page PDFs plus a manifest of known
text and form values: scan, rotated scan, mixed raster/text, 7-point small print,
German/French text, interactive form, and AES-256 encrypted scan. It does not read
user documents. Generated files are test intermediates, kept outside Git.

Use a Python environment containing ReportLab, Pillow and pypdf[crypto]:

```sh
python3 test/fixtures/ocr/generate.py /tmp/kdrive-synthetic-ocr-acceptance
node --import tsx scripts/validate-pdf-ocr.ts --fixtures /tmp/kdrive-synthetic-ocr-acceptance
```

The default runner performs local extraction/rendering only. It compares stored
form values, records hashes and writes connector-rendered PNGs for inspection.
`prepared_without_ocr` is not an OCR pass.

Live mode is separate and requires explicit authorization, a signed-in Wrangler
session with Workers AI access, and independent confirmation that the chosen
account remains on Workers Free. No account plan or deployment is changed.

```sh
node --import tsx scripts/validate-pdf-ocr.ts \
  --fixtures /tmp/kdrive-synthetic-ocr-acceptance \
  --live --free-plan-verified --account ACCOUNT_ID
```

The runner sends at most seven synthetic page images directly to Cloudflare's
Workers AI REST API using the production renderer and model adapter. It stops
at the first access/contract failure and never retries automatically. Credentials
are obtained from Wrangler into memory and are not written to the report.

Review `live-report.json` against the manifest and page images. Exact-text checks
normalize whitespace/Markdown only; manually check punctuation, amounts and
checkbox meaning. A matching phrase does not prove absence of hallucinations or
completeness. Provider timing/usage is recorded when returned. This does not test
production Worker CPU/memory, account quota exhaustion, a live kDrive upload or
the actual ChatGPT conversation. Those remain distinct acceptance gates.

Initial local execution found a single-choice field mismatch: PDF.js returned
`Business` in the form tree and `["Business"]` in the widget. Comparison now
normalizes these equivalent choice representations while preserving the returned
selection array. Different values still produce review warnings.
