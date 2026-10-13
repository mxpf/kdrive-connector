// Loads an existing dry-run build only, with synthetic/local bindings and no I/O.
import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
const [bundlePath, reportPath] = process.argv.slice(2);
assert.ok(bundlePath && reportPath,'Supply dry-run bundle directory and report path.');
const dir=resolve(bundlePath);
const modules=[{type:'ESModule',path:'index.js',contents:await readFile(join(dir,'index.js'),'utf8')}];
for(const file of await readdir(dir)) if(file.endsWith('.wasm')) modules.push({type:'CompiledWasm',path:file,contents:await readFile(join(dir,file))});
let outbound=0;const start=performance.now();
const mf=new Miniflare(convertV4MiniflareOptions({name:'production-offline-startup',port:0,modules,
  compatibilityDate:'2026-08-13',compatibilityFlags:['nodejs_compat'],kvNamespaces:['OAUTH_KV'],
  durableObjects:{MCP_OBJECT:{className:'KDriveMCP',useSQLite:true},KDRIVE_OPERATION_NONCES:{className:'KDriveOperationNonceStore',useSQLite:true},KDRIVE_BINARY_DIGESTS:{className:'KDriveBinaryDigestStore',useSQLite:true}},
  bindings:{KDRIVE_PDF_OCR_ENABLED:'false'},outboundService:()=>{outbound++;return new Response('No network',{status:502});},
}));
try {
  const url=await mf.ready;const ready=performance.now();
  const response=await fetch(new URL('/.well-known/oauth-authorization-server',url));
  const data=await response.json();
  const report={date:new Date().toISOString(),deploymentPerformed:false,localReadyWallMs:Math.round(ready-start),
    localColdMetadataRequestWallMs:Math.round(performance.now()-ready),httpStatus:response.status,
    metadataValid:typeof data.authorization_endpoint==='string',unexpectedOutboundRequests:outbound,
    bundleBytes:modules.reduce((sum,m)=>sum+Buffer.byteLength(m.contents),0),productionStartupVerified:false};
  await writeFile(resolve(reportPath),JSON.stringify(report,null,2)+'\n');
  assert.equal(response.status,200);assert.equal(report.metadataValid,true);assert.equal(outbound,0);
  assert.ok(report.bundleBytes<64*1024*1024,'Bundle exceeds the documented Free size limit.');
  console.log(JSON.stringify(report));
} finally {await mf.dispose();}
