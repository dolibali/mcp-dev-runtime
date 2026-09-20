import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fixture, manager, finish, delay, nodeCmd } from '../helpers.mjs';
import { ExecManager } from '../../dist/runtime/exec-manager.js';
import { Runtime } from '../../dist/runtime/runtime.js';
import { HistoryStore } from '../../dist/runtime/history-store.js';
import { RetryCache } from '../../dist/runtime/retry-cache.js';
import { assertOutput } from '../output-contract-helper.mjs';

async function historyFixture(t, overrides={}) {
  const config=await fixture(t,{history:{enabled:true,...overrides}});
  const m=new ExecManager(config);
  t.after(()=>m.close());
  await m.history.ready;
  assert.equal(m.history.status.state,'ready',JSON.stringify(m.history.status));
  return {m,config,dir:m.history.directory};
}
function seed(h,id,extra={}) {return {session_id:id,instance_id:h.instanceId,state:'running',exit_code:null,signal:null,tty:false,
  workdir:h.config.cwd,created_at:new Date().toISOString(),ended_at:null,cmd:'fixture secret text',capture_output:true,total_output_bytes:0,...extra};}
const end=(bytes=0)=>({state:'exited',exit_code:0,signal:null,ended_at:new Date().toISOString(),total_output_bytes:bytes});

test('retention: default has no time expiry, even after multiple days; active tasks are untouched',async t=>{
  const m=await manager(t,{exec:{termination_grace_ms:30}});
  assert.equal(m.config.exec.retained_session_ms,null);
  const done=await m.exec({cmd:'printf retained'}),active=await m.exec({cmd:'sleep 10',yield_time_ms:0});
  const original=Date.now;try{Date.now=()=>original()+3*86400000;m.sweep();}finally{Date.now=original;}
  assert.equal((await m.write({session_id:done.session_id,output_cursor:0,yield_time_ms:0})).output,'retained');
  assert.equal(m.list({state:'running'}).sessions[0].session_id,active.session_id);
});
test('retention: zero disables expiry while count and byte accounting remain bounded',async t=>{
  const m=await manager(t,{exec:{retained_session_ms:0,max_ended_sessions:2,total_output_bytes:1024,per_session_output_bytes:1024}});
  for(let i=0;i<6;i++)await m.exec({cmd:nodeCmd("process.stdout.write('x'.repeat(800))")});
  m.sweep();assert.equal(m.list().sessions.length,2);assert(m.outputBytes<=1024);
  assert.equal(m.outputBytes,[...m.records.values()].reduce((n,s)=>n+s.log.size,0));
});
test('retention: completed records release process handles and bound command previews',async t=>{
  const m=await manager(t);const r=await m.exec({cmd:': # '+ 'x'.repeat(8000)});
  assert.equal(r.exit_code,0);const retained=m.records.get(r.session_id);
  assert.equal(retained.handle,undefined);assert(retained.cmd.length<=513);
});
test('retention: running creation request stays pinned across TTL and cache pressure',async t=>{
  const m=await manager(t,{request_cache_ttl_ms:100,request_cache_entries:8,exec:{retained_session_ms:100,termination_grace_ms:30}});
  const args={cmd:'printf x >> created-once; sleep 10',yield_time_ms:0,request_id:'protected-active'};
  const first=await m.exec(args);await delay(150);
  for(let i=0;i<20;i++)await m.exec({cmd:':',request_id:'pressure-'+i});
  const replay=await m.exec(args);assert.equal(first.session_id,replay.session_id);
  assert.equal(await fs.readFile(path.join(m.config.cwd,'created-once'),'utf8'),'x');
  await assert.rejects(m.exec({...args,cmd:':'}),{code:'REQUEST_ID_CONFLICT'});
  await m.terminate({session_id:first.session_id});
  assert.equal(m.diagnostics.retry.protected_entries,0);
});
test('retry: pinned records cannot be evicted; completed TTL starts after release',async()=>{
  const cache=new RetryCache(30,1);let release;
  const a=await cache.run('exec','pin',{},async()=>{release=cache.pin('pin');return 42;});
  await delay(45);cache.sweep();assert.equal(cache.stats.protected_entries,1);
  assert.equal(await cache.run('exec','pin',{},async()=>0),a);
  await assert.rejects(cache.run('exec','other',{},async()=>1),{code:'REQUEST_CACHE_FULL'});
  release();release();assert.equal(cache.stats.protected_entries,0);
  assert.equal(await cache.run('exec','pin',{},async()=>0),42);
  await delay(40);assert.equal(await cache.run('exec','pin',{},async()=>9),9);
});
test('history: default metadata is private; command and raw output are not saved',async t=>{
  const {m,dir}=await historyFixture(t);
  const secret='SYNTHETIC_HISTORY_SECRET_'+randomUUID();
  const result=await m.exec({cmd:`printf '${secret}'`,label:'privacy-check'});
  await m.history.flush();assert(result.archive_id);
  const listing=await m.history.list();assert.equal(listing.sessions[0].cmd,'[not recorded]');assert.equal(listing.sessions[0].label,'privacy-check');
  for(const name of await fs.readdir(dir))if(name.endsWith('.json')||name.endsWith('.log'))assert(!(await fs.readFile(path.join(dir,name),'utf8')).includes(secret));
  assert.equal((await fs.stat(dir)).mode&0o777,0o700);
  assert.equal((await fs.stat(path.join(dir,result.archive_id+'.json'))).mode&0o777,0o600);
  await assert.rejects(m.history.read(result.archive_id,{},256),{code:'OUTPUT_NOT_RECORDED'});
});
test('history: disk output survives memory eviction and restart, with exact UTF-8 bytes',async t=>{
  const config=await fixture(t,{exec:{max_ended_sessions:1,per_session_output_bytes:1024},history:{enabled:true}});
  const first=new ExecManager(config);t.after(()=>first.close());
  const text='历史🙂完整输出\n'.repeat(500);
  const r=await first.exec({cmd:nodeCmd(`process.stdout.write(${JSON.stringify(text)})`),capture_output:true,label:'build/frontend'});
  assert(r.output_gap);await first.exec({cmd:':'});first.sweep();
  await assert.rejects(first.write({session_id:r.session_id}),{code:'UNKNOWN_SESSION'});
  await first.close();
  const second=new ExecManager(config);t.after(()=>second.close());
  const all=await second.history.list({label:'frontend',workdir:config.cwd,outcome:'success'});
  assert.equal(all.sessions.length,1);assert.equal(all.sessions[0].archive_id,r.archive_id);
  let cursor=0,output='',last;
  do {last=await second.write({session_id:r.session_id,archive_id:r.archive_id,output_cursor:cursor,max_output_tokens:256});
    assert.equal(last.output_start,cursor);assert.equal(last.archive_truncated,false);output+=last.output;cursor=last.next_output_cursor;
  }while(last.has_more);
  assert.equal(output,text);assert.equal(cursor,Buffer.byteLength(text));assert.equal(last.instance_id,first.instanceId);
  await assert.rejects(async()=>second.write({session_id:r.session_id,archive_id:r.archive_id,chars:'input'}),{code:'ARCHIVED_SESSION_READ_ONLY'});
  await assert.rejects(second.terminate({session_id:r.session_id}),{code:'UNKNOWN_SESSION'});
});
test('history: capture occurs while running, not reconstructed from a truncated final cache',async t=>{
  const {m}=await historyFixture(t);
  const r=await m.exec({cmd:"printf 'before-sleep\n'; sleep 5",capture_output:true,yield_time_ms:40});
  assert.equal(r.state,'running');await m.history.flush();
  const saved=await m.history.read(r.archive_id,{},256);assert.equal(saved.output,'before-sleep\n');assert.equal(saved.state,'running');
  await m.terminate({session_id:r.session_id});await m.history.flush();
});
test('history: unconfirmed previous-instance outcomes are never reported as successful',async t=>{
  const config=await fixture(t,{history:{enabled:true}});
  const a=new HistoryStore(config,randomUUID());await a.ready;
  const id=await a.start(seed(a,100));a.append(id,'partial');await a.flush();await a.close();
  const b=new HistoryStore(config,randomUUID());t.after(()=>b.close());
  const list=await b.list({outcome:'unknown'});assert.equal(list.sessions.length,1);
  assert.equal(list.sessions[0].state,'unknown');assert.equal(list.sessions[0].ended_at,null);assert.equal(list.sessions[0].exit_code,null);
  const recovered=await b.read(id,{},256);assert.equal(recovered.output,'partial');assert.equal(recovered.archive_truncated,true);
});
test('history: entry quota rotates oldest complete entries, not protected running entries',async t=>{
  const {m}=await historyFixture(t,{max_records:2});
  const active=await m.exec({cmd:'sleep 10',yield_time_ms:0,label:'active'});
  const old=await m.exec({cmd:'printf old',capture_output:true});await m.history.flush();
  const recent=await m.exec({cmd:'printf recent',capture_output:true});await m.history.flush();
  const list=await m.history.list();assert.equal(list.sessions.length,2);
  assert(list.sessions.some(s=>s.archive_id===active.archive_id));assert(list.sessions.some(s=>s.archive_id===recent.archive_id));
  await assert.rejects(m.history.read(old.archive_id,{},256),{code:'HISTORY_NOT_FOUND'});
});
test('history: full active archive does not block execution and can accept records after release',async t=>{
  const {m}=await historyFixture(t,{max_records:1});
  const active=await m.exec({cmd:'sleep 10',yield_time_ms:0});
  const notArchived=await m.exec({cmd:'printf still-runs'});assert.equal(notArchived.output,'still-runs');assert.equal(notArchived.archive_id,undefined);
  assert.equal(m.history.status.state,'degraded');await m.terminate({session_id:active.session_id});await m.history.flush();
  const after=await m.exec({cmd:'printf recovered'});assert(after.archive_id);await m.history.flush();
});
test('history: queue and per-log caps explicitly mark incomplete archives',async t=>{
  const {m}=await historyFixture(t,{max_pending_bytes:1024,max_log_bytes:2048});
  const r=await m.exec({cmd:nodeCmd("process.stdout.write('中'.repeat(4000))"),capture_output:true});await m.history.flush();
  const saved=await m.history.read(r.archive_id,{},256);
  assert.equal(saved.archive_truncated,true);assert(saved.archive_output_bytes<=2048);assert(saved.history_warning);
  assert.equal(m.history.status.pending_bytes,0);assert(!saved.output.includes('\ufffd'));
});
test('history: a second writer degrades safely and cannot remove the first writer lock',async t=>{
  const {m,config,dir}=await historyFixture(t);
  const second=new ExecManager(config);t.after(()=>second.close());await second.history.ready;
  assert.equal(second.history.status.state,'degraded');assert.equal((await second.exec({cmd:'printf no-archive'})).output,'no-archive');
  await second.close();assert((await fs.stat(path.join(dir,'.writer-lock'))).isDirectory());
  assert((await m.exec({cmd:':'})).archive_id);
});
test('history: corrupt metadata reports degradation, without disabling ordinary commands',async t=>{
  const {m,config,dir}=await historyFixture(t);const r=await m.exec({cmd:':'});await m.close();
  await fs.writeFile(path.join(dir,r.archive_id+'.json'),'{invalid');
  const second=new ExecManager(config);t.after(()=>second.close());await second.history.ready;
  assert.equal(second.history.status.state,'degraded');await assert.rejects(second.history.list(),{code:'HISTORY_UNAVAILABLE'});
  assert.equal((await second.exec({cmd:'printf survives'})).output,'survives');
});
test('history: directory symlinks are rejected; no arbitrary target is used as storage',async t=>{
  const config=await fixture(t,{history:{enabled:true}});const target=path.join(config.cwd,'target');await fs.mkdir(target);
  const link=path.join(config.cwd,'link');await fs.symlink(target,link);config.history.directory=link;
  const m=new ExecManager(config);t.after(()=>m.close());await m.history.ready;assert.equal(m.history.status.state,'degraded');
  assert.deepEqual(await fs.readdir(target),[]);assert.equal((await m.exec({cmd:':'})).exit_code,0);
});
test('history: stable filtered pagination, explicit disk clearing and argument validation',async t=>{
  const {m}=await historyFixture(t);
  for(let i=0;i<4;i++)await m.exec({cmd:':',label:'group-'+i});
  const one=await m.history.list({label:'group',limit:2});assert(one.next_cursor);
  await m.exec({cmd:':',label:'group-new'});
  const two=await m.history.list({label:'group',limit:2,cursor:one.next_cursor});assert.equal(two.next_cursor,null);
  assert.equal(new Set([...one.sessions,...two.sessions].map(s=>s.session_id)).size,4);
  await assert.rejects(m.history.list({label:'different',cursor:one.next_cursor}),{code:'INVALID_CURSOR'});
  await assert.rejects(m.history.read('../outside',{},256),{code:'INVALID_HISTORY_ID'});
  await m.history.clear();assert.equal((await m.history.list()).sessions.length,0);
});
test('history: actual runtime history results satisfy all advertised output schemas',async t=>{
  const config=await fixture(t,{history:{enabled:true}});const runtime=new Runtime(config);t.after(()=>runtime.close());
  const r=await runtime.invoke('exec_command',{cmd:"printf 'one\nerror two\nlast\n'",capture_output:true,label:'wire'});
  await assertOutput('exec_command',r);const id=r.structuredContent.session_id,archive=r.structuredContent.archive_id;
  await assertOutput('list_exec_sessions',await runtime.invoke('list_exec_sessions',{scope:'history',label:'wire'}));
  for(const mode of [{},{tail_lines:2},{search:'error'}])await assertOutput('write_stdin',await runtime.invoke('write_stdin',{session_id:id,archive_id:archive,...mode}));
});
test('history: disk-write failure is explicit and does not pretend to capture missing output',async t=>{
  const config=await fixture(t,{history:{enabled:true}});
  const h=new HistoryStore(config,randomUUID(),{beforeWrite:kind=>{if(kind==='log')throw new Error('Injected ENOSPC');}});t.after(()=>h.close());
  const id=await h.start(seed(h,1));h.append(id,'not-written');h.finish(id,end(11));await h.flush();
  assert.equal(h.status.state,'degraded');assert.equal(h.status.pending_bytes,0);
  const r=await h.read(id,{},256);assert.equal(r.archive_truncated,true);assert.equal(r.output,'');assert.equal(r.total_output_bytes,11);
  assert.equal(r.archive_output_bytes,0);assert.equal(r.history_warning,'ARCHIVE_WRITE_FAILED');
});
test('history: total disk quota stays bounded across many large completed archives',async t=>{
  const {m,dir}=await historyFixture(t,{max_total_bytes:98304,max_log_bytes:32768,max_records:20});
  for(let n=0;n<8;n++){await m.exec({cmd:nodeCmd("process.stdout.write('x'.repeat(20000))"),capture_output:true});await m.history.flush();}
  const names=(await fs.readdir(dir)).filter(n=>n.endsWith('.json')||n.endsWith('.log'));
  let bytes=0;for(const name of names)bytes+=(await fs.stat(path.join(dir,name))).size;
  assert(bytes<=98304);assert.equal(bytes,m.history.status.bytes);assert(m.history.status.evicted_records>0);
});
