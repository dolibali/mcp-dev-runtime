import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {promisify} from 'node:util';
import {execFile} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {Runtime} from '../../dist/runtime/runtime.js';
import {HistoryStore} from '../../dist/runtime/history-store.js';
import {startHttp} from '../../dist/mcp/http.js';
import {fixture,nodeCmd} from '../helpers.mjs';
import {assertOutput,contracts} from '../output-contract-helper.mjs';
const exec=promisify(execFile);
async function serve(t,config){
  const runtime=new Runtime(config),http=await startHttp(runtime);t.after(()=>http.close());
  const client=new Client({name:'history-protocol-test',version:'1.0.0'});t.after(()=>client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(http.url)));
  const call=async(name,args={})=>assertOutput(name,await client.callTool({name,arguments:args}));
  return {runtime,http,client,call};
}
test('history HTTP: opt-in archive, filters, read-only query modes and schemas work through the real SDK',async t=>{
  const config=await fixture(t,{history:{enabled:true}}),{call,client}=await serve(t,config);
  assert.equal((await client.listTools()).tools.length,6);
  const r=await call('exec_command',{cmd:"printf 'line one\n错误 error\nlast\n'",capture_output:true,label:'protocol/build'});
  assert(r.archive_id);assert.equal(r.exit_code,0);
  const list=await call('list_exec_sessions',{scope:'history',workdir:config.cwd,label:'protocol',outcome:'success',order:'desc'});
  assert.equal(list.sessions.length,1);assert.equal(list.sessions[0].archive_id,r.archive_id);
  const tail=await call('write_stdin',{session_id:r.session_id,archive_id:r.archive_id,tail_lines:1});assert.equal(tail.output,'last\n');
  const search=await call('write_stdin',{session_id:r.session_id,archive_id:r.archive_id,search:'错误'});assert.equal(search.matches.length,1);assert.equal(search.output,'');
  const bad=await call('write_stdin',{session_id:r.session_id,tail_lines:1,chars:'not-sent'});assert.equal(bad.error.code,'INVALID_QUERY');
});
test('history HTTP: new service instance can inspect old logs but cannot send input to old processes',async t=>{
  const config=await fixture(t,{history:{enabled:true}});const first=await serve(t,config);
  const r=await first.call('exec_command',{cmd:'printf cross-restart',capture_output:true,label:'restart-check'});
  await first.client.close();await first.http.close();
  const second=await serve(t,config);assert.notEqual(second.runtime.exec.instanceId,first.runtime.exec.instanceId);
  const listed=await second.call('list_exec_sessions',{scope:'history',label:'restart-check'});assert.equal(listed.sessions.length,1);
  const read=await second.call('write_stdin',{session_id:r.session_id,archive_id:r.archive_id});assert.equal(read.output,'cross-restart');
  assert.equal(read.instance_id,r.instance_id);assert.equal(read.source,'history');
  const old=await second.call('write_stdin',{session_id:r.session_id});assert.equal(old.error.code,'UNKNOWN_SESSION');
  const input=await second.call('write_stdin',{session_id:r.session_id,archive_id:r.archive_id,chars:'input'});assert.equal(input.error.code,'ARCHIVED_SESSION_READ_ONLY');
});
test('history HTTP: unknown previous outcomes validate, without fabricated exit codes',async t=>{
  const config=await fixture(t,{history:{enabled:true}});const h=new HistoryStore(config,randomUUID());await h.ready;
  const id=await h.start({session_id:101,instance_id:h.instanceId,state:'running',exit_code:null,signal:null,tty:false,workdir:config.cwd,
    created_at:new Date().toISOString(),ended_at:null,cmd:'not actually executed',capture_output:true,total_output_bytes:0});
  h.append(id,'observed-prefix');await h.close();
  const {call}=await serve(t,config);
  const listing=await call('list_exec_sessions',{scope:'history',state:'unknown'});assert.equal(listing.sessions.length,1);
  const read=await call('write_stdin',{session_id:101,archive_id:id});assert.equal(read.state,'unknown');assert.equal(read.exit_code,null);assert.equal(read.ended_at,null);
});
test('history HTTP: oversized, invalid and conflicting selectors are rejected safely',async t=>{
  const config=await fixture(t,{history:{enabled:true}}),{call,client}=await serve(t,config);
  const r=await call('exec_command',{cmd:':'});
  for(const args of [{tail_lines:0},{search:''},{archive_id:'../bad'},{tail_lines:10001},{max_matches:101,search:'x'}]){
    const raw=await client.callTool({name:'write_stdin',arguments:{session_id:r.session_id,...args}});
    assert.equal(raw.isError,true,JSON.stringify(args));
  }
  const r2=await call('exec_command',{cmd:'printf after-invalid'});assert.equal(r2.output,'after-invalid');
});
test('doctor: fresh health and official SDK discovery do not start commands',async t=>{
  const config=await fixture(t,{history:{enabled:true}}),{runtime,http}=await serve(t,config);
  const file=path.join(config.cwd,'doctor-config.json');await fs.writeFile(file,JSON.stringify({...config,port:http.port}));
  const before=runtime.exec.list().sessions.length;
  const r=await exec(process.execPath,[path.resolve('scripts/doctor.mjs'),'--config',file,'--json'],{timeout:15000});
  const d=JSON.parse(r.stdout);assert.equal(d.ok,true,r.stdout);assert.equal(d.protocol.tools.length,6);assert.equal(d.protocol.commands_executed,0);
  assert.equal(runtime.exec.list().sessions.length,before);
});
test('history CLI: clearing requires confirmation and refuses an active writer',async t=>{
  const config=await fixture(t,{history:{enabled:true}}),{call,http,client}=await serve(t,config);
  await call('exec_command',{cmd:':'});
  const file=path.join(config.cwd,'history-clear-config.json');await fs.writeFile(file,JSON.stringify(config));
  const cli=path.resolve('dist/launcher/cli.js');
  await assert.rejects(exec(process.execPath,[cli,'history-clear','--config',file],{timeout:10000}),e=>e.stderr.includes('--confirm'));
  await assert.rejects(exec(process.execPath,[cli,'history-clear','--config',file,'--confirm'],{timeout:10000}),e=>e.stderr.includes('in use'));
  await client.close();await http.close();
  const cleared=await exec(process.execPath,[cli,'history-clear','--config',file,'--confirm'],{timeout:10000});assert.equal(JSON.parse(cleared.stdout).cleared,true);
});
