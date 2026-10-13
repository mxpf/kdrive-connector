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

test('improved live evidence matches corrected scans and explicit regions but still rejects visual form marks',async()=>{
  const improved=JSON.parse(await readFile(new URL('../docs/evidence/ocr-preprocessing-2026-10-13.json',import.meta.url),'utf8'));
  assert.equal(improved.cases.length,10);
  const failed:string[]=[];
  for(const row of improved.cases) {
    const actual=await cloudflareOcrProvider({run:async()=>row.provider.result})
      .recognize(new Uint8Array(),new AbortController().signal);
    assert.equal(actual,row.ocr.text);
    if(missingOcrText(row.expectedText,actual).length) failed.push(row.name);
    assert.equal(row.ocr.status,'review_required');
    assert.equal(row.ocr.preparation.rotation,row.ocrOptions.ocrRotation??0);
    if(row.name==='region-heldout') {
      assert.equal(row.ocr.preparation.scope,'region');
      assert.ok(!actual.includes('OUTSIDE REQUESTED REGION'));
    }
    if(row.name==='forms') assert.deepEqual(row.formMismatches,[]);
  }
  assert.deepEqual(failed,['forms']);
});
