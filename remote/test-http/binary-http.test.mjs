import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

// SELF.fetch() keeps manually set headers in memory. Only crossing workerd's
// actual HTTP boundary reproduces its removal of Content-Length for JS streams.
test('real workerd HTTP preserves signed PDF lengths and complete bytes', async () => {
  const fixtures = await Promise.all(['ordinary', 'password-protected'].map(async name => {
    const bytes = await readFile(new URL(`../../test/fixtures/pdf/${name}.pdf`, import.meta.url));
    return { name, bytes: Array.from(bytes), sha256: createHash('sha256').update(bytes).digest('hex') };
  }));
  const bundle = await build({
    stdin: {
      contents: `
        import { createBinaryExport, serveBinaryExport } from './src/binary-export.ts';
        const fixtures = ${JSON.stringify(fixtures)};
        const secret = 'synthetic-test-only-signing-secret';
        export default { async fetch(request) {
          const url = new URL(request.url);
          const fixture = fixtures[Number(url.searchParams.get('fixture') ?? 0)];
          if (url.pathname === '/reference') return Response.json(await createBinaryExport(secret, 'https://fixture.example', 'owner', 42,
            { id: 7, name: fixture.name + '.pdf', type: 'file', mime_type: 'application/pdf' }, 8,
            { size_bytes: fixture.bytes.length, sha256: fixture.sha256 }));
          return serveBinaryExport(request, url.pathname.slice(8), {
            secret, subject: 'owner', driveId: 42,
            client: { downloadVersionStream: async () => new Response(new Uint8Array(fixture.bytes)) }
          });
        }};`,
      resolveDir: fileURLToPath(new URL('../../', import.meta.url)),
    },
    bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['node:*'],
  });
  const mf = new Miniflare(convertV4MiniflareOptions({ port: 0, modules: true, script: bundle.outputFiles[0].text,
    compatibilityDate: '2026-08-13', compatibilityFlags: ['nodejs_compat'] }));
  try {
    const origin = (await mf.ready).origin;
    for (const [index, fixture] of fixtures.entries()) {
      const ref = await (await fetch(`${origin}/reference?fixture=${index}`)).json();
      const url = origin + new URL(ref.download_url).pathname + `?fixture=${index}`;
      const response = await fetch(url);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-length'), String(fixture.bytes.length));
      assert.equal(response.headers.get('content-type'), 'application/pdf');
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.deepEqual(bytes, Buffer.from(fixture.bytes));
      assert.equal(createHash('sha256').update(bytes).digest('hex'), ref.sha256);
      const head = await fetch(url, { method: 'HEAD' });
      assert.equal(head.headers.get('content-length'), String(bytes.length));
      assert.equal((await head.arrayBuffer()).byteLength, 0);
    }
  } finally { await mf.dispose(); }
});
