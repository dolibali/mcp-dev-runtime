import test from 'node:test';
import assert from 'node:assert/strict';
import { OutputLog } from '../../dist/runtime/output-log.js';
import { queryLog } from '../../dist/runtime/log-query.js';
import { manager,nodeCmd } from '../helpers.mjs';

test('query: tail preserves Unicode and newline conventions while keeping a bounded suffix',async()=>{
  for(const text of ['one\n二🙂\nlast\n','one\n二🙂\nlast','one\r\n二🙂\r\nlast\r\n']){
    const log=new OutputLog(10000);log.append(text);
    const r=await queryLog(log,{tail_lines:2},1024);assert.equal(r.output,text.slice(text.indexOf('\n')+1));assert.equal(r.tail_truncated,false);
  }
  const log=new OutputLog(20000);log.append('中'.repeat(2000)+'TAIL');const r=await queryLog(log,{tail_lines:1},1024);
  assert(r.tail_truncated);assert(r.output.endsWith('TAIL'));assert(Buffer.byteLength(r.output)<=1024);assert(!r.output.includes('\ufffd'));
});
test('query: search is literal, paginated and does not lose cross-window UTF-8 matches',async()=>{
  const log=new OutputLog(3*1024*1024);log.append('x'.repeat(1024*1024-2)+'中🙂needle\n'+'中🙂needle\n'.repeat(5));
  let cursor=0,matches=[],calls=0;
  for(;;){const r=await queryLog(log,{search:'中🙂needle',output_cursor:cursor,max_matches:2},1024);
    matches.push(...r.matches);calls++;if(!r.search_has_more)break;assert(r.search_next_cursor>cursor);cursor=r.search_next_cursor;assert(calls<20);
  }
  assert.equal(matches.length,6);assert.equal(new Set(matches.map(m=>m.byte_offset)).size,6);
  const symbols=new OutputLog(1024);symbols.append('literal .* [x]');assert.equal((await queryLog(symbols,{search:'.*'},1024)).matches.length,1);
});
test('query: tails, searches and replays never advance the command default cursor',async t=>{
  const m=await manager(t);const text='abc\n'.repeat(1000)+'ERROR final\n';
  const first=await m.exec({cmd:nodeCmd(`process.stdout.write(${JSON.stringify(text)})`),max_output_tokens:256});
  const tail=await m.write({session_id:first.session_id,tail_lines:1});assert.equal(tail.output,'ERROR final\n');
  const search=await m.write({session_id:first.session_id,search:'ERROR'});assert.equal(search.matches.length,1);
  const next=await m.write({session_id:first.session_id,max_output_tokens:256});assert.equal(next.output_start,first.next_output_cursor);
});
test('query: conflicting selection and input arguments are rejected before side effects',async t=>{
  const m=await manager(t),r=await m.exec({cmd:':'});
  for(const q of [{tail_lines:0},{tail_lines:1,search:'x'},{tail_lines:1,output_cursor:0},{max_matches:2},{search:''},{search:'x',chars:'input'}]){
    await assert.rejects(async()=>m.write({session_id:r.session_id,...q}),{code:'INVALID_QUERY'});
  }
});
