import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { fromJsonSchema } from '@modelcontextprotocol/server';
const expectedTools=JSON.parse(await fs.readFile(new URL('../contracts/tools.json',import.meta.url),'utf8')).tools;
const outputChecks=new Map(expectedTools.map(t=>[t.name,fromJsonSchema(t.outputSchema)]));
async function validateOutput(name,result){
  assert(result.structuredContent!==undefined,`${name}: missing structuredContent`);
  const checked=await outputChecks.get(name)['~standard'].validate(result.structuredContent);
  assert(!checked.issues,`${name}: ${JSON.stringify(checked.issues)}`);
  if(['exec_command','write_stdin'].includes(name)&&Object.hasOwn(result.structuredContent,'session_id')) {
    const text=result.content?.find(x=>x.type==='text')?.text;
    assert.equal(typeof text,'string',`${name}: missing legacy text envelope`);
    const at=text.indexOf('\n');assert(at>=0,`${name}: missing output separator`);
    const {output,...metadata}=result.structuredContent;
    assert.equal(output,text.slice(at+1),`${name}: output channels differ`);
    assert.equal(Buffer.byteLength(output),metadata.next_output_cursor-metadata.output_start,`${name}: output byte length differs from cursor range`);
    assert.deepEqual(JSON.parse(text.slice(0,at)),metadata,`${name}: metadata channels differ`);
  }
  return result;
}
const url = process.argv[2] ?? 'http://127.0.0.1:3001/mcp';
const report = {started_at:new Date().toISOString(),transport_url:url,scope:'deployed MCP endpoint; not ChatGPT UI',checks:[]};
const dir = await fs.mkdtemp(path.join(os.tmpdir(),'local-dev-mcp-live-'));
const owned = new Set(); let client;
function unpack(r) {
  const text=r.content?.find(x=>x.type==='text')?.text ?? '';
  const i=text.indexOf('\n');
  return {...(r.structuredContent ?? JSON.parse(i<0?text:text.slice(0,i))),output:r.structuredContent?.output ?? (i<0?'':text.slice(i+1)),isError:!!r.isError};
}
async function connect() {
  client=new Client({name:'local-dev-deployed-verification',version:'0.1.0'});
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
}
async function call(name,args={}) {return unpack(await validateOutput(name,await client.callTool({name,arguments:args})));}
async function exec(cmd,extra={}) {
  const r=await call('exec_command',{cmd,workdir:dir,...extra});
  if(r.session_id) owned.add(r.session_id); assert(!r.isError,JSON.stringify(r));return r;
}
async function drain(r) {
  let output=r.output; const until=Date.now()+15000;
  while(['running','terminating'].includes(r.state)||r.has_more){assert(Date.now()<until,'Execution deadline exceeded');r=await call('write_stdin',{session_id:r.session_id,yield_time_ms:1000});assert(!r.isError);output+=r.output;}
  return {...r,output};
}
function pass(name,details={}){report.checks.push({name,status:'passed',...details});console.log('PASS:',name);}
try {
  await connect();
  const listed=(await client.listTools()).tools;
  const contract=JSON.parse(await fs.readFile(new URL('../contracts/tools.json',import.meta.url),'utf8')).tools;
  assert.deepEqual(listed.map(x=>x.name).sort(),contract.map(x=>x.name).sort());
  for(const t of contract) {const actual=listed.find(x=>x.name===t.name);assert.deepEqual(actual.inputSchema,t.inputSchema);assert.deepEqual(actual.outputSchema,t.outputSchema);}
  report.output_schemas_validated=true;
  pass('six input/output tool schemas', {tools:listed.map(x=>x.name)});
  const first=await drain(await exec("printf 'live-command-ok'; printf '\nstderr-ok' >&2"));
  assert.equal(first.exit_code,0);assert(first.output.includes('live-command-ok')&&first.output.includes('stderr-ok'));
  report.instance_id=first.instance_id;pass('exec_command stdout/stderr and exit', {exit_code:first.exit_code});
  const structuredRaw=await validateOutput('exec_command',await client.callTool({name:'exec_command',arguments:{cmd:"printf 'structured-only-ok'",workdir:dir,yield_time_ms:1000}}));
  owned.add(structuredRaw.structuredContent.session_id);
  const structuredOnly=unpack({structuredContent:JSON.parse(JSON.stringify(structuredRaw.structuredContent)),isError:structuredRaw.isError});
  assert.equal(structuredOnly.exit_code,0);assert.equal(structuredOnly.output,'structured-only-ok');
  pass('structured-only adapter retains command output');
  const failed=await drain(await exec('exit 7'));assert.equal(failed.exit_code,7);assert.equal(failed.isError,false);pass('nonzero exit semantics');
  const label='live-history-'+path.basename(dir);
  const history=await drain(await exec("printf 'history-first\n历史 error line\nhistory-last\n'",{label,capture_output:true}));
  assert(history.archive_id,'The selected deployment must enable metadata history for this verification.');
  const current=await call('list_exec_sessions',{scope:'current',workdir:dir,label,outcome:'success',order:'desc'});
  assert.equal(current.sessions.length,1);assert.equal(current.sessions[0].session_id,history.session_id);
  pass('current execution filters and task labels');
  const tail=await call('write_stdin',{session_id:history.session_id,tail_lines:1});
  assert.equal(tail.output,'history-last\n');assert.equal(tail.tail_truncated,false);
  const search=await call('write_stdin',{session_id:history.session_id,search:'历史',max_matches:10});
  assert.equal(search.matches.length,1);assert.equal(search.output,'');
  const next=await call('write_stdin',{session_id:history.session_id,yield_time_ms:0});
  assert.equal(next.output,'');assert.equal(next.output_start,history.next_output_cursor);
  pass('tail and literal search preserve the default output cursor');
  const archive=await call('list_exec_sessions',{scope:'history',workdir:dir,label,outcome:'success'});
  assert.equal(archive.sessions.length,1);assert.equal(archive.sessions[0].archive_id,history.archive_id);
  assert.equal(archive.history_status.state,'ready');
  pass('bounded disk execution-history listing');
  const saved=await call('write_stdin',{session_id:history.session_id,archive_id:history.archive_id,output_cursor:0});
  assert.equal(saved.output,history.output);assert.equal(saved.source,'history');assert.equal(saved.archive_truncated,false);
  const savedTail=await call('write_stdin',{session_id:history.session_id,archive_id:history.archive_id,tail_lines:1});
  assert.equal(savedTail.output,'history-last\n');
  const savedSearch=await call('write_stdin',{session_id:history.session_id,archive_id:history.archive_id,search:'历史'});
  assert.equal(savedSearch.matches.length,1);
  pass('archived UTF-8 output, tail and search');
  const denied=await call('write_stdin',{session_id:history.session_id,archive_id:history.archive_id,chars:'not-sent'});
  assert.equal(denied.isError,true);assert.equal(denied.error.code,'ARCHIVED_SESSION_READ_ONLY');
  pass('archived execution rejects terminal input');
  const patch='*** Begin Patch\n*** Add File: calc.cjs\n+exports.multiply = (a,b) => a*b;\n*** Add File: calc.test.cjs\n+const assert=require("node:assert/strict");\n+const {multiply}=require("./calc.cjs");\n+assert.equal(multiply(3,4),12);\n+assert.equal(multiply(-3,4),-12);\n+assert.equal(multiply(0,4),0);\n*** End Patch\n';
  const args={patch,workdir:dir,request_id:'live-patch-'+path.basename(dir)};
  const applied=await call('apply_patch',args);assert(applied.applied&&!applied.isError);
  assert.deepEqual(await call('apply_patch',args),applied);pass('apply_patch multi-file and retry');
  const quotedNode = "'" + process.execPath.replaceAll("'", "'\\''") + "'";
  const tested=await drain(await exec(quotedNode+' --test --test-reporter=tap calc.test.cjs'));
  assert.equal(tested.exit_code,0);assert(tested.output.includes('# pass'));pass('real generated code tests',{exit_code:tested.exit_code});
  const mv=await call('apply_patch',{workdir:dir,patch:'*** Begin Patch\n*** Update File: calc.cjs\n*** Move to: renamed.cjs\n@@\n-exports.multiply = (a,b) => a*b;\n+exports.multiply = (a,b) => b*a;\n*** Delete File: calc.test.cjs\n*** End Patch\n'});
  assert(mv.applied&&!mv.isError);assert((await fs.readFile(path.join(dir,'renamed.cjs'),'utf8')).includes('b*a'));pass('patch update, move and delete');
  const long=await exec("sleep 0.4; printf 'cross-connection-ok'",{yield_time_ms:0});
  await client.close();await connect();const continued=await drain({...long,output:''});
  assert.equal(continued.exit_code,0);assert.equal(continued.output,'cross-connection-ok');pass('write_stdin across fresh HTTP connection');
  const pty=await exec('printf "pty-ready\\n"; IFS= read -r line; printf "pty:%s\\n" "$line"',{tty:true,yield_time_ms:1000});
  const input=await call('write_stdin',{session_id:pty.session_id,chars:'verified-input\n',yield_time_ms:1000});
  const ptyEnd=await drain(input);assert.equal(ptyEnd.exit_code,0);assert(ptyEnd.output.includes('pty:verified-input'));pass('PTY interactive input');
  for(const format of ['png','jpeg','webp']) {
    const file=path.join(dir,'fixture.'+format);
    await sharp({create:{width:31,height:23,channels:3,background:'#315a9a'}}).toFormat(format).toFile(file);
    const r=await validateOutput('view_image',await client.callTool({name:'view_image',arguments:{path:file}}));
    assert.equal(r.isError,false);const image=r.content.find(x=>x.type==='image');assert(image);
    const decoded=await sharp(Buffer.from(image.data,'base64')).metadata();assert.equal(decoded.width,31);assert.equal(decoded.height,23);
    pass('view_image '+format,{mime_type:image.mimeType,decoded_width:decoded.width,decoded_height:decoded.height});
  }
  const sleeping=await exec('sleep 30',{yield_time_ms:0});
  const sessions=await call('list_exec_sessions',{state:'running'});
  assert(sessions.sessions.some(x=>x.session_id===sleeping.session_id));pass('list_exec_sessions active process');
  const terminated=await call('terminate_exec_session',{session_id:sleeping.session_id});
  assert(terminated.termination_confirmed);assert.equal(terminated.state,'terminated');pass('terminate_exec_session confirmed exit');
  const bad=await call('apply_patch',{patch:'not a patch',workdir:dir});assert(bad.isError);pass('invalid patch reported as tool error');
  report.status='passed';
} catch(e) {
  report.status='failed';report.error=e instanceof Error?e.message:String(e);process.exitCode=1;
  console.error('VERIFICATION FAILED:',report.error);
} finally {
  if(client) {
    for(const session_id of owned) {try{await call('terminate_exec_session',{session_id});}catch{}}
    await client.close();
  }
  await fs.rm(dir,{recursive:true,force:true});
  report.finished_at=new Date().toISOString();
  const reportDir=process.env.MDR_VERIFICATION_REPORT_DIR??new URL('../reports/',import.meta.url);
  await fs.mkdir(reportDir,{recursive:true});
  const reportFile=typeof reportDir==='string'?path.join(reportDir,'deployed-verification.json'):new URL('deployed-verification.json',reportDir);
  await fs.writeFile(reportFile,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({status:report.status,checks:report.checks.length,instance_id:report.instance_id,report:'reports/deployed-verification.json'}));
}
