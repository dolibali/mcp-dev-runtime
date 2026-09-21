import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { promisify } from 'node:util';
import { execFile, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { request } from 'node:http';
import { finished } from 'node:stream/promises';
import { RotatingLog } from '../../dist/launcher/rotating-log.js';
import { canonicalDirectory } from '../../dist/skills/io.js';
import { fileURLToPath } from 'node:url';
import { Runtime } from '../../dist/runtime/runtime.js';
import { loadConfig, expandPath } from '../../dist/config.js';
import { defaultShell } from '../../dist/platform/shell.js';
import { windowsHostPath, windowsSecurity } from '../../dist/platform/windows-host.js';
import { stopManaged, current } from '../../dist/launcher/supervisor.js';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
const exec=promisify(execFile),cli=fileURLToPath(new URL('../../dist/launcher/cli.js',import.meta.url));
const win=(name,fn)=>test(name,{skip:process.platform!=='win32',timeout:90000},fn);
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const psQuote=s=>"'"+s.replaceAll("'","''")+"'";
async function fixture(t,history=false){
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'mdr-win-robust-')));
  const config=await loadConfig(undefined,{cwd:root,port:0,shell:defaultShell(),log_level:'silent',history:{enabled:history,record_output:history}}),runtime=new Runtime(config);
  const cleanups=[];
  t.after(async()=>{for(const cleanup of cleanups.reverse())await cleanup();assert.deepEqual((await runtime.close()).remaining,[]);await fs.rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:200})});
  return {root,runtime,onCleanup:fn=>cleanups.push(fn),call:async(name,args)=>{const r=await runtime.invoke(name,args);assert.equal(r.isError,false,JSON.stringify(r));return r.structuredContent}};
}
async function drain(call,first){let r=first,text=r.output??'',until=Date.now()+25000;while(['running','terminating'].includes(r.state)||r.has_more){assert(Date.now()<until,'Execution did not finish');r=await call('write_stdin',{session_id:r.session_id,yield_time_ms:1000,max_output_tokens:1000});text+=r.output??'';}return {...r,output:text};}
async function freePort(){return new Promise((resolve,reject)=>{const s=createServer();s.once('error',reject);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p))})})}

win('Windows robustness: UTF-8 output/replay and duplicate requests preserve bytes and exact native exit',async t=>{
  const {root,call}=await fixture(t),expected='中文🙂\r\n'.repeat(20000);
  await fs.writeFile(path.join(root,'emit.cjs'),`process.stdout.write(${JSON.stringify(expected)});process.exitCode=7;`);
  const args={cmd:`& ${psQuote(process.execPath)} .\\emit.cjs`,workdir:root,max_output_tokens:256,yield_time_ms:0,request_id:'one-command'};
  const first=await call('exec_command',args),again=await call('exec_command',args);assert.equal(first.session_id,again.session_id);
  const done=await drain(call,first);assert.equal(done.output,expected);assert.equal(done.exit_code,7);assert.equal(done.signal,null);
  const replay=await call('write_stdin',{session_id:done.session_id,output_cursor:0,max_output_tokens:256});assert.equal(replay.output_start,0);assert(expected.startsWith(replay.output));
});
win('Windows robustness: timeout and pipe-input errors do not pretend to be success',async t=>{
  const {runtime,call}=await fixture(t);
  const first=await call('exec_command',{cmd:'Start-Sleep 30',timeout_ms:80,yield_time_ms:0});
  const input=await runtime.invoke('write_stdin',{session_id:first.session_id,chars:'x'});assert.equal(input.structuredContent.error.code,'STDIN_CLOSED');
  const done=await drain(call,first);assert.equal(done.state,'timed_out');assert.equal(done.signal,null);
  const failed=await runtime.invoke('exec_command',{cmd:'not run',shell:path.join(os.tmpdir(),'missing-mdr-shell.exe')});assert.equal(failed.isError,true);assert.equal(failed.structuredContent.state,'start_failed');
});
win('Windows robustness: rotating logs retain UTF-8 and successfully flush writable handles',async t=>{
  const {root}=await fixture(t),file=path.join(root,'rotate.log');
  await fs.writeFile(file,'existing\n');
  const log=new RotatingLog(file,1024,3);
  log.end('中文🙂\n'.repeat(240));await finished(log);
  assert.equal(log.stats.error,null);assert(log.stats.rotations>0);
  for(const name of await fs.readdir(root))if(name.startsWith('rotate.log')){
    const text=await fs.readFile(path.join(root,name),'utf8');assert(!text.includes('\ufffd'));assert(Buffer.byteLength(text)<=1024);
  }
});
win('Windows robustness: patch update preserves explicit DACL and CRLF; case aliases reject before writing',async t=>{
  const {root,runtime,call}=await fixture(t),file=path.join(root,'Case.txt');await fs.writeFile(file,'old\r\nnext\r\n');
  const acl=()=>execFileSync(defaultShell(),['-NoProfile','-Command',`(Get-Acl -LiteralPath ${psQuote(file)}).Sddl`],{encoding:'utf8',windowsHide:true}).trim();
  const before=acl();await call('apply_patch',{workdir:root,patch:'*** Begin Patch\n*** Update File: Case.txt\n@@\n-old\n+new\n*** End Patch'});
  assert.equal(await fs.readFile(file,'utf8'),'new\r\nnext\r\n');assert.equal(acl(),before);
  const alias=await runtime.invoke('apply_patch',{workdir:root,patch:'*** Begin Patch\n*** Add File: fresh.txt\n+a\n*** Add File: FRESH.txt\n+b\n*** End Patch'});
  assert.equal(alias.isError,true);assert.equal(alias.structuredContent.error.code,'DUPLICATE_PATH');await assert.rejects(fs.stat(path.join(root,'fresh.txt')),{code:'ENOENT'});
  await call('apply_patch',{workdir:root,patch:'*** Begin Patch\n*** Update File: Case.txt\n*** Move to: moved.txt\n@@\n-new\n+final\n*** End Patch'});await assert.rejects(fs.stat(file),{code:'ENOENT'});
  await call('apply_patch',{workdir:root,patch:'*** Begin Patch\n*** Delete File: moved.txt\n*** End Patch'});
});
win('Windows robustness: source paths reject drive-relative paths and private directories reject linked parents',async t=>{
  const {root}=await fixture(t);
  for(const value of ['C:','C:relative','\\rooted'])assert.throws(()=>expandPath(value,root),/fully qualified/);
  assert.equal(expandPath('~\\foo',root),path.join(os.homedir(),'foo'));
  await assert.rejects(canonicalDirectory('\\Windows'),{code:'INVALID_WORKDIR'});
  assert.equal(await canonicalDirectory(root),root);
  const target=path.join(root,'real'),link=path.join(root,'linked');await fs.mkdir(target);await fs.symlink(target,link,'junction');
  await assert.rejects(windowsSecurity('private-dir',path.join(link,'not-created')),/reparse/);await assert.rejects(fs.stat(path.join(target,'not-created')),{code:'ENOENT'});
});
win('Windows robustness: native global wrapper forwards quotes, Unicode and shell metacharacters literally',async t=>{
  const {root}=await fixture(t),bin=path.join(root,'bin'),app=path.join(root,'app');await fs.mkdir(bin);await fs.mkdir(path.join(app,'dist','launcher'),{recursive:true});
  await fs.cp(windowsHostPath(),path.join(bin,'mdr.exe'));
  await fs.writeFile(path.join(bin,'mdr-command.json'),JSON.stringify({project:'mcp-dev-runtime',schema_version:1,kind:'source',root:app,node:process.execPath}));
  await fs.writeFile(path.join(app,'dist','launcher','cli.js'),'console.log(JSON.stringify(process.argv.slice(2)));process.exitCode=7;');
  const args=['a b',"quote'\"",'%PATH%!&|中🙂','tail\\',''];
  try{await exec(path.join(bin,'mdr.exe'),args,{windowsHide:true});assert.fail('Expected exit 7')}catch(e){assert.equal(e.code,7);assert.deepEqual(JSON.parse(e.stdout),args)}
});
win('Windows robustness: authenticated shutdown flushes active history; smoke/doctor and long-path IPC work',async t=>{
  const {root,onCleanup}=await fixture(t),state=path.join(root,'long-state-'+('s'.repeat(80))),logs=path.join(root,'logs'),file=path.join(root,'config.json');
  const port=await freePort(),config={schema_version:1,mcp:{host:'127.0.0.1',port},tunnel:{enabled:false},runtime:{cwd:root,shell:defaultShell(),state_dir:state,logs_dir:logs},history:{enabled:true,directory:path.join(state,'history'),record_output:true}};
  await fs.writeFile(file,JSON.stringify(config));
  const run=args=>exec(process.execPath,[cli,...args,'--config',file],{windowsHide:true,timeout:45000,maxBuffer:1024*1024});
  onCleanup(async()=>{if((await current(state)).managed)await stopManaged(state)});
  const started=JSON.parse((await run(['start','--bg'])).stdout);assert.equal(started.state,'ready');assert.equal(started.health.tunnel.disabled,true);
  const denied=await new Promise((resolve,reject)=>{const r=request({socketPath:started.control_socket,path:'/stop',method:'POST',headers:{'X-Run-ID':'not-this-run'}},s=>{s.resume();s.on('end',()=>resolve(s.statusCode))});r.on('error',reject);r.end()});assert.equal(denied,409);
  const duplicate=JSON.parse((await run(['up','--background'])).stdout);assert.equal(duplicate.run_id,started.run_id);assert.equal(duplicate.already_running,true);
  const client=new Client({name:'windows-life',version:'1'});onCleanup(()=>client.close());await client.connect(new StreamableHTTPClientTransport(new URL(started.mcp_url)));
  const r=await client.callTool({name:'exec_command',arguments:{cmd:"Write-Output 'owned-running';Start-Sleep 30",yield_time_ms:0}});assert.equal(r.isError,false);await client.close();
  const restarted=JSON.parse((await run(['restart','--bg'])).stdout);assert.equal(restarted.state,'ready');assert.notEqual(restarted.run_id,started.run_id);
  const records=await fs.readdir(path.join(state,'history')),record=records.find(p=>p.endsWith('.'+r.structuredContent.session_id+'.json'));assert(record);
  assert.equal(JSON.parse(await fs.readFile(path.join(state,'history',record),'utf8')).state,'terminated');
  const doctor=JSON.parse((await run(['doctor','--json'])).stdout);assert.equal(doctor.ok,true);assert.equal(doctor.protocol.tools.length,6);
  assert.match((await run(['smoke'])).stdout,/LOCAL MCP SMOKE PASSED/);
  assert.equal(JSON.parse((await run(['stop'])).stdout).state,'stopped');assert.equal((await current(state)).state,'stopped');
});
win('Windows robustness: occupied port is not adopted or killed, and failed launch leaves no live state',async t=>{
  const {root}=await fixture(t),server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
  const file=path.join(root,'busy.json'),state=path.join(root,'state');await fs.writeFile(file,JSON.stringify({schema_version:1,mcp:{port:server.address().port},tunnel:{enabled:false},runtime:{cwd:root,shell:defaultShell(),state_dir:state,logs_dir:path.join(root,'logs')},history:{enabled:false}}));
  await assert.rejects(exec(process.execPath,[cli,'start','--config',file],{windowsHide:true,timeout:15000}),/already in use/);assert(server.listening);assert.equal((await current(state)).state,'stopped');
});
