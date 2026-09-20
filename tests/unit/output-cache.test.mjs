import test from 'node:test';
import assert from 'node:assert/strict';
import { OutputLog } from '../../dist/runtime/output-log.js';
import { RetryCache } from '../../dist/runtime/retry-cache.js';
import { delay } from '../helpers.mjs';

test('output: byte cursors support long lines without duplication', () => {
  const log = new OutputLog(100000); const input = 'a'.repeat(40000); log.append(input);
  let cursor = 0, text = '', r;
  do { r = log.read(cursor, 1024); text += r.output; cursor = r.next_output_cursor; } while (r.has_more);
  assert.equal(text, input); assert.equal(cursor, 40000); assert.equal(log.read(cursor,1024).output, '');
});
test('output: Unicode budgets never split characters', () => {
  const log = new OutputLog(200000); const input = '中🙂文é'.repeat(9000); log.append(input);
  let cursor=0, text='', r;
  do { r=log.read(cursor,1025);text+=r.output;cursor=r.next_output_cursor; } while(r.has_more);
  assert.equal(text,input);assert.equal(cursor,Buffer.byteLength(input));assert(!text.includes('\ufffd'));
});
test('output: eviction is explicit and begins at a UTF-8 boundary', () => {
  const log=new OutputLog(17);log.append('中文🙂'.repeat(10));
  const r=log.read(0,100); assert(r.output_gap);assert(r.retained_from>0);assert(log.size<=17);
  assert(!r.output.includes('\ufffd'));assert.equal(Buffer.byteLength(r.output), log.size);
});
test('output: capacity trims large chunks and supports exact replay',()=>{
  const l=new OutputLog(1024);l.append('abc'.repeat(9000));
  assert(l.size<=1024); const a=l.read(l.retainedFrom,200), b=l.read(a.output_start,200);assert.deepEqual(a,b);
});
test('output: rejects future, negative and mid-codepoint cursors',()=>{
  const l=new OutputLog(1024);l.append('中a');
  for(const c of [-1,1,2,9,0.5]) assert.throws(()=>l.read(c,40));
});
test('output: trimming to zero preserves monotonic positions',()=>{
  const l=new OutputLog(100);l.append('hello');l.trimTo(0);l.append('world');
  assert.equal(l.read(0,100).output,'world');assert.equal(l.read(0,100).output_start,5);assert.equal(l.end,10);
});
test('retry: concurrent duplicate requests perform one side effect',async()=>{
  const c=new RetryCache(1000,8);let n=0;
  const action=async()=>{n++;await delay(15);return {n};};
  const [a,b]=await Promise.all([c.run('x','id',{a:1,b:2},action),c.run('x','id',{b:2,a:1},action)]);
  assert.equal(n,1);assert.strictEqual(a,b);
});
test('retry: mismatched arguments and tool names are rejected',async()=>{
  const c=new RetryCache(1000,8);await c.run('a','id',{x:1},async()=>1);
  await assert.rejects(async()=>c.run('a','id',{x:2},async()=>2), {code:'REQUEST_ID_CONFLICT'});
  await assert.rejects(async()=>c.run('b','id',{x:1},async()=>2), {code:'REQUEST_ID_CONFLICT'});
});
test('retry: failures are cached; completed entries expire',async()=>{
  const c=new RetryCache(25,8);let n=0;const action=async()=>{n++;throw new Error('expected');};
  await assert.rejects(c.run('x','id',{},action));await assert.rejects(c.run('x','id',{},action));assert.equal(n,1);
  await delay(35);await assert.rejects(c.run('x','id',{},action));assert.equal(n,2);
});
test('retry: pending entries cannot be evicted by capacity pressure',async()=>{
  const c=new RetryCache(1000,1);let release;const p=c.run('x','1',{},()=>new Promise(r=>release=r));
  await delay(0);await assert.rejects(async()=>c.run('x','2',{},async()=>2),{code:'REQUEST_CACHE_FULL'});release(1);await p;
  assert.equal(await c.run('x','2',{},async()=>2),2);
});
