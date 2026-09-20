import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { manager, finish, delay, nodeCmd, quote } from '../helpers.mjs';

test('exec: short command finishes within yield with real exit code', async t=>{
  const m=await manager(t);const r=await m.exec({cmd:'printf hello',yield_time_ms:1000});
  assert.equal(r.state,'exited');assert.equal(r.exit_code,0);assert.equal(r.output,'hello');assert(r.session_id>0);
});
test('exec: nonzero exit is a normal execution result',async t=>{
  const m=await manager(t);const r=await finish(m,await m.exec({cmd:'printf problem >&2; exit 7'}));
  assert.equal(r.state,'exited');assert.equal(r.exit_code,7);assert.equal(r.output,'problem');assert.equal(r.error,undefined);
});
test('exec: missing shell reports start_failed rather than successful empty output',async t=>{
  const m=await manager(t);const r=await finish(m,await m.exec({cmd:'true',shell:'/nonexistent/local-dev-shell'}));
  assert.equal(r.state,'start_failed');assert.equal(r.exit_code,null);assert(r.error);
});
test('exec: nonexistent workdir reports a start failure',async t=>{
  const m=await manager(t);const r=await m.exec({cmd:'true',workdir:'missing'});assert.equal(r.state,'start_failed');
});
test('exec: each concurrent command has an independent cwd',async t=>{
  const m=await manager(t);const a=path.join(m.config.cwd,'a'),b=path.join(m.config.cwd,'b');await mkdir(a);await mkdir(b);
  const rs=await Promise.all([m.exec({cmd:'pwd',workdir:a}),m.exec({cmd:'pwd',workdir:b})]);
  assert.equal((await finish(m,rs[0])).output.trim(),a);assert.equal((await finish(m,rs[1])).output.trim(),b);
});
test('exec: a short yield does not kill a longer command',async t=>{
  const m=await manager(t);const r=await m.exec({cmd:nodeCmd("setTimeout(()=>console.log('done'),250)"),yield_time_ms:5});
  assert.equal(r.state,'running');const end=await finish(m,r);assert.equal(end.exit_code,0);assert.equal(end.output,'done\n');
});
test('exec: final stdout/stderr is drained and UTF-8 spans chunks',async t=>{
  const m=await manager(t);const cmd=nodeCmd("const b=Buffer.from('中🙂尾'); process.stdout.write(b.subarray(0,2));setTimeout(()=>{process.stdout.write(b.subarray(2));process.stderr.write('ERR')},30)");
  const r=await finish(m,await m.exec({cmd}));assert(r.output.includes('中🙂尾'));assert(r.output.includes('ERR'));assert(!r.output.includes('\ufffd'));
});
test('exec: long single-line output is fully retrievable after process exit',async t=>{
  const m=await manager(t);const r=await finish(m,await m.exec({cmd:nodeCmd("process.stdout.write('x'.repeat(50000))"),max_output_tokens:256}),{tokens:256});
  assert.equal(r.output,'x'.repeat(50000));assert.equal(r.next_output_cursor,50000);
});
test('exec: explicit cursor replay does not advance the default consumer',async t=>{
  const m=await manager(t);const first=await m.exec({cmd:nodeCmd("process.stdout.write('a'.repeat(3000))"),max_output_tokens:256});
  const replay=await m.write({session_id:first.session_id,output_cursor:0,max_output_tokens:256});assert.equal(replay.output.length,1024);
  const next=await m.write({session_id:first.session_id,max_output_tokens:256});assert.equal(next.output_start,1024);
});
test('exec: ring log loss is reported rather than silently hidden',async t=>{
  const m=await manager(t,{exec:{per_session_output_bytes:1024}});const r=await m.exec({cmd:nodeCmd("process.stdout.write('x'.repeat(12000))")});
  assert(r.output_gap);assert(r.retained_from>0);assert(m.outputBytes<=1024);
});
test('exec: global output budget is enforced across retained records',async t=>{
  const m=await manager(t,{exec:{per_session_output_bytes:8000,total_output_bytes:3000}});
  for(let i=0;i<3;i++)await finish(m,await m.exec({cmd:nodeCmd("process.stdout.write('x'.repeat(2000))")}));
  assert(m.outputBytes<=3000);
});
test('exec: duplicate request_id starts one command and conflicting reuse fails',async t=>{
  const m=await manager(t);const a={cmd:'printf x >> count.txt',request_id:'once'};
  const [x,y]=await Promise.all([m.exec(a),m.exec(a)]);assert.equal(x.session_id,y.session_id);await finish(m,x);
  assert.equal(await readFile(path.join(m.config.cwd,'count.txt'),'utf8'),'x');
  await assert.rejects(async()=>m.exec({...a,cmd:'printf y'}),{code:'REQUEST_ID_CONFLICT'});
});
test('exec: active limit is reserved before asynchronous spawn',async t=>{
  const m=await manager(t,{exec:{max_active_sessions:1,termination_grace_ms:50}});
  const a=m.exec({cmd:'sleep 5',yield_time_ms:0});const b=m.exec({cmd:'sleep 5',yield_time_ms:0});
  const rs=await Promise.allSettled([a,b]);assert.equal(rs.filter(x=>x.status==='fulfilled').length,1);
  assert.equal(rs.find(x=>x.status==='rejected').reason.code,'SESSION_LIMIT');
});
test('exec: pipe stdin is intentionally closed',async t=>{
  const m=await manager(t,{exec:{termination_grace_ms:50}});const r=await m.exec({cmd:'sleep 5',yield_time_ms:0});
  await assert.rejects(m.write({session_id:r.session_id,chars:'hello'}),{code:'STDIN_CLOSED'});
});
test('exec: overlapping default cursor polls are rejected without consuming output',async t=>{
  const m=await manager(t);const r=await m.exec({cmd:nodeCmd("setTimeout(()=>console.log('end'),350)"),yield_time_ms:0});
  const one=m.write({session_id:r.session_id,yield_time_ms:1000});await delay(10);
  await assert.rejects(m.write({session_id:r.session_id,yield_time_ms:1}),{code:'SESSION_BUSY'});
  await finish(m,await one);
});
test('exec: timeout is separate from yield and reports confirmed termination',async t=>{
  const m=await manager(t,{exec:{termination_grace_ms:50}});const r=await finish(m,await m.exec({cmd:'sleep 20',timeout_ms:80,yield_time_ms:0}));
  assert.equal(r.state,'timed_out');assert.notEqual(r.exit_code,0);assert(r.signal);
});
test('exec: terminate is idempotent and preserves final state',async t=>{
  const m=await manager(t,{exec:{termination_grace_ms:50}});const r=await m.exec({cmd:'sleep 20',yield_time_ms:0});
  const a=await m.terminate({session_id:r.session_id});assert.equal(a.state,'terminated');assert(a.termination_confirmed);
  const b=await m.terminate({session_id:r.session_id});assert.equal(b.state,a.state);assert.equal(m.activeCount,0);
});
test('exec: SIGTERM-resistant process is escalated and force is available',async t=>{
  const m=await manager(t,{exec:{termination_grace_ms:40}});
  const r=await m.exec({cmd:nodeCmd("process.on('SIGTERM',()=>{});console.log('ready');setInterval(()=>{},1000)"),yield_time_ms:120});
  let ready=r.output;
  for(let n=0;!ready.includes('ready')&&n<5;n++){
    assert.equal(r.state,'running');
    ready+=(await m.write({session_id:r.session_id,yield_time_ms:1000})).output;
  }
  assert(ready.includes('ready'));const end=await m.terminate({session_id:r.session_id});assert.equal(end.state,'terminated');assert(end.signal);
  const other=await m.exec({cmd:'sleep 10',yield_time_ms:0});assert((await m.terminate({session_id:other.session_id,force:true})).termination_confirmed);
});
test('exec: list supports stable pagination and rejects foreign instance cursor',async t=>{
  const m=await manager(t);for(let i=0;i<3;i++) await finish(m,await m.exec({cmd:'true'}));
  const a=m.list({limit:1});assert.equal(a.sessions.length,1);assert(a.next_cursor);
  const b=m.list({limit:2,cursor:a.next_cursor});assert.equal(b.sessions.length,2);assert.equal(b.next_cursor,null);
  assert.equal(new Set([...a.sessions,...b.sessions].map(x=>x.session_id)).size,3);
  await assert.rejects(async()=>m.list({state:'running',cursor:a.next_cursor}),{code:'INVALID_CURSOR'});
});
test('exec: ended retention expires handles and never silently kills active sessions',async t=>{
  const m=await manager(t,{exec:{retained_session_ms:100,termination_grace_ms:30}});const ended=await m.exec({cmd:'true'});
  const active=await m.exec({cmd:'sleep 5',yield_time_ms:0});await delay(130);
  await assert.rejects(m.write({session_id:ended.session_id}),{code:'UNKNOWN_SESSION'});assert.equal(m.list({state:'running'}).sessions[0].session_id,active.session_id);
});
test('exec: child retains normal HOME but not Tunnel control credentials',async t=>{
  const m=await manager(t);const old=process.env.CONTROL_PLANE_API_KEY;process.env.CONTROL_PLANE_API_KEY='synthetic-test-key';
  try {const r=await finish(m,await m.exec({cmd:nodeCmd("console.log(JSON.stringify({home:process.env.HOME,key:process.env.CONTROL_PLANE_API_KEY??null}))")}));
    const parsed=JSON.parse(r.output);assert.equal(parsed.home,process.env.HOME);assert.equal(parsed.key,null);
  }finally{if(old===undefined)delete process.env.CONTROL_PLANE_API_KEY;else process.env.CONTROL_PLANE_API_KEY=old;}
});
test('exec: graceful shutdown rejects later spawns and cleans owned processes',async t=>{
  const m=await manager(t,{exec:{termination_grace_ms:30}});await m.exec({cmd:'sleep 10',yield_time_ms:0});
  assert.deepEqual((await m.close()).remaining,[]);await assert.rejects(m.exec({cmd:'true'}),{code:'SERVER_CLOSING'});
});
test('exec: PTY input, deduplication and terminal control',async t=>{
  const m=await manager(t,{exec:{termination_grace_ms:50}});
  const program="const r=require('node:readline').createInterface({input:process.stdin});console.log('ready');r.on('line',x=>{if(x==='quit')process.exit(0);console.log('reply:'+x)})";
  const first=await m.exec({cmd:nodeCmd(program),tty:true,yield_time_ms:300});
  let ready=first.output;for(let n=0;!ready.includes('ready')&&n<5;n++){assert.equal(first.state,'running');ready+=(await m.write({session_id:first.session_id,yield_time_ms:1000})).output;}
  assert(ready.includes('ready'));
  const input={session_id:first.session_id,chars:'hello\n',request_id:'input-once',yield_time_ms:300};
  const a=await m.write(input),b=await m.write(input);assert.deepEqual(a,b);
  let output=a.output;for(let n=0;!output.includes('reply:hello')&&n<10;n++)output+=(await m.write({session_id:first.session_id,yield_time_ms:300})).output;
  assert(output.includes('reply:hello'));await m.write({session_id:first.session_id,chars:'quit\n',yield_time_ms:300});
  const end=await finish(m,await m.write({session_id:first.session_id,yield_time_ms:300}));assert.equal(end.exit_code,0);
});

test('exec: inherited PATH resolves a fixture executable without replacing HOME',async t=>{
  const m=await manager(t);
  const bin=path.join(m.config.cwd,'fixture toolchain');await mkdir(bin);
  const executable=path.join(bin,'mcp-path-fixture');
  await writeFile(executable,"#!/bin/sh\nprintf 'path-fixture-ok\\n'\n",{mode:0o755});
  const previousPath=process.env.PATH,expectedHome=process.env.HOME??'';
  try{
    // The fixture is intentionally outside the default PATH; no pnpm/Go installation is required.
    process.env.PATH=[bin,previousPath].filter(Boolean).join(path.delimiter);
    const r=await finish(m,await m.exec({cmd:'command -v mcp-path-fixture && mcp-path-fixture && printf "HOME=%s\\n" "$HOME"'}));
    assert.equal(r.exit_code,0);
    assert.deepEqual(r.output.trimEnd().split('\n'),[executable,'path-fixture-ok','HOME='+expectedHome]);
  }finally{
    if(previousPath===undefined)delete process.env.PATH;else process.env.PATH=previousPath;
  }
});
test('exec: sustained stderr does not block and final marker is drained',async t=>{
  const m=await manager(t);const r=await finish(m,await m.exec({cmd:nodeCmd("process.stderr.write('e'.repeat(200000));process.stderr.write('END')"),max_output_tokens:16000}),{tokens:16000});
  assert.equal(r.exit_code,0);assert.equal(r.output.length,200003);assert(r.output.endsWith('END'));
});
test('exec: fresh runtime does not accept a previous instance execution handle',async t=>{
  const a=await manager(t),b=await manager(t);const r=await a.exec({cmd:'true'});
  await assert.rejects(b.write({session_id:r.session_id}),{code:'UNKNOWN_SESSION'});assert.notEqual(a.instanceId,b.instanceId);
});
test('exec: PTY Ctrl-C and EOF keep terminal semantics',async t=>{
  const m=await manager(t,{exec:{termination_grace_ms:100}});
  const a=await m.exec({cmd:'printf ready; sleep 20',tty:true,yield_time_ms:500});
  let r=await m.write({session_id:a.session_id,chars:'\u0003',yield_time_ms:500});r=await finish(m,r);assert.notEqual(r.state,'running');assert(r.signal!==null||r.exit_code!==0);
  const b=await m.exec({cmd:'cat',tty:true,yield_time_ms:100});
  const e=await finish(m,await m.write({session_id:b.session_id,chars:'\u0004',yield_time_ms:500}));
  assert(!['running','terminating'].includes(e.state));assert(e.exit_code===0||e.signal!==null,JSON.stringify(e));
});
test('exec: explicit termination works for PTY sessions',async t=>{
  const m=await manager(t,{exec:{termination_grace_ms:100}});const r=await m.exec({cmd:'sleep 20',tty:true,yield_time_ms:100});
  const end=await m.terminate({session_id:r.session_id});assert(end.termination_confirmed);assert.equal(end.state,'terminated');
});
