import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as flush } from 'node:timers/promises';
import { readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { PdfReadJobs, PDF_JOB_LIMITS } from '../src/pdf-jobs.js';
import { PdfReadError } from '../src/pdf-extract.js';
import { registerPdfTools, type PdfReadResult } from '../src/pdf-tools.js';
import type { KDriveClient } from '../src/kdrive-client.js';

const result = { sha256:'synthetic', ocr:{text:'SYNTHETIC RESULT'} } as PdfReadResult;
const code = (c:string) => (e:any) => {assert.equal(e.code,c);return true;};

test('a read lasting beyond the old deadline completes through polling with one inference', async t => {
  t.mock.timers.enable({apis:['setTimeout','Date']});
  let resolve!: (r:PdfReadResult)=>void, calls=0, alive:Promise<unknown>|undefined;
  const jobs=new PdfReadJobs({keepAlive:p=>{alive=p;}});
  const starting=jobs.start(async (_signal,stage)=>{calls++;stage('inference');return new Promise(r=>{resolve=r;});});
  await flush();t.mock.timers.tick(PDF_JOB_LIMITS.initialWaitMs);
  const pending=await starting;
  assert.equal(pending.status,'pending');
  if(pending.status!=='pending')throw new Error('Expected pending');
  assert.equal(pending.phase,'inference');
  await assert.rejects(jobs.start(async()=>result),code('PDF_BUSY'));
  const poll=jobs.get(pending.jobId);t.mock.timers.tick(PDF_JOB_LIMITS.pollWaitMs);
  assert.equal((await poll).status,'pending');
  t.mock.timers.tick(60_000);resolve(result);await alive;
  const complete=await jobs.get(pending.jobId);
  assert.equal(complete.status,'complete');
  if(complete.status==='complete')assert.equal(complete.result,result);
  assert.equal(calls,1);
  assert.ok(complete.elapsedMs>45_000);
});

test('deadline is absolute across polls, aborts inference, sanitizes failure and permits recovery', async t=>{
  t.mock.timers.enable({apis:['setTimeout','Date']});
  let signal!:AbortSignal, alive:Promise<unknown>|undefined;
  const jobs=new PdfReadJobs({keepAlive:p=>{alive=p;}});
  const start=jobs.start(async(s,stage)=>{signal=s;stage('inference');return new Promise(()=>{});});
  await flush();t.mock.timers.tick(1500);const first=await start;
  for(let i=0;i<3;i++){const poll=jobs.get(first.jobId);t.mock.timers.tick(10_000);assert.equal((await poll).status,'pending');}
  t.mock.timers.tick(180_000-31_500);await alive;
  const failed=await jobs.get(first.jobId);
  assert.equal(failed.status,'failed');assert.equal(signal.aborted,true);
  if(failed.status==='failed'){assert.equal(failed.error_code,'PDF_TIMEOUT');assert.equal(failed.phase,'inference');}
  assert.equal((await jobs.start(async()=>result)).status,'complete');
  const unsafe=await jobs.start(async()=>{throw new Error('PRIVATE DOCUMENT DETAIL');});
  assert.equal(unsafe.status,'failed');assert.ok(!JSON.stringify(unsafe).includes('PRIVATE DOCUMENT DETAIL'));
});

test('results are isolated to a session, expire without polling, and retained results are capped',async t=>{
  t.mock.timers.enable({apis:['setTimeout','Date']});
  const jobs=new PdfReadJobs({keepAlive:()=>{}}), other=new PdfReadJobs({keepAlive:()=>{}});
  const first=await jobs.start(async()=>result);
  await assert.rejects(other.get(first.jobId),code('PDF_JOB_NOT_FOUND'));
  for(let i=0;i<4;i++)await jobs.start(async()=>result);
  await assert.rejects(jobs.get(first.jobId),code('PDF_JOB_NOT_FOUND'));
  const last=await jobs.start(async()=>result);
  t.mock.timers.tick(PDF_JOB_LIMITS.retentionMs);
  await assert.rejects(jobs.get(last.jobId),code('PDF_JOB_NOT_FOUND'));
});

test('background lifetime registration failure cancels the job without exposing provider details',async()=>{
  const jobs=new PdfReadJobs({keepAlive:()=>{throw new Error('PRIVATE');}});
  let signal!:AbortSignal;
  await assert.rejects(jobs.start(async s=>{signal=s;s.throwIfAborted();return result;}),code('PDF_OCR_UNAVAILABLE'));
  assert.equal(signal.aborted,true);
});

test('MCP returns pending, then full verified PDF result without another download or inference',async()=>{
  const bytes=new Uint8Array(await readFile(new URL('./fixtures/pdf/ordinary.pdf',import.meta.url)));
  let downloads=0,calls=0,release!:()=>void;
  const gated=new Promise<void>(r=>{release=r;});
  const server=new McpServer({name:'ocr-jobs',version:'1'});
  const client={resolveBinaryVersion:async()=>({file:{id:7,name:'fixture.pdf',size:bytes.length},versionId:'v1'}),
    downloadVersionStream:async()=>{downloads++;return new Response(bytes);}};
  registerPdfTools(server,client as unknown as KDriveClient,42,{
    render:async()=>({png:new Uint8Array(),width:1,height:1}),
    provider:{recognize:async()=>{calls++;await gated;return 'SYNTHETIC OCR';}},
  },{keepAlive:()=>{},limits:{initialWaitMs:5,pollWaitMs:5}});
  const host=new Client({name:'test',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair();
  await server.connect(a);await host.connect(b);
  try{
    assert.ok((await host.listTools()).tools.some(t=>t.name==='kdrive_get_pdf_ocr_result'));
    const pending=await host.callTool({name:'kdrive_read_pdf',arguments:{path:'/fixture.pdf',ocr:true}});
    assert.equal(pending.isError,false);assert.equal(pending.structuredContent?.status,'pending');
    assert.ok(!JSON.stringify(pending).includes('/fixture.pdf'));
    release();
    let final=await host.callTool({name:'kdrive_get_pdf_ocr_result',arguments:{jobId:pending.structuredContent!.jobId}});
    // PDF.js may still be initializing when the initial response is delivered.
    for(let i=0;i<100&&final.structuredContent?.status==='pending';i++){
      final=await host.callTool({name:'kdrive_get_pdf_ocr_result',arguments:{jobId:pending.structuredContent!.jobId}});
    }
    assert.ok(!final.isError);assert.equal((final.structuredContent?.ocr as any)?.text,'SYNTHETIC OCR');
    assert.match(JSON.stringify(final.structuredContent?.pages),/ORCHID-7319/);
    assert.equal(downloads,1);assert.equal(calls,1);
    const missing=await host.callTool({name:'kdrive_get_pdf_ocr_result',arguments:{jobId:crypto.randomUUID()}});
    assert.equal(missing.isError,true);assert.equal(missing.structuredContent?.error_code,'PDF_JOB_NOT_FOUND');
  }finally{release();await host.close();await server.close();}
});

test('upstream safe failures keep their code and report the active phase',async()=>{
  const jobs=new PdfReadJobs({keepAlive:()=>{}});
  const out=await jobs.start(async(_s,stage)=>{stage('download');throw new PdfReadError('PDF_VERSION_CHANGED','The file changed.');});
  assert.equal(out.status,'failed');
  if(out.status==='failed'){assert.equal(out.error_code,'PDF_VERSION_CHANGED');assert.equal(out.phase,'download');}
});
