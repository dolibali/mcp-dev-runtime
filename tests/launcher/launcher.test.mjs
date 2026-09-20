import test from 'node:test';
import {VERSION} from '../../dist/version.js';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,mkdir,stat} from 'node:fs/promises';
import path from 'node:path';
import {createServer} from 'node:net';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readLock,compatibleVersion,inspectTunnel} from '../../dist/launcher/tunnel.js';
import {current,readState,stopManaged} from '../../dist/launcher/supervisor.js';
import {options,resolveOptions} from '../../dist/launcher/options.js';
import {mcpEnvironment,launchEnvironment} from '../../dist/launcher/environment.js';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
const exec=promisify(execFile),cli=path.resolve('dist/launcher/cli.js');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function freePort(){return new Promise((resolve,reject)=>{const s=createServer();s.on('error',reject);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});}
async function fixture(t,mode='normal',readyTimeout=5000){
  const dir=await mkdtemp('/tmp/mdr-launch-');const config=path.join(dir,'config.json'),fake=path.join(dir,'tunnel-client-runtime');
  const mp=await freePort();let tp=await freePort();while(tp===mp)tp=await freePort();
  await writeFile(config,JSON.stringify({transport:'http',host:'127.0.0.1',port:mp,cwd:dir,shell:'/bin/bash',log_level:'silent'}));
  const stub=`#!${process.execPath}
// Deterministic launcher test double. Never contacts OpenAI or runs a model.
const http=require('node:http');const args=process.argv.slice(2);
if(args.includes('--version')){console.log('0.0.14 git sha: 70bb5a7 go: test flavor=runtime');process.exit(0);}
if(args.includes('--help')){console.log('Available Commands:\\n  run  Run test-only tunnel');process.exit(0);}
if(${JSON.stringify(mode)}==='exit'){process.exit(7);}
const a=args.find(x=>x.startsWith('--health.listen-addr='));const port=Number(a.split(':').at(-1));
const s=http.createServer((q,r)=>{if(${JSON.stringify(mode)}==='not-ready'||(${JSON.stringify(mode)}==='toggle'&&require('node:fs').existsSync(${JSON.stringify(path.join(dir,'offline'))}))){r.writeHead(503);r.end('starting');}else r.end(q.url==='/readyz'?'ready':'live');});
s.listen(port,'127.0.0.1');process.on('SIGTERM',()=>s.close(()=>process.exit(0)));
// Trigger the fault after the test observes ready, independently of runner speed.
if(${JSON.stringify(mode)}==='late-exit')setInterval(()=>{if(require('node:fs').existsSync(${JSON.stringify(path.join(dir,'crash-now'))}))process.exit(8);},20);
`;
  await writeFile(fake,stub,{mode:0o755});
  const stateDir=path.join(dir,'state');
  const launchConfig=path.join(dir,'launcher.json');await writeFile(launchConfig,JSON.stringify({shell_env:false}));
  const args=['--launcher-config',launchConfig,'--config',config,'--state-dir',stateDir,'--tunnel-bin',fake,'--tunnel-health-port',String(tp),'--ready-timeout-ms',String(readyTimeout)];
  const env={...process.env,CONTROL_PLANE_TUNNEL_ID:'tunnel_'+'0'.repeat(32),CONTROL_PLANE_API_KEY:'local-mock-test-key'};
  t.after(async()=>{try{await stopManaged(stateDir);}catch{}await rm(dir,{recursive:true,force:true});});
  const call=(cmd,extra=[])=>exec(process.execPath,[cli,cmd,...args,...extra],{env,timeout:25000,maxBuffer:262144});
  return {dir,config,fake,stateDir,args,env,mp,tp,call};
}
async function waitState(dir,expected='ready',ms=10000){const until=Date.now()+ms;while(Date.now()<until){const s=await current(dir);if(s.state===expected)return s;await sleep(50);}throw new Error('State not reached: '+expected);}
async function foreground(f,t){const p=spawn(process.execPath,[cli,'up',...f.args],{env:f.env,stdio:['ignore','pipe','pipe']});let text='';p.stdout.on('data',s=>text+=s);p.stderr.on('data',s=>text+=s);const finished=new Promise(resolve=>p.on('close',(code,signal)=>resolve({code,signal,text})));t.after(async()=>{if(p.exitCode===null&&p.signalCode===null){p.kill('SIGTERM');await finished;}});return {p,finished};}

test('launcher: full and runtime version formats match exact tested pin',async()=>{
 const lock=await readLock();assert(compatibleVersion('0.0.14+70bb5a7 (git sha: 70bb5a7)',lock));
 assert(compatibleVersion('0.0.14 git sha: 70bb5a7 go: go1.27.0 flavor=runtime',lock));
 for(const bad of ['0.0.14','0.0.13+70bb5a7','0.0.14+abcdef0','0.0.14+70bb5a70'])assert(!compatibleVersion(bad,lock),bad);
});
test('launcher: configuration paths are relative to the selected config file',async t=>{
 const f=await fixture(t);const file=path.join(f.dir,'launch.json');await writeFile(file,JSON.stringify({runtime_config:'config.json',state_dir:'state',shell_env:false}));
 const o=await options(file);assert.equal(o.runtime_config,f.config);assert.equal(o.state_dir,f.stateDir);assert.equal(o.shell_env,false);
});
test('launcher: unified config cannot be combined with legacy launcher selection',async t=>{
 const f=await fixture(t);const unified=path.join(f.dir,'unified.json'),legacy=path.join(f.dir,'legacy-launcher.json');
 await writeFile(unified,JSON.stringify({schema_version:1,mcp:{port:f.mp},runtime:{cwd:f.dir,shell:'/bin/bash'}}));
 await writeFile(legacy,JSON.stringify({runtime_config:'config.json',state_dir:'state'}));
 await assert.rejects(resolveOptions({configFile:unified,launcherFile:legacy}),/do not combine.*--launcher-config/i);
});
test('launcher: unified config can disable Tunnel and start MCP without Tunnel credentials or binary',async t=>{
 const dir=await mkdtemp('/tmp/mdr-unified-local-');t.after(()=>rm(dir,{recursive:true,force:true}));
 const mp=await freePort(),state=path.join(dir,'state'),logs=path.join(dir,'logs'),file=path.join(dir,'config.json');
 await writeFile(file,JSON.stringify({
  schema_version:1,
  mcp:{transport:'http',host:'127.0.0.1',port:mp,path:'/mcp',health_path:'/healthz'},
  tunnel:{enabled:false},
  runtime:{cwd:dir,shell:'/bin/bash',state_dir:'state',logs_dir:'logs'},
  logging:{level:'silent'}
 }));
 const env={...process.env};delete env.CONTROL_PLANE_API_KEY;delete env.OPENAI_API_KEY;delete env.CONTROL_PLANE_TUNNEL_ID;
 t.after(async()=>{try{await stopManaged(state);}catch{}});
 const up=JSON.parse((await exec(process.execPath,[cli,'up','--config',file,'--background'],{env,timeout:20000})).stdout);
 assert.equal(up.state,'ready');assert.equal(up.health.tunnel.disabled,true);assert.equal(up.tunnel_pid,undefined);
 assert.equal((await (await fetch(`http://127.0.0.1:${mp}/healthz`)).json()).status,'ok');
 const status=JSON.parse((await exec(process.execPath,[cli,'status','--config',file,'--json'],{env,timeout:10000})).stdout);
 assert.equal(status.health.availability,'ready');assert.equal(status.health.tunnel.disabled,true);assert.equal(status.log_directory,logs);
 assert.equal(JSON.parse((await exec(process.execPath,[cli,'down','--config',file],{env,timeout:10000})).stdout).state,'stopped');
});
test('launcher: installed test binary identity and run syntax are inspected',async t=>{const f=await fixture(t);const b=await inspectTunnel(f.fake,await readLock());assert.deepEqual(b.args_prefix,['run']);assert.equal(b.sha256.length,64);});
test('launcher: MCP child does not inherit control-plane keys',()=>{const env=mcpEnvironment({HOME:'/example',PATH:'/bin',CONTROL_PLANE_API_KEY:'secret',OPENAI_API_KEY:'other',NODE_TEST_CONTEXT:'child-v8'});assert.equal(env.HOME,'/example');assert.equal(env.CONTROL_PLANE_API_KEY,undefined);assert.equal(env.OPENAI_API_KEY,undefined);assert.equal(env.NODE_TEST_CONTEXT,undefined);});
test('launcher: missing credentials fail without echoing input data',async t=>{
 const f=await fixture(t);const env={...f.env};delete env.CONTROL_PLANE_API_KEY;delete env.OPENAI_API_KEY;delete env.CONTROL_PLANE_TUNNEL_ID;
 await assert.rejects(exec(process.execPath,[cli,'up',...f.args],{env,timeout:10000}),e=>e.stderr.includes('Missing CONTROL_PLANE')&&!e.stderr.includes('local-mock-test-key'));
});
test('launcher: dotenv credentials are data rather than executable shell code',async t=>{
 const f=await fixture(t);const file=path.join(f.dir,'runtime.env');await writeFile(file,'CONTROL_PLANE_TUNNEL_ID=tunnel_'+ '0'.repeat(32)+'\nCONTROL_PLANE_API_KEY=example-only\nMCP_LITERAL=$(touch should-not-exist)\n');
 const env={...f.env};delete env.CONTROL_PLANE_API_KEY;delete env.CONTROL_PLANE_TUNNEL_ID;
 await exec(process.execPath,[cli,'up',...f.args,'--env-file',file,'--background'],{env,timeout:15000});
 assert.equal((await current(f.stateDir)).state,'ready');await assert.rejects(stat(path.join(f.dir,'should-not-exist')));
});
test('launcher: background startup, repeat startup, status and owned shutdown',async t=>{
 const f=await fixture(t);const first=JSON.parse((await f.call('start',['--bg'])).stdout);assert.equal(first.state,'ready');
 assert.equal(first.health.availability,'ready');assert.equal(first.health.mcp.ok,true);assert.equal(first.health.tunnel.ok,true);
 const second=JSON.parse((await f.call('up',['--background'])).stdout);assert.equal(second.already_running,true);assert.equal(second.run_id,first.run_id);
 const health=await (await fetch(`http://127.0.0.1:${f.mp}/healthz`)).json();assert.equal(health.server,'mcp-dev-runtime');assert.equal(health.version,VERSION);
 assert(!JSON.stringify(await readState(f.stateDir)).includes('local-mock-test-key'));
 const final=JSON.parse((await f.call('stop')).stdout);assert.equal(final.state,'stopped');assert.equal((await current(f.stateDir)).state,'stopped');
 assert.equal(JSON.parse((await f.call('down')).stdout).state,'stopped');
 await assert.rejects(fetch(`http://127.0.0.1:${f.mp}/healthz`));
});
test('launcher: restart replaces a running instance and starts cleanly when stopped',async t=>{
 const f=await fixture(t);
 const first=JSON.parse((await f.call('start',['--bg'])).stdout);assert.equal(first.state,'ready');
 const restarted=JSON.parse((await f.call('restart',['--bg'])).stdout);
 assert.equal(restarted.state,'ready');assert.notEqual(restarted.run_id,first.run_id);assert.notEqual(restarted.mcp_pid,first.mcp_pid);
 assert.equal((await current(f.stateDir)).run_id,restarted.run_id);
 assert.equal(JSON.parse((await f.call('stop')).stdout).state,'stopped');
 const fromStopped=JSON.parse((await f.call('restart',['--bg'])).stdout);
 assert.equal(fromStopped.state,'ready');assert.notEqual(fromStopped.run_id,restarted.run_id);
});
test('launcher: first observable ready state includes a complete initial health snapshot',async t=>{
 const f=await fixture(t);await foreground(f,t);
 const until=Date.now()+10000;let ready;
 while(Date.now()<until){
  const state=await current(f.stateDir);
  if(state.state==='ready'){ready=state;break;}
  await sleep(5);
 }
 assert(ready,'Launcher did not reach ready');
 assert.equal(ready.health?.availability,'ready');
 assert.equal(ready.health?.mcp?.ok,true);assert.equal(ready.health?.tunnel?.ok,true);
 assert.equal(ready.health.mcp.instance_id,ready.mcp_instance);
 assert(Number.isFinite(Date.parse(ready.health.checked_at)));
});
test('launcher: occupied ports are refused and unrelated listeners remain alive',async t=>{
 const f=await fixture(t);const listener=createServer(s=>s.end());await new Promise(r=>listener.listen(f.mp,'127.0.0.1',r));t.after(()=>listener.close());
 await assert.rejects(f.call('up'),e=>e.stderr.includes('already in use'));assert(listener.listening);assert.equal(await readState(f.stateDir),null);
});
test('launcher: readiness timeout stops the owned MCP sibling',async t=>{
 const f=await fixture(t,'not-ready',1200);await assert.rejects(f.call('up'),e=>e.stderr.includes('Readiness timeout'));
 await assert.rejects(fetch(`http://127.0.0.1:${f.mp}/healthz`));assert.equal(await readState(f.stateDir),null);
});
test('launcher: failed Tunnel startup does not leave an orphan MCP',async t=>{
 const f=await fixture(t,'exit');await assert.rejects(f.call('up'),e=>e.stderr.includes('exited unexpectedly'));
 await assert.rejects(fetch(`http://127.0.0.1:${f.mp}/healthz`));
});
test('launcher: SIGTERM stops foreground supervisor and its two children',async t=>{
 const f=await fixture(t);const c=await foreground(f,t);await waitState(f.stateDir);c.p.kill('SIGTERM');const end=await c.finished;assert.equal(end.code,0,end.text);assert.equal(await readState(f.stateDir),null);
});
test('launcher: child crash after ready triggers coordinated fail-stop',async t=>{
 const f=await fixture(t,'late-exit');const c=await foreground(f,t);await waitState(f.stateDir);await writeFile(path.join(f.dir,'crash-now'),'crash the owned test double');const end=await c.finished;assert.equal(end.code,1);assert(end.text.includes('unexpectedly'));assert.equal(await readState(f.stateDir),null);
});
test('launcher: transient Tunnel readiness failure and recovery update live status without killing the MCP task',async t=>{
 const f=await fixture(t,'toggle');await f.call('up',['--background']);
 const before=await current(f.stateDir);assert.equal(before.health.availability,'ready');
 const client=new Client({name:'readiness-regression',version:'1.0.0'});t.after(()=>client.close());
 await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${f.mp}/mcp`)));
 const started=(await client.callTool({name:'exec_command',arguments:{cmd:'sleep 15',yield_time_ms:0}})).structuredContent;
 await writeFile(path.join(f.dir,'offline'),'simulate network loss');await sleep(1100);
 const down=await current(f.stateDir);assert.equal(down.health.availability,'degraded');assert.equal(down.health.mcp.ok,true);assert.equal(down.mcp_instance,before.mcp_instance);
 const sessions=(await client.callTool({name:'list_exec_sessions',arguments:{state:'running'}})).structuredContent;
 assert(sessions.sessions.some(s=>s.session_id===started.session_id));
 await rm(path.join(f.dir,'offline'));await sleep(1100);
 const up=await current(f.stateDir);assert.equal(up.health.availability,'ready');assert.equal(up.mcp_pid,before.mcp_pid);assert.equal(up.tunnel_pid,before.tunnel_pid);
 const stopped=(await client.callTool({name:'terminate_exec_session',arguments:{session_id:started.session_id}})).structuredContent;
 assert.equal(stopped.termination_confirmed,true);
});
test('launcher: down never kills a live PID from an unreachable stale record',async t=>{
 const f=await fixture(t);await mkdir(f.stateDir);await writeFile(path.join(f.stateDir,'supervisor.json'),JSON.stringify({pid:process.pid,run_id:'not-a-controller',control_socket:path.join(f.stateDir,'missing.sock')}));
 await assert.rejects(stopManaged(f.stateDir));assert.equal((await current(f.stateDir)).state,'unreachable');
 await assert.rejects(f.call('restart',['--bg']),e=>/Supervisor unavailable|ENOENT|connect/i.test(e.stderr));assert.equal((await current(f.stateDir)).state,'unreachable');
});
test('launcher: mismatched Tunnel commit is rejected before services start',async t=>{
 const f=await fixture(t);let text=await readFile(f.fake,'utf8');text=text.replaceAll('70bb5a7','abcdef0');await writeFile(f.fake,text,{mode:0o755});
 await assert.rejects(f.call('up'),e=>e.stderr.includes('version mismatch'));assert.equal(await readState(f.stateDir),null);
});


test('launcher: cancellation during startup cleans owned children',async t=>{
 const f=await fixture(t,'not-ready');const c=await foreground(f,t);await waitState(f.stateDir,'starting');c.p.kill('SIGTERM');const end=await c.finished;assert.notEqual(end.code,null);assert.equal(await readState(f.stateDir),null);await assert.rejects(fetch(`http://127.0.0.1:${f.mp}/healthz`));
});
test('launcher: dead-owner lock can be recovered without signalling its PID',async t=>{
 const f=await fixture(t);await mkdir(path.join(f.stateDir,'launch.lock'),{recursive:true});await writeFile(path.join(f.stateDir,'launch.lock','owner.json'),JSON.stringify({pid:2147483647,run_id:'dead-owner'}));
 const r=JSON.parse((await f.call('up',['--background'])).stdout);assert.equal(r.state,'ready');
});
test('launcher: simultaneous background starts do not create two instances',async t=>{
 const f=await fixture(t);const results=await Promise.allSettled([f.call('up',['--background']),f.call('up',['--background'])]);assert(results.some(r=>r.status==='fulfilled'));
 const s=await waitState(f.stateDir);const successes=results.filter(r=>r.status==='fulfilled').map(r=>JSON.parse(r.value.stdout));assert(successes.every(r=>r.run_id===s.run_id));
});
test('launcher: empty inherited credential variables do not mask an env file',async t=>{
 const f=await fixture(t);const file=path.join(f.dir,'empty-env-test.env');await writeFile(file,'CONTROL_PLANE_TUNNEL_ID=tunnel_'+ '0'.repeat(32)+'\nCONTROL_PLANE_API_KEY=env-file-test-value\n');
 const env={...f.env,CONTROL_PLANE_API_KEY:'',CONTROL_PLANE_TUNNEL_ID:'',OPENAI_API_KEY:''};
 const r=await exec(process.execPath,[cli,'up',...f.args,'--env-file',file,'--background'],{env,timeout:15000});assert.equal(JSON.parse(r.stdout).state,'ready');
});

test('versions: sync updates the project association without moving the upstream pin',async t=>{
 const dir=await mkdtemp('/tmp/mdr-version-');t.after(()=>rm(dir,{recursive:true,force:true}));
 await writeFile(path.join(dir,'package.json'),JSON.stringify({version:'0.2.1'}));
 await writeFile(path.join(dir,'package-lock.json'),JSON.stringify({version:'0.2.1',packages:{'':{version:'0.2.1'}}}));
 const before=await readLock();await writeFile(path.join(dir,'tunnel.lock.json'),JSON.stringify(before));
 await exec(process.execPath,[path.resolve('scripts/sync-version.mjs')],{cwd:dir});
 const after=JSON.parse(await readFile(path.join(dir,'tunnel.lock.json'),'utf8'));assert.equal(after.runtime_version,'0.2.1');assert.deepEqual(after.upstream,before.upstream);assert.equal(after.contract_version,before.contract_version);
});
