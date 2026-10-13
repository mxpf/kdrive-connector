import test from 'node:test';
import assert from 'node:assert/strict';
import { extractPdf } from '../src/pdf-extract.js';
import { extractFormFields } from '../src/pdf-forms.js';

function formPdf(extra = '', fieldValue = 'SYNTHETIC VALUE', checked = true, singleChoice = false) {
  // Hierarchical text field, checkbox, multiselect, radio group, empty/default,
  // redacted password, orphan widget and an unsupported signature. All synthetic.
  const objects = [
    `<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [4 0 R 6 0 R 8 0 R 9 0 R 12 0 R 13 0 R 14 0 R] ${extra} >> >>`,
    '<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Annots [5 0 R 6 0 R 7 0 R 8 0 R 10 0 R 11 0 R 12 0 R 13 0 R 14 0 R] >>',
    `<< /FT /Tx /T (person) /V (${fieldValue}) /Kids [5 0 R] >>`,
    '<< /Type /Annot /Subtype /Widget /Parent 4 0 R /Rect [10 10 200 30] /P 3 0 R >>',
    `<< /Type /Annot /Subtype /Widget /FT /Btn /T (checked) /V /${checked ? 'Yes' : 'Off'} /AS /${checked ? 'Yes' : 'Off'} /Rect [10 40 30 60] /P 3 0 R >>`,
    '<< /Type /Annot /Subtype /Widget /FT /Tx /T (orphan) /V (UNTRUSTED) /Rect [10 70 200 90] /P 3 0 R >>',
    `<< /Type /Annot /Subtype /Widget /FT /Ch /T (choices) /Ff ${singleChoice ? 131072 : 2097152} /Opt [(A) (B) (C)] /V ${singleChoice ? '(B)' : '[(A) (C)]'} /Rect [10 100 200 120] /P 3 0 R >>`,
    '<< /FT /Btn /T (radio) /Ff 32768 /V /B /Kids [10 0 R 11 0 R] >>',
    '<< /Type /Annot /Subtype /Widget /Parent 9 0 R /AS /Off /AP << /N << /Off 15 0 R /A 15 0 R >> >> /Rect [10 130 30 150] /P 3 0 R >>',
    '<< /Type /Annot /Subtype /Widget /Parent 9 0 R /AS /B /AP << /N << /Off 15 0 R /B 15 0 R >> >> /Rect [50 130 70 150] /P 3 0 R >>',
    '<< /Type /Annot /Subtype /Widget /FT /Tx /T (empty) /DV (DEFAULT MUST NOT REPLACE EMPTY) /V () /Rect [10 160 200 180] /P 3 0 R >>',
    '<< /Type /Annot /Subtype /Widget /FT /Tx /T (secret) /Ff 8192 /V (MUST-REDACT) /Rect [10 190 200 210] /P 3 0 R >>',
    '<< /Type /Annot /Subtype /Widget /FT /Sig /T (signature) /Rect [10 220 200 240] /P 3 0 R >>',
    '<< /Type /XObject /Subtype /Form /BBox [0 0 20 20] /Length 0 >>\nstream\n\nendstream',
    '<< /Length 11 >>\nstream\n<template/>\nendstream',
  ];
  let pdf = '%PDF-1.7\n'; const offsets = [0];
  for (const [i, obj] of objects.entries()) { offsets.push(pdf.length); pdf += `${i+1} 0 obj\n${obj}\nendobj\n`; }
  const xref = pdf.length;
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets.slice(1).map(o => `${String(o).padStart(10,'0')} 00000 n \n`).join('')}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(pdf, 'latin1'));
}

test('real PDF parser extracts inherited values, choices, checkbox/radio selections and explicit empty values', async () => {
  const result = await extractPdf(formPdf());
  const fields = result.pages[0].formFields;
  const field = (name: string) => fields.find(f => f.name === name)!;
  assert.equal(field('person').value, 'SYNTHETIC VALUE');
  assert.equal(field('person').status, 'stored_value');
  assert.deepEqual(field('choices').value, ['A', 'C']);
  assert.equal(field('checked').checked, true);
  assert.equal(field('checked').valueSource,'pdfjs_checkbox_state');
  assert.equal(field('checked').status,'review_required');
  assert.deepEqual(fields.filter(f => f.name === 'radio').map(f => [f.exportValue, f.checked]), [['A',false],['B',true]]);
  assert.equal(field('empty').value, '');
  assert.equal(field('secret').value, null);
  assert.equal(field('secret').status, 'redacted');
  assert.ok(!JSON.stringify(result).includes('MUST-REDACT'));
  assert.equal(field('orphan').status, 'review_required');
  assert.ok(field('orphan').issues.includes('ORPHAN_WIDGET'));
  assert.ok(field('signature').issues.includes('UNSUPPORTED_FIELD_TYPE'));
  assert.equal(result.forms.appearanceVerified, false);
});

test('a checkbox whose raw value disagrees with its appearance state is never claimed as a verified stored value',async()=>{
  const original=formPdf();
  const stale=new Uint8Array(Buffer.from(Buffer.from(original).toString('latin1').replace('/V /Yes /AS /Yes','/V /Off /AS /Yes'),'latin1'));
  assert.equal(stale.length,original.length); // Preserve synthetic xref offsets.
  const result=await extractPdf(stale);
  const field=result.pages[0].formFields.find(f=>f.name==='checked')!;
  assert.equal(field.value,'Yes'); // PDF.js prefers /AS, even though raw /V is Off.
  assert.equal(field.checked,true);
  assert.equal(field.valueSource,'pdfjs_checkbox_state');
  assert.equal(field.status,'review_required');
  assert.ok(field.issues.includes('CHECKBOX_RAW_VALUE_UNVERIFIED'));
  assert.match(result.warnings.join(' '),/rather than raw \/V/);
});

test('contradictory widgets, scripts, prototype-like names and unsupported values are marked for review', () => {
  const base = { subtype:'Widget', id:'1', fieldName:'amount', fieldType:'Tx', fieldValue:'100' };
  const tree = { amount: [{ id:'1', value:'200' }, { id:'2', value:'300' }] };
  const [field] = extractFormFields([{ ...base, actions: { Format: ['private script'] } }], tree);
  assert.ok(field.issues.includes('TREE_WIDGET_VALUE_MISMATCH'));
  assert.ok(field.issues.includes('CONFLICTING_FIELD_VALUES'));
  assert.ok(field.issues.includes('SCRIPTED_FIELD_NOT_EVALUATED'));
  assert.equal(field.status, 'review_required');
  assert.ok(!JSON.stringify(field).includes('private script'));
  assert.equal(extractFormFields([{ ...base, fieldName:'constructor' }], {})[0].status,'review_required');
  assert.equal(extractFormFields([{ ...base, fieldValue: { secret:'not a scalar' } }], null)[0].value, null);
});

test('form payloads share the bounded text output budget', async () => {
  await assert.rejects(extractPdf(formPdf('', 'X'.repeat(100001))), (e: any) => e.code === 'PDF_OUTPUT_LIMIT');
});

test('unchecked fields stay false, Unicode values survive, and XFA is explicitly unsupported', async () => {
  const unicode = '\\376\\377\\000M\\000\\374\\000l\\000l\\000e\\000r';
  const result = await extractPdf(formPdf('/XFA [(template) 16 0 R]', unicode, false));
  assert.equal(result.pages[0].formFields.find(f => f.name === 'person')?.value, 'Müller');
  assert.equal(result.pages[0].formFields.find(f => f.name === 'checked')?.checked, false);
  assert.equal(result.forms.xfaPresent, true);
  assert.match(result.warnings.join(' '), /XFA forms are unsupported/);
});

test('single-select choices compare scalar tree values to widget arrays without false conflicts', async () => {
  const result = await extractPdf(formPdf('', 'SYNTHETIC', true, true));
  const field = result.pages[0].formFields.find(f => f.name === 'choices')!;
  assert.deepEqual(field.value, ['B']);
  assert.equal(field.status, 'stored_value');
  assert.deepEqual(field.issues, []);
  const widget = {subtype:'Widget', id:'1',fieldName:'choice',fieldType:'Ch',fieldValue:['B']};
  assert.equal(extractFormFields([widget], {choice:[{id:'1',value:'C'}]})[0].status,'review_required');
  assert.equal(extractFormFields([{...widget,fieldType:'Tx'}], {choice:[{id:'1',value:'B'}]})[0].status,'review_required');
});
