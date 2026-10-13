import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { decode } from 'fast-png';
import { readKDrivePdf, registerPdfTools } from '../src/pdf-tools.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { KDriveClient } from '../src/kdrive-client.js';
import { renderPdfPage } from '../src/pdf-render.js';
import { cloudflareOcrProvider, PDF_OCR_MODEL, runPdfOcr, type PdfOcrRuntime } from '../src/pdf-ocr.js';
import { connectorDiagnostics } from '../src/connector-diagnostics.js';

const ordinary = new Uint8Array(await readFile(new URL('./fixtures/pdf/ordinary.pdf', import.meta.url)));
const encrypted = new Uint8Array(await readFile(new URL('./fixtures/pdf/password-protected.pdf', import.meta.url)));
const client = (bytes = ordinary) => ({
  resolveBinaryVersion: async () => ({ file: { id:7, name:'fixture.pdf', type:'file', size:bytes.length }, versionId:'v1' }),
  downloadVersionStream: async () => new Response(bytes),
});
const code = (expected: string) => (e: any) => { assert.equal(e.code, expected); return true; };
const mockRuntime = (recognize = async () => 'MOCK TRANSCRIPTION'): PdfOcrRuntime => ({ render: renderPdfPage, provider: { recognize } });

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
  const runtime: PdfOcrRuntime = { render: renderPdfPage, provider: { recognize: async png => {
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

test('model adapter sends only rendered bytes and forwards cancellation, rejects incomplete/oversized responses', async () => {
  const signal = new AbortController().signal;
  let calls = 0;
  const provider = cloudflareOcrProvider({ run: async (model, input, options) => {
    calls++;
    assert.equal(model, PDF_OCR_MODEL); assert.equal(options?.signal,signal);
    assert.equal(input.image,'data:image/png;base64,AQID');
    assert.equal(input.reasoning,false); assert.equal(input.stream,false);
    assert.equal(input.max_tokens,4096);
    assert.ok(!('password' in input)); assert.ok(!('url' in input));
    return { answer:' SYNTHETIC ', finish_reason:'stop' };
  } });
  assert.equal(await provider.recognize(new Uint8Array([1,2,3]),signal),'SYNTHETIC');
  assert.equal(calls,1);
  for (const result of [{answer:'partial',finish_reason:'length'},{answer:'unknown'},{answer:'unknown',finish_reason:'future_reason'},{answer:'unknown',finish_reason:'eos'},{answer:'unknown',finish_reason:'end_turn'}]) {
    await assert.rejects(cloudflareOcrProvider({run:async()=>result}).recognize(new Uint8Array(),signal),code('PDF_OCR_INCOMPLETE'));
  }
  await assert.rejects(cloudflareOcrProvider({run:async()=>({answer:'x'.repeat(30001),finish_reason:'stop'})}).recognize(new Uint8Array(),signal),code('PDF_OCR_OUTPUT_LIMIT'));
});

test('model adapter accepts the live Cloudflare envelope and validates its completion', async () => {
  const signal = new AbortController().signal;
  assert.equal(await cloudflareOcrProvider({run:async()=>({
    result:{answer:'LIVE ENVELOPE SHAPE',finish_reason:'stop',caption:null,reasoning:null},
    usage:{prompt_tokens:789,completion_tokens:95,neurons:30.1545467376709},
  })}).recognize(new Uint8Array([1]),signal),'LIVE ENVELOPE SHAPE');
  await assert.rejects(cloudflareOcrProvider({run:async()=>({result:{answer:'partial',finish_reason:'length'}})}).recognize(new Uint8Array(),signal),code('PDF_OCR_INCOMPLETE'));
  await assert.rejects(cloudflareOcrProvider({run:async()=>({result:null})}).recognize(new Uint8Array(),signal),code('PDF_OCR_FAILED'));
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
