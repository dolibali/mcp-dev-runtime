import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {fixture} from '../helpers.mjs';
import {assertOutput} from '../output-contract-helper.mjs';

test('history process restart: committed output survives SIGKILL, stale-lock recovery and a new Node process',async t=>{
  const config=await fixture(t,{history:{enabled:true}}),file=path.join(config.cwd,'server.json');
  await fs.writeFile(file,JSON.stringify(config));
  const children=[],clients=[];
  t.after(async()=>{
    for(const c of clients)await c.close().catch(()=>{});
    for(const {child,exited} of children)if(child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await exited;}
  });
  async function launch(){
    const env={...process.env};delete env.NODE_TEST_CONTEXT;
    const child=spawn(process.execPath,[path.resolve('dist/main.js'),'--config',file,'--log-level','info'],{env,stdio:['ignore','pipe','pipe']});
    child.stdout.resume();let buffer='';
    const exited=new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));children.push({child,exited});
    const url=await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('Fixture server did not start: '+buffer.slice(-2000))),5000);
      child.once('error',e=>{clearTimeout(timer);reject(e);});
      child.stderr.setEncoding('utf8');child.stderr.on('data',text=>{
        buffer+=text;let at;
        while((at=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,at);buffer=buffer.slice(at+1);
          try{const event=JSON.parse(line);if(event.event==='started'&&event.url){clearTimeout(timer);resolve(event.url);}}catch{}
        }
      });
      void exited.then(r=>{clearTimeout(timer);reject(new Error('Fixture server exited before ready: '+JSON.stringify(r)));});
    });
    const client=new Client({name:'actual-process-restart',version:'1.0.0'});clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    const call=async(name,args)=>assertOutput(name,await client.callTool({name,arguments:args}));
    return {child,exited,client,call};
  }
  const first=await launch();
  const r=await first.call('exec_command',{cmd:"printf '进程重启后仍可读取\n'",capture_output:true,label:'actual-restart'});
  assert.equal(r.exit_code,0);
  const saved=await first.call('write_stdin',{session_id:r.session_id,archive_id:r.archive_id});assert.equal(saved.output,'进程重启后仍可读取\n');
  await first.client.close();first.child.kill('SIGKILL');assert.equal((await first.exited).signal,'SIGKILL');
  const second=await launch();
  const listing=await second.call('list_exec_sessions',{scope:'history',label:'actual-restart'});assert.equal(listing.sessions.length,1);assert.notEqual(listing.instance_id,r.instance_id);
  const recovered=await second.call('write_stdin',{session_id:r.session_id,archive_id:r.archive_id});
  assert.equal(recovered.output,saved.output);assert.equal(recovered.exit_code,0);assert.equal(recovered.archive_truncated,false);
});
