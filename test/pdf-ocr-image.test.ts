import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { decode } from 'fast-png';
import { transformOcrRaster } from '../src/pdf-ocr-image.js';
import { validatePdfOptions } from '../src/pdf-extract.js';
import { renderPdfPage, renderPdfOcrPage } from '../src/pdf-render.js';

test('white margin removal preserves even one faint edge pixel and padding', () => {
  const data = new Uint8Array(100 * 100 * 4).fill(255);
  data[(50 * 100 + 50) * 4] = 0;
  data[(2 * 100 + 2) * 4] = 254;
  const result = transformOcrRaster({ data, width:100, height:100 });
  assert.deepEqual(result.preparation.crop, {x:0,y:0,width:75,height:75});
  assert.equal(result.data[(2 * 75 + 2) * 4],254);
  assert.equal(result.data[(50 * 75 + 50) * 4],0);
  assert.equal(result.preparation.scope,'full_page');
  assert.equal(result.preparation.whiteMarginsTrimmed,true);
  const blank = transformOcrRaster({data:new Uint8Array(40000).fill(255),width:100,height:100});
  assert.equal(blank.width,100); assert.equal(blank.height,100);
  assert.equal(blank.preparation.whiteMarginsTrimmed,false);
});

test('quarter-turn correction is lossless, clockwise and does not infer orientation', () => {
  const data = new Uint8Array([1,2,3,255, 4,5,6,255, 7,8,9,255, 10,11,12,255, 13,14,15,255, 16,17,18,255]);
  for (const [rotation, expected] of [[0,[1,4,7,10,13,16]],[90,[13,7,1,16,10,4]],[180,[16,13,10,7,4,1]],[270,[4,10,16,1,7,13]]] as const) {
    const result=transformOcrRaster({data,width:2,height:3},{ocrRotation:rotation});
    assert.deepEqual([...result.data].filter((_,i)=>i%4===0),expected);
    assert.equal(result.width,rotation===90||rotation===270?3:2);
  }
});

test('region coordinates use the original displayed page, before rotation, with outward rounding', () => {
  const data=new Uint8Array(10*10*4).fill(247);
  const result=transformOcrRaster({data,width:10,height:10},{ocrRegion:{x:.15,y:.25,width:.5,height:.4},ocrRotation:90});
  assert.deepEqual(result.preparation.crop,{x:1,y:2,width:6,height:5});
  assert.equal(result.width,5);assert.equal(result.height,6);
  assert.equal(result.preparation.scope,'region');
  assert.equal(result.preparation.whiteMarginsTrimmed,false);
});

test('invalid options fail before retrieval; no OCR option can silently affect an ordinary read', () => {
  for(const options of [{ocrRotation:90},{ocrRegion:{x:0,y:0,width:1,height:1}},
    {ocr:true,ocrRotation:45},{ocr:true,ocrRotation:'90'},
    {ocr:true,ocrRegion:null},{ocr:true,ocrRegion:{x:.7,y:0,width:.5,height:1}},
    {ocr:true,ocrRegion:{x:0,y:NaN,width:1,height:1}},
    {ocr:true,ocrRegion:{x:0,y:0,width:0,height:1}},
    {ocr:true,ocrRegion:{x:.5,y:0,width:1e-20,height:1}}]) {
    assert.throws(()=>validatePdfOptions(options as any),(e:any)=>e.code==='PDF_OCR_OPTIONS');
  }
  assert.doesNotThrow(()=>validatePdfOptions({ocr:true,ocrRotation:270,ocrRegion:{x:0,y:.5,width:1,height:.5}}));
});

test('real PDF renderer keeps complete-page pixels separate from OCR crops and rotation',async()=>{
  const bytes=new Uint8Array(await readFile(new URL('./fixtures/pdf/ordinary.pdf',import.meta.url)));
  const full=await renderPdfPage(bytes,1);
  const crop=await renderPdfOcrPage(bytes,1);
  const rotated=await renderPdfOcrPage(bytes,1,undefined,{ocrRotation:90});
  assert.ok(crop.width*crop.height<full.width*full.height);
  assert.equal(rotated.width,crop.height);assert.equal(rotated.height,crop.width);
  const a=decode(crop.png),b=decode(rotated.png);
  const expected=transformOcrRaster({data:new Uint8Array(a.data),width:a.width,height:a.height},{ocrRotation:90});
  assert.deepEqual(new Uint8Array(b.data),expected.data);
  assert.equal(crop.preparation?.sourceWidth,full.width);
});
