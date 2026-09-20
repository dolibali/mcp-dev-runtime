#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import { mkdir, open, stat, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
  status [--verbose|--json]           Show the managed instance
  down                                Stop only the managed instance
  doctor [--json] [--offline]          Diagnose the installed runtime and selected configuration
  smoke [URL]                         Discover tools and run one harmless command
  paths [--json]                      Show resolved paths used by this installation
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
  --verbose                            Detailed human-readable status
  --json                               Full machine-readable status/doctor output
Windows native is not supported. No Codex, Agent or model API is invoked.
Management commands use this installation's configuration and working-directory base.
Explicit relative path flags resolve from the caller's directory; serve keeps caller cwd.
`;
const pathFlags = new Set(['--launcher-config','--config','--tunnel-bin','--state-dir','--env-file']);
function absolutePathArgs(args: string[]): string[] {
  const result = [...args];
  for (let i = 0; i < result.length; i++) {
    const arg = result[i]!;
    const equals = arg.indexOf('=');
    if (equals > 0 && pathFlags.has(arg.slice(0, equals))) {
      const value = arg.slice(equals + 1);
      if (!value) throw new Error(`Missing path for ${arg.slice(0, equals)}`);
      result[i] = arg.slice(0, equals + 1) + path.resolve(value);
    } else if (pathFlags.has(arg)) {
      const value = result[i + 1];
      if (!value || value.startsWith('--')) throw new Error(`Missing path for ${arg}`);
      result[++i] = path.resolve(value);
    }
  }
  return result;
}
async function runScript(name: string, args: string[]) {
  const file = path.join(ROOT,'scripts',name);
  process.argv = [process.execPath,file,...args];
  await import(pathToFileURL(file).href);
}
type StatusRecord = Record<string, any>;
function duration(seconds: unknown): string {
  if(typeof seconds!=='number'||!Number.isFinite(seconds)||seconds<0)return 'unknown';
  const whole=Math.floor(seconds),days=Math.floor(whole/86400),hours=Math.floor((whole%86400)/3600),minutes=Math.floor((whole%3600)/60),secs=whole%60;
  if(days)return days+'d '+hours+'h '+minutes+'m '+secs+'s';
  if(hours)return hours+'h '+minutes+'m '+secs+'s';
  if(minutes)return minutes+'m '+secs+'s';
  return secs+'s';
}
function bytes(value: unknown): string {
  if(typeof value!=='number'||!Number.isFinite(value)||value<0)return 'unknown';
  const units=['B','KiB','MiB','GiB'];let amount=value,unit=0;
  while(amount>=1024&&unit<units.length-1){amount/=1024;unit++;}
  return (unit===0?String(Math.round(amount)):amount.toFixed(amount>=10?1:2))+' '+units[unit];
}
function row(label: string, value: unknown): string {return label.padEnd(14)+String(value??'unknown');}
function formatStatus(state: StatusRecord,stateDir:string,verbose=false): string {
  const health=(state.health??{}) as StatusRecord,mcp=(health.mcp??{}) as StatusRecord,tunnel=(health.tunnel??{}) as StatusRecord;
  const details=(mcp.details??{}) as StatusRecord,history=(details.history??{}) as StatusRecord;
  const logs=Array.isArray(state.logs)?state.logs as StatusRecord[]:[];
  const availability=health.availability??state.state??'unknown';
  const mcpState=mcp.ok===true?'ready':mcp.ok===false?'degraded':'unknown';
  const tunnelState=tunnel.ok===true?'ready':tunnel.ok===false?'degraded':'unknown';
  const logDir=logs[0]?.file?path.dirname(String(logs[0].file)):stateDir;
  const lines=[
    NAME+' '+(state.version??VERSION),
    '',
    row('Status',availability),
    row('MCP',mcpState+(state.mcp_url?'  '+state.mcp_url:'')),
    row('Tunnel',tunnelState),
    row('Sessions',details.active_sessions!==undefined?details.active_sessions+' / '+(details.max_active_sessions??'?')+' active':'unknown'),
    row('History',history.records!==undefined?history.records+' records':'unknown'),
    row('Uptime',duration(details.uptime_seconds)),
    row('Logs',logDir)
  ];
  if(!verbose)return lines.join('\n');
  lines.push(
    '',
    row('Lifecycle',state.state??'unknown'),
    row('Managed',state.managed===true?'yes':state.managed===false?'no':'unknown'),
    row('Run ID',state.run_id??'—'),
    row('MCP instance',state.mcp_instance??'—'),
    row('Supervisor',state.pid??'—'),
    row('MCP PID',state.mcp_pid??'—'),
    row('Tunnel PID',state.tunnel_pid??'—'),
    row('MCP latency',typeof mcp.latency_ms==='number'?mcp.latency_ms.toFixed(2)+' ms':'unknown'),
    row('Tunnel lat.',typeof tunnel.latency_ms==='number'?tunnel.latency_ms.toFixed(2)+' ms':'unknown'),
    row('Memory',bytes(details.rss_bytes)),
    row('Retained',details.retained_sessions!==undefined?details.retained_sessions+' sessions / '+bytes(details.retained_output_bytes)+' output':'unknown'),
    row('History size',history.bytes!==undefined?bytes(history.bytes):'unknown'),
    row('Tunnel ver.',state.tunnel_version??'unknown')
  );
  for(const log of logs)lines.push(row(path.basename(String(log.file??'log')),log.file??'unknown'));
  return lines.join('\n');
}
async function main(){
  const [command,...originalArgs]=process.argv.slice(2);
  if(!command||command==='--help'||command==='-h'){console.log(help);return;}
  if(command==='--version'){console.log(`${NAME} ${VERSION}`);return;}
  if(command==='serve'){
    process.argv=[process.argv[0]!,path.join(ROOT,'dist','main.js'),...originalArgs];await import('../main.js');return;
  }
  if(originalArgs.includes('--help')||originalArgs.includes('-h')){console.log(help);return;}
  // Resolve user-provided paths before switching the management cwd. The MCP
  // child already starts from ROOT; doctor and history-clear must use that same base.
  const args = absolutePathArgs(originalArgs);
  process.chdir(ROOT);
  if(command==='doctor'){
    parseArgs({args,options:{config:{type:'string'},'launcher-config':{type:'string'},json:{type:'boolean'},offline:{type:'boolean'}}});
    await runScript('doctor.mjs',args);return;
  }
  if(command==='smoke'){
    const {values,positionals}=parseArgs({args,allowPositionals:true,options:{config:{type:'string'},'launcher-config':{type:'string'}}});
    if(positionals.length>1)throw new Error('smoke accepts at most one endpoint URL.');
    let url=positionals[0];
    if(!url){
      const o=await options(values['launcher-config']);
      const c=await loadConfig(values.config??o.runtime_config);
      if(c.transport!=='http')throw new Error('smoke requires HTTP configuration or an explicit URL.');
      url=`http://${c.host.includes(':')?'['+c.host+']':c.host}:${c.port}${c.mcp_path}`;
    }
    await runScript('smoke.mjs',[url]);return;
  }
  if(command==='paths'){
    const {values}=parseArgs({args,options:{
      'launcher-config':{type:'string'},'state-dir':{type:'string'},json:{type:'boolean'}
    }});
    const overrides:Record<string,unknown>={};
    if(values['state-dir']!==undefined)overrides.state_dir=path.resolve(values['state-dir']);
    const launcherFile=path.resolve(values['launcher-config']??path.join(ROOT,'launcher.config.json'));
    const o=await options(values['launcher-config'],overrides);
    const result={
      package_root:ROOT,
      launcher_config:launcherFile,
      runtime_config:o.runtime_config??null,
      state_dir:o.state_dir,
      logs_dir:o.state_dir
    };
    if(values.json){console.log(JSON.stringify(result,null,2));return;}
    console.log([
      NAME+' '+VERSION,
      '',
      row('Package',result.package_root),
      row('Launcher',result.launcher_config),
      row('Runtime cfg',result.runtime_config??'none'),
      row('State',result.state_dir),
      row('Logs',result.logs_dir)
    ].join('\n'));
    return;
  }
  if(command==='status'){
    const {values}=parseArgs({args,options:{
      'launcher-config':{type:'string'},'state-dir':{type:'string'},verbose:{type:'boolean'},json:{type:'boolean'}
    }});
    if(values.verbose&&values.json)throw new Error('status accepts either --verbose or --json, not both.');
    const overrides:Record<string,unknown>={};
    if(values['state-dir']!==undefined)overrides.state_dir=path.resolve(values['state-dir']);
    const o=await options(values['launcher-config'],overrides);
    const state=await current(o.state_dir);
    console.log(values.json?JSON.stringify(state,null,2):formatStatus(state,o.state_dir,values.verbose??false));
    return;
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
