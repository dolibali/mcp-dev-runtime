import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stopManaged } from '../../dist/launcher/supervisor.js';
import { defaultShell } from '../../dist/platform/shell.js';
const exec = promisify(execFile), cli = path.resolve('dist/launcher/cli.js');
async function port(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}

test('Windows: named-pipe managed start/status/restart/stop without Unix signals or real credentials', {skip:process.platform!=='win32',timeout:65000}, async t=>{
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'mdr-win-lifecycle-')));
  const state=path.join(root,'state'),file=path.join(root,'config.json'),mp=await port();
  t.after(async()=>{await stopManaged(state).catch(()=>{});await fs.rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:200});});
  await fs.writeFile(file,JSON.stringify({schema_version:1,mcp:{port:mp},tunnel:{enabled:false},runtime:{cwd:root,shell:defaultShell(),state_dir:'state',logs_dir:'logs'},history:{directory:path.join(root,'history')},logging:{level:'silent'}}));
  const run=async (...args)=>{const r=await exec(process.execPath,[cli,...args,'--config',file],{windowsHide:true,timeout:30000,maxBuffer:1024*1024});return JSON.parse(r.stdout);};
  const first=await run('start','--bg');assert.equal(first.state,'ready');assert.equal(first.health.tunnel.disabled,true);assert(first.control_socket.startsWith('\\\\.\\pipe\\mdr-'));
  assert.equal((await run('status','--json')).run_id,first.run_id);
  const restarted=await run('restart','--bg');assert.equal(restarted.state,'ready');assert.notEqual(restarted.run_id,first.run_id);
  assert.equal((await run('stop')).state,'stopped');await assert.rejects(fs.stat(path.join(state,'supervisor.json')),{code:'ENOENT'});
});
