import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { decode, encode } from 'fast-png';
import { readKDrivePdf, registerPdfTools } from '../src/pdf-tools.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { KDriveClient } from '../src/kdrive-client.js';
import { renderPdfPage, renderPdfOcrPage } from '../src/pdf-render.js';
import { cloudflareOcrProvider, PDF_OCR_MODEL, runPdfOcr, type PdfOcrRuntime } from '../src/pdf-ocr.js';
import { connectorDiagnostics } from '../src/connector-diagnostics.js';

const ordinary = new Uint8Array(await readFile(new URL('./fixtures/pdf/ordinary.pdf', import.meta.url)));
const encrypted = new Uint8Array(await readFile(new URL('./fixtures/pdf/password-protected.pdf', import.meta.url)));
const client = (bytes = ordinary) => ({
  resolveBinaryVersion: async () => ({ file: { id:7, name:'fixture.pdf', type:'file', size:bytes.length }, versionId:'v1' }),
  downloadVersionStream: async () => new Response(bytes),
});
const code = (expected: string) => (e: any) => { assert.equal(e.code, expected); return true; };
const mockRuntime = (recognize = async () => 'MOCK TRANSCRIPTION'): PdfOcrRuntime => ({ render: renderPdfOcrPage, provider: { recognize } });

// Flatten a rendered synthetic fixture into an image-only PDF, in memory.
function scannedPdf(png: Uint8Array) {
  const image = decode(png); const rgb = new Uint8Array(image.width * image.height * 3);
  for (let i=0; i<image.width * image.height; i++) rgb.set(image.data.subarray(i*4,i*4+3), i*3);
  const compressed = deflateSync(rgb).toString('latin1');
  const paint = 'q 612 0 0 792 0 0 cm /Im0 Do Q';
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${paint.length} >>\nstream\n${paint}\nendstream`,
    `<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${compressed.length} >>\nstream\n${compressed}\nendstream`];
  let pdf = '%PDF-1.7\n'; const offsets = [0];
  for (const [i,obj] of objs.entries()) { offsets.push(pdf.length); pdf += `${i+1} 0 obj\n${obj}\nendobj\n`; }
  const xref = pdf.length;
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets.slice(1).map(o => `${String(o).padStart(10,'0')} 00000 n \n`).join('')}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(pdf,'latin1'));
}

test('scanned PDF flows through complete download, hash, full-page rendering and separate OCR result', async () => {
  const originalImage = await renderPdfPage(ordinary.slice(), 1);
  const scan = scannedPdf(originalImage.png);
  let calls = 0;
  const runtime: PdfOcrRuntime = { render: renderPdfOcrPage, provider: { recognize: async png => {
    calls++;
    const rendered = decode(png);
    assert.ok(rendered.data.filter((value, index) => index % 4 !== 3 && value < 128).length > 1000, 'scan render must contain ink, not just a PNG header');
    return 'MOCK OCR — NOT AN ACCURACY TEST';
  } } };
  const result = await readKDrivePdf(client(scan), 42, { path:'/Private/scan.pdf', ocr:true }, runtime);
  assert.equal(result.pages[0].status, 'no_text');
  assert.equal(result.pages[0].text, '');
  assert.equal(result.ocr?.status, 'review_required');
  assert.match(result.ocr!.text, /MOCK OCR/);
  assert.equal(result.sha256, createHash('sha256').update(scan).digest('hex'));
  assert.equal(calls, 1);
  assert.match(result.warnings.join(' '), /may omit or invent/);
  assert.ok(!result.warnings.join(' ').includes('no OCR was performed'));
  assert.ok(!JSON.stringify(result).includes('data:image'));
});

test('opaque-white scanned page returns empty text with renderer provenance and no AI call', async () => {
  const scan = scannedPdf(encode({width:100,height:100,channels:4,data:new Uint8Array(100*100*4).fill(255)}));
  let calls = 0;
  const result = await readKDrivePdf(client(scan),42,{path:'/synthetic-blank.pdf',ocr:true},
    mockRuntime(async () => { calls++; return '""'; }));
  assert.equal(result.pages[0].status,'no_text');
  assert.equal(result.ocr?.text,'');
  assert.equal(result.ocr?.status,'no_text_detected');
  assert.equal(result.ocr?.source,'pdf_render');
  assert.equal(result.ocr?.model,null);
  assert.equal(result.ocr?.preparation?.allPixelsOpaqueWhite,true);
  assert.equal(result.ocr?.preparation?.scope,'full_page');
  assert.equal(result.sha256,createHash('sha256').update(scan).digest('hex'));
  assert.match(result.warnings.join(' '),/No AI inference was performed/);
  assert.equal(calls,0);
});

test('empty selected region does not imply the rest of the page is empty', async () => {
  let calls=0;
  const result=await readKDrivePdf(client(),42,{path:'/fixture.pdf',ocr:true,
    ocrRegion:{x:0,y:0,width:.02,height:.02},ocrRotation:90},
    mockRuntime(async()=>{calls++;return '""';}));
  assert.match(result.pages[0].text,/ORCHID-7319/);
  assert.equal(result.ocr?.text,'');
  assert.equal(result.ocr?.source,'pdf_render');
  assert.equal(result.ocr?.preparation?.allPixelsOpaqueWhite,true);
  assert.equal(result.ocr?.preparation?.scope,'region');
  assert.match(result.warnings.join(' '),/not the complete page/);
  assert.equal(calls,0);
});

test('nonwhite raster retains literal quotation marks and review status from the model', async () => {
  let calls=0;
  const result=await readKDrivePdf(client(),42,{path:'/fixture.pdf',ocr:true},{
    render:renderPdfOcrPage,
    provider:cloudflareOcrProvider({run:async()=>{calls++;return completion(' "" ');}}),
  });
  assert.equal(result.ocr?.preparation?.allPixelsOpaqueWhite,false);
  assert.equal(result.ocr?.text,'""');
  assert.equal(result.ocr?.status,'review_required');
  assert.equal(result.ocr?.source,'cloudflare_workers_ai');
  assert.equal(result.ocr?.model,PDF_OCR_MODEL);
  assert.equal(calls,1);
});

test('OCR is explicit, unavailable without configuration, one page only and never invoked before integrity checks', async () => {
  let calls = 0;
  const runtime = mockRuntime(async () => { calls++; return 'mock'; });
  await readKDrivePdf(client(), 42, { path:'/fixture.pdf' }, runtime);
  await assert.rejects(readKDrivePdf(client(),42,{path:'/fixture.pdf',ocr:true}),code('PDF_OCR_UNAVAILABLE'));
  await assert.rejects(readKDrivePdf(client(),42,{path:'/fixture.pdf',ocr:true,pageCount:2},runtime),code('PDF_OCR_PAGE_LIMIT'));
  await assert.rejects(readKDrivePdf(client(),42,{path:'/fixture.pdf',ocr:true,expectedSha256:'0'.repeat(64)},runtime),code('PDF_INTEGRITY_MISMATCH'));
  assert.equal(calls,0);
  assert.equal(connectorDiagnostics({binaryExport:true,maxReadBytes:1,maxUploadBytes:1}).capabilities.pdf_ocr,false);
  assert.equal(connectorDiagnostics({binaryExport:true,maxReadBytes:1,maxUploadBytes:1,pdfOcr:true}).capabilities.pdf_ocr,true);
});

test('encrypted PDF renders only with correct password and does not expose it in results', async () => {
  let calls = 0;
  const runtime = mockRuntime(async () => { calls++; return 'mock'; });
  for (const password of [undefined,'wrong']) await assert.rejects(readKDrivePdf(client(encrypted),42,{path:'/protected.pdf',ocr:true,password},runtime),code(password ? 'PDF_PASSWORD_INCORRECT':'PDF_PASSWORD_REQUIRED'));
  const result = await readKDrivePdf(client(encrypted),42,{path:'/protected.pdf',ocr:true,password:'synthetic-open-password'},runtime);
  assert.equal(calls,1);
  assert.ok(!JSON.stringify(result).includes('synthetic-open-password'));
});

const completion = (content: unknown, finish_reason: unknown = 'stop', extra = {}) => ({
  choices:[{message:{role:'assistant',content,...extra},finish_reason}],
});

test('vision adapter sends only rendered bytes and forwards cancellation, with bounded Free inference', async () => {
  const signal = new AbortController().signal;
  let calls = 0;
  const provider = cloudflareOcrProvider({ run: async (model, input, options) => {
    calls++;
    assert.equal(model, PDF_OCR_MODEL); assert.equal(options?.signal,signal);
    const messages=input.messages as any[];
    assert.equal(messages.length,2);
    assert.equal(messages[0].role,'system');
    assert.match(messages[0].content,/colored box background does not mean/);
    assert.deepEqual(messages[1],{role:'user',content:[{type:'image_url',image_url:{url:'data:image/png;base64,AQID'}}]});
    assert.equal(input.reasoning_effort,'low');
    assert.deepEqual(input.chat_template_kwargs,{enable_thinking:false});
    assert.equal(input.stream,false);assert.equal(input.store,false);
    assert.equal(input.max_completion_tokens,4096);
    assert.ok(!('password' in input));assert.ok(!('tools' in input));assert.ok(!('gateway' in input));
    return completion(' SYNTHETIC ', 'stop', {reasoning:'PRIVATE REASONING'});
  } });
  assert.equal(await provider.recognize(new Uint8Array([1,2,3]),signal),'SYNTHETIC');
  assert.equal(calls,1);
});

test('vision adapter validates choices, normal completion and text-only output before returning a transcription',async()=>{
  const signal=new AbortController().signal;
  const recognize=(result:unknown)=>cloudflareOcrProvider({run:async()=>result}).recognize(new Uint8Array(),signal);
  assert.equal(await recognize(completion('direct')),'direct');
  assert.equal(await recognize({result:completion('wrapped'),usage:{neurons:33}}),'wrapped');
  assert.equal(await recognize(completion('')),'');
  for(const reason of ['length','tool_calls','content_filter','future_reason',null]) {
    await assert.rejects(recognize(completion('partial',reason)),code('PDF_OCR_INCOMPLETE'));
  }
  await assert.rejects(recognize({choices:[{message:{role:'assistant',content:'partial'}}]}),code('PDF_OCR_INCOMPLETE'));
  for(const result of [{choices:[]},{choices:[{},{}]},{choices:null},{result:null},
    completion(null),completion('not an answer','stop',{role:'user'}),
    completion('refused','stop',{refusal:'no'}),completion('tool','stop',{tool_calls:[{}]}),
    completion('tool','stop',{tool_calls:{}}),completion('tool','stop',{function_call:{}})]) {
    await assert.rejects(recognize(result),code('PDF_OCR_FAILED'));
  }
  await assert.rejects(recognize(completion('x'.repeat(30001))),code('PDF_OCR_OUTPUT_LIMIT'));
});

test('OCR failure and deadline return safe errors, never retry or leak provider details', async () => {
  let calls = 0;
  const render = async () => ({png:new Uint8Array(),width:1,height:1});
  const provider = {recognize:async()=>{calls++; throw new Error('SECRET DOCUMENT AND QUOTA DETAILS');}};
  await assert.rejects(runPdfOcr({render,provider},ordinary,1,undefined,new AbortController().signal),(e:any)=>{
    assert.equal(e.code,'PDF_OCR_FAILED'); assert.ok(!e.message.includes('SECRET')); return true;
  });
  assert.equal(calls,1);
  const controller = new AbortController();
  const pending = runPdfOcr({render,provider:{recognize:()=>new Promise(()=>{})}},ordinary,1,undefined,controller.signal);
  setTimeout(()=>controller.abort(),10);
  await assert.rejects(pending,code('PDF_TIMEOUT'));
});

test('MCP accepts explicit OCR with an omitted pageCount and returns structured OCR separately', async () => {
  const server = new McpServer({ name:'ocr-test',version:'1' });
  registerPdfTools(server, client() as unknown as KDriveClient, 42, mockRuntime());
  const host = new Client({ name:'test',version:'1' });
  const [a,b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await host.connect(b);
  try {
    const result = await host.callTool({name:'kdrive_read_pdf',arguments:{path:'/fixture.pdf',ocr:true}});
    assert.ok(!result.isError);
    assert.match(JSON.stringify(result.structuredContent?.ocr), /MOCK TRANSCRIPTION/);
    assert.match(JSON.stringify(result.structuredContent?.pages), /ORCHID-7319/);
  } finally { await host.close(); await server.close(); }
});

test('MCP preserves explicit region scope, rotation and whole-file integrity with one inference', async () => {
  let calls=0, downloads=0;
  const source=client();
  const server = new McpServer({ name:'region-test',version:'1' });
  registerPdfTools(server, {...source, downloadVersionStream:async()=>{downloads++;return source.downloadVersionStream();}} as unknown as KDriveClient,42,
    mockRuntime(async()=>{calls++;return 'MOCK REGION';}));
  const host=new Client({name:'test',version:'1'});
  const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);await host.connect(b);
  try {
    const region={x:0,y:0,width:.8,height:.4};
    const result=await host.callTool({name:'kdrive_read_pdf',arguments:{path:'/fixture.pdf',ocr:true,ocrRegion:region,ocrRotation:270}});
    assert.ok(!result.isError);
    const body=result.structuredContent as any;
    assert.equal(body.ocr.preparation.scope,'region');
    assert.equal(body.ocr.preparation.rotation,270);
    assert.deepEqual(body.ocr.preparation.region,region);
    assert.equal(body.sha256,createHash('sha256').update(ordinary).digest('hex'));
    assert.match(JSON.stringify(body.pages),/ORCHID-7319/);
    assert.match(body.warnings.join(' '),/only the explicitly selected region/);
    assert.equal(calls,1);assert.equal(downloads,1);
    for(const input of [{ocr:false,ocrRotation:90},{ocr:true,ocrRegion:{x:.8,y:0,width:.4,height:1}}]) {
      const bad=await host.callTool({name:'kdrive_read_pdf',arguments:{path:'/fixture.pdf',...input}});
      assert.equal(bad.isError,true);
    }
    assert.equal(calls,1);assert.equal(downloads,1);
  } finally {await host.close();await server.close();}
});
