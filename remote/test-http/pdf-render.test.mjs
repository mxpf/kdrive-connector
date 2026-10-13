import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

test('PDFium renders ordinary and encrypted pages in workerd using bundled WASM and no network', async () => {
  const fixtures = await Promise.all(['ordinary', 'password-protected'].map(async name => Array.from(await readFile(new URL(`../../test/fixtures/pdf/${name}.pdf`, import.meta.url)))));
  const bundle = await build({ stdin: { contents: `
    import { DurableObject } from 'cloudflare:workers';
    import { renderPdfPage } from './src/pdf-render.ts';
    import { readKDrivePdf } from './src/pdf-tools.ts';
    import { cloudflareOcrProvider } from './src/pdf-ocr.ts';
    import wasm from './pdfium.wasm';
    export class PdfTest extends DurableObject {
      async fetch(request) {
        const input = await request.json();
        const bytes = new Uint8Array(${JSON.stringify(fixtures)}[input.encrypted ? 1 : 0]);
        if (input.pipeline) {
          const client = {
            resolveBinaryVersion: async () => ({ file: { id: 7, name: 'fixture.pdf', size: bytes.length }, versionId: 'v1' }),
            downloadVersionStream: async () => new Response(bytes),
          };
          const result = await readKDrivePdf(client, 42, { path: '/fixture.pdf', ocr: true, password: input.encrypted ? 'synthetic-open-password' : undefined }, {
            render: (bytes, page, password) => renderPdfPage(bytes, page, password, wasm),
            provider: cloudflareOcrProvider({ run: async (model, payload) => {
              if (!payload.image.startsWith('data:image/png;base64,iVBOR')) throw new Error('Invalid PNG input');
              return { result: { answer: 'MOCK OCR RESPONSE', finish_reason: 'stop' }, usage: { neurons: 30 } };
            } }),
          });
          return Response.json(result);
        }
        const result = await renderPdfPage(bytes, 1, input.encrypted ? 'synthetic-open-password' : undefined, wasm);
        return new Response(result.png, { headers: { 'Content-Type': 'image/png', 'X-Width': String(result.width), 'X-Height': String(result.height) } });
      }
    }
    export default { fetch(request, env) { return env.PDF.getByName('render').fetch(request); } };
  `, resolveDir: fileURLToPath(new URL('../../', import.meta.url)) }, bundle: true, write: false, format: 'esm', platform: 'neutral', conditions: ['browser'], external: ['node:*', 'cloudflare:*', '*.wasm'], minify: true });
  let outbound = 0;
  const mf = new Miniflare(convertV4MiniflareOptions({ port: 0,
    modules: [ { type: 'ESModule', path: 'index.mjs', contents: bundle.outputFiles[0].text },
      { type: 'CompiledWasm', path: 'pdfium.wasm', contents: await readFile(new URL('../../node_modules/@hyzyla/pdfium/dist/pdfium.wasm', import.meta.url)) } ],
    compatibilityDate: '2026-08-13', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { PDF: { className: 'PdfTest', useSQLite: true } },
    outboundService: () => { outbound++; return new Response('Unexpected network', { status: 502 }); },
  }));
  try {
    const url = (await mf.ready).origin;
    for (const encrypted of [false, true]) {
      const response = await fetch(url, { method: 'POST', body: JSON.stringify({ encrypted }) });
      assert.equal(response.status, 200, await response.clone().text());
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
      assert.ok(bytes.length > 1000);
      assert.ok(Number(response.headers.get('X-Width')) * Number(response.headers.get('X-Height')) <= 2000000);
      const pipeline = await fetch(url, { method: 'POST', body: JSON.stringify({ encrypted, pipeline: true }) });
      const result = await pipeline.json();
      assert.equal(pipeline.status, 200);
      assert.match(result.pages[0].text, /ORCHID-7319/);
      assert.equal(result.ocr.text, 'MOCK OCR RESPONSE');
      assert.equal(result.ocr.status, 'review_required');
      assert.equal(result.byteLength, fixtures[encrypted ? 1 : 0].length);
    }
    assert.equal(outbound, 0);
  } finally { await mf.dispose(); }
});
