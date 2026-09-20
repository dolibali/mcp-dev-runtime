import {access,stat,readFile} from 'node:fs/promises';
import {constants} from 'node:fs';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {parseArgs,isDeepStrictEqual} from 'node:util';
import {loadConfig} from '../dist/config.js';
import {options} from '../dist/launcher/options.js';
import {current} from '../dist/launcher/supervisor.js';
import {probe} from '../dist/launcher/health.js';
const require=createRequire(import.meta.url);
const {values,positionals}=parseArgs({allowPositionals:true,options:{config:{type:'string'},json:{type:'boolean'},offline:{type:'boolean'},'launcher-config':{type:'string'}}});
const launch=await options(values['launcher-config']);
const file=values.config??positionals[0]??launch.runtime_config;
const config=await loadConfig(file);
const report={checked_at:new Date().toISOString(),node:process.version,platform:process.platform,arch:process.arch,
  cwd:config.cwd,shell:config.shell,configuration_file:file??null,toolchains:{},
  scope:'Local configuration, fresh liveness, MCP discovery and managed Tunnel readiness; not a remote ChatGPT round trip.'};
for(const name of ['rg','git','node']){
  const result=spawnSync(name==='node'?process.execPath:name,['--version'],{encoding:'utf8',timeout:3000});
  report.toolchains[name]={available:!result.error&&result.status===0,version:result.error?result.error.message:(result.stdout||result.stderr).trim().split('\n')[0]};
}
const root=path.resolve(path.dirname(require.resolve('node-pty')),'..');
let helpers=0;
for(const sub of [`prebuilds/${process.platform}-${process.arch}/spawn-helper`,'build/Release/spawn-helper']){
  try{await stat(path.join(root,sub));await access(path.join(root,sub),constants.X_OK);helpers++;}
  catch(e){if(e.code!=='ENOENT')throw e;}
}
report.pty_helper_available=helpers>0;
report.limits={...config.exec,request_cache_ttl_ms:config.request_cache_ttl_ms,history:{...config.history}};
if(config.transport==='http'&&!values.offline){
  const base=`http://${config.host.includes(':')?'['+config.host+']':config.host}:${config.port}`;
  report.runtime=await probe(base+config.health_path,'mcp');
  const managed=await current(launch.state_dir);
  report.supervisor=managed.mcp_url===base+config.mcp_path?managed:{managed:false,state:managed.state,reason:'No selected supervisor owns the target MCP URL.'};
  if(report.runtime.ok){
    let client,timer;
    const controller=new AbortController();
    try{
      const {Client,StreamableHTTPClientTransport}=await import('@modelcontextprotocol/client');
      client=new Client({name:'mcp-dev-runtime-doctor',version:'1.0.0'});
      const transport=new StreamableHTTPClientTransport(new URL(base+config.mcp_path),{
        fetch:(url,init={})=>fetch(url,{...init,signal:AbortSignal.any([controller.signal,...(init.signal?[init.signal]:[])])})});
      timer=setTimeout(()=>controller.abort(new Error('MCP discovery timed out')),3000);
      await client.connect(transport);
      const listed=(await client.listTools()).tools;
      const expected=JSON.parse(await readFile(new URL('../contracts/tools.json',import.meta.url),'utf8')).tools;
      const ok=listed.length===expected.length&&expected.every(t=>listed.some(x=>x.name===t.name&&isDeepStrictEqual(x.inputSchema,t.inputSchema)&&isDeepStrictEqual(x.outputSchema,t.outputSchema)));
      report.protocol={ok,tools:listed.map(t=>t.name),schemas_match:ok,commands_executed:0};
    }catch(e){report.protocol={ok:false,reason:e.message};}
    finally{clearTimeout(timer);controller.abort();await client?.close().catch(()=>{});}
  }
  report.ok=report.runtime.ok&&report.protocol?.ok===true&&(!report.supervisor.managed||report.supervisor.health?.availability==='ready');
  if(report.runtime.details?.history?.state==='degraded')report.ok=false;
}else{
  report.ok=true;report.runtime={checked:false,reason:values.offline?'offline configuration check':'stdio transport is not started by doctor'};
}
if(values.json)console.log(JSON.stringify(report,null,2));
else{
  console.log(`MCP Dev Runtime doctor: ${report.ok?'PASS':'ATTENTION REQUIRED'}`);
  console.log(JSON.stringify(report,null,2));
}
if(!report.ok)process.exitCode=1;
