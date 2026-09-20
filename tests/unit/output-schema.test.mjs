import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { Runtime } from '../../dist/runtime/runtime.js';
import { PatchEngine } from '../../dist/runtime/patch-engine.js';
import { RetryCache } from '../../dist/runtime/retry-cache.js';
import { fixture, nodeCmd } from '../helpers.mjs';
import { contracts, validators, assertOutput, assertInvalid } from '../output-contract-helper.mjs';
async function setup(t, overrides = {}) {
  const config = await fixture(t, overrides), runtime = new Runtime(config);
  t.after(async () => assert.deepEqual((await runtime.close()).remaining, []));
  return {config, runtime, call: async (name, args = {}) => assertOutput(name, await runtime.invoke(name, args))};
}
async function drain(call, first) {
  let last = first, text = first.output, until = Date.now() + 15000;
  while (['running','terminating'].includes(last.state) || last.has_more) {
    assert(Date.now() < until, 'execution failed to finish');
    last = await call('write_stdin', {session_id:last.session_id, yield_time_ms:1000}); text += last.output;
  }
  return {...last, output:text};
}
test('output schema: six object contracts reject empty and malformed error results', async () => {
  assert.equal(contracts.length, 6);
  for (const tool of contracts) {
    assert.equal(tool.outputSchema.type, 'object');
    assert.equal(tool.outputSchema.additionalProperties, false);
    assert(tool.outputSchema.description.length > 20);
    for (const value of Object.values(tool.outputSchema.properties)) assert(value.description);
    await assertInvalid(tool.name, {});
    await assertInvalid(tool.name, {error:{code:'BROKEN'}});
    await assertInvalid(tool.name, {error:{code:12,message:'wrong type'}});
    await assertInvalid(tool.name, {error:{code:'X',message:'err'},unexpected:true});
    const valid = await validators.get(tool.name)['~standard'].validate({error:{code:'OPERATION_FAILED',message:'example'}});
    assert(!valid.issues);
  }
});
test('output schema: completed and nonzero commands retain the same bounded log chunk in both channels', async t => {
  const {call} = await setup(t);
  for (const code of [0, 7]) {
    const r = await drain(call, await call('exec_command', {cmd:`printf output; printf error >&2; exit ${code}`}));
    assert.equal(r.isError, false); assert.equal(r.state,'exited'); assert.equal(r.exit_code,code);
    assert(r.output.includes('output')); assert(r.output.includes('error'));
  }
});
test('output schema: active, completed, timeout and contradictory states', async t => {
  const {call} = await setup(t, {exec:{termination_grace_ms:50}});
  const active = await call('exec_command', {cmd:'sleep 0.2; printf done',yield_time_ms:0});
  assert.equal(active.state,'running'); assert.equal(active.exit_code,null);
  const end = await drain(call,active); assert.equal(end.state,'exited'); assert.equal(end.exit_code,0);
  const timed = await drain(call, await call('exec_command',{cmd:'sleep 10',timeout_ms:40,yield_time_ms:0}));
  assert.equal(timed.state,'timed_out'); assert.equal(timed.exit_code,null);
  const {isError,...data} = active;
  await assertInvalid('exec_command',{...data,exit_code:0});
  await assertInvalid('exec_command',{...data,ended_at:new Date().toISOString()});
  const {session_id,...missingHandle} = data;
  await assertInvalid('exec_command',missingHandle);
});
test('output schema: empty chunks remain present and missing or non-string output is rejected', async t => {
  const {call,runtime}=await setup(t);
  const done=await drain(call,await call('exec_command',{cmd:':'}));
  assert.equal(done.output,'');
  const empty=await call('write_stdin',{session_id:done.session_id,yield_time_ms:0});
  assert.equal(empty.output,'');
  for(const [name,args] of [['exec_command',{cmd:':'}],['write_stdin',{session_id:done.session_id,yield_time_ms:0}]]) {
    const raw=await runtime.invoke(name,args);
    const {output,...missing}=raw.structuredContent;
    assert.equal(output,'');
    await assertInvalid(name,missing);
    for(const invalid of [null,42,{}]) await assertInvalid(name,{...missing,output:invalid});
  }
});
test('output schema: retry and explicit replay do not consume the output twice', async t => {
  const {call}=await setup(t);
  const args={cmd:'printf replay-ok',request_id:'structured-output-retry',yield_time_ms:1000};
  const first=await call('exec_command',args);
  assert.equal(first.state,'exited');
  assert.equal(first.output,'replay-ok');
  assert.deepEqual(await call('exec_command',args),first);
  const replay=await call('write_stdin',{session_id:first.session_id,output_cursor:0,yield_time_ms:0});
  assert.equal(replay.output,first.output);
  assert.equal(replay.output_start,0);
  assert.equal(replay.next_output_cursor,Buffer.byteLength(first.output));
  const empty=await call('write_stdin',{session_id:first.session_id,yield_time_ms:0});
  assert.equal(empty.output,'');
  assert.equal(empty.output_start,replay.next_output_cursor);
});
test('output schema: startup errors include metadata and isError remains true', async t => {
  const {call,config} = await setup(t);
  for (const extra of [{shell:'/nonexistent/mcp-shell'}, {workdir:path.join(config.cwd,'missing')}]) {
    const r = await call('exec_command',{cmd:'true',...extra});
    assert.equal(r.state,'start_failed'); assert.equal(r.isError,true); assert.equal(r.exit_code,null);
    assert.equal(r.error.code,'START_FAILED'); assert(r.ended_at);
  }
});
test('output schema: errors remain valid for each tool, including cursor diagnostics', async t => {
  const {call,config} = await setup(t);
  const cases = [
    ['write_stdin',{session_id:1},'UNKNOWN_SESSION'],
    ['terminate_exec_session',{session_id:1},'UNKNOWN_SESSION'],
    ['list_exec_sessions',{cursor:'bad-cursor'},'INVALID_CURSOR'],
    ['apply_patch',{patch:'not a patch'},null],
    ['view_image',{path:path.join(config.cwd,'missing.png')},'OPERATION_FAILED']
  ];
  for (const [name,args,code] of cases) {const r=await call(name,args);assert.equal(r.isError,true);if(code)assert.equal(r.error.code,code);}
  const done=await drain(call,await call('exec_command',{cmd:'printf x'}));
  const r=await call('write_stdin',{session_id:done.session_id,output_cursor:100});
  assert.equal(r.isError,true);assert.equal(r.error.end,1);
  const p=await call('write_stdin',{session_id:done.session_id,chars:'input'});assert.equal(p.error.code,'STDIN_CLOSED');
});
test('output schema: pagination includes ended and startup-failed sessions', async t => {
  const {call}=await setup(t);
  await drain(call,await call('exec_command',{cmd:'true'}));
  await call('exec_command',{cmd:'true',shell:'/missing-shell'});
  const one=await call('list_exec_sessions',{limit:1});assert.equal(one.sessions.length,1);assert(one.next_cursor);
  const two=await call('list_exec_sessions',{limit:1,cursor:one.next_cursor});assert.equal(two.sessions[0].state,'start_failed');assert.equal(two.next_cursor,null);
  const {output,isError,...data}=one;const invalid=structuredClone(data);invalid.sessions[0].session_id='not-an-integer';
  await assertInvalid('list_exec_sessions',invalid);
});
test('output schema: termination uses observed completion, not command success', async t => {
  const {call}=await setup(t,{exec:{termination_grace_ms:50}});
  const active=await call('exec_command',{cmd:'sleep 10',yield_time_ms:0});
  const stopped=await call('terminate_exec_session',{session_id:active.session_id});
  assert.equal(stopped.termination_confirmed,true);assert.equal(stopped.state,'terminated');assert.equal(stopped.exit_code,null);
  const already=await call('terminate_exec_session',{session_id:active.session_id});assert.equal(already.state,'terminated');
  const {output,isError,...data}=stopped;
  await assertInvalid('terminate_exec_session',{...data,termination_confirmed:false});
  const pending={...data,state:'terminating',exit_code:null,ended_at:null,termination_confirmed:false};
  assert(!(await validators.get('terminate_exec_session')['~standard'].validate(pending)).issues);
  await assertInvalid('terminate_exec_session',{...pending,termination_confirmed:true});
});
test('output schema: patch add, move and delete declare real changes', async t => {
  const {call,config}=await setup(t);
  const add=await call('apply_patch',{patch:'*** Begin Patch\n*** Add File: nested/a.txt\n+first\n*** End Patch\n'});
  assert.equal(add.applied,true);assert.equal(add.partial,false);assert.equal(add.changes[0].operation,'add');assert.equal(add.created_directories.length,1);
  const moved=await call('apply_patch',{patch:'*** Begin Patch\n*** Update File: nested/a.txt\n*** Move to: nested/b.txt\n@@\n-first\n+second\n*** End Patch\n'});
  assert.equal(moved.changes[0].source_removed,true);assert.equal(await fs.readFile(path.join(config.cwd,'nested/b.txt'),'utf8'),'second\n');
  const del=await call('apply_patch',{patch:'*** Begin Patch\n*** Delete File: nested/b.txt\n*** End Patch\n'});assert.equal(del.changes[0].operation,'delete');
  const {output,isError,...data}=moved;const invalid=structuredClone(data);delete invalid.changes[0].to;
  await assertInvalid('apply_patch',invalid);
});
test('output schema: partial patch error preserves changes and failure position', async t => {
  const {call,config,runtime}=await setup(t);
  runtime.patch=new PatchEngine(config,new RetryCache(60000,32),{beforeWrite:async index=>{if(index===1)throw new Error('Injected disk write failure');}});
  const r=await call('apply_patch',{patch:'*** Begin Patch\n*** Add File: first.txt\n+written\n*** Add File: second.txt\n+unwritten\n*** End Patch\n'});
  assert.equal(r.isError,true);assert.equal(r.error.code,'PARTIAL_APPLY');assert.equal(r.error.partial,true);assert.equal(r.error.applied,false);
  assert.equal(r.error.changes.length,1);assert(r.error.failed_path.endsWith('second.txt'));
  assert.equal(await fs.readFile(path.join(config.cwd,'first.txt'),'utf8'),'written\n');
  await assert.rejects(fs.stat(path.join(config.cwd,'second.txt')),{code:'ENOENT'});
  const {output,isError,...data}=r;const invalid=structuredClone(data);delete invalid.error.changes;await assertInvalid('apply_patch',invalid);
});
test('output schema: Unicode output continues after a byte-budget boundary', async t => {
  const {call}=await setup(t);const expected='中🙂文'.repeat(1200);
  const initial=await call('exec_command',{cmd:nodeCmd(`process.stdout.write(${JSON.stringify(expected)})`),max_output_tokens:256});
  assert(initial.has_more);const last=await drain(call,initial);assert.equal(last.output,expected);assert.equal(last.total_output_bytes,Buffer.byteLength(expected));
});
test('output schema: declared image dimensions agree with actual image content', async t => {
  const {call,config,runtime}=await setup(t,{image:{max_output_dimension:32}});
  for (const format of ['png','jpeg','webp']) {
    const filename=path.join(config.cwd,`image.${format}`);
    await sharp({create:{width:64,height:40,channels:3,background:'#124678'}}).toFormat(format).toFile(filename);
    const raw=await runtime.invoke('view_image',{path:filename});const meta=await assertOutput('view_image',raw);
    const image=raw.content.find(c=>c.type==='image');assert(image);assert.equal(image.mimeType,meta.mime_type);
    const actual=await sharp(Buffer.from(image.data,'base64')).metadata();assert.equal(actual.width,meta.width);assert.equal(actual.height,meta.height);
    assert.equal(meta.resized,true);assert.equal(meta.encoded_bytes,Buffer.byteLength(image.data));
    const {output,isError,...data}=meta;await assertInvalid('view_image',{...data,width:'32'});
  }
});
