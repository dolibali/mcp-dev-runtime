import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { Runtime } from '../../dist/runtime/runtime.js';
import { PatchEngine } from '../../dist/runtime/patch-engine.js';
import { RetryCache } from '../../dist/runtime/retry-cache.js';
import { startHttp } from '../../dist/mcp/http.js';
import { fixture, nodeCmd } from '../helpers.mjs';
import { contracts, assertOutput } from '../output-contract-helper.mjs';
import { defaultToolAllowlist } from '../../dist/mcp/tool-registry.js';
async function setup(t) {
  const config=await fixture(t),runtime=new Runtime(config),http=await startHttp(runtime);
  t.after(()=>http.close());
  const c=new Client({name:'output-schema-test',version:'1.0.0'});t.after(()=>c.close());
  await c.connect(new StreamableHTTPClientTransport(new URL(http.url)));
  const names=(await c.listTools()).tools;
  assert.deepEqual(names.map(tool=>tool.name),defaultToolAllowlist);
  for(const expected of contracts.filter(tool=>defaultToolAllowlist.includes(tool.name)))assert.deepEqual(names.find(x=>x.name===expected.name)?.outputSchema,expected.outputSchema);
  return {config,runtime,http,c,call:async(name,args={})=>assertOutput(name,await c.callTool({name,arguments:args}))};
}
test('output contract HTTP: all six real tools validate against the advertised schemas',async t=>{
  const {call,config,c}=await setup(t);
  const first=await call('exec_command',{cmd:'printf before; sleep 0.1; printf after',yield_time_ms:0});
  assert.equal(first.state,'running');let r=first,output=r.output;
  while(['running','terminating'].includes(r.state)||r.has_more){r=await call('write_stdin',{session_id:r.session_id,yield_time_ms:1000});output+=r.output;}
  assert.equal(r.exit_code,0);assert.equal(output,'beforeafter');
  const list=await call('list_exec_sessions');assert(list.sessions.some(x=>x.session_id===first.session_id));
  const patch=await call('apply_patch',{patch:'*** Begin Patch\n*** Add File: check.txt\n+checked\n*** End Patch\n'});assert.equal(patch.applied,true);
  assert.equal(await fs.readFile(path.join(config.cwd,'check.txt'),'utf8'),'checked\n');
  const imagePath=path.join(config.cwd,'pixel.png');await sharp({create:{width:12,height:8,channels:3,background:'#aabbcc'}}).png().toFile(imagePath);
  const image=await c.callTool({name:'view_image',arguments:{path:imagePath}});const meta=await assertOutput('view_image',image);
  assert.equal(meta.width,12);assert(image.content.some(x=>x.type==='image'));
  const active=await call('exec_command',{cmd:'sleep 10',yield_time_ms:0});
  const end=await call('terminate_exec_session',{session_id:active.session_id});assert.equal(end.termination_confirmed,true);
});
test('output contract HTTP: error branches are not masked by output validation',async t=>{
  const {call,config}=await setup(t);
  const cases=[['exec_command',{cmd:'true',shell:'/nonexistent/output-test-shell'}],['write_stdin',{session_id:1}],
    ['apply_patch',{patch:'invalid'}],['view_image',{path:path.join(config.cwd,'missing.png')}],
    ['list_exec_sessions',{cursor:'invalid'}],['terminate_exec_session',{session_id:1}]];
  for(const [name,args] of cases){const r=await call(name,args);assert.equal(r.isError,true,name);assert(r.error.code);assert(r.error.message);}
  const nonzero=await call('exec_command',{cmd:'exit 6'});assert.equal(nonzero.isError,false);assert.equal(nonzero.exit_code,6);
});
test('output contract HTTP: structured-only callers receive stdout, stderr and bounded Unicode continuation',async t=>{
  const {c}=await setup(t);
  async function structured(name,args) {
    const result=await c.callTool({name,arguments:args});
    assert.equal(result.isError,false);
    // Model a client adapter that discards every content block.
    return JSON.parse(JSON.stringify(result.structuredContent));
  }
  const expected='中🙂文\n'.repeat(900);
  let r=await structured('exec_command',{cmd:nodeCmd(`process.stdout.write(${JSON.stringify(expected)})`),max_output_tokens:256,yield_time_ms:1000});
  let output='',cursor=0,calls=0;
  const deadline=Date.now()+15000;
  for(;;) {
    assert(Date.now()<deadline,'structured-only continuation did not finish');
    assert.equal(typeof r.output,'string');
    assert.equal(r.output_gap,false);
    assert.equal(r.output_start,cursor);
    assert(Buffer.byteLength(r.output)<=1024);
    output+=r.output;cursor=r.next_output_cursor;calls++;
    if(!['running','terminating'].includes(r.state)&&!r.has_more) break;
    r=await structured('write_stdin',{session_id:r.session_id,max_output_tokens:256,yield_time_ms:1000});
  }
  assert(calls>1);assert.equal(r.exit_code,0);
  assert.equal(output,expected);assert.equal(cursor,Buffer.byteLength(expected));
  const empty=await structured('write_stdin',{session_id:r.session_id,yield_time_ms:0});
  assert.equal(empty.output,'');assert.equal(empty.output_start,cursor);
  const failed=await structured('exec_command',{cmd:"printf 'stdout-marker\n'; printf 'stderr-marker\n' >&2; exit 7",yield_time_ms:1000});
  assert.equal(failed.exit_code,7);
  assert(failed.output.includes('stdout-marker'));assert(failed.output.includes('stderr-marker'));
});
test('output contract HTTP: partial changes survive SDK error-result handling',async t=>{
  const {runtime,config,call}=await setup(t);
  runtime.patch=new PatchEngine(config,new RetryCache(60000,32),{beforeWrite:async i=>{if(i===1)throw new Error('Injected I/O failure');}});
  const r=await call('apply_patch',{patch:'*** Begin Patch\n*** Add File: a\n+applied\n*** Add File: b\n+not-applied\n*** End Patch\n'});
  assert.equal(r.isError,true);assert.equal(r.error.code,'PARTIAL_APPLY');assert.equal(r.error.partial,true);assert.equal(r.error.changes.length,1);
  assert.equal(await fs.readFile(path.join(config.cwd,'a'),'utf8'),'applied\n');await assert.rejects(fs.stat(path.join(config.cwd,'b')),{code:'ENOENT'});
});
test('output contract HTTP: SDK rejects deliberately malformed success results',async t=>{
  const {runtime,c}=await setup(t);
  runtime.invoke=async()=>({content:[{type:'text',text:'{}'}],structuredContent:{},isError:false});
  let rejected=false;
  try{const r=await c.callTool({name:'exec_command',arguments:{cmd:'not-executed'}});rejected=r.isError===true;}
  catch{rejected=true;}
  assert(rejected,'SDK must not accept an empty execution result under the declared schema');
});
test('output contract stdio: schemas and error envelopes survive the stdio transport',async t=>{
  const config=await fixture(t);
  const transport=new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../../dist/main.js',import.meta.url)),'--transport','stdio','--cwd',config.cwd,'--shell','/bin/bash','--log-level','silent'],stderr:'pipe'});
  const c=new Client({name:'output-contract-stdio',version:'1.0.0'});t.after(()=>c.close());await c.connect(transport);
  for(const tool of (await c.listTools()).tools)assert.deepEqual(tool.outputSchema,contracts.find(x=>x.name===tool.name).outputSchema);
  const raw=await c.callTool({name:'exec_command',arguments:{cmd:'printf stdio-contract'}});
  assert.equal(raw.structuredContent.output,'stdio-contract');
  const good=await assertOutput('exec_command',raw);assert.equal(good.exit_code,0);assert.equal(good.output,'stdio-contract');
  const error=await assertOutput('write_stdin',await c.callTool({name:'write_stdin',arguments:{session_id:1}}));assert.equal(error.error.code,'UNKNOWN_SESSION');assert.equal(error.isError,true);
});
test('output contract legacy HTTP: object schemas and call results remain compatible',async t=>{
  const {http}=await setup(t);
  async function post(method,params,id){
    const r=await fetch(http.url,{method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json, text/event-stream','MCP-Protocol-Version':'2025-11-25'},body:JSON.stringify({jsonrpc:'2.0',method,params,id})});
    const text=await r.text();const data=r.headers.get('content-type')?.includes('text/event-stream')?text.split('\n').filter(x=>x.startsWith('data:')).map(x=>JSON.parse(x.slice(5))).find(x=>x.id===id):JSON.parse(text);
    assert(data&&!data.error,JSON.stringify(data));return data.result;
  }
  await post('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'legacy-output-contract',version:'1.0.0'}},'init');
  const listed=await post('tools/list',{},'list');assert.equal(listed.tools.length,6);assert(listed.tools.every(x=>x.outputSchema?.type==='object'));
  const r=await assertOutput('exec_command',await post('tools/call',{name:'exec_command',arguments:{cmd:'printf legacy-contract'}},'call'));
  assert.equal(r.exit_code,0);assert.equal(r.output,'legacy-contract');
});
