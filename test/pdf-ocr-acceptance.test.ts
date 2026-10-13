import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { missingOcrText } from '../scripts/lib/ocr-acceptance.js';
import { cloudflareOcrProvider } from '../src/pdf-ocr.js';

const report = JSON.parse(await readFile(new URL('../docs/evidence/ocr-live-2026-10-13.json', import.meta.url), 'utf8'));

test('recorded live envelopes decode; altered amounts and omitted checkbox states fail acceptance', async () => {
  const failed: string[] = [];
  for (const row of report.cases) {
    const actual = await cloudflareOcrProvider({ run: async () => row.provider.result })
      .recognize(new Uint8Array(), new AbortController().signal);
    assert.equal(actual, row.ocr.text);
    // Original phrase checks only required the form labels. These did not
    // establish selected marks; require both checked and unchecked states.
    const expected = row.name === 'forms'
      ? [...row.expectedText, '[X] Resident', '[ ] Nonresident'] : row.expectedText;
    const missing = missingOcrText(expected, actual);
    if (missing.length) failed.push(row.name);
    if (row.name === 'rotated') assert.ok(missing.includes('Gross amount: $12,345.67'));
    if (row.name === 'forms') assert.deepEqual(missing, ['[X] Resident', '[ ] Nonresident']);
  }
  assert.deepEqual(failed, ['rotated', 'small-print', 'forms']);
});
