import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {writeFile,mkdir,mkdtemp,realpath,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const cwd=await realpath(await mkdtemp(path.join(os.tmpdir(),'mcp-cli-verification-')));
const child=spawn(process.execPath,['dist/main.js','--transport','http','--cwd',cwd,'--shell','/bin/bash','--port','0'],{stdio:['ignore','pipe','pipe']});
let stderr='',stdout='',started;child.stdout.on('data',x=>stdout+=x);child.stderr.on('data',x=>{
  stderr+=x;for(const line of stderr.split('\n')){try{const j=JSON.parse(line);if(j.event==='started')started=j;}catch{}}
});
const finished=once(child,'close');
try{
  const deadline=Date.now()+10000;
  while(!started){if(child.exitCode!==null)throw new Error(stderr);assert(Date.now()<deadline,'CLI startup timed out');await new Promise(r=>setTimeout(r,25));}
  const health=await fetch(started.url.replace('/mcp','/healthz'));const h=await health.json();assert.equal(health.status,200);assert.equal(h.instance_id,started.instance_id);
  const smoke=spawn(process.execPath,['scripts/smoke.mjs',started.url],{stdio:['ignore','pipe','pipe']});let output='';smoke.stdout.on('data',x=>output+=x);smoke.stderr.on('data',x=>output+=x);
  const [code]=await once(smoke,'close');assert.equal(code,0,output);assert(output.includes('LOCAL MCP SMOKE PASSED'));
  child.kill('SIGTERM');const stop=await Promise.race([finished,new Promise((_,reject)=>{const t=setTimeout(()=>reject(new Error('CLI shutdown timed out')),5000);t.unref();})]);assert.equal(stop[0],0);
  const report={recorded_at:new Date().toISOString(),passed:true,config_file:null,port_override:0,health_status:200,smoke_output:output,shutdown_exit_code:stop[0],stdout_bytes:Buffer.byteLength(stdout),model_calls:0,original_tunnel_modified:false};
  await mkdir('reports',{recursive:true});
  await writeFile('reports/cli-verification.json',JSON.stringify(report,null,2)+'\n');console.log(output);console.log('Production CLI startup and SIGTERM cleanup: PASS');
}finally{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await finished;}await rm(cwd,{recursive:true,force:true});}
