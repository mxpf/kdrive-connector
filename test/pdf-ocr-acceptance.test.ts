import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { missingOcrText } from '../scripts/lib/ocr-acceptance.js';
import { cloudflareOcrProvider } from '../src/pdf-ocr.js';

const report = JSON.parse(await readFile(new URL('../docs/evidence/ocr-live-2026-10-13.json', import.meta.url), 'utf8'));

test('historical Moondream evidence retains altered-amount and omitted-checkbox acceptance failures', async () => {
  const failed: string[] = [];
  for (const row of report.cases) {
    const actual = row.provider.result.result.answer; // Historical Moondream evidence, not the current adapter.
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

test('Qwen live evidence recognizes checkbox combinations and scans without substituting normalized form data',async()=>{
  const fixed=JSON.parse(await readFile(new URL('../docs/evidence/ocr-checkbox-2026-10-13.json',import.meta.url),'utf8'));
  assert.equal(fixed.cases.length,15);
  for(const row of fixed.cases) {
    const actual=await cloudflareOcrProvider({run:async()=>row.provider.result})
      .recognize(new Uint8Array(),new AbortController().signal);
    assert.equal(actual,row.ocr.text);
    assert.deepEqual(missingOcrText(row.expectedText,actual),[],row.name);
    assert.equal(row.provider.finishReason,'stop');
    assert.equal(row.ocr.status,'review_required');
    assert.deepEqual(row.formMismatches??[],[],row.name);
    for(const field of row.formFields.filter((f:any)=>f.valueSource==='pdfjs_checkbox_state')) {
      assert.equal(field.status,'review_required');
      assert.ok(field.issues.includes('CHECKBOX_RAW_VALUE_UNVERIFIED'));
    }
  }
  const get=(name:string)=>fixed.cases.find((c:any)=>c.name===name);
  for(const [name,resident,nonresident] of [['forms',true,false],['forms-reversed',false,true],['forms-empty',false,false],['forms-both',true,true],['forms-flattened',true,false],['forms-stale',true,false]] as const) {
    const text=get(name).ocr.text;
    for(const [label,checked] of [['Resident',resident],['Nonresident',nonresident]] as const) {
      const states=[...text.matchAll(new RegExp('\\[\\s*([xX]?)\\s*\\]\\s*'+label+'\\b','g'))].map(m=>Boolean(m[1]));
      assert.deepEqual(states,[checked],`${name}: ${label} must have exactly one correct state`);
    }
  }
  assert.deepEqual(get('forms-flattened').formFields,[]);
  const stale=get('forms-stale');
  assert.deepEqual(stale.independentRawCheckboxValues,{resident:'/Off',nonresident:'/Yes'});
  assert.equal(stale.formFields.find((f:any)=>f.name==='resident').value,'Yes');
});

test('improved live evidence matches corrected scans and explicit regions but still rejects visual form marks',async()=>{
  const improved=JSON.parse(await readFile(new URL('../docs/evidence/ocr-preprocessing-2026-10-13.json',import.meta.url),'utf8'));
  assert.equal(improved.cases.length,10);
  const failed:string[]=[];
  for(const row of improved.cases) {
    const actual=row.provider.result.result.answer; // Historical model output.
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
