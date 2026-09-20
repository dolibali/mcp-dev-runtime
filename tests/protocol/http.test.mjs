import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Runtime } from '../../dist/runtime/runtime.js';
import { startHttp } from '../../dist/mcp/http.js';
import { fixture, delay, nodeCmd } from '../helpers.mjs';
const unpack = result => {
  assert(result.content?.[0]?.type==='text');const text=result.content[0].text;const i=text.indexOf('\n');
  return { ...(result.structuredContent ?? JSON.parse(i===-1?text:text.slice(0,i))), output:i===-1?'':text.slice(i+1), isError:result.isError };
};
async function connection(url) {
  const c=new Client({name:'local-dev-mcp-tests',version:'1.0.0'});
  await c.connect(new StreamableHTTPClientTransport(new URL(url)));return c;
}
async function setup(t,overrides={}) {
  const config=await fixture(t,overrides),runtime=new Runtime(config),h=await startHttp(runtime);
  t.after(()=>h.close());const c=await connection(h.url);t.after(()=>c.close());
  return {config,runtime,h,c,call:async(name,args={})=>unpack(await c.callTool({name,arguments:args}))};
}
async function drain(call,result) {
  let output=result.output;const until=Date.now()+15000;
  while(['running','terminating'].includes(result.state)||result.has_more) {
    assert(Date.now()<until,'process did not complete');result=await call('write_stdin',{session_id:result.session_id,yield_time_ms:1000});output+=result.output;
  }
  return {...result,output};
}
const modernHeaders={'Content-Type':'application/json','Accept':'application/json, text/event-stream','MCP-Protocol-Version':'2026-07-28','MCP-Method':'server/discover'};
const discovery={jsonrpc:'2.0',id:'discover-test',method:'server/discover',params:{_meta:{
  'io.modelcontextprotocol/protocolVersion':'2026-07-28',
  'io.modelcontextprotocol/clientInfo':{name:'test',version:'1.0.0'},
  'io.modelcontextprotocol/clientCapabilities':{}
}}};
test('HTTP: modern discovery returns real SDK result, not just HTTP 200',async t=>{
  const {h}=await setup(t);const r=await fetch(h.url,{method:'POST',headers:modernHeaders,body:JSON.stringify(discovery)});
  assert.equal(r.status,200);const j=await r.json();assert(!j.error,JSON.stringify(j));assert(j.result.supportedVersions.includes('2026-07-28'));
  const health=await fetch(h.url.replace('/mcp','/healthz'));assert.equal((await health.json()).status,'ok');
});
test('HTTP: all six names, parameters, required properties and annotations match contract',async t=>{
  const {c}=await setup(t);const actual=(await c.listTools()).tools;
  const contract=JSON.parse(await fs.readFile(new URL('../../contracts/tools.json',import.meta.url),'utf8')).tools;
  assert.deepEqual(actual.map(x=>x.name).sort(),contract.map(x=>x.name).sort());
  for(const expected of contract){const got=actual.find(x=>x.name===expected.name);assert.deepEqual(got.inputSchema,expected.inputSchema);assert.deepEqual(got.outputSchema,expected.outputSchema);assert.deepEqual(got.annotations,expected.annotations);}
});
test('HTTP: nonzero exit remains a normal tool result; invalid process becomes isError',async t=>{
  const {call}=await setup(t);const r=await drain(call,await call('exec_command',{cmd:'printf failure >&2; exit 9'}));
  assert.equal(r.isError,false);assert.equal(r.exit_code,9);assert.equal(r.output,'failure');
  const bad=await call('exec_command',{cmd:'true',shell:'/nonexistent/shell'});assert.equal(bad.isError,true);assert.equal(bad.error.code,'START_FAILED');
});
test('HTTP: unknown session and invalid patch are structured tool errors',async t=>{
  const {call}=await setup(t);const a=await call('write_stdin',{session_id:1});assert(a.isError);assert.equal(a.error.code,'UNKNOWN_SESSION');
  const b=await call('apply_patch',{patch:'not a patch'});assert(b.isError);assert(b.error.code);
});
test('HTTP: unknown input fields and wrong types are not executed',async t=>{
  const {c,config}=await setup(t);
  for(const args of [{cmd:4},{cmd:'touch should-not-exist',unexpected:true},{cmd:'true',yield_time_ms:10001}]){
    let rejected=false;try{const r=await c.callTool({name:'exec_command',arguments:args});rejected=!!r.isError;}catch{rejected=true;}assert(rejected);
  }
  await assert.rejects(fs.stat(path.join(config.cwd,'should-not-exist')),{code:'ENOENT'});
});
test('HTTP: process survives closing one client and polling from a new connection',async t=>{
  const {h,c,call}=await setup(t);const r=await call('exec_command',{cmd:nodeCmd("setTimeout(()=>console.log('survived'),350)"),yield_time_ms:0,request_id:'across-connection'});
  await c.close();const next=await connection(h.url);t.after(()=>next.close());const nextCall=async(name,arguments_)=>unpack(await next.callTool({name,arguments:arguments_}));
  const list=await nextCall('list_exec_sessions',{});assert(list.sessions.some(x=>x.session_id===r.session_id));
  const end=await drain(nextCall,{...r,output:''});assert.equal(end.exit_code,0);assert.equal(end.output,'survived\n');
});
test('HTTP: concurrent retries start one process',async t=>{
  const {c,call,config}=await setup(t);const args={cmd:'printf x >> once',request_id:'network-retry',yield_time_ms:1000};
  const [a,b]=await Promise.all([c.callTool({name:'exec_command',arguments:args}),c.callTool({name:'exec_command',arguments:args})]);
  const r=unpack(a);assert.equal(r.session_id,unpack(b).session_id);await drain(call,r);assert.equal(await fs.readFile(path.join(config.cwd,'once'),'utf8'),'x');
});
test('HTTP: image payload actually reaches the SDK client',async t=>{
  const {c,config}=await setup(t);const p=path.join(config.cwd,'screenshot.png');await sharp({create:{width:10,height:9,channels:3,background:'#abcd00'}}).png().toFile(p);
  const r=await c.callTool({name:'view_image',arguments:{path:p}});assert.equal(r.isError,false);const image=r.content.find(x=>x.type==='image');assert(image);
  assert.equal((await sharp(Buffer.from(image.data,'base64')).metadata()).width,10);
});
test('HTTP: request limits and malformed JSON do not break subsequent requests',async t=>{
  const {h,call}=await setup(t,{max_http_body_bytes:1024});
  const tooLarge=await fetch(h.url,{method:'POST',headers:{'Content-Type':'application/json'},body:'x'.repeat(2048)});assert.equal(tooLarge.status,413);
  const malformed=await fetch(h.url,{method:'POST',headers:{'Content-Type':'application/json'},body:'{'});assert.equal(malformed.status,400);
  assert.equal((await call('list_exec_sessions')).isError,false);
});
test('HTTP: legacy initialize and tools/list remain compatible',async t=>{
  const {h}=await setup(t);
  async function post(method,params,id){const r=await fetch(h.url,{method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json, text/event-stream','MCP-Protocol-Version':'2025-11-25'},body:JSON.stringify({jsonrpc:'2.0',method,params,id})});
    const text=await r.text();const data=r.headers.get('content-type')?.includes('text/event-stream')?text.split('\n').filter(x=>x.startsWith('data:')).map(x=>JSON.parse(x.slice(5))).find(x=>x.id===id):JSON.parse(text);assert(!data.error,JSON.stringify(data));return data;}
  const init=await post('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'legacy-test',version:'1.0.0'}},'init');assert(init.result.serverInfo);
  const tools=await post('tools/list',{},'tools');assert.equal(tools.result.tools.length,6);
});
test('HTTP: full development flow reads, patches, executes real tests and checks diff',async t=>{
  const {call,config}=await setup(t);
  await fs.writeFile(path.join(config.cwd,'calc.cjs'),'exports.add = (a,b) => a+b;\n');
  await fs.writeFile(path.join(config.cwd,'calc.test.cjs'),"const a=require('node:assert/strict');const c=require('./calc.cjs');a.equal(c.add(2,3),5);\n");
  const git=await drain(call,await call('exec_command',{cmd:'git init -q && git add calc.cjs calc.test.cjs && git -c user.name=MCP-Test -c user.email=test@example.invalid commit -qm baseline'}));assert.equal(git.exit_code,0);
  assert((await drain(call,await call('exec_command',{cmd:'cat calc.cjs calc.test.cjs'}))).output.includes('exports.add'));
  const patch='*** Begin Patch\n*** Update File: calc.cjs\n@@\n exports.add = (a,b) => a+b;\n+exports.multiply = (a,b) => a*b;\n*** Update File: calc.test.cjs\n@@\n const a=require(\'node:assert/strict\');const c=require(\'./calc.cjs\');a.equal(c.add(2,3),5);\n+a.equal(c.multiply(2,3),6);a.equal(c.multiply(-2,3),-6);a.equal(c.multiply(0,9),0);\n*** End Patch\n';
  const patched=await call('apply_patch',{patch});assert.equal(patched.applied,true,JSON.stringify(patched));
  const check=await drain(call,await call('exec_command',{cmd:`${JSON.stringify(process.execPath)} --check calc.cjs && ${JSON.stringify(process.execPath)} --test calc.test.cjs`}));assert.equal(check.exit_code,0);assert(check.output.includes('pass'),JSON.stringify(check));
  const diff=await drain(call,await call('exec_command',{cmd:'git diff --stat && git diff -- calc.cjs'}));assert(diff.output.includes('multiply'));
});

test('HTTP: lost initial response can be recovered without launching the command again',async t=>{
  const {h,call,config}=await setup(t);const controller=new AbortController();
  const params={name:'exec_command',arguments:{cmd:'printf x >> lost-once; sleep 0.3; printf recovered',yield_time_ms:1000,request_id:'lost-response'},_meta:discovery.params._meta};
  const pending=fetch(h.url,{method:'POST',signal:controller.signal,headers:{...modernHeaders,'MCP-Method':'tools/call','MCP-Name':'exec_command'},body:JSON.stringify({jsonrpc:'2.0',id:'lost',method:'tools/call',params})}).catch(e=>e);
  let record;for(let i=0;i<100;i++){record=(await call('list_exec_sessions')).sessions.find(x=>x.request_id==='lost-response');if(record)break;await delay(10);}
  assert(record,'The raw request must reach the actual runtime before aborting');controller.abort();await pending;
  // Output arrival and observed process exit are separate events. Recover the
  // same session using explicit cursors until it has actually exited; do not
  // assume a fixed sleep guarantees that a loaded CI runner has reaped it.
  let r,output='',cursor=0;const deadline=Date.now()+15000;
  do {
    assert(Date.now()<deadline,'Original session did not finish after the response was lost');
    r=await call('write_stdin',{session_id:record.session_id,output_cursor:cursor,yield_time_ms:1000});
    assert(!r.isError,JSON.stringify(r));assert(!r.output_gap);
    output+=r.output;cursor=r.next_output_cursor;
  } while(['running','terminating'].includes(r.state)||r.has_more);
  assert.equal(output,'recovered');assert.equal(r.exit_code,0);
  assert.equal(await fs.readFile(path.join(config.cwd,'lost-once'),'utf8'),'x');
});
test('HTTP: session extensions terminate a running command and expose terminal state',async t=>{
  const {call}=await setup(t,{exec:{termination_grace_ms:50}});const a=await call('exec_command',{cmd:'sleep 10',yield_time_ms:0});
  const stopped=await call('terminate_exec_session',{session_id:a.session_id});assert(stopped.termination_confirmed);assert.equal(stopped.state,'terminated');
  const records=await call('list_exec_sessions',{state:'terminated'});assert(records.sessions.some(x=>x.session_id===a.session_id));
});

test('HTTP: TypeScript diagnostics are fixed by a real patch and rechecked',async t=>{
  const {call,config}=await setup(t);
  await fs.writeFile(path.join(config.cwd,'typed.ts'),'export const count: number = "wrong";\n');
  const tsc=JSON.stringify(path.resolve('node_modules/.bin/tsc'));
  const command=tsc+' --noEmit --skipLibCheck --target ES2023 --module NodeNext typed.ts';
  const bad=await drainUnchecked(await call('exec_command',{cmd:command,yield_time_ms:1000}),call);assert.notEqual(bad.exit_code,0);assert(bad.output.includes('number'));
  const patched=await call('apply_patch',{patch:'*** Begin Patch\n*** Update File: typed.ts\n@@\n-export const count: number = "wrong";\n+export const count: number = 3;\n*** End Patch\n'});assert(patched.applied);
  const good=await drain(call,await call('exec_command',{cmd:command,yield_time_ms:1000}));assert.equal(good.exit_code,0);
});
async function drainUnchecked(result,call){let output=result.output;const until=Date.now()+15000;
  while(['running','terminating'].includes(result.state)||result.has_more){assert(Date.now()<until);result=await call('write_stdin',{session_id:result.session_id,yield_time_ms:1000});output+=result.output;}return {...result,output};
}
test('HTTP: JPEG and WebP reach the client with valid MIME and image bytes',async t=>{
  const {c,config}=await setup(t);
  for(const type of ['jpeg','webp']){
    const file=path.join(config.cwd,'image.'+type);await sharp({create:{width:11,height:7,channels:3,background:'#123456'}}).toFormat(type).toFile(file);
    const r=await c.callTool({name:'view_image',arguments:{path:file}});assert.equal(r.isError,false);const image=r.content.find(x=>x.type==='image');assert(image);assert.equal(image.mimeType,'image/'+type);assert.equal((await sharp(Buffer.from(image.data,'base64')).metadata()).width,11);
  }
});
