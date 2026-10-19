import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { startPdfJobHarness } from '../scripts/pdf-job-harness.mjs';

test('OCR survives separate workerd requests beyond 45 seconds; deadline, isolation and recovery remain bounded',async()=>{
  const fixtures=await Promise.all(['ordinary','password-protected'].map(async name=>({name,bytes:await readFile(new URL('../../test/fixtures/pdf/'+name+'.pdf',import.meta.url))})));
  const harness=await startPdfJobHarness(fixtures);
  try {
    const input={path:'/synthetic.pdf',ocr:true,expectedSha256:harness.inputs[0].sha256};
    const first=await harness.invoke('slow','kdrive_read_pdf',input);
    assert.equal(first.response.structuredContent.status,'pending');assert.ok(first.wallMs<10_000);
    const {jobId}=first.response.structuredContent;
    const busy=await harness.invoke('slow','kdrive_read_pdf',input);
    assert.equal(busy.response.structuredContent.error_code,'PDF_BUSY');
    const isolated=await harness.invoke('other','kdrive_get_pdf_ocr_result',{jobId});
    assert.equal(isolated.response.structuredContent.error_code,'PDF_JOB_NOT_FOUND');
    // No request remains open for the inference lifetime. waitUntil owns it.
    await new Promise(r=>setTimeout(r,46_000));
    const complete=await harness.invoke('slow','kdrive_get_pdf_ocr_result',{jobId});
    assert.ok(!complete.response.isError);
    assert.equal(complete.response.structuredContent.ocr.text,'SYNTHETIC DELAYED OCR');
    assert.equal(complete.response.structuredContent.sha256,harness.inputs[0].sha256);
    assert.equal(complete.telemetry.downloads,1);assert.equal(complete.telemetry.calls,1);
    const timeout=await harness.invoke('hang','kdrive_read_pdf',input,{mode:'hang'});
    let failed=timeout;
    for(let i=0;i<100&&failed.response.structuredContent.status==='pending';i++) {
      failed=await harness.invoke('hang','kdrive_get_pdf_ocr_result',{jobId:timeout.response.structuredContent.jobId});
    }
    assert.equal(failed.response.isError,true);
    assert.equal(failed.response.structuredContent.error_code,'PDF_TIMEOUT');
    assert.equal(failed.response.structuredContent.phase,'inference');
    assert.equal(failed.telemetry.calls,1);assert.equal(failed.telemetry.aborted,true);
    const recovery=await harness.invoke('hang','kdrive_read_pdf',{path:'/synthetic.pdf',ocr:false});
    assert.ok(!recovery.response.isError);assert.match(recovery.response.structuredContent.pages[0].text,/ORCHID-7319/);
    // Password handling and white-page fast path through the same tool/job code.
    const encrypted=await harness.invoke('encrypted','kdrive_read_pdf',{
      path:'/synthetic.pdf',ocr:true,password:'synthetic-open-password',expectedSha256:harness.inputs[1].sha256,
      ocrRegion:{x:0,y:0,width:.02,height:.02}}, {fixture:'password-protected'});
    let white=encrypted;
    while(white.response.structuredContent.status==='pending')white=await harness.invoke('encrypted','kdrive_get_pdf_ocr_result',{jobId:encrypted.response.structuredContent.jobId});
    assert.ok(!white.response.isError);assert.equal(white.response.structuredContent.ocr.text,'');
    assert.equal(white.response.structuredContent.ocr.source,'pdf_render');assert.equal(white.telemetry.calls,0);
    assert.equal(harness.outbound,0);
  } finally {await harness.dispose();}
});
