import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { verifyBundle, inventory, digest } from './bundle-lib.mjs';

if(process.platform!=='win32')throw new Error('Run Windows package acceptance on native Windows.');
const archive=path.resolve(process.argv[2]??'');if(!archive.endsWith('.zip'))throw new Error('Pass a Windows .zip runtime archive.');
const exec=promisify(execFile),temp=await fs.realpath(await fs.mkdtemp(path.join(tmpdir(),'mdr-win-vfy-')));
const home=path.join(temp,'home 中文 &'),local=path.join(home,'Local'),workspace=path.join(home,"work space 中文 & ' % !"),checks=[];
await fs.mkdir(workspace,{recursive:true});
const system=process.env.SystemRoot??'C:\\Windows',tar=path.join(system,'System32','tar.exe'),powershell=path.join(system,'System32','WindowsPowerShell','v1.0','powershell.exe');
const env={...process.env,HOME:home,USERPROFILE:home,LOCALAPPDATA:local,APPDATA:path.join(home,'Roaming'),CODEX_HOME:path.join(home,'.codex'),PATH:path.join(system,'System32')+';'+path.dirname(powershell),NODE_OPTIONS:'',NODE_TEST_CONTEXT:'',TUNNEL_BIN:'',MDR_WINDOWS_HOST:'',CONTROL_PLANE_API_KEY:'',CONTROL_PLANE_TUNNEL_ID:'',OPENAI_API_KEY:''};
for(const key of Object.keys(env))if(key.toLowerCase()==='path'&&key!=='PATH')delete env[key];
const pass=name=>{checks.push(name);console.log('PASS: '+name)};
const run=(exe,args,extra={})=>exec(exe,args,{env,cwd:workspace,windowsHide:true,timeout:60000,maxBuffer:8*1024*1024,...extra});
const runInput=(exe,args,input)=>new Promise((resolve,reject)=>{
  const child=spawn(exe,args,{env,cwd:workspace,windowsHide:true,stdio:['pipe','pipe','pipe']});let stdout='',stderr='';
  const timer=setTimeout(()=>{child.kill();reject(new Error('Uninstall timeout'))},90000);
  child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);child.stdin.on('error',()=>{});
  child.once('error',e=>{clearTimeout(timer);reject(e)});child.once('close',code=>{clearTimeout(timer);if(code===0)resolve({stdout,stderr});else reject(new Error(`Process exited ${code}: ${stderr||stdout}`))});child.stdin.end(input);
});
async function port(){const s=createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
const psQuote=s=>"'"+s.replaceAll("'","''")+"'";
let entry,started=false;
try{
  const listing=(await run(tar,['-tf',archive])).stdout.split(/\r?\n/).filter(Boolean),rootName=path.basename(archive,'.zip');
  for(const name of listing){const normalized=name.replaceAll('\\','/');assert(!normalized.startsWith('/')&&!/^[A-Za-z]:/.test(normalized)&&normalized.split('/').every(p=>p!=='..')&&normalized.split('/')[0]===rootName,'Unsafe zip entry: '+name)}
  await run(tar,['-xf',archive,'-C',temp]);const bundle=path.join(temp,rootName),manifest=await verifyBundle(bundle);
  assert.equal(manifest.platform,'win32');assert.equal(manifest.arch,process.arch);pass('ZIP manifest, file hashes and native platform identity');
  const packageNode=path.join(bundle,'runtime','node.exe');assert.equal((await run(packageNode,['--version'])).stdout.trim(),'v'+manifest.node.version);
  const installer=path.join(bundle,'app','scripts','windows','install.mjs');
  const defaultsBin=path.join(local,'Programs','mcp-dev-runtime','bin');
  const conflict=path.join(workspace,'foreign-commands');await fs.mkdir(conflict);
  await fs.writeFile(path.join(conflict,'mcp-dev-runtime.cmd'),'@exit /b 93\r\n');
  await assert.rejects(run(packageNode,[installer],{env:{...env,PATH:conflict+';'+env.PATH}}),/Existing command on PATH/);
  assert.equal(await fs.readFile(path.join(conflict,'mcp-dev-runtime.cmd'),'utf8'),'@exit /b 93\r\n');
  await assert.rejects(fs.stat(path.join(defaultsBin,'mcp-dev-runtime.exe')),{code:'ENOENT'});
  await assert.rejects(run(packageNode,[installer,'--prefix',path.join(local,'mcp-dev-runtime','nested')]),/must be separate/);
  pass('foreign commands and overlapping install roots fail before publication');
  await run(powershell,['-NoLogo','-NoProfile','-File',path.join(bundle,'install.ps1')]);
  const prefix=path.join(local,'Programs','mcp-dev-runtime','releases'),bin=path.join(local,'Programs','mcp-dev-runtime','bin'),data=path.join(local,'mcp-dev-runtime');entry=path.join(bin,'mdr.exe');
  const installed=path.join(prefix,manifest.version);await verifyBundle(installed);assert((await fs.stat(entry)).isFile());assert((await fs.stat(path.join(data,'uninstall.ps1'))).isFile());pass('offline user install with no system Node/npm/Go/compiler on PATH');
  const paths=JSON.parse((await run(entry,['paths','--json'])).stdout);assert.equal(paths.config_file,path.join(data,'config.json'));assert.equal(paths.state_dir,path.join(data,'state'));assert.equal(paths.logs_dir,path.join(data,'logs'));
  const before=await fs.readFile(paths.config_file,'utf8');await run(packageNode,[installer]);assert.equal(await fs.readFile(paths.config_file,'utf8'),before);pass('idempotent install, unified user directories and configuration preservation');
  const tools=JSON.parse((await run(entry,['tools','--json'])).stdout).tools;assert.equal(tools.filter(t=>t.enabled).length,6);assert.equal(tools.filter(t=>t.stability==='experimental'&&t.enabled).length,0);pass('six stable defaults; Skills remain opt-in');
  const tunnel=JSON.parse((await run(entry,['tunnel-setup'])).stdout);assert(tunnel.version.includes(manifest.tunnel.commit.slice(0,7)));pass('actual bundled Tunnel identity');
  await assert.rejects(run(entry,['start']),/Missing CONTROL_PLANE_API_KEY/);pass('missing Tunnel credentials fail locally before startup');
  const config=JSON.parse(before);config.runtime.cwd=workspace;config.tunnel.enabled=false;config.mcp.port=await port();await fs.writeFile(paths.config_file,JSON.stringify(config,null,2)+'\n');
  const active=JSON.parse((await run(entry,['start','--bg'])).stdout);started=true;assert.equal(active.state,'ready');assert.equal(active.health.tunnel.disabled,true);
  await assert.rejects(run(packageNode,[installer]),/Stop the selected managed instance/);pass('managed native startup and active-upgrade protection');
  assert.match((await run(entry,['smoke'])).stdout,/LOCAL MCP SMOKE PASSED/);assert.equal(JSON.parse((await run(entry,['doctor','--json'])).stdout).ok,true);pass('installed smoke and doctor use only bundled runtime');
  const client=new Client({name:'windows-bundle-verify',version:'1'});await client.connect(new StreamableHTTPClientTransport(new URL(active.mcp_url)));
  try{
    const call=async(name,args)=>{const r=await client.callTool({name,arguments:args});assert.equal(r.isError,false,JSON.stringify(r));return r.structuredContent};
    const discovered=(await client.listTools()).tools;assert.equal(discovered.length,6);
    await call('apply_patch',{workdir:workspace,patch:'*** Begin Patch\n*** Add File: verify.cjs\n+process.stdout.write("exact-中文🙂");process.stderr.write("stderr-marker");process.exitCode=7;\n*** End Patch'});
    let r=await call('exec_command',{cmd:`& ${psQuote(path.join(installed,'runtime','node.exe'))} .\\verify.cjs`,workdir:workspace,capture_output:true,yield_time_ms:0}),output=r.output;
    while(['running','terminating'].includes(r.state)||r.has_more){r=await call('write_stdin',{session_id:r.session_id,yield_time_ms:1000});output+=r.output;}
    assert.equal(r.exit_code,7);assert(output.includes('exact-中文🙂')&&output.includes('stderr-marker'));
    const list=await call('list_exec_sessions',{});assert(list.sessions.some(s=>s.session_id===r.session_id));
    const long=await call('exec_command',{cmd:'Start-Sleep 30',yield_time_ms:0});const stopped=await call('terminate_exec_session',{session_id:long.session_id,force:true});assert(['terminated','terminating'].includes(stopped.state));
    let interactive=await call('exec_command',{cmd:"Write-Output 'READY';$s=Read-Host;Write-Output ('ECHO:'+$s)",tty:true,yield_time_ms:1000}),text=interactive.output;
    const until=Date.now()+10000;while(!text.includes('READY')){assert(Date.now()<until);interactive=await call('write_stdin',{session_id:interactive.session_id,yield_time_ms:1000});text+=interactive.output}
    interactive=await call('write_stdin',{session_id:interactive.session_id,chars:'hello中\r',yield_time_ms:1000});text+=interactive.output;
    while(['running','terminating'].includes(interactive.state)||interactive.has_more){assert(Date.now()<until);interactive=await call('write_stdin',{session_id:interactive.session_id,yield_time_ms:1000});text+=interactive.output}
    assert(text.includes('ECHO:hello中'));assert.equal(interactive.exit_code,0);
    const imageScript=path.join(workspace,'images.cjs');
    await fs.writeFile(imageScript,`const sharp=require(${JSON.stringify(path.join(installed,'app','node_modules','sharp'))});(async()=>{for(const f of ['png','jpeg','webp'])await sharp({create:{width:12,height:8,channels:3,background:{r:12,g:24,b:48}}}).toFormat(f).toFile('one.'+f)})().catch(e=>{console.error(e);process.exitCode=1});`);
    await run(path.join(installed,'runtime','node.exe'),[imageScript]);
    for(const format of ['png','jpeg','webp']){
      const viewed=await client.callTool({name:'view_image',arguments:{path:path.join(workspace,'one.'+format)}});assert.equal(viewed.isError,false,JSON.stringify(viewed));assert(viewed.content.some(b=>b.type==='image'));
    }
  }finally{await client.close()}
  pass('real six-tool HTTP flow, UTF-8/nonzero output, history, ConPTY and images');
  const restarted=JSON.parse((await run(entry,['restart','--bg'])).stdout);assert.equal(restarted.state,'ready');assert.notEqual(restarted.run_id,active.run_id);
  await run(entry,['stop']);started=false;pass('orderly stop/restart flushes owned service state');
  const skillDir=path.join(workspace,'.agents','skills','packaged-skill'),shared=path.join(home,'.agents','skills','shared');await fs.mkdir(path.join(skillDir,'references'),{recursive:true});await fs.mkdir(shared,{recursive:true});
  const main='---\nname: packaged-skill\ndescription: Windows bundle Skill acceptance and references.\n---\nRead references/test.md fully.\n',text='中文🙂 Windows reference\n'.repeat(3000);
  await fs.writeFile(path.join(skillDir,'SKILL.md'),main);await fs.writeFile(path.join(skillDir,'references','test.md'),text);await fs.writeFile(path.join(shared,'KEEP'),'user-owned');
  config.tools.allow.push('discover_skills','read_skill');config.history.enabled=false;const skillConfig=path.join(temp,'skills.json');await fs.writeFile(skillConfig,JSON.stringify(config));
  const skills=new Client({name:'windows-package-skills',version:'1'});
  try{
    await skills.connect(new StdioClientTransport({command:entry,args:['serve','--transport','stdio','--config',skillConfig],env,stderr:'pipe'}));assert.equal((await skills.listTools()).tools.length,8);
    const found=await skills.callTool({name:'discover_skills',arguments:{workdir:workspace,query:'packaged-skill'}});assert.equal(found.isError,false);const id=found.structuredContent.skills[0].id;
    const loaded=await skills.callTool({name:'read_skill',arguments:{workdir:workspace,skill:id}});assert.equal(loaded.structuredContent.contents,main);
    let joined='',cursor;do{const r=await skills.callTool({name:'read_skill',arguments:{workdir:workspace,skill:id,resource:'references/test.md',...(cursor?{cursor}:{})}});assert.equal(r.isError,false);joined+=r.structuredContent.contents;cursor=r.structuredContent.next_cursor;}while(cursor);assert.equal(joined,text);
  }finally{await skills.close()}
  pass('actual bundled YAML/Skill discovery, UTF-8 paging and stdio');
  const original=await fs.readFile(path.join(prefix,'current.json'),'utf8'),preservedConfig=await fs.readFile(paths.config_file,'utf8'),synthetic='0.0.0-test';
  const previous=path.join(prefix,synthetic);await fs.cp(bundle,previous,{recursive:true});
  await fs.writeFile(path.join(prefix,'current.json'),JSON.stringify({project:'mcp-dev-runtime',version:synthetic}));assert.match((await run(entry,['--version'])).stdout,new RegExp(manifest.version.replaceAll('.','\\.')));
  const switched=JSON.parse((await run(entry,['paths','--json'])).stdout);assert.equal(path.resolve(switched.package_root),path.join(previous,'app'));
  await fs.writeFile(path.join(prefix,'current.json'),original);assert.equal(await fs.readFile(paths.config_file,'utf8'),preservedConfig);
  pass('native command version-pointer rollback without junctions or overwritten executables');
  const foreignShort=path.join(conflict,'mdr.cmd');await fs.writeFile(foreignShort,'@exit /b 94\r\n');
  await fs.unlink(path.join(conflict,'mcp-dev-runtime.cmd'));
  assert.match((await run(packageNode,[installer],{env:{...env,PATH:conflict+';'+env.PATH}})).stdout,/Skipped short command/);
  assert.equal(await fs.readFile(foreignShort,'utf8'),'@exit /b 94\r\n');
  pass('short-command conflict preserves foreign entry and long command');
  const stable=path.join(data,'uninstall.ps1');const cancelled=await runInput(powershell,['-NoLogo','-NoProfile','-File',stable],'n\r\n');assert.match(cancelled.stdout,/cancelled/);assert((await fs.stat(entry)).isFile());
  assert.match((await runInput(powershell,['-NoLogo','-NoProfile','-File',stable],'')).stdout,/cancelled/);
  const removed=await runInput(powershell,['-NoLogo','-NoProfile','-File',stable],'y\r\n');assert.match(removed.stdout,/completely uninstalled/);
  for(const gone of [prefix,data,entry])await assert.rejects(fs.stat(gone),{code:'ENOENT'});assert.equal(await fs.readFile(path.join(shared,'KEEP'),'utf8'),'user-owned');await verifyBundle(bundle);pass('staged-runtime full uninstall, explicit cancellation and shared Skill/download preservation');
  const report={status:'passed',platform:process.platform,arch:process.arch,version:manifest.version,source_commit:manifest.source_commit,archive_sha256:await digest(archive),checks,scope:'Native Windows local package checks. No real Tunnel credentials or hosted-model behavior used.'};
  await fs.writeFile(archive.replace(/\.zip$/,'.verification.json'),JSON.stringify(report,null,2)+'\n');console.log('WINDOWS_BUNDLE_VERIFICATION_PASS '+checks.length+' groups');
}finally{
  if(started&&entry)await run(entry,['stop']).catch(()=>{});
  await fs.rm(temp,{recursive:true,force:true,maxRetries:8,retryDelay:250});
}
