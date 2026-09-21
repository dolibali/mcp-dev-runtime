import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const exec=promisify(execFile);

test('POSIX isolation: ordinary tools never load the Windows native adapter',async t=>{
  const cwd=await mkdtemp(path.join(tmpdir(),'mdr-posix-isolation-'));
  t.after(()=>rm(cwd,{recursive:true,force:true}));
  const moduleURL=file=>pathToFileURL(path.resolve(file)).href;
  const code=`
    import {registerHooks} from 'node:module';
    import assert from 'node:assert/strict';
    registerHooks({resolve(name,context,next){
      if(/windows-(host|process)\\.js/.test(name))throw new Error('Windows adapter was loaded on POSIX');
      return next(name,context);
    }});
    const {loadConfig}=await import(${JSON.stringify(moduleURL('dist/config.js'))});
    const {Runtime}=await import(${JSON.stringify(moduleURL('dist/runtime/runtime.js'))});
    const c=await loadConfig(undefined,{cwd:${JSON.stringify(cwd)},shell:'/bin/bash',history:{enabled:false},log_level:'silent'});
    const runtime=new Runtime(c);
    try {
      for(const tty of [false,true]){
        let r=await runtime.invoke('exec_command',{cmd:'printf POSIX_UNCHANGED',tty});
        assert.equal(r.isError,false);let output=r.structuredContent.output;
        while(['running','terminating'].includes(r.structuredContent.state)){
          r=await runtime.invoke('write_stdin',{session_id:r.structuredContent.session_id,yield_time_ms:1000});output+=r.structuredContent.output;
        }
        assert.equal(r.structuredContent.exit_code,0);assert.equal(output,'POSIX_UNCHANGED');
      }
    }finally{assert.deepEqual((await runtime.close()).remaining,[])}
    console.log('POSIX_ISOLATION_PASS');
  `;
  const r=await exec(process.execPath,['--input-type=module','-e',code],{timeout:20000});
  assert.match(r.stdout,/POSIX_ISOLATION_PASS/);
});
