import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fixture } from '../helpers.mjs';
import { PatchEngine } from '../../dist/runtime/patch-engine.js';
import { RetryCache } from '../../dist/runtime/retry-cache.js';
import { ToolError } from '../../dist/runtime/errors.js';
import { parsePatch, updateText } from '../../dist/runtime/patch-parser.js';
const patch = text => `*** Begin Patch\n${text}\n*** End Patch\n`;
async function engine(t, hooks = {}) {const c=await fixture(t);return {cwd:c.cwd,e:new PatchEngine(c,new RetryCache(10000,32),hooks)};}
const exists = p => fs.stat(p).then(()=>true,()=>false);

test('patch: adds nested files and reports actual change list',async t=>{
  const {e,cwd}=await engine(t);const r=await e.apply({patch:patch('*** Add File: src/a.ts\n+export const a = 1;')});
  assert(r.applied);assert.equal(r.changes[0].operation,'add');assert.equal(await fs.readFile(path.join(cwd,'src/a.ts'),'utf8'),'export const a = 1;\n');
});
test('patch: updates multiple hunks and multiple files',async t=>{
  const {e,cwd}=await engine(t);await fs.writeFile(path.join(cwd,'a'),'a\nb\nc\nd\n');await fs.writeFile(path.join(cwd,'b'),'x\n');
  const r=await e.apply({patch:patch('*** Update File: a\n@@\n-a\n+A\n b\n@@\n c\n-d\n+D\n*** Update File: b\n@@\n-x\n+X')});
  assert.equal(r.changes.length,2);assert.equal(await fs.readFile(path.join(cwd,'a'),'utf8'),'A\nb\nc\nD\n');
});
test('patch: supports update-and-move without silently overwriting destinations',async t=>{
  const {e,cwd}=await engine(t);await fs.writeFile(path.join(cwd,'a'),'old\n');
  const r=await e.apply({patch:patch('*** Update File: a\n*** Move to: nested/b\n@@\n-old\n+new')});
  assert.equal(r.changes[0].source_removed,true);assert(!(await exists(path.join(cwd,'a'))));assert.equal(await fs.readFile(path.join(cwd,'nested/b'),'utf8'),'new\n');
});
test('patch: move-only preserves source content',async t=>{
  const {e,cwd}=await engine(t);await fs.writeFile(path.join(cwd,'a'),'raw');
  await e.apply({patch:patch('*** Update File: a\n*** Move to: b')});assert.equal(await fs.readFile(path.join(cwd,'b'),'utf8'),'raw');
});
test('patch: removes a file and adds an empty file',async t=>{
  const {e,cwd}=await engine(t);await fs.writeFile(path.join(cwd,'a'),'remove');
  await e.apply({patch:patch('*** Delete File: a\n*** Add File: empty')});assert(!(await exists(path.join(cwd,'a'))));assert.equal((await fs.stat(path.join(cwd,'empty'))).size,0);
});
test('patch: all predictable errors are found before any file write',async t=>{
  const {e,cwd}=await engine(t);await fs.writeFile(path.join(cwd,'b'),'actual\n');
  await assert.rejects(e.apply({patch:patch('*** Add File: a\n+new\n*** Update File: b\n@@\n-wrong\n+new')}));
  assert(!(await exists(path.join(cwd,'a'))));assert.equal(await fs.readFile(path.join(cwd,'b'),'utf8'),'actual\n');
});
test('patch: Add/Move destinations refuse to overwrite existing entries',async t=>{
  const {e,cwd}=await engine(t);await fs.writeFile(path.join(cwd,'a'),'A');await fs.writeFile(path.join(cwd,'b'),'B');
  await assert.rejects(e.apply({patch:patch('*** Add File: a\n+X')}),{code:'TARGET_EXISTS'});
  await assert.rejects(e.apply({patch:patch('*** Update File: a\n*** Move to: b')}),{code:'TARGET_EXISTS'});
});
test('patch: detects duplicate or aliased operation paths',async t=>{
  const {e}=await engine(t);await assert.rejects(e.apply({patch:patch('*** Add File: a\n+1\n*** Add File: ./a\n+2')}),{code:'DUPLICATE_PATH'});
});
test('patch: precommit external changes are not overwritten',async t=>{
  let cwd;const setup=await engine(t,{beforeCommit:async()=>fs.writeFile(path.join(cwd,'a'),'external\n')});cwd=setup.cwd;
  await fs.writeFile(path.join(cwd,'a'),'old\n');await assert.rejects(setup.e.apply({patch:patch('*** Update File: a\n@@\n-old\n+new')}),{code:'FILE_CHANGED'});
  assert.equal(await fs.readFile(path.join(cwd,'a'),'utf8'),'external\n');
});
test('patch: mid-commit I/O failure reports already applied operations',async t=>{
  const {e,cwd}=await engine(t,{beforeWrite:async i=>{if(i===1)throw new Error('injected disk failure');}});
  await assert.rejects(e.apply({patch:patch('*** Add File: a\n+1\n*** Add File: b\n+2')}),err=>{
    assert.equal(err.code,'PARTIAL_APPLY');assert.equal(err.details.partial,true);assert.equal(err.details.changes.length,1);return true;
  });assert(await exists(path.join(cwd,'a')));assert(!(await exists(path.join(cwd,'b'))));
});
test('patch: metadata failure after replacement reports the changed file as partial',async t=>{
  const {e,cwd}=await engine(t),file=path.join(cwd,'a');
  await fs.writeFile(file,'old\n');
  // Inject a completed content replacement followed by a metadata failure.
  // This is a test instance override, not a runtime/MCP input or platform branch.
  e.writeAtomic=async(filename,data)=>{
    await fs.writeFile(filename,data);
    throw new ToolError('WINDOWS_REPLACE_PARTIAL','synthetic metadata failure',{file_replaced:true});
  };
  await assert.rejects(e.apply({patch:patch('*** Update File: a\n@@\n-old\n+new')}),error=>{
    assert.equal(error.code,'PARTIAL_APPLY');assert.equal(error.details.partial,true);
    assert.deepEqual(error.details.changes,[{operation:'update',path:file}]);return true;
  });
  assert.equal(await fs.readFile(file,'utf8'),'new\n');
});
test('patch: concurrent overlapping patches cannot both overwrite the same version',async t=>{
  let prepared=0,release;const ready=new Promise(r=>release=r);
  const {e,cwd}=await engine(t,{beforeCommit:async()=>{if(++prepared===2)release();await ready;}});
  await fs.writeFile(path.join(cwd,'a'),'old\n');const make=v=>({patch:patch(`*** Update File: a\n@@\n-old\n+${v}`)});
  const r=await Promise.allSettled([e.apply(make('one')),e.apply(make('two'))]);assert.equal(r.filter(x=>x.status==='fulfilled').length,1);assert.equal(r.find(x=>x.status==='rejected').reason.code,'FILE_CHANGED');
});
test('patch: LF, CRLF, mixed line endings and missing final newline are preserved',async t=>{
  const {e,cwd}=await engine(t);
  for(const [i,source,wanted] of [[0,'a\nb\n','a\nB\n'],[1,'a\r\nb\r\n','a\r\nB\r\n'],[2,'a\nb','a\nB'],[3,'a\r\nb\nc\r\n','a\r\nB\r\nc\r\n']]) {
    const name=`f${i}`;await fs.writeFile(path.join(cwd,name),source);
    await e.apply({patch:patch(`*** Update File: ${name}\n@@\n a\n-b\n+B`)});assert.equal(await fs.readFile(path.join(cwd,name),'utf8'),wanted);
  }
});
test('patch: EOF marker selects the final matching block',async t=>{
  const {e,cwd}=await engine(t);await fs.writeFile(path.join(cwd,'a'),'x\nmiddle\nx\n');
  await e.apply({patch:patch('*** Update File: a\n@@\n-x\n+last\n*** End of File')});assert.equal(await fs.readFile(path.join(cwd,'a'),'utf8'),'x\nmiddle\nlast\n');
});
test('patch: context hint, trailing whitespace and Unicode punctuation matching',async t=>{
  const {e,cwd}=await engine(t);await fs.writeFile(path.join(cwd,'a'),'function one\n x  \nfunction two\n “value”\n');
  await e.apply({patch:patch('*** Update File: a\n@@ function two\n- "value"\n+ next')});
  assert.equal(await fs.readFile(path.join(cwd,'a'),'utf8'),'function one\n x  \nfunction two\n next\n');
});
test('patch: existing executable mode is preserved',async t=>{
  const {e,cwd}=await engine(t);const p=path.join(cwd,'run');await fs.writeFile(p,'old\n',{mode:0o751});
  await e.apply({patch:patch('*** Update File: run\n@@\n-old\n+new')});assert.equal((await fs.stat(p)).mode & 0o777,0o751);
});
test('patch: symlink update changes target without replacing the link; delete removes link only',async t=>{
  const {e,cwd}=await engine(t);await fs.writeFile(path.join(cwd,'target'),'old\n');await fs.symlink('target',path.join(cwd,'link'));
  await e.apply({patch:patch('*** Update File: link\n@@\n-old\n+new')});assert((await fs.lstat(path.join(cwd,'link'))).isSymbolicLink());
  assert.equal(await fs.readFile(path.join(cwd,'target'),'utf8'),'new\n');await e.apply({patch:patch('*** Delete File: link')});assert(await exists(path.join(cwd,'target')));
});
test('patch: dangling symlink updates fail, deletion remains valid',async t=>{
  const {e,cwd}=await engine(t);await fs.symlink('missing',path.join(cwd,'link'));
  await assert.rejects(e.apply({patch:patch('*** Update File: link\n@@\n-old\n+new')}));
  await e.apply({patch:patch('*** Delete File: link')});await assert.rejects(fs.lstat(path.join(cwd,'link')),{code:'ENOENT'});
});
test('patch: replacing one hardlink does not change another directory entry',async t=>{
  const {e,cwd}=await engine(t);await fs.writeFile(path.join(cwd,'a'),'old\n');await fs.link(path.join(cwd,'a'),path.join(cwd,'b'));
  await e.apply({patch:patch('*** Update File: a\n@@\n-old\n+new')});assert.equal(await fs.readFile(path.join(cwd,'b'),'utf8'),'old\n');
});
test('patch: malformed syntax and binary updates are rejected',async t=>{
  const {e,cwd}=await engine(t);for(const p of ['diff --git a b','*** Begin Patch\n*** End Patch','*** Begin Patch\n*** Add File: a\nmissing-plus\n*** End Patch'])await assert.rejects(e.apply({patch:p}));
  await fs.writeFile(path.join(cwd,'binary'),Buffer.from([255,0,1]));await assert.rejects(e.apply({patch:patch('*** Update File: binary\n@@\n-a\n+b')}),{code:'NOT_TEXT'});
});
test('patch: duplicate request_id returns first result without reapplying',async t=>{
  const {e,cwd}=await engine(t);const a={patch:patch('*** Add File: a\n+new'),request_id:'one'};
  assert.deepEqual(await e.apply(a),await e.apply(a));assert.equal(await fs.readFile(path.join(cwd,'a'),'utf8'),'new\n');
});
