import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

test('production JSON session transport preserves OCR jobs across separate HTTP requests without session storage', async () => {
  const bytes = Array.from(await readFile(new URL('../../test/fixtures/pdf/ordinary.pdf', import.meta.url)));
  const bundle = await build({ stdin: { contents: `
    import { KDriveMCP } from './remote/src/index.ts';
    import { createMcpHandler } from './remote/src/mcp-session.ts';
    import { registerPdfTools } from './src/pdf-tools.ts';
    import { renderPdfOcrPage } from './src/pdf-render.ts';
    import { cloudflareOcrProvider } from './src/pdf-ocr.ts';
    import wasm from './pdfium.wasm';
    export class SyntheticMcp extends KDriveMCP {
      async init() {
        const bytes = new Uint8Array(${JSON.stringify(bytes)});
        let downloads = 0, inferences = 0;
        registerPdfTools(this.server, {
          resolveBinaryVersion: async () => ({file:{id:7,name:'synthetic.pdf',size:bytes.length},versionId:'synthetic-v1'}),
          downloadVersionStream: async () => { downloads++; return new Response(bytes); },
        }, 42, {
          render: (b,p,pw,o) => renderPdfOcrPage(b,p,pw,o,wasm),
          provider: cloudflareOcrProvider({run: async () => {
            inferences++; await new Promise(r => setTimeout(r,46000));
            return {choices:[{message:{role:'assistant',content:'SYNTHETIC SESSION OCR'},finish_reason:'stop'}]};
          }}),
        }, {keepAlive:p => this.ctx.waitUntil(p)});
        this.server.registerTool('synthetic_metrics', {inputSchema:{}}, async () => ({content:[], structuredContent:{
          downloads,inferences,keys:(await this.ctx.storage.list()).size,
          tables:this.ctx.storage.sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '_cf_%'").toArray().length,
        }}));
      }
    }
    const handler=createMcpHandler();
    export default {fetch(request,env,ctx) {
      // Synthetic authenticated owner only; production OAuth is covered separately.
      return handler.fetch(request,env,Object.assign(ctx,{props:{login:'synthetic',name:null,email:null}}));
    }};
  `, resolveDir: fileURLToPath(new URL('../../', import.meta.url)) }, bundle:true,write:false,format:'esm',platform:'neutral',conditions:['browser'],mainFields:['module','main'],
    external:['node:*','cloudflare:*','*.wasm'], minify:true,
    plugins:[{name:'wasm-path',setup(b){b.onResolve({filter:/@hyzyla\/pdfium\/pdfium\.wasm$/},()=>({path:'./pdfium.wasm',external:true}));}}],
  });
  let outbound=0;
  const mf=new Miniflare(convertV4MiniflareOptions({port:0,modules:[
    {type:'ESModule',path:'index.mjs',contents:bundle.outputFiles[0].text},
    {type:'CompiledWasm',path:'pdfium.wasm',contents:await readFile(new URL('../../node_modules/@hyzyla/pdfium/dist/pdfium.wasm',import.meta.url))}],
    compatibilityDate:'2026-08-13',compatibilityFlags:['nodejs_compat'],
    durableObjects:{MCP_OBJECT:{className:'SyntheticMcp',useSQLite:true}},
    bindings:{ALLOWED_GITHUB_LOGIN:'synthetic',KDRIVE_OPERATION_SECRET:'synthetic-session-secret'},
    outboundService:()=>{outbound++;return new Response('Unexpected network',{status:502});},
  }));
  const clients=[];
  try {
    const url=new URL('/mcp',await mf.ready);
    let initializations=0;
    const connect=async()=>{
      const client=new Client({name:'synthetic-http',version:'1'});
      const transport=new StreamableHTTPClientTransport(url,{fetch:async(input,init)=>{
        const request=new Request(input,init);
        if(request.method==='POST' && (await request.clone().json()).method==='initialize')initializations++;
        const response=await fetch(request);
        if(request.method==='POST'&&response.status===200)assert.match(response.headers.get('content-type'),/application\/json/);
        return response;
      }});
      clients.push(client);await client.connect(transport);return {client,transport};
    };
    const {client,transport}=await connect();
    const first=await client.callTool({name:'kdrive_read_pdf',arguments:{path:'/synthetic.pdf',ocr:true}});
    assert.equal(first.structuredContent.status,'pending');
    const {jobId}=first.structuredContent;
    const other=await connect();
    const isolated=await other.client.callTool({name:'kdrive_get_pdf_ocr_result',arguments:{jobId}});
    assert.equal(isolated.structuredContent.error_code,'PDF_JOB_NOT_FOUND');
    // All HTTP requests have ended while the DO's waitUntil keeps inference alive.
    await new Promise(r=>setTimeout(r,46000));
    const complete=await client.callTool({name:'kdrive_get_pdf_ocr_result',arguments:{jobId}});
    assert.equal(complete.isError,undefined);
    assert.equal(complete.structuredContent.ocr.text,'SYNTHETIC SESSION OCR');
    const metrics=await client.callTool({name:'synthetic_metrics',arguments:{}});
    assert.deepEqual(metrics.structuredContent,{downloads:1,inferences:1,keys:0,tables:0});
    assert.equal(initializations,2);assert.equal(outbound,0);
    const session=transport.sessionId;
    await transport.terminateSession();
    const stale=await fetch(url,{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream','mcp-session-id':session},
      body:JSON.stringify({jsonrpc:'2.0',id:90,method:'tools/list'})});
    assert.equal(stale.status,404);
  } finally {for(const client of clients)await client.close();await mf.dispose();}
});
