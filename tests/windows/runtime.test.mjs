import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { loadConfig } from '../../dist/config.js';
import { Runtime } from '../../dist/runtime/runtime.js';
import { startHttp } from '../../dist/mcp/http.js';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { defaultToolAllowlist } from '../../dist/mcp/tool-registry.js';
import { defaultShell } from '../../dist/platform/shell.js';

const win=(name,fn)=>test(name,{skip:process.platform!=='win32',timeout:45000},fn);
async function fixture(t,extra={}){
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'mdr-win-runtime-')));
  const config=await loadConfig(undefined,{cwd:root,shell:defaultShell(),port:0,log_level:'silent',history:{enabled:false},...extra});
  const runtime=new Runtime(config);
  t.after(async()=>{await runtime.close();await fs.rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:200});});return {root,runtime,config};
}
async function finish(runtime,r){let result=r.structuredContent;while(['running','terminating'].includes(result.state)){r=await runtime.invoke('write_stdin',{session_id:result.session_id,chars:'',yield_time_ms:1000});assert.equal(r.isError,false);result=r.structuredContent;}return result;}

win('Windows: HTTP execution, schema discovery, patch and actual Node tests',async t=>{
  const {root,runtime}=await fixture(t);const server=await startHttp(runtime);t.after(()=>server.close());
  const client=new Client({name:'windows-acceptance',version:'1'});t.after(()=>client.close());await client.connect(new StreamableHTTPClientTransport(new URL(server.url)));
  assert.deepEqual((await client.listTools()).tools.map(t=>t.name).sort(),[...defaultToolAllowlist].sort());
  const patch=await client.callTool({name:'apply_patch',arguments:{workdir:root,patch:'*** Begin Patch\n*** Add File: sum.cjs\n+module.exports=(a,b)=>a+b;\n*** End Patch'}});
  assert.equal(patch.isError,false,JSON.stringify(patch));
  // Windows PowerShell 5.1 has legacy native-argument quoting; use an actual
  // script instead of assuming Node -e receives nested double quotes unchanged.
  await fs.writeFile(path.join(root,'verify.cjs'),'if(require("./sum.cjs")(2,3)!==5)process.exit(1);console.log("windows-tool-test-ok");\n');
  const cmd="& '"+process.execPath.replaceAll("'","''")+"' .\\verify.cjs";
  const r=await client.callTool({name:'exec_command',arguments:{workdir:root,cmd,yield_time_ms:1000}});const done=await finish(runtime,r);assert.equal(done.exit_code,0,JSON.stringify(done));assert.equal(done.state,'exited');
  const all=await runtime.invoke('write_stdin',{session_id:done.session_id,output_cursor:0});assert(all.structuredContent.output.includes('windows-tool-test-ok'));
});
win('Windows: output chunks, nonzero exit, history and two Skill tools remain accurate',async t=>{
  const {root,runtime}=await fixture(t,{history:{enabled:true,record_output:true},tools:{allow:[...defaultToolAllowlist,'discover_skills','read_skill']}});
  await runtime.exec.history.ready;assert.equal(runtime.exec.history.status.state,'ready',JSON.stringify(runtime.exec.history.status));
  const source=path.join(root,'.agents','skills','windows-fixture');await fs.mkdir(path.join(source,'references'),{recursive:true});
  await fs.writeFile(path.join(source,'SKILL.md'),'---\nname: windows-fixture\ndescription: Windows-only fixture discovery and Unicode document reading\n---\nRead the referenced guide.\n');
  const text='中文🙂 reference\n'.repeat(3000);await fs.writeFile(path.join(source,'references','guide.md'),text);
  const found=await runtime.invoke('discover_skills',{workdir:root,query:'windows-fixture',refresh:true});assert.equal(found.isError,false);const id=found.structuredContent.skills.find(s=>s.name==='windows-fixture').id;
  let cursor,joined='';do{const r=await runtime.invoke('read_skill',{workdir:root,skill:id,resource:'references/guide.md',...(cursor?{cursor}:{})});assert.equal(r.isError,false,JSON.stringify(r));joined+=r.structuredContent.contents;cursor=r.structuredContent.next_cursor;}while(cursor);assert.equal(joined,text);
  const r=await runtime.invoke('exec_command',{workdir:root,cmd:"Write-Output 'history-中文🙂'; exit 7",capture_output:true});const done=await finish(runtime,r);assert.equal(done.exit_code,7);
  const log=await runtime.invoke('write_stdin',{session_id:done.session_id,output_cursor:0});assert(log.structuredContent.output.includes('history-中文🙂'));
  const sessions=await runtime.invoke('list_exec_sessions',{});assert(sessions.structuredContent.sessions.some(s=>s.session_id===done.session_id));
});
win('Windows: real PNG JPEG WebP reads use bundled native dependencies',async t=>{
  const {root,runtime}=await fixture(t);const sharp=(await import('sharp')).default;
  for(const format of ['png','jpeg','webp']){
    const file=path.join(root,'image.'+format);await sharp({create:{width:32,height:24,channels:3,background:{r:12,g:32,b:64}}}).toFormat(format).toFile(file);
    const r=await runtime.invoke('view_image',{path:file});assert.equal(r.isError,false,JSON.stringify(r));assert(r.content.some(c=>c.type==='image'));
  }
});
win('Windows: execution cancellation waits for actual exit and prevents orphan shells',async t=>{
  const {root,runtime}=await fixture(t);const r=await runtime.invoke('exec_command',{workdir:root,cmd:'Start-Sleep 30',yield_time_ms:0});assert.equal(r.isError,false);
  const stop=await runtime.invoke('terminate_exec_session',{session_id:r.structuredContent.session_id,force:true});assert.equal(stop.isError,false,JSON.stringify(stop));
  const done=await finish(runtime,{structuredContent:stop.structuredContent});assert.equal(done.state,'terminated');assert.equal(done.signal,null);
});
