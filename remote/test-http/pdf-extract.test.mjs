import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

test('direct PDF extraction runs in a real SQLite Durable Object without external services', async () => {
  const fixtures = await Promise.all(['ordinary', 'password-protected'].map(async name => Array.from(await readFile(new URL(`../../test/fixtures/pdf/${name}.pdf`, import.meta.url)))));
  const bundle = await build({ stdin: {
    contents: `
      import { DurableObject } from 'cloudflare:workers';
      import { readKDrivePdf } from './src/pdf-tools.ts';
      export class PdfTest extends DurableObject {
        async fetch(request) {
          const input = await request.json();
          const bytes = new Uint8Array(${JSON.stringify(fixtures)}[input.fixture || 0]);
          const client = {
            resolveBinaryVersion: async () => ({ file: { id: 7, name: 'fixture.pdf', type: 'file', size: bytes.length }, versionId: 'v1' }),
            downloadVersionStream: async () => new Response(bytes),
          };
          try { return Response.json(await readKDrivePdf(client, 42, { path: '/Private/fixture.pdf', password: input.password })); }
          catch (e) { return Response.json({ code: e.code, message: e.message }, { status: 422 }); }
        }
      }
      export default { fetch(request, env) { return env.PDF.getByName('synthetic').fetch(request); } };`,
    resolveDir: fileURLToPath(new URL('../../', import.meta.url)),
  }, bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['node:*', 'cloudflare:*'], minify: true });
  const script = bundle.outputFiles[0].text;
  assert.ok(Buffer.byteLength(script) < 64 * 1024 * 1024);
  let outboundRequests = 0;
  const mf = new Miniflare(convertV4MiniflareOptions({ port: 0, modules: true, script,
    compatibilityDate: '2026-08-13', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { PDF: { className: 'PdfTest', useSQLite: true } },
    outboundService: () => { outboundRequests++; return new Response('Unexpected outbound request', { status: 502 }); },
  }));
  try {
    const url = (await mf.ready).origin;
    for (const input of [{}, { fixture: 1 }, { fixture: 1, password: 'wrong' }, { fixture: 1, password: 'synthetic-open-password' }]) {
      const start = performance.now();
      const response = await fetch(url, { method: 'POST', body: JSON.stringify(input) });
      const result = await response.json();
      if (input.fixture && input.password !== 'synthetic-open-password') {
        assert.equal(result.code, input.password ? 'PDF_PASSWORD_INCORRECT' : 'PDF_PASSWORD_REQUIRED');
      } else {
        assert.equal(response.status, 200, JSON.stringify(result));
        assert.match(result.pages[0].text, /ORCHID-7319/);
        assert.equal(result.byteLength, fixtures[input.fixture || 0].length);
      }
      console.info('LOCAL_PDF_DO', { encrypted: Boolean(input.fixture), status: response.status, wallMs: Math.round(performance.now() - start) });
    }
    assert.equal(outboundRequests, 0);
  } finally { await mf.dispose(); }
});
