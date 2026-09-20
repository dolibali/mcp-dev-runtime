import {spawn} from 'node:child_process';
import {mkdtemp,realpath,rm,mkdir,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {performance,monitorEventLoopDelay} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {loadConfig} from '../../dist/config.js';
import {Runtime} from '../../dist/runtime/runtime.js';
import {startHttp} from '../../dist/mcp/http.js';
const cwd=await realpath(await mkdtemp(path.join(os.tmpdir(),'local-dev-mcp-bench-')));
const config=await loadConfig(undefined,{cwd,shell:'/bin/bash',port:0,log_level:'silent'});
const runtime=new Runtime(config),server=await startHttp(runtime);
const client=new Client({name:'local-dev-mcp-benchmark',version:'0.1.0'});
const samples={};let wireBytes=0,compatibilityMirrorBytes=0;
function unpack(result){
  wireBytes+=Buffer.byteLength(JSON.stringify(result));
  assert.equal(result.isError,false,JSON.stringify(result));
  const text=result.content[0].text,at=text.indexOf('\n'),legacyOutput=at<0?'':text.slice(at+1);
  assert.equal(result.structuredContent.output,legacyOutput,'Output channels must carry the same chunk');
  compatibilityMirrorBytes+=Buffer.byteLength(legacyOutput);
  return {...result.structuredContent};
}
const call=async(name,arguments_)=>unpack(await client.callTool({name,arguments:arguments_}));
async function drain(r){let output=r.output;let polls=0;const deadline=Date.now()+15000;
  while(r.state==='running'||r.state==='terminating'||r.has_more){assert(Date.now()<deadline);r=await call('write_stdin',{session_id:r.session_id,yield_time_ms:1000,max_output_tokens:4000});output+=r.output;polls++;}
  assert.equal(r.exit_code,0);return {...r,output,polls};
}
async function direct(){await new Promise((resolve,reject)=>{const p=spawn('/bin/bash',['-c','printf benchmark'],{cwd,stdio:['ignore','pipe','pipe']});let text='';p.stdout.on('data',b=>text+=b);p.stderr.resume();p.on('error',reject);p.on('close',code=>{try{assert.equal(code,0);assert.equal(text,'benchmark');resolve();}catch(e){reject(e);}});});}
const summary=values=>{const a=[...values].sort((x,y)=>x-y);return {samples_ms:values,p50_ms:a[Math.floor((a.length-1)*.50)],p95_ms:a[Math.ceil((a.length-1)*.95)],min_ms:a[0],max_ms:a.at(-1)};};
try{
  await client.connect(new StreamableHTTPClientTransport(new URL(server.url)));
  const actions={direct_shell:direct,runtime:async()=>{const r=await runtime.exec.exec({cmd:'printf benchmark'});assert.equal(r.exit_code,0);},mcp_http:async()=>{const r=await call('exec_command',{cmd:'printf benchmark'});assert.equal(r.exit_code,0);}};
  for(const action of Object.values(actions))for(let i=0;i<5;i++)await action();
  for(const name of Object.keys(actions))samples[name]=[];
  // Interleave the layers so one layer does not always receive a colder machine.
  for(let i=0;i<30;i++)for(const [name,action] of Object.entries(actions)){const t=performance.now();await action();samples[name].push(performance.now()-t);}
  const concurrency=[];
  for(const parallel of [1,4,8]){
    const health=[];const loop=monitorEventLoopDelay({resolution:5});loop.enable();
    const cpu0=process.cpuUsage(),start=performance.now(),rss0=process.memoryUsage().rss;let peakRss=rss0;
    let sampling=true;
    const sampler=(async()=>{while(sampling){const t=performance.now();const r=await fetch(server.url.replace('/mcp','/healthz'));await r.arrayBuffer();assert.equal(r.status,200);health.push(performance.now()-t);peakRss=Math.max(peakRss,process.memoryUsage().rss);await new Promise(r=>setTimeout(r,10));}})();
    try {await Promise.all(Array.from({length:parallel},async()=>{for(let i=0;i<6;i++){const r=await call('exec_command',{cmd:'sleep 0.06; printf done',yield_time_ms:1000});assert.equal(r.exit_code,0);}}));}
    finally{sampling=false;await sampler;loop.disable();}
    const cpu=process.cpuUsage(cpu0);concurrency.push({parallel,commands:parallel*6,wall_ms:performance.now()-start,health:summary(health),event_loop_p95_ms:loop.percentile(95)/1e6,event_loop_max_ms:loop.max/1e6,cpu_user_ms:cpu.user/1000,cpu_system_ms:cpu.system/1000,rss_before_bytes:rss0,rss_peak_bytes:peakRss,rss_after_bytes:process.memoryUsage().rss});
  }
  const before=wireBytes,mirroredBefore=compatibilityMirrorBytes;const cmd=JSON.stringify(process.execPath)+` -e "process.stdout.write('x'.repeat(200000))"`;
  const result=await drain(await call('exec_command',{cmd,max_output_tokens:4000}));assert.equal(result.output,'x'.repeat(200000));
  const empty=await call('write_stdin',{session_id:result.session_id,yield_time_ms:0});assert.equal(empty.output,'');
  const report={recorded_at:new Date().toISOString(),environment:{platform:process.platform,arch:process.arch,os_release:os.release(),node:process.version,cpu_model:os.cpus()[0]?.model,logical_cpus:os.cpus().length},method:{warmups_per_layer:5,measured_samples_per_layer:30,command:'printf benchmark',shell:'/bin/bash',transport:'loopback HTTP',model_calls:0,tunnel_included:false,codex_comparison:false,cpu_scope:'Current Node process (runtime and local SDK client), not aggregate child-process CPU',token_budget:'Approximate 4 UTF-8 bytes per output-token unit; metadata is additional'},latency:Object.fromEntries(Object.entries(samples).map(([k,v])=>[k,summary(v)])),concurrency,output:{unique_bytes:Buffer.byteLength(result.output),duplicate_bytes:0,missing_bytes:0,calls:result.polls+2,mcp_result_json_bytes:wireBytes-before,empty_followup_bytes:Buffer.byteLength(empty.output)},limitations:['One machine and one run; no ChatGPT inference time or Tunnel WAN latency.','No direct Codex binary benchmark was run.','These are measurements, not a guaranteed latency or throughput SLA.']};
  report.output.compatibility_mirror_bytes=compatibilityMirrorBytes-mirroredBefore;
  report.output.duplicate_bytes_scope='Repeated bytes across consumed output chunks; excludes intentional content/structuredContent mirroring.';
  report.method.token_budget+=' Full result serialization also includes JSON escaping and the compatibility output copy.';
  await mkdir('reports',{recursive:true});await writeFile('reports/benchmark.json',JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({latency:Object.fromEntries(Object.entries(report.latency).map(([k,v])=>[k,{p50_ms:v.p50_ms,p95_ms:v.p95_ms}])),concurrency:concurrency.map(x=>({parallel:x.parallel,health_p95_ms:x.health.p95_ms,event_loop_p95_ms:x.event_loop_p95_ms,rss_peak_bytes:x.rss_peak_bytes})),output:report.output},null,2));
}finally{await client.close();const closed=await server.close();assert.deepEqual(closed.remaining,[]);await rm(cwd,{recursive:true,force:true});}
