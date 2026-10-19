// Explicit opt-in: one synthetic dense page through the real AI development
// binding and local workerd. No production deployment, kDrive access or retry.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startPdfJobHarness } from './pdf-job-harness.mjs';

const args=process.argv.slice(2), arg=key=>args[args.indexOf(key)+1];
assert.ok(args.includes('--live')&&args.includes('--free-plan-verified')&&args.includes('--report'));
assert.match(arg('--account'),/^[a-f0-9]{32}$/);
const temp=await mkdtemp(join(tmpdir(),'kdrive-dense-ocr-'));
const report={date:new Date().toISOString(),syntheticOnly:true,liveBinding:true,deploymentPerformed:false,requests:[]};
let session,harness;
try {
  execFileSync(process.env.KDRIVE_TEST_PYTHON??'python3',[fileURLToPath(new URL('../../test/fixtures/ocr/generate_dense.py',import.meta.url)),temp],{stdio:['ignore','ignore','pipe'],timeout:60_000});
  const manifest=JSON.parse(await readFile(join(temp,'dense-manifest.json'),'utf8'));
  assert.equal(manifest.syntheticOnly,true);
  const config=join(temp,'wrangler.json');
  await writeFile(config,JSON.stringify({name:'kdrive-ocr-job-validation',account_id:arg('--account'),compatibility_date:'2026-08-13',ai:{binding:'AI',remote:true}}));
  const {maybeStartOrUpdateRemoteProxySession}=await import('wrangler');
  session=(await maybeStartOrUpdateRemoteProxySession({path:config}))?.session;
  assert.ok(session,'Missing development proxy');
  harness=await startPdfJobHarness([{name:'dense-scan',bytes:await readFile(join(temp,'dense-scan.pdf'))}],{connection:session.remoteProxyConnectionString});
  report.fixtureSha256=harness.inputs[0].sha256;
  const began=performance.now();
  let row=await harness.invoke('dense','kdrive_read_pdf',{path:'/synthetic-dense.pdf',ocr:true,expectedSha256:report.fixtureSha256},{mode:'live'});
  const jobId=row.response.structuredContent.jobId;
  const record=()=>{report.requests.push({wallMs:row.wallMs,status:row.response.structuredContent.status??(row.response.isError?'failed':'complete'),phase:row.response.structuredContent.phase});};
  record();
  assert.equal(row.response.structuredContent.status,'pending');
  while(row.response.structuredContent.status==='pending'&&performance.now()-began<200_000){
    row=await harness.invoke('dense','kdrive_get_pdf_ocr_result',{jobId});record();
  }
  report.totalWallMs=Math.round(performance.now()-began);
  report.telemetry=row.telemetry;
  report.errorCode=row.response.structuredContent.error_code;
  assert.ok(!row.response.isError,report.errorCode);
  const result=row.response.structuredContent;
  assert.equal(result.sha256,report.fixtureSha256);
  assert.equal(row.telemetry.calls,1);assert.equal(row.telemetry.downloads,1);
  assert.equal(result.ocr.status,'review_required');
  const norm=s=>s.replace(/[\s*\x60]+/g,' ').trim().toLowerCase();
  report.outputChars=result.ocr.text.length;
  report.missingText=manifest.expected.filter(s=>!norm(result.ocr.text).includes(norm(s)));
  assert.deepEqual(report.missingText,[]);
  assert.equal(harness.outbound,0);
  report.status='passed';
} catch(error) {report.status='failed';report.failure=error.message;process.exitCode=1;}
finally {await harness?.dispose();await session?.dispose();await rm(temp,{recursive:true,force:true});await writeFile(resolve(arg('--report')),JSON.stringify(report,null,2)+'\n');}
console.log(JSON.stringify(report));
