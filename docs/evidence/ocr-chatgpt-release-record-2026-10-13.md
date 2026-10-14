# ChatGPT host-reported production results

This is the completed ChatGPT assistant's rendering of its prior tool responses, retrieved from the [actual acceptance conversation](https://chatgpt.com/c/6acef390-90d0-83e9-a5b5-349ee6ea86f2). It is not a raw MCP transport log. Test prompts supplied independent hashes and options, not expected document text. All document content is synthetic. Markdown escaping is preserved as returned by the host.

# kDrive Connector — Synthetic OCR Acceptance Release Record

**Date\:** October 13, 2026
**Scope\:** `/Private/OCR QA 2026-10-13`
**Result\:** 15 OCR reads completed; 4 negative/control checks passed.
**Method\:** Previously returned connector responses only. No additional tool calls or tests.

All 15 OCR responses reported `review_required`\. The transcriptions below preserve the exact OCR text, including numbers, punctuation, checkbox marks, and line breaks.

## 1\. scan.pdf

**byteLength\:** 38458
**SHA-256\:** `72bdbb76f53eda6f9c4d2e98e6ce226042a533535ee1a0de2e989bb5142a3e44`
**OCR scope\:** full\_page
**Rotation\:** 0°
**Parsed fields\:** None

SYNTHETIC OCR TEST - NOT A REAL TAX RECORD
Fixture: CEDAR-4826
Tax year: 2025
Gross amount: \$12,345.67
Deduction: \$890.12
Net amount: \$11,455.55
Payment date: 2025-12-31
\\\[X\\\] Resident  \\\[ \\\] Nonresident

## 2\. rotated.pdf

**byteLength\:** 38382
**SHA-256\:** `1cd0cbc37e1bc4bd71453ad9a4e59fdc32585ef01f0acecbcd5d97d410b10131`
**OCR scope\:** full\_page
**Rotation\:** 270°
**Parsed fields\:** None

SYNTHETIC OCR TEST - NOT A REAL TAX RECORD
Fixture: CEDAR-4826
Tax year: 2025
Gross amount: \$12,345.67
Deduction: \$890.12
Net amount: \$11,455.55
Payment date: 2025-12-31
\\\[X\\\] Resident  \\\[ \\\] Nonresident

## 3\. mixed.pdf

**byteLength\:** 38525
**SHA-256\:** `623432857e3556923093ac332e80bd88dcc989d17f35c639ccd32e1ca9883e4c`
**OCR scope\:** full\_page
**Rotation\:** 0°
**Parsed fields\:** None
**PDF text layer\:** `MIXED TEXT LAYER: CEDAR-4826`

MIXED TEXT LAYER: CEDAR-4826
SYNTHETIC OCR TEST - NOT A REAL TAX RECORD
Fixture: CEDAR-4826
Tax year: 2025
Gross amount: \$12,345.67
Deduction: \$890.12
Net amount: \$11,455.55
Payment date: 2025-12-31
\\\[X\\\] Resident  \\\[ \\\] Nonresident

## 4\. small-print.pdf

**byteLength\:** 22428
**SHA-256\:** `16b64b1c616889873d3b36ad74872d0f9c466f8ba3b3bda264dc4816cc913077`
**OCR scope\:** full\_page
**Rotation\:** 0°
**Parsed fields\:** None

SYNTHETIC OCR TEST - NOT A REAL TAX RECORD
Fixture: CEDAR-4826
Tax year: 2025
Gross amount: \$12,345.67
Deduction: \$890.12
Net amount: \$11,455.55
Payment date: 2025-12-31
\\\[X\\\] Resident \\\[ \\\] Nonresident
Small print: 0.01 1,001.10 10,010.01 -42.50

## 5\. multilingual.pdf

**byteLength\:** 22845
**SHA-256\:** `10f8e3da8104ae8469ec51148c6943a7ca6c11563e390ecad633f88441ae5ffa`
**OCR scope\:** full\_page
**Rotation\:** 0°
**Parsed fields\:** None

SYNTHETIC OCR TEST - FICTIONAL VALUES
Name: Anna Müller
Reçu: déjà payé
Betrag: 1.234,56 EUR
Référence: ÉTÉ-2025

## 6\. forms.pdf

**byteLength\:** 9034
**SHA-256\:** `1354b161bc1808407c05ae23ebdae700e61cacd4ba6ab9da75ec5301d60bb939`
**OCR scope\:** full\_page
**Rotation\:** 0°

SYNTHETIC FORM - FICTIONAL VALUES
Entity
CEDAR TEST LLC
Gross amount
12345.67
\\\[X\\\] Resident
\\\[ \\\] Nonresident
Category
Business

**Parsed form values (separate from OCR)\:**

- `entity`\: `CEDAR TEST LLC` — stored\_value
- `amount`\: `12345.67` — stored\_value
- `resident`\: `Yes`; checked=true; provenance=`pdfjs_checkbox_state`; status=`review_required`; issue=`CHECKBOX_RAW_VALUE_UNVERIFIED`
- `nonresident`\: `Off`; checked=false; provenance=`pdfjs_checkbox_state`; status=`review_required`; issue=`CHECKBOX_RAW_VALUE_UNVERIFIED`
- `category`\: `["Business"]` — stored\_value

## 7\. forms-reversed.pdf

**byteLength\:** 9034
**SHA-256\:** `1611908171fb687e4dc94ece0885ede16f63128133c686e3e2c99f3325668cb7`
**OCR scope\:** full\_page
**Rotation\:** 0°

SYNTHETIC FORM - FICTIONAL VALUES
Entity
CEDAR TEST LLC
Gross amount
12345.67
\\\[ \\\] Resident
\\\[X\\\] Nonresident
Category
Business

**Parsed form values (separate from OCR)\:**

- `entity`\: `CEDAR TEST LLC` — stored\_value
- `amount`\: `12345.67` — stored\_value
- `resident`\: `Off`; checked=false; provenance=`pdfjs_checkbox_state`; status=`review_required`; issue=`CHECKBOX_RAW_VALUE_UNVERIFIED`
- `nonresident`\: `Yes`; checked=true; provenance=`pdfjs_checkbox_state`; status=`review_required`; issue=`CHECKBOX_RAW_VALUE_UNVERIFIED`
- `category`\: `["Business"]` — stored\_value

## 8\. forms-empty.pdf

**byteLength\:** 9034
**SHA-256\:** `a882d725f9dd7364840c332f1f3b058d8483a44646782939f75ceb9152534b21`
**OCR scope\:** full\_page
**Rotation\:** 0°

SYNTHETIC FORM - FICTIONAL VALUES
Entity
CEDAR TEST LLC
Gross amount
12345.67
\\\[ \\\] Resident
\\\[ \\\] Nonresident
Category
Business

**Parsed form values (separate from OCR)\:**

- `entity`\: `CEDAR TEST LLC` — stored\_value
- `amount`\: `12345.67` — stored\_value
- `resident`\: `Off`; checked=false; provenance=`pdfjs_checkbox_state`; status=`review_required`; issue=`CHECKBOX_RAW_VALUE_UNVERIFIED`
- `nonresident`\: `Off`; checked=false; provenance=`pdfjs_checkbox_state`; status=`review_required`; issue=`CHECKBOX_RAW_VALUE_UNVERIFIED`
- `category`\: `["Business"]` — stored\_value

## 9\. forms-both.pdf

**byteLength\:** 9034
**SHA-256\:** `b02f97c44bb68f6810af3f929f0a9ba0d0bb79f4f66899c2f0f1b1ef4ada4a01`
**OCR scope\:** full\_page
**Rotation\:** 0°

SYNTHETIC FORM - FICTIONAL VALUES
Entity
CEDAR TEST LLC
Gross amount
12345.67
\\\[X\\\] Resident
\\\[X\\\] Nonresident
Category
Business

**Parsed form values (separate from OCR)\:**

- `entity`\: `CEDAR TEST LLC` — stored\_value
- `amount`\: `12345.67` — stored\_value
- `resident`\: `Yes`; checked=true; provenance=`pdfjs_checkbox_state`; status=`review_required`; issue=`CHECKBOX_RAW_VALUE_UNVERIFIED`
- `nonresident`\: `Yes`; checked=true; provenance=`pdfjs_checkbox_state`; status=`review_required`; issue=`CHECKBOX_RAW_VALUE_UNVERIFIED`
- `category`\: `["Business"]` — stored\_value

## 10\. forms-flattened.pdf

**byteLength\:** 32502
**SHA-256\:** `3ebbb11022e692acd12917f732d476bd34d37248552c1006dc819ad2689c9cf1`
**OCR scope\:** full\_page
**Rotation\:** 0°
**Parsed fields\:** None (`[]`\)

SYNTHETIC FORM - FICTIONAL VALUES
Entity
CEDAR TEST LLC
Gross amount
12345.67
\\\[X\\\] Resident
\\\[ \\\] Nonresident
Category
Business

The values above were returned through OCR, not as parsed form fields.

## 11\. forms-stale.pdf

**byteLength\:** 9053
**SHA-256\:** `04dd565fac83c3431267c4e111c68380ea9e9c05ad63051635ce9fbee9005c94`
**OCR scope\:** full\_page
**Rotation\:** 0°

SYNTHETIC FORM - FICTIONAL VALUES
Entity
CEDAR TEST LLC
Gross amount
12345.67
\\\[X\\\] Resident
\\\[ \\\] Nonresident
Category
Business

**Parsed form values (separate from OCR)\:**

- `entity`\: `CEDAR TEST LLC` — stored\_value
- `amount`\: `12345.67` — stored\_value
- `resident`\: `Yes`; checked=true; provenance=`pdfjs_checkbox_state`; status=`review_required`; issue=`CHECKBOX_RAW_VALUE_UNVERIFIED`
- `nonresident`\: `Off`; checked=false; provenance=`pdfjs_checkbox_state`; status=`review_required`; issue=`CHECKBOX_RAW_VALUE_UNVERIFIED`
- `category`\: `["Business"]` — stored\_value

The connector did not independently verify visible form appearances or raw checkbox storage.

## 12\. encrypted-scan.pdf

**byteLength\:** 39607
**SHA-256\:** `21b4f93a4d038b9aba86c89a0ea8a85650068be57367a8386f40071e033c747e`
**OCR scope\:** full\_page
**Rotation\:** 0°
**Parsed fields\:** None

SYNTHETIC OCR TEST - NOT A REAL TAX RECORD
Fixture: CEDAR-4826
Tax year: 2025
Gross amount: \$12,345.67
Deduction: \$890.12
Net amount: \$11,455.55
Payment date: 2025-12-31
\\\[X\\\] Resident  \\\[ \\\] Nonresident

## 13\. sideways-heldout.pdf

**byteLength\:** 35700
**SHA-256\:** `ef8fc88983460a0eb8fddcb0368c69a62d6f27111042789663c9a3d876c15983`
**OCR scope\:** full\_page
**Rotation\:** 90°
**Parsed fields\:** None

SYNTHETIC INVOICE - FICTIONAL
Invoice: MAPLE-9361
Date: 2026-04-09
Subtotal: 8,008.80
Adjustment: -0.05
\\\[ \\\] Approved \\\[X\\\] Pending

## 14\. upside-down-heldout.pdf

**byteLength\:** 26126
**SHA-256\:** `da1c5d2c4ff26b1dec5f03cae5ee9fb818ebc1ec099066a0d7472919d5e5e727`
**OCR scope\:** full\_page
**Rotation\:** 180°
**Parsed fields\:** None

SYNTHETIC INVOICE - FICTIONAL
Invoice: MAPLE-9361
Date: 2026-04-09
Subtotal: 8,008.80
Adjustment: -0.05
\\\[ \\\] Approved \\\[X\\\] Pending

## 15\. region-heldout.pdf

**byteLength\:** 17697
**SHA-256\:** `a9b320e79d97c3ea1f21e43fe8af1db10c76f9746e2a5faa5568e82191ad240e`
**OCR scope\:** region
**Rotation\:** 0°
**Selected region\:** x=0.5, y=0.57, width=0.4, height=0.11
**Parsed fields\:** None

SYNTHETIC REGION
Invoice: BIRCH-2750
Credit: 7,070.07
Fee: -0.09
\\\[X\\\] Verified  \\\[ \\\] Pending

The OCR transcription covers only the selected region, not the complete page.

---

## Connector warnings

These are the five distinct warnings returned across the OCR acceptance suite, consolidated without duplication.

1. Reading order and table layout may differ from the visual PDF. Images and non-form annotations are not extracted as text.
2. Text/choice values are stored PDF values; checkbox states have separate provenance. Values are not visually verified. Stale appearances, hidden/non-widget fields, signatures and scripts are not evaluated. Review fields marked review\_required; password fields are redacted.
3. Checkbox values are PDF.js normalized states, which may come from /AS rather than raw /V. They are marked CHECKBOX\_RAW\_VALUE\_UNVERIFIED; matching tree/widget values do not independently verify raw storage or visible marks.
4. OCR is an unverified visual transcription and may omit or invent text. Check amounts, dates and selected marks. OCR does not override stored form values; resolve discrepancies before relying on either.
5. OCR covers only the explicitly selected region, not the complete page. Text and stored form values still cover the selected page.

## Final negative/control outcomes

| Check | Actual outcome | Result |
|--------|--------|--------|
| 1\. Encrypted PDF, no password | `PDF_PASSWORD_REQUIRED` | PASS |
| 2\. Encrypted PDF, incorrect password | `PDF_PASSWORD_INCORRECT` | PASS |
| 3\. PDF with incorrect expected SHA-256 | `PDF_INTEGRITY_MISMATCH` | PASS |
| 4\. Valid forms.pdf, OCR disabled | Parsed text and five form fields returned; `ocr=null`; SHA-256 matched | PASS |

**Final release acceptance result: PASS — 15/15 OCR responses completed and 4/4 negative/control checks behaved as expected.**

All operations were read-only, sequential, and limited to the authorized QA folder. No additional calls were made for this release record.
