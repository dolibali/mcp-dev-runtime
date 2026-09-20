import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import path from 'node:path';
import {configSchema,loadConfig,expandPath,validateConfig} from '../../dist/config.js';
import {fixture} from '../helpers.mjs';
test('config: nested defaults resolve without configuring optional modules',()=>{
  const c=configSchema.parse({});assert.equal(c.exec.max_active_sessions,8);assert.equal(c.image.max_output_dimension,2048);assert.equal(c.transport,'http');
});
test('config: invalid budgets, unknown fields and fractional ports fail',()=>{
  for(const c of [{port:1.5},{port:70000},{exec:{max_active_sessions:0}},{unexpected:true}])assert.throws(()=>configSchema.parse(c));
});
test('config: CLI values override file while independent options remain',async t=>{
  const c=await fixture(t);const file=path.join(c.cwd,'config.json');await writeFile(file,JSON.stringify({cwd:c.cwd,shell:'/bin/bash',port:3001,log_level:'debug'}));
  const loaded=await loadConfig(file,{port:3999});assert.equal(loaded.port,3999);assert.equal(loaded.log_level,'debug');
});
test('config: unified file maps runtime fields, resolves relative paths from the config file and applies tool allowlist',async t=>{
  const c=await fixture(t),dir=path.join(c.cwd,'cfg');await (await import('node:fs/promises')).mkdir(dir);
  const file=path.join(dir,'config.json');
  await writeFile(file,JSON.stringify({
    schema_version:1,
    mcp:{host:'127.0.0.1',port:3555,path:'/custom-mcp',health_path:'/custom-health'},
    runtime:{cwd:'..',shell:'/bin/bash'},
    tools:{allow:['list_exec_sessions']},
    logging:{level:'debug'},
    request_cache:{ttl_ms:1234}
  }));
  const loaded=await loadConfig(file);
  assert.equal(loaded.port,3555);assert.equal(loaded.mcp_path,'/custom-mcp');assert.equal(loaded.health_path,'/custom-health');
  assert.equal(loaded.cwd,c.cwd);assert.equal(loaded.log_level,'debug');assert.equal(loaded.request_cache_ttl_ms,1234);
  assert.deepEqual(loaded.tools.allow,['list_exec_sessions']);
});
test('config: tools.allow rejects unknown and duplicate names without wildcard semantics',async t=>{
  const c=await fixture(t),file=path.join(c.cwd,'config.json');
  for(const allow of [['exec_command','missing_tool'],['exec_command','exec_command'],['*']]){
    await writeFile(file,JSON.stringify({schema_version:1,runtime:{cwd:c.cwd,shell:'/bin/bash'},tools:{allow}}));
    await assert.rejects(loadConfig(file),/Unknown tool|Duplicate tool/);
  }
});
test('config: invalid routes and inconsistent response budgets are rejected',async t=>{
  const c=await fixture(t);await assert.rejects(validateConfig({...c,mcp_path:'/same',health_path:'/same'}));
  await assert.rejects(validateConfig({...c,exec:{...c.exec,default_yield_time_ms:1000,max_yield_time_ms:500}}));assert.throws(()=>expandPath('a\0b',c.cwd));
});
