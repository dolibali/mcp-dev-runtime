import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {Runtime} from '../../dist/runtime/runtime.js';
import {startHttp} from '../../dist/mcp/http.js';
import {fixture,finish} from '../helpers.mjs';

const exec=promisify(execFile);
const script=fileURLToPath(new URL('../../scripts/smoke.mjs',import.meta.url));

for(const retained of [0,125]) {
  test(`smoke CLI: finds its execution with ${retained} older records without running it twice`,async t=>{
    const config=await fixture(t,{exec:{max_ended_sessions:256}});
    const runtime=new Runtime(config),http=await startHttp(runtime);
    t.after(()=>http.close());
    for(let i=0;i<retained;i++) {
      const r=await finish(runtime.exec,await runtime.exec.exec({cmd:':'}));
      assert.equal(r.exit_code,0);
    }
    let launches=0;
    const listingArgs=[];
    const invoke=runtime.invoke.bind(runtime);
    runtime.invoke=async(name,args)=>{
      if(name==='exec_command')launches++;
      if(name==='list_exec_sessions')listingArgs.push({...args});
      return invoke(name,args);
    };
    const result=await exec(process.execPath,[script,http.url],{
      cwd:config.cwd,timeout:20000,maxBuffer:256*1024
    });
    assert(result.stdout.includes('LOCAL MCP SMOKE PASSED'),result.stdout);
    assert.equal(launches,1,'Looking up a missing first-page result must not relaunch the command');
    assert.equal(runtime.exec.activeCount,0);
    assert.equal(listingArgs.length,retained===0?1:2);
    assert.equal(listingArgs[0].limit,100);
    if(retained>0)assert.equal(typeof listingArgs[1].cursor,'string');
  });
}
