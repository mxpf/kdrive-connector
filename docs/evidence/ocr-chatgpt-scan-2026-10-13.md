# ChatGPT scan acceptance — 2026-10-13

Source: the completed assistant response in the actual [ChatGPT acceptance conversation](https://chatgpt.com/c/6acef390-90d0-83e9-a5b5-349ee6ea86f2), retrieved after completion. This is a host response, not a raw MCP transport log. All document data below is synthetic.

(Acceptance test completed)

The kDrive Connector successfully read `scan.pdf` and returned OCR output. The SHA-256 matched the expected value exactly. No files were modified, and no fallback methods were used.

## 1\. Connector status

| Property | Actual result |
|--------|--------|
| Connected | `true` |
| Drive status | `ok` |
| Connector version | `0.3.1` |
| Build capability revision | `2026-10-13.7` |
| PDF OCR capability | `true` |
| Folder listing | Successful |
| Target file found | `scan.pdf` |
| OCR operation | Successful |
| OCR review status | `review_required` |

## 2\. Complete OCR transcription

This is the exact text returned by the connector's OCR field, including line breaks.

Page 1 — OCR output [Copy]

SYNTHETIC OCR TEST - NOT A REAL TAX RECORD
Fixture: CEDAR-4826
Tax year: 2025
Gross amount: \$12,345.67
Deduction: \$890.12
Net amount: \$11,455.55
Payment date: 2025-12-31
\[X\] Resident  \[ \] Nonresident

## 3\. File integrity and extraction metadata

| Field | Actual value |
|--------|--------|
| File | `scan.pdf` |
| Directory | `/Private/OCR QA 2026-10-13` |
| byteLength | `38458` |
| Total pages | `1` |
| Page processed | `1` |
| OCR source | `cloudflare_workers_ai` |
| OCR model | `@cf/qwen/qwen3.8-27b` |
| OCR status | `review_required` |
| PDF text layer | `no_text` |
| OCR scope | `full_page` |
| Rotation | `0°` |
| White margins trimmed | `true` |
| Form fields | `[]` |

**Actual SHA-256\:**

72bdbb76f53eda6f9c4d2e98e6ce226042a533535ee1a0de2e989bb5142a3e44

Exact match with expected SHA-256

## 4\. All returned warnings

The connector returned four warnings, reproduced verbatim\:

1. Reading order and table layout may differ from the visual PDF. Images and non-form annotations are not extracted as text.
2. Text/choice values are stored PDF values; checkbox states have separate provenance. Values are not visually verified. Stale appearances, hidden/non-widget fields, signatures and scripts are not evaluated. Review fields marked review\_required; password fields are redacted.
3. Checkbox values are PDF.js normalized states, which may come from /AS rather than raw /V. They are marked CHECKBOX\_RAW\_VALUE\_UNVERIFIED; matching tree/widget values do not independently verify raw storage or visible marks.
4. OCR is an unverified visual transcription and may omit or invent text. Check amounts, dates and selected marks. OCR does not override stored form values; resolve discrepancies before relying on either.

## 5\. Acceptance assessment

| Test | Result |
|--------|--------|
| Connector connection | Pass |
| Scoped folder listing | Pass |
| `kdrive_read_pdf` available | Pass |
| OCR returned for page 1 | Pass |
| Complete OCR field returned | Pass |
| SHA-256 verification | Pass |
| Source and model reported | Pass |
| Warnings reported | Pass |
| Independent transcription accuracy | Not assessed |

**Final result: PASS for this single-file connector acceptance test.**

The connector successfully performed native PDF OCR against the exact requested file, verified its integrity, and returned the transcription with provenance and warnings.

The OCR itself remains marked `review_required`\. The result establishes successful execution and complete response delivery, not independently verified character-level transcription accuracy.

No Adobe integration, export URL, manual download, re-upload, retry, or write operation was used.
