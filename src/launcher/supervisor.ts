import { createServer as httpServer, request } from 'node:http';
import { createServer as tcpServer } from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { finished } from 'node:stream/promises';
import { mkdir, readFile, writeFile, rename, unlink, rmdir, stat, chmod } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { NAME, VERSION } from '../version.js';
import { loadConfig } from '../config.js';
import { launchEnvironment, mcpEnvironment } from './environment.js';
import { resolveTunnel, readLock } from './tunnel.js';
import { ROOT, type LaunchOptions } from './options.js';
import { RotatingLog } from './rotating-log.js';
import { probePair } from './health.js';

export type State = {
  run_id: string; pid: number; state: 'starting'|'ready'|'stopping'; version: string;
  control_socket: string; mcp_url: string; mcp_health: string; tunnel_health: string;
  mcp_instance?: string; mcp_pid?: number; tunnel_pid?: number; tunnel_version?: string;
  tunnel_sha256?: string; tunnel_source_commit?: string; started_at: string;
};
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const alive = (pid: number) => {try {process.kill(pid,0);return true;}catch(e){return (e as NodeJS.ErrnoException).code==='EPERM';}};
export async function readState(dir: string): Promise<State | null> {
  try { const s=JSON.parse(await readFile(path.join(dir,'supervisor.json'),'utf8')) as State;
    if(!s.run_id || !Number.isSafeInteger(s.pid) || !s.control_socket) throw new Error('Invalid supervisor state file');return s;
  } catch(e) {if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e;}
}
export async function control(s: State, endpoint='/status'): Promise<Record<string,unknown>> {
  return new Promise((resolve,reject)=>{
    const req=request({socketPath:s.control_socket,path:endpoint,method:endpoint==='/stop'?'POST':'GET',headers:{'X-Run-ID':s.run_id}},res=>{
      let text='';res.on('data',d=>{text+=d;if(text.length>65536){res.destroy();reject(new Error('Oversized supervisor response'));}});
      res.on('end',()=>{try{if(res.statusCode!==200)throw new Error('Supervisor control failed');const result=JSON.parse(text);if(result.run_id!==s.run_id)throw new Error('Supervisor identity mismatch');resolve(result);}catch(e){reject(e);}});
    });req.setTimeout(2500,()=>req.destroy(new Error('Supervisor unavailable')));req.on('error',reject);req.end();
  });
}
export async function current(dir: string): Promise<Record<string,unknown>> {
  const s=await readState(dir);if(!s)return {state:'stopped',managed:false};
  try {return {...await control(s),managed:true};}
  catch {return {state:alive(s.pid)?'unreachable':'stale',managed:false,pid:s.pid,run_id:s.run_id};}
}
async function available(host: string, port: number) {
  await new Promise<void>((resolve,reject)=>{const s=tcpServer();s.once('error',()=>reject(new Error(`Port ${host}:${port} is already in use; no existing process was stopped.`)));s.listen(port,host,()=>s.close(()=>resolve()));});
}
export async function stopManaged(dir: string) {
  const s=await readState(dir);if(!s)return {state:'stopped',managed:false};
  // Never signal a PID loaded from disk: request shutdown through the owning instance.
  await control(s,'/stop');const until=Date.now()+22000;
  while(Date.now()<until){const now=await readState(dir);if(!now||now.run_id!==s.run_id)return {state:'stopped',run_id:s.run_id};await sleep(100);}
  throw new Error('Managed shutdown did not finish; inspect launcher logs. No unrelated process was signalled.');
}
export async function supervise(o: LaunchOptions) {
  if(!['darwin','linux'].includes(process.platform))throw new Error('Windows native support is deferred. Use macOS or Linux.');
  const old=await current(o.state_dir);
  if(old.state==='ready'||old.state==='starting')return old;
  const config=await loadConfig(o.runtime_config,{transport:'http'});
  if(config.port===0)throw new Error('Managed startup requires a fixed MCP port; use serve for an ephemeral port.');
  if(config.port===o.tunnel_health_port)throw new Error('MCP and Tunnel health ports must differ.');
  const env=await launchEnvironment(o),binary=await resolveTunnel(o.tunnel_bin),lock=await readLock();
  await mkdir(o.state_dir,{recursive:true,mode:0o700});
  const lockDir=path.join(o.state_dir,'launch.lock'),stateFile=path.join(o.state_dir,'supervisor.json');
  const socket=path.join(o.state_dir,'control.sock');
  if(Buffer.byteLength(socket)>100)throw new Error('State directory path is too long for a POSIX socket; choose a shorter --state-dir.');
  try {await mkdir(lockDir,{mode:0o700});}
  catch(e){
    if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;
    const state=await readState(o.state_dir);
    let owner:{pid:number}|undefined;
    try{owner=JSON.parse(await readFile(path.join(lockDir,'owner.json'),'utf8'));}catch{}
    if(owner&&alive(owner.pid))throw new Error('Another launcher is active; use status/down, not a second startup.');
    if(!owner && Date.now()-(await stat(lockDir)).mtimeMs<15000)throw new Error('Another launcher is starting; retry status shortly.');
    if(state && alive(state.pid))throw new Error('State belongs to a live process; refusing automatic stale-state cleanup.');
    // Only remove the known files of a dead owner, never a recursive directory tree.
    for(const file of [path.join(lockDir,'owner.json'),stateFile,socket])await unlink(file).catch(err=>{if(err.code!=='ENOENT')throw err;});
    await rmdir(lockDir);await mkdir(lockDir,{mode:0o700});
  }
  const runId=randomUUID();await writeFile(path.join(lockDir,'owner.json'),JSON.stringify({pid:process.pid,run_id:runId}),{mode:0o600});
  const host=config.host.includes(':')?`[${config.host}]`:config.host;
  const state:State={run_id:runId,pid:process.pid,state:'starting',version:VERSION,control_socket:socket,
    mcp_url:`http://${host}:${config.port}${config.mcp_path}`,mcp_health:`http://${host}:${config.port}${config.health_path}`,
    tunnel_health:`http://127.0.0.1:${o.tunnel_health_port}`,tunnel_source_commit:lock.upstream.commit,
    tunnel_version:binary.version,tunnel_sha256:binary.sha256,started_at:new Date().toISOString()};
  const children:ChildProcess[]=[],streams:RotatingLog[]=[];
  let health:Awaited<ReturnType<typeof probePair>>|undefined,healthTimer:NodeJS.Timeout|undefined;
  let healthInFlight:Promise<void>|undefined;
  const refreshHealth=():Promise<void>=>healthInFlight??=(async()=>{
    health=await probePair(state.mcp_health,state.tunnel_health+'/readyz',state.mcp_instance);
  })().finally(()=>{healthInFlight=undefined;});
  let stopping=false,cancelled=false,startupFinished=false,failed:Error|undefined,resolveDone!:()=>void;
  const done=new Promise<void>(r=>resolveDone=r);
  let stopPromise:Promise<void>|undefined;
  const save=async()=>{const tmp=stateFile+'.tmp';await writeFile(tmp,JSON.stringify(state,null,2)+'\n',{mode:0o600});await rename(tmp,stateFile);};
  let server:ReturnType<typeof httpServer>|undefined;
  const stop=()=>stopPromise??=(async()=>{
    stopping=true;state.state='stopping';
    if(healthTimer)clearInterval(healthTimer);
    // Stop the Tunnel first; each MCP child cleans up the executions it owns.
    for(const child of [...children].reverse()){
      if(child.exitCode!==null||child.signalCode!==null)continue;
      child.kill('SIGTERM');const until=Date.now()+16000;
      while(child.exitCode===null&&child.signalCode===null&&Date.now()<until)await sleep(30);
      if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await sleep(100);}
    }
    if(server)await new Promise<void>(r=>server!.close(()=>r()));
    for(const stream of streams){stream.end();await finished(stream).catch(()=>{});}
    // Files belong to this process, verified before removing the run record.
    const disk=await readState(o.state_dir);
    if(!disk||disk.run_id===runId){
      for(const file of [stateFile,stateFile+'.tmp',socket,path.join(lockDir,'owner.json')])await unlink(file).catch(e=>{if(e.code!=='ENOENT')throw e;});
      await rmdir(lockDir);
    }
    resolveDone();
  })();
  const onSignal=()=>{cancelled=true;if(startupFinished)void stop().catch(e=>{failed=e;resolveDone();});};
  process.once('SIGTERM',onSignal);process.once('SIGINT',onSignal);
  async function start(command: string,args: string[],childEnv:NodeJS.ProcessEnv,label:string) {
    if(cancelled||stopping)throw new Error('Startup cancelled');
    const filename=path.join(o.state_dir,label+'.log');
    const stream=new RotatingLog(filename,o.log_max_bytes,o.log_files);streams.push(stream);
    stream.on('error',()=>{failed=new Error(`${label} log write failed`);if(startupFinished)onSignal();});
    const child=spawn(command,args,{cwd:ROOT,env:childEnv,stdio:['ignore','pipe','pipe']});children.push(child);
    const secrets=[env.CONTROL_PLANE_API_KEY,env.OPENAI_API_KEY,env.OPENAI_ADMIN_KEY].filter((x):x is string=>!!x);
    for(const input of [child.stdout!,child.stderr!]){
      input.setEncoding('utf8');let pending='';
      const log=(line:string)=>{
        for(const key of secrets)line=line.replaceAll(key,'[REDACTED]');
        if(!stream.write(line)&&!input.isPaused()){
          input.pause();stream.once('drain',()=>input.resume());
        }
      };
      input.on('data',(text:string)=>{pending+=text;let at;while((at=pending.indexOf('\n'))>=0){log(pending.slice(0,at+1));pending=pending.slice(at+1);}if(pending.length>262144){log('[oversized unterminated log line omitted]\n');pending='';}});
      input.on('end',()=>{if(pending)log(pending);});
    }
    child.once('close',(code,signal)=>{if(!stopping){failed=new Error(`${label} exited unexpectedly (${signal??code}). See ${filename}`);if(startupFinished)void stop().catch(e=>{failed=e;resolveDone();});}});
    await new Promise<void>((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});return child;
  }
  async function waitHealth(url:string,check:(value:string)=>boolean){
    const until=Date.now()+o.ready_timeout_ms;
    while(Date.now()<until){if(failed)throw failed;if(cancelled||stopping)throw new Error('Startup cancelled');
      try{const res=await fetch(url,{signal:AbortSignal.timeout(1500)});const text=await res.text();if(res.ok&&check(text))return;}catch{}
      await sleep(150);
    }throw new Error(`Readiness timeout at ${url}; see launcher logs.`);
  }
  try{
    await available(config.host,config.port);await available('127.0.0.1',o.tunnel_health_port);
    if(cancelled)throw new Error('Startup cancelled');
    server=httpServer((req,res)=>{
      if(req.headers['x-run-id']!==runId){res.writeHead(409);res.end();return;}
      if(req.url==='/status'&&req.method==='GET'){
        const reply=()=>{if(!res.destroyed){res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify({...state,health,logs:streams.map(s=>s.stats)}));}};
        if(startupFinished&&!stopping&&(!health||Date.now()-Date.parse(health.checked_at)>1000))void refreshHealth().then(reply,reply);
        else reply();
      }
      else if(req.url==='/stop'&&req.method==='POST'){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({run_id:runId,state:'stopping'}));setImmediate(onSignal);}
      else {res.writeHead(404);res.end();}
    });
    await new Promise<void>((resolve,reject)=>{server!.once('error',reject);server!.listen(socket,()=>resolve());});await chmod(socket,0o600);await save();
    const main=path.join(ROOT,'dist','main.js');const args=[main,...(o.runtime_config?['--config',o.runtime_config]:[]),'--transport','http'];
    const mcp=await start(process.execPath,args,mcpEnvironment(env),'mcp');state.mcp_pid=mcp.pid;await save();
    await waitHealth(state.mcp_health,text=>{const h=JSON.parse(text);if(h.server!==NAME||h.version!==VERSION||h.status!=='ok')return false;state.mcp_instance=h.instance_id;return true;});
    if(cancelled||stopping)throw new Error('Startup cancelled');
    const tunnel=await start(binary.path,[...binary.args_prefix,`--mcp.server-url=${state.mcp_url}`,`--health.listen-addr=127.0.0.1:${o.tunnel_health_port}`,'--log.level=warn','--log.format=struct-text'],env,'tunnel');
    state.tunnel_pid=tunnel.pid;await save();await waitHealth(state.tunnel_health+'/readyz',s=>s.trim()==='ready');
    if(cancelled||stopping)throw new Error('Startup cancelled');state.state='ready';await save();startupFinished=true;if(cancelled||failed){await stop();if(failed)throw failed;return {state:'stopped',run_id:runId};}console.log(JSON.stringify(state));
    healthTimer=setInterval(()=>{if(!stopping)void refreshHealth();},o.health_interval_ms);healthTimer.unref();
    await refreshHealth();
    await done;if(failed)throw failed;return {state:'stopped',run_id:runId};
  }catch(e){await stop();throw e;}
  finally{process.off('SIGTERM',onSignal);process.off('SIGINT',onSignal);}
}
