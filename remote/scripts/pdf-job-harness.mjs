// Local workerd test harness. Inputs are synthetic fixtures supplied by the
// test/validation runners; it never connects to kDrive or deploys a Worker.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

export async function startPdfJobHarness(fixtures, { connection, delayMs = 46_000 } = {}) {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const inputs = fixtures.map(f => ({ ...f, bytes: f.bytes.toString('base64'), sha256: createHash('sha256').update(f.bytes).digest('hex') }));
  const bundle = await build({ stdin: { contents: `
    import { DurableObject } from 'cloudflare:workers';
    import { Buffer } from 'node:buffer';
    import { registerPdfTools } from './src/pdf-tools.ts';
    import { renderPdfOcrPage } from './src/pdf-render.ts';
    import { cloudflareOcrProvider } from './src/pdf-ocr.ts';
    import wasm from './pdfium.wasm';
    const fixtures = ${JSON.stringify(inputs)};
    export class PdfTest extends DurableObject {
      handlers = new Map(); telemetry = {downloads:0,calls:0,aborted:false};
      async fetch(request) {
        const input = await request.json();
        if (!this.handlers.size) {
          const fixture = fixtures.find(f=>f.name===input.fixture);
          if (!fixture) return new Response('Unknown synthetic fixture',{status:400});
          const bytes = new Uint8Array(Buffer.from(fixture.bytes,'base64'));
          const client = {
            resolveBinaryVersion:async()=>({file:{id:7,name:'synthetic.pdf',size:bytes.length},versionId:'synthetic-v1'}),
            downloadVersionStream:async()=>{this.telemetry.downloads++;return new Response(bytes);},
          };
          const mode=input.mode;
          const runtime={render:(b,p,pw,o)=>renderPdfOcrPage(b,p,pw,o,wasm),provider:cloudflareOcrProvider({run:async(model,payload,options)=>{
            this.telemetry.calls++;
            options.signal.addEventListener('abort',()=>{this.telemetry.aborted=true;},{once:true});
            if(mode==='hang') return new Promise(()=>{});
            if(mode==='live') {
              const result=await this.env.AI.run(model,payload,options);
              this.telemetry.usage=result.usage??result.result?.usage;
              return result;
            }
            await new Promise(r=>setTimeout(r,${delayMs}));
            return {choices:[{message:{role:'assistant',content:'SYNTHETIC DELAYED OCR'},finish_reason:'stop'}]};
          }})};
          registerPdfTools({registerTool:(name,_schema,handler)=>this.handlers.set(name,handler)},client,42,runtime,
            {keepAlive:p=>this.ctx.waitUntil(p),...(mode==='hang'?{limits:{timeoutMs:3000,initialWaitMs:10,pollWaitMs:50}}:{})});
        }
        const handler=this.handlers.get(input.tool);
        if(!handler)return new Response('Unknown tool',{status:400});
        const response=await handler(input.args);
        return Response.json({response,telemetry:this.telemetry});
      }
    }
    export default {fetch(request,env){return env.PDF.getByName(new URL(request.url).pathname).fetch(request);}};
  `, resolveDir: root }, bundle:true,write:false,format:'esm',platform:'neutral',conditions:['browser'],external:['node:*','cloudflare:*','*.wasm'],minify:true });
  let outbound=0;
  const mf=new Miniflare(convertV4MiniflareOptions({port:0,modules:[
    {type:'ESModule',path:'index.mjs',contents:bundle.outputFiles[0].text},
    {type:'CompiledWasm',path:'pdfium.wasm',contents:await readFile(new URL('../../node_modules/@hyzyla/pdfium/dist/pdfium.wasm',import.meta.url))}],
    compatibilityDate:'2026-08-13',compatibilityFlags:['nodejs_compat'],durableObjects:{PDF:{className:'PdfTest',useSQLite:true}},
    ...(connection?{ai:{binding:'AI',remoteProxyConnectionString:connection}}:{}),
    outboundService:()=>{outbound++;return new Response('Unexpected network',{status:502});},
  }));
  try {
    const url=(await mf.ready).origin;
    return { inputs, dispose:()=>mf.dispose(), get outbound(){return outbound;},
      async invoke(session,tool,args,{fixture=fixtures[0].name,mode='delayed'}={}) {
        const start=performance.now();
        const response=await fetch(url+'/'+session,{method:'POST',body:JSON.stringify({fixture,mode,tool,args}),signal:AbortSignal.timeout(20_000)});
        if(!response.ok)throw new Error('Unexpected harness HTTP status: '+response.status);
        return {wallMs:Math.round(performance.now()-start),...await response.json()};
      },
    };
  } catch(error) {await mf.dispose();throw error;}
}
