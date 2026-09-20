#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import { mkdir, open, stat, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NAME, VERSION } from '../version.js';
import { ROOT, options } from './options.js';
import { current, stopManaged, supervise } from './supervisor.js';
import { resolveTunnel, buildTunnel, readLock } from './tunnel.js';
import { loadConfig } from '../config.js';
import { HistoryStore } from '../runtime/history-store.js';
import { randomUUID } from 'node:crypto';
const help=`${NAME} ${VERSION}
Commands:
  serve [--transport http|stdio ...]   Run the MCP server without Tunnel
  up [--background]                   Start MCP and the locked Tunnel together
  status                              Show the managed instance
  down                                Stop only the managed instance
  tunnel-setup [--build]               Check an installed binary or build pinned runtime
  versions                            Show project/tool-contract/Tunnel version pair
  history-clear --confirm              Clear this config's disk history while its writer is stopped
Options:
  --launcher-config FILE              Launcher JSON (defaults to package-local file)
  --config FILE                       MCP runtime JSON
  --tunnel-bin FILE                    Explicit compatible Tunnel binary
  --state-dir DIR                     Local state and log directory
  --env-file FILE                      Read dotenv data without evaluating shell code
  --shell-env                          Load login-shell configuration only when keys missing
  --tunnel-health-port PORT            Default 9098
  --ready-timeout-ms NUMBER            Default 30000
Windows native is not supported. No Codex, Agent or model API is invoked.
`;
async function main(){
  const [command,...args]=process.argv.slice(2);
  if(!command||command==='--help'||command==='-h'){console.log(help);return;}
  if(command==='--version'){console.log(`${NAME} ${VERSION}`);return;}
  if(command==='serve'){
    process.argv=[process.argv[0]!,path.join(ROOT,'dist','main.js'),...args];await import('../main.js');return;
  }
  const {values}=parseArgs({args,options:{
    'launcher-config':{type:'string'},config:{type:'string'},'tunnel-bin':{type:'string'},
    'state-dir':{type:'string'},'env-file':{type:'string'},'shell-env':{type:'boolean'},
    'tunnel-health-port':{type:'string'},'ready-timeout-ms':{type:'string'},background:{type:'boolean'},build:{type:'boolean'},confirm:{type:'boolean'}
  }});
  const overrides:Record<string,unknown>={};
  for(const [flag,key] of [['config','runtime_config'],['tunnel-bin','tunnel_bin'],['state-dir','state_dir'],['env-file','env_file']] as const){
    if(values[flag]!==undefined)overrides[key]=path.resolve(values[flag]!);
  }
  if(values['shell-env']!==undefined)overrides.shell_env=values['shell-env'];
  if(values['tunnel-health-port'])overrides.tunnel_health_port=Number(values['tunnel-health-port']);
  if(values['ready-timeout-ms'])overrides.ready_timeout_ms=Number(values['ready-timeout-ms']);
  const o=await options(values['launcher-config'],overrides);
  if(command==='history-clear'){
    if(!values.confirm)throw new Error('history-clear requires --confirm. Stop the writer first; no active service will be stopped automatically.');
    const config=await loadConfig(o.runtime_config);
    const h=new HistoryStore(config,randomUUID());
    try{
      await h.ready;
      if(h.status.state!=='ready')throw new Error('History is unavailable or in use. '+h.status.warnings.join('; '));
      const result=await h.clear();
      if(result.records!==0)throw new Error('History clear was incomplete. '+result.warnings.join('; '));
      console.log(JSON.stringify({cleared:true,directory:h.directory,remaining_records:result.records},null,2));
    }finally{await h.close();}
    return;
  }
  if(command==='versions'){console.log(JSON.stringify({project:NAME,version:VERSION,lock:await readLock()},null,2));return;}
  if(command==='tunnel-setup'){const r=values.build?await buildTunnel():await resolveTunnel(o.tunnel_bin);console.log(JSON.stringify(r,null,2));return;}
  if(command==='status'){console.log(JSON.stringify(await current(o.state_dir),null,2));return;}
  if(command==='down'){console.log(JSON.stringify(await stopManaged(o.state_dir),null,2));return;}
  if(command!=='up')throw new Error(`Unknown command: ${command}`);
  const existing=await current(o.state_dir);
  if(existing.state==='ready'||existing.state==='starting'){console.log(JSON.stringify({already_running:true,...existing},null,2));return;}
  if(!values.background){await supervise(o);return;}
  await mkdir(o.state_dir,{recursive:true,mode:0o700});
  const log=path.join(o.state_dir,'launcher.log');
  try{if((await stat(log)).size>10*1024*1024){await unlink(log+'.1').catch(e=>{if(e.code!=='ENOENT')throw e;});await rename(log,log+'.1');}}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  const fd=await open(log,'a',0o600);
  const child=spawn(process.execPath,[fileURLToPath(import.meta.url),'up',...args.filter(a=>a!=='--background')],{
    cwd:process.cwd(),env:process.env,detached:true,stdio:['ignore',fd.fd,fd.fd]
  });
  let failed=false;child.on('error',()=>{failed=true;});child.on('exit',()=>{failed=true;});child.unref();await fd.close();
  const until=Date.now()+o.ready_timeout_ms*2+15000;
  while(Date.now()<until){
    const state=await current(o.state_dir);
    if(state.state==='ready'){console.log(JSON.stringify({...state,log_directory:o.state_dir},null,2));return;}
    if(failed)throw new Error(`Background startup failed; inspect ${log}.`);
    await new Promise(r=>setTimeout(r,200));
  }
  // ChildProcess is owned by this startup attempt, not a PID from a stale file.
  child.kill('SIGTERM');throw new Error(`Background startup timed out; shutdown requested. Inspect ${log}.`);
}
main().catch(error=>{process.stderr.write(`${NAME}: ${error instanceof Error?error.message:String(error)}\n`);process.exitCode=1;});
