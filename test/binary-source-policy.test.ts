import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import dns from 'node:dns/promises';
import { syncBuiltinESMExports } from 'node:module';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerBinaryTools } from '../src/binary-tools.js';
import { DEFAULT_BINARY_SOURCE_HOSTS, ARCHIVE_SOURCE_HOSTS } from '../src/binary-source-hosts.js';
import { validateSourceUrl } from '../src/binary-transport.js';
import { connectorDiagnostics } from '../src/connector-diagnostics.js';
import { KDriveClient } from '../src/kdrive-client.js';
import { loadConfig } from '../src/config.js';

test('Worker and Node exact host policy stays aligned and diagnostics reflect overrides',async()=>{
  const config=await readFile(new URL('../remote/wrangler.jsonc',import.meta.url),'utf8');
  const hosts=JSON.parse(config.match(/"KDRIVE_BINARY_SOURCE_HOSTS":\s*("[^"]*")/)![1]).split(',');
  assert.deepEqual(hosts,[...DEFAULT_BINARY_SOURCE_HOSTS]);
  assert.equal(new Set(hosts).size,hosts.length);
  const status=connectorDiagnostics({binaryExport:true,maxReadBytes:1,maxUploadBytes:1,binarySourceHosts:['approved.example']});
  assert.deepEqual(status.binary_source_policy.trusted_hosts,['approved.example']);
  assert.equal(status.binary_source_policy.authoritative_error_field,'binary_error_code');
});

test('reviewed native region and Archive hosts are exact-only',()=>{
  for(const host of ['sdmntprwestus2.oaiusercontent.com','sdmntprcacentral.oaiusercontent.com',...ARCHIVE_SOURCE_HOSTS]) {
    assert.equal(validateSourceUrl('https://'+host+'/file',DEFAULT_BINARY_SOURCE_HOSTS).hostname,host);
    for(const url of ['https://evil.'+host+'/file','https://'+host+'.evil.example/file','http://'+host+'/file','https://user:secret@'+host+'/file','https://'+host+':8443/file']) {
      assert.throws(()=>validateSourceUrl(url,DEFAULT_BINARY_SOURCE_HOSTS),{code:'SOURCE_HOST_DENIED'});
    }
  }
  for(const host of ['unreviewed.archive.org','ia123456.us.archive.org','dn123456.eu.archive.org','sdmntunknown.oaiusercontent.com']) {
    assert.throws(()=>validateSourceUrl('https://'+host+'/file',DEFAULT_BINARY_SOURCE_HOSTS),{code:'SOURCE_HOST_DENIED'});
  }
  assert.throws(()=>validateSourceUrl('https://dn123456.eu.archive.org/private?sig=SECRET',DEFAULT_BINARY_SOURCE_HOSTS),(error:any)=>{
    assert.match(error.message,/Rejected hostname: dn123456\.eu\.archive\.org/);
    assert.ok(!error.message.includes('SECRET'));return true;
  });
});

for(const route of ['native','archive'] as const)for(const fault of ['none','hash','size','redirect','private-dns'] as const) {
  test(`${route} MCP ingestion: ${fault}, complete bytes or safe pre-finalization rejection`,async t=>{
    const bytes=await readFile(new URL('./fixtures/pdf/ordinary.pdf',import.meta.url));
    const digest=createHash('sha256').update(bytes).digest('hex');
    const seenDns:string[]=[],sourceRequests:string[]=[],chunks:Uint8Array[]=[];
    let starts=0,finishes=0,cancels=0;
    t.mock.method(dns,'resolve4',async(host:string)=>{seenDns.push(host);return fault==='private-dns'?['127.0.0.1']:['8.8.8.8'];});
    t.mock.method(dns,'resolve6',async()=>[]);syncBuiltinESMExports();
    t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
    const sourceHost=route==='native'?'sdmntprwestus2.oaiusercontent.com':'archive.org';
    t.mock.method(globalThis,'fetch',async(input:any,init:any)=>{
      const url=new URL(String(input));sourceRequests.push(url.hostname);
      assert.equal(init.redirect,'manual');assert.equal(init.headers.authorization,undefined);
      if(fault==='redirect')return new Response(null,{status:302,headers:{location:'https://unreviewed.archive.org/private?sig=SECRET'}});
      if(url.hostname==='archive.org')return new Response(null,{status:302,headers:{location:'https://dn760102.eu.archive.org/0/items/synthetic/test.pdf'}});
      return new Response(bytes,{headers:{'content-length':String(bytes.length)}});
    });
    const envelope=(data:unknown)=>Response.json({result:'success',data});
    const provider=new KDriveClient(loadConfig({INFOMANIAK_DRIVE_ID:'42'}),{getAccessToken:async()=>'SYNTHETIC_TOKEN'},async(input,init)=>{
      const url=new URL(String(input));
      if(url.pathname.endsWith('/start')){starts++;assert.equal(JSON.parse(String(init?.body)).conflict,'error');return envelope({token:'synthetic',upload_url:'https://api.kdrive.infomaniak.com/'});}
      if(init?.method==='DELETE'){cancels++;return envelope(true);}
      if(url.pathname.endsWith('/chunk')){chunks.push(new Uint8Array(init!.body as Uint8Array));return envelope({status:'ok'});}
      if(url.pathname.endsWith('/finish')){finishes++;return envelope({result:true,file:{id:9,name:'test.pdf',type:'file',size:bytes.length}});}
      throw new Error('Unexpected provider request');
    });
    provider.resolvePath=async()=>({id:7,name:'Synthetic',type:'dir'});
    const server=new McpServer({name:'binary-policy',version:'1'});
    registerBinaryTools(server,provider,{driveId:42,buildOpenUrl:()=> 'https://example.com/open'});
    const host=new Client({name:'test',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair();
    await server.connect(a);await host.connect(b);
    try{
      const source='https://'+sourceHost+'/synthetic/test.pdf?sig=SECRET';
      const response=await host.callTool({name:route==='native'?'kdrive_upload_file_ref':'kdrive_upload_from_url',arguments:{
        path:'/Synthetic/test.pdf',expected_size:bytes.length+(fault==='size'?1:0),expected_sha256:fault==='hash'?'0'.repeat(64):digest,
        ...(route==='native'?{file_ref:{file_id:'synthetic-adapter-fixture',download_url:source}}:{source_url:source}),
      }});
      assert.ok(!JSON.stringify(response).includes('SECRET'));
      if(fault==='none'){
        assert.ok(!response.isError);assert.equal(response.structuredContent?.sha256,digest);
        assert.equal(response.structuredContent?.size_bytes,bytes.length);
        assert.deepEqual(Buffer.concat(chunks),bytes);assert.equal(starts,1);assert.equal(finishes,1);assert.equal(cancels,0);
        assert.deepEqual(seenDns,route==='native'?[sourceHost]:['archive.org','dn760102.eu.archive.org']);
      }else{
        assert.equal(response.isError,true);assert.equal(finishes,0);
        const code=response.structuredContent?.binary_error_code;
        assert.equal(response.structuredContent?.error_code,code);
        assert.ok(response.structuredContent?.trace_id);
        assert.equal(code,fault==='redirect'?'SOURCE_HOST_DENIED':fault==='private-dns'?'BINARY_TRANSFER_FAILED':'INTEGRITY_MISMATCH');
        if(fault==='hash'){assert.equal(starts,1);assert.equal(cancels,1);}
        else{assert.equal(starts,0);assert.equal(response.structuredContent?.stage,'source_fetch');}
        if(fault==='redirect')assert.deepEqual(sourceRequests,[sourceHost]);
        if(fault==='private-dns')assert.equal(sourceRequests.length,0);
      }
    }finally{await host.close();await server.close();}
  });
}
