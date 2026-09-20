#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import { mkdir, open, stat, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { NAME, VERSION } from '../version.js';
import { ROOT, options, resolveOptions } from './options.js';
import { current, stopManaged, supervise } from './supervisor.js';
import { resolveTunnel, buildTunnel, readLock } from './tunnel.js';
import { loadConfig } from '../config.js';
import { HistoryStore } from '../runtime/history-store.js';
import { randomUUID } from 'node:crypto';
import { layout } from './layout.js';
import { initializeUser } from './initialize.js';
import { toolPolicies } from '../mcp/tool-registry.js';
const help=`${NAME} ${VERSION}
Commands:
  init                                Create missing user configuration (binary distribution)
  serve [--transport http|stdio ...]   Run the MCP server without Tunnel
  start [--background|--bg]           Start managed MCP and Tunnel when enabled
  stop                                Stop only the managed instance
  restart [--background|--bg]         Safely stop, then start the managed instance
  status [--verbose|--json]           Show the managed instance
  up                                  Alias for start
  down                                Alias for stop
  doctor [--json] [--offline]          Diagnose the installed runtime and selected configuration
  smoke [URL]                         Discover tools and run one harmless command
  paths [--json]                      Show resolved paths used by this installation
  config [--json]                     Show effective non-secret configuration
  tools [--json]                      Show enabled and available tool policy
  tunnel-setup [--build]               Check an installed binary or build pinned runtime
  versions                            Show project/tool-contract/Tunnel version pair
  history-clear --confirm              Clear this config's disk history while its writer is stopped
Options:
  --config FILE                       Unified MDR config (legacy runtime JSON remains accepted)
  --launcher-config FILE              Legacy split launcher JSON (compatibility only)
  --tunnel-bin FILE                    Explicit compatible Tunnel binary
  --state-dir DIR                     Local state and log directory
  --logs-dir DIR                      Separate diagnostic log directory
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
const pathFlags = new Set(['--launcher-config','--config','--tunnel-bin','--state-dir','--logs-dir','--env-file']);
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
  const tunnelState=tunnel.disabled===true?'disabled':tunnel.ok===true?'ready':tunnel.ok===false?'degraded':'unknown';
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
    row('Tunnel PID',tunnel.disabled===true?'disabled':state.tunnel_pid??'—'),
    row('MCP latency',typeof mcp.latency_ms==='number'?mcp.latency_ms.toFixed(2)+' ms':'unknown'),
    row('Tunnel lat.',tunnel.disabled===true?'disabled':typeof tunnel.latency_ms==='number'?tunnel.latency_ms.toFixed(2)+' ms':'unknown'),
    row('Memory',bytes(details.rss_bytes)),
    row('Retained',details.retained_sessions!==undefined?details.retained_sessions+' sessions / '+bytes(details.retained_output_bytes)+' output':'unknown'),
    row('History size',history.bytes!==undefined?bytes(history.bytes):'unknown'),
    row('Tunnel ver.',tunnel.disabled===true?'disabled':state.tunnel_version??'unknown')
  );
  for(const log of logs)lines.push(row(path.basename(String(log.file??'log')),log.file??'unknown'));
  return lines.join('\n');
}
async function main(){
  const [rawCommand,...originalArgs]=process.argv.slice(2);
  if(!rawCommand||rawCommand==='--help'||rawCommand==='-h'){console.log(help);return;}
  if(rawCommand==='--version'){console.log(`${NAME} ${VERSION}`);return;}
  const command=rawCommand==='up'?'start':rawCommand==='down'?'stop':rawCommand;
  if(command==='serve'){
    process.argv=[process.argv[0]!,path.join(ROOT,'dist','main.js'),...originalArgs];await import('../main.js');return;
  }
  if(originalArgs.includes('--help')||originalArgs.includes('-h')){console.log(help);return;}
  // Resolve user-provided paths before switching the management cwd. The MCP
  // child already starts from ROOT; doctor and history-clear must use that same base.
  // --bg is a convenience alias only; normalize it before parsing so the
  // launcher keeps one background-mode implementation and one child-spawn path.
  const args = absolutePathArgs(originalArgs.map(arg => arg === '--bg' ? '--background' : arg));
  process.chdir(layout().working_dir);
  if(command==='init'){
    parseArgs({args,options:{}});
    const result=await initializeUser();
    for(const file of result.created)console.log('Created: '+file);
    for(const file of result.preserved)console.log('Preserved: '+file);
    console.log('Fill your Tunnel ID and API key locally in: '+result.env_file);
    console.log('Then run: mcp-dev-runtime start --bg');
    return;
  }
  if(command==='doctor'){
    parseArgs({args,options:{config:{type:'string'},'launcher-config':{type:'string'},json:{type:'boolean'},offline:{type:'boolean'}}});
    await runScript('doctor.mjs',args);return;
  }
  if(command==='smoke'){
    const {values,positionals}=parseArgs({args,allowPositionals:true,options:{config:{type:'string'},'launcher-config':{type:'string'}}});
    if(positionals.length>1)throw new Error('smoke accepts at most one endpoint URL.');
    let url=positionals[0], expectedTools:string[]|undefined;
    if(!url||values.config||values['launcher-config']){
      const o=await resolveOptions({configFile:values.config,launcherFile:values['launcher-config']});
      const c=await loadConfig(o.runtime_config);
      expectedTools=c.tools.allow;
      if(c.transport!=='http')throw new Error('smoke requires HTTP configuration or an explicit URL.');
      url??=`http://${c.host.includes(':')?'['+c.host+']':c.host}:${c.port}${c.mcp_path}`;
    }
    await runScript('smoke.mjs',[url,...(expectedTools?[JSON.stringify(expectedTools)]:[])]);return;
  }
  if(command==='paths'){
    const {values}=parseArgs({args,options:{
      config:{type:'string'},'launcher-config':{type:'string'},'state-dir':{type:'string'},'logs-dir':{type:'string'},json:{type:'boolean'}
    }});
    const overrides:Record<string,unknown>={};
    if(values['state-dir']!==undefined)overrides.state_dir=path.resolve(values['state-dir']);
    if(values['logs-dir']!==undefined)overrides.logs_dir=path.resolve(values['logs-dir']);
    const o=await resolveOptions({configFile:values.config,launcherFile:values['launcher-config'],overrides});
    const result={
      package_root:ROOT,
      config_file:o.configuration_file,
      configuration_mode:o.configuration_mode,
      launcher_config:o.launcher_config_file,
      runtime_config:o.runtime_config??null,
      env_file:o.env_file??null,
      state_dir:o.state_dir,
      logs_dir:o.logs_dir??o.state_dir,
      cache_dir:layout().mode==='source'?layout().cache_dir:null
    };
    if(values.json){console.log(JSON.stringify(result,null,2));return;}
    console.log([
      NAME+' '+VERSION,
      '',
      row('Package',result.package_root),
      ...(result.configuration_mode==='unified'
        ? [row('Config',result.config_file??'none')]
        : [row('Launcher',result.launcher_config??'none'),row('Runtime cfg',result.runtime_config??'none')]),
      ...(result.env_file?[row('Env file',result.env_file)]:[]),
      row('State',result.state_dir),
      row('Logs',result.logs_dir),
      ...(result.cache_dir?[row('Cache',result.cache_dir)]:[])
    ].join('\n'));
    return;
  }
  if(command==='config'){
    const {values}=parseArgs({args,options:{
      config:{type:'string'},'launcher-config':{type:'string'},json:{type:'boolean'}
    }});
    const o=await resolveOptions({configFile:values.config,launcherFile:values['launcher-config']});
    const c=await loadConfig(o.runtime_config);
    const result={
      configuration_file:o.configuration_file,
      configuration_mode:o.configuration_mode,
      mcp:{transport:c.transport,host:c.host,port:c.port,path:c.mcp_path,health_path:c.health_path},
      tunnel:{enabled:o.tunnel_enabled,health_port:o.tunnel_health_port,ready_timeout_ms:o.ready_timeout_ms,health_interval_ms:o.health_interval_ms},
      tools:{allow:c.tools.allow},
      runtime:{cwd:c.cwd,shell:c.shell,state_dir:o.state_dir,logs_dir:o.logs_dir??o.state_dir,env_file:o.env_file??null,shell_env:o.shell_env},
      logging:{level:c.log_level,max_bytes:o.log_max_bytes,files:o.log_files}
    };
    if(values.json){console.log(JSON.stringify(result,null,2));return;}
    console.log([
      NAME+' '+VERSION,
      '',
      row('Config',result.configuration_file??'defaults'),
      row('Mode',result.configuration_mode),
      row('MCP',`${result.mcp.host}:${result.mcp.port}${result.mcp.path}`),
      row('Tunnel',result.tunnel.enabled?'enabled':'disabled'),
      row('Tunnel health',result.tunnel.enabled?result.tunnel.health_port:'disabled'),
      row('Tools',result.tools.allow.length+' enabled'),
      row('Workspace',result.runtime.cwd),
      row('State',result.runtime.state_dir),
      row('Logs',result.runtime.logs_dir),
      row('Secrets',result.runtime.env_file??'none')
    ].join('\n'));
    return;
  }
  if(command==='tools'){
    const {values}=parseArgs({args,options:{
      config:{type:'string'},'launcher-config':{type:'string'},json:{type:'boolean'}
    }});
    const o=await resolveOptions({configFile:values.config,launcherFile:values['launcher-config']});
    const c=await loadConfig(o.runtime_config),enabled=new Set(c.tools.allow);
    const entries=toolPolicies.map(tool=>({...tool,enabled:enabled.has(tool.name)}));
    if(values.json){console.log(JSON.stringify({configuration_file:o.configuration_file,configuration_mode:o.configuration_mode,tools:entries},null,2));return;}
    const yes=entries.filter(x=>x.enabled),no=entries.filter(x=>!x.enabled);
    const lines=[NAME+' '+VERSION,'','Enabled'];
    for(const tool of yes)lines.push('  '+tool.name+(tool.stability==='experimental'?'  (experimental)':''));
    if(no.length){
      lines.push('','Available but disabled');
      for(const tool of no)lines.push('  '+tool.name+'  ('+tool.stability+')');
    }
    console.log(lines.join('\n'));return;
  }
  if(command==='status'){
    const {values}=parseArgs({args,options:{
      config:{type:'string'},'launcher-config':{type:'string'},'state-dir':{type:'string'},'logs-dir':{type:'string'},verbose:{type:'boolean'},json:{type:'boolean'}
    }});
    if(values.verbose&&values.json)throw new Error('status accepts either --verbose or --json, not both.');
    const overrides:Record<string,unknown>={};
    if(values['state-dir']!==undefined)overrides.state_dir=path.resolve(values['state-dir']);
    if(values['logs-dir']!==undefined)overrides.logs_dir=path.resolve(values['logs-dir']);
    const o=await resolveOptions({configFile:values.config,launcherFile:values['launcher-config'],overrides});
    const state=await current(o.state_dir);
    console.log(values.json?JSON.stringify(state,null,2):formatStatus(state,o.logs_dir??o.state_dir,values.verbose??false));
    return;
  }
  const {values}=parseArgs({args,options:{
    'launcher-config':{type:'string'},config:{type:'string'},'tunnel-bin':{type:'string'},
    'state-dir':{type:'string'},'logs-dir':{type:'string'},'env-file':{type:'string'},'shell-env':{type:'boolean'},
    'tunnel-health-port':{type:'string'},'ready-timeout-ms':{type:'string'},background:{type:'boolean'},build:{type:'boolean'},confirm:{type:'boolean'}
  }});
  const overrides:Record<string,unknown>={};
  for(const [flag,key] of [['config','runtime_config'],['tunnel-bin','tunnel_bin'],['state-dir','state_dir'],['logs-dir','logs_dir'],['env-file','env_file']] as const){
    if(values[flag]!==undefined)overrides[key]=path.resolve(values[flag]!);
  }
  if(values['shell-env']!==undefined)overrides.shell_env=values['shell-env'];
  if(values['tunnel-health-port'])overrides.tunnel_health_port=Number(values['tunnel-health-port']);
  if(values['ready-timeout-ms'])overrides.ready_timeout_ms=Number(values['ready-timeout-ms']);
  const o=await resolveOptions({configFile:values.config,launcherFile:values['launcher-config'],overrides});
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
  if(command==='stop'){console.log(JSON.stringify(await stopManaged(o.state_dir),null,2));return;}
  if(command!=='start'&&command!=='restart')throw new Error(`Unknown command: ${rawCommand}`);
  if(layout().mode==='binary'&&!o.runtime_config)throw new Error('User configuration is missing; run mcp-dev-runtime init first.');
  if(command==='restart'){
    const before=await current(o.state_dir);
    // stopped has nothing to stop; stale is safely recovered by supervise().
    // Any live/unreachable controller goes through stopManaged(), which fails
    // closed instead of signalling a PID recovered from disk.
    if(before.state!=='stopped'&&before.state!=='stale')await stopManaged(o.state_dir);
  }
  const existing=await current(o.state_dir);
  if(existing.state==='ready'||existing.state==='starting'){console.log(JSON.stringify({already_running:true,...existing},null,2));return;}
  if(!values.background){await supervise(o);return;}
  await mkdir(o.state_dir,{recursive:true,mode:0o700});
  await mkdir(o.logs_dir??o.state_dir,{recursive:true,mode:0o700});
  const log=path.join(o.logs_dir??o.state_dir,'launcher.log');
  try{if((await stat(log)).size>10*1024*1024){await unlink(log+'.1').catch(e=>{if(e.code!=='ENOENT')throw e;});await rename(log,log+'.1');}}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  const fd=await open(log,'a',0o600);
  const child=spawn(process.execPath,[fileURLToPath(import.meta.url),'start',...args.filter(a=>a!=='--background')],{
    cwd:process.cwd(),env:process.env,detached:true,stdio:['ignore',fd.fd,fd.fd]
  });
  let failed=false;child.on('error',()=>{failed=true;});child.on('exit',()=>{failed=true;});child.unref();await fd.close();
  const until=Date.now()+o.ready_timeout_ms*2+15000;
  while(Date.now()<until){
    const state=await current(o.state_dir);
    if(state.state==='ready'){console.log(JSON.stringify({...state,log_directory:o.logs_dir??o.state_dir},null,2));return;}
    if(failed)throw new Error(`Background startup failed; inspect ${log}.`);
    await new Promise(r=>setTimeout(r,200));
  }
  // ChildProcess is owned by this startup attempt, not a PID from a stale file.
  child.kill('SIGTERM');throw new Error(`Background startup timed out; shutdown requested. Inspect ${log}.`);
}
main().catch(error=>{process.stderr.write(`${NAME}: ${error instanceof Error?error.message:String(error)}\n`);process.exitCode=1;});
