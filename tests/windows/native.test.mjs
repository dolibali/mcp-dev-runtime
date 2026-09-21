import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { once } from 'node:events';
import { spawn, execFileSync } from 'node:child_process';
import { WindowsChild, windowsSecurity, windowsHostPath, windowsEnvironment } from '../../dist/platform/windows-host.js';
import { defaultShell, windowsShellArgs } from '../../dist/platform/shell.js';

const win = (name, fn) => test(name, { skip: process.platform !== 'win32', timeout: 25000 }, fn);
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mdr-native-test-')));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 150 })); return root;
}
async function execute(t, root, cmd, tty = false, onOutput) {
  const prepared = await windowsShellArgs(defaultShell(), cmd, false, tty);
  t.after(prepared.cleanup);
  const child = new WindowsChild({ exe: defaultShell(), args: prepared.args, cwd: root, env: windowsEnvironment(process.env), tty });
  let output = '', error;
  child.on('error', e => { error = e; });
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding('utf8'); stream.on('data', x => { output += x; onOutput?.(output, child); });
  }
  const timer = setTimeout(() => child.kill('SIGKILL'), 18000); t.after(() => clearTimeout(timer));
  const closed = new Promise(resolve => child.once('close', (code, signal, fault) => resolve({code,signal,fault})));
  const result = await closed; clearTimeout(timer);
  assert.equal(error, undefined, error?.stack); assert.equal(result.fault, undefined, result.fault);
  return { ...result, output };
}

win('Windows: native helper identity and inherited environment are deterministic', async t => {
  const root = await fixture(t);
  assert.match(execFileSync(windowsHostPath(), ['--version'], { encoding: 'utf8', windowsHide: true }), /protocol=1/);
  assert.deepEqual(windowsEnvironment({Path:'a',TOKEN:'old'}, {PATH:'b',token:'new'}), {PATH:'b',TOKEN:'new'});
  const r = await execute(t, root, "Write-Output '中文🙂'; [Console]::Error.WriteLine('错误🙂'); exit 7");
  assert.equal(r.code,7); assert.equal(r.signal,null); assert(r.output.includes('中文🙂')); assert(r.output.includes('错误🙂')); assert(!r.output.includes('#< CLIXML'));
});
win('Windows: exact native failures and successful recovery are not flattened to 0/1', async t => {
  const root=await fixture(t);
  assert.equal((await execute(t,root,'cmd.exe /d /c exit 7')).code,7);
  assert.equal((await execute(t,root,"cmd.exe /d /c exit 7; Write-Output 'recovered'")).code,0);
  assert.notEqual((await execute(t,root,"throw 'expected failure'")).code,0);
});
win('Windows: ConPTY output and Read-Host Unicode input are real terminal operations', async t => {
  const root=await fixture(t); let sent=false;
  const r=await execute(t,root,"Write-Output 'INPUT_READY'; $v=Read-Host; Write-Output ('VALUE:'+$v); exit 0",true,(text,child)=>{
    if(!sent&&text.includes('INPUT_READY')){sent=true;setTimeout(()=>child.write('hello-中文\r'),150);}
  });
  assert.equal(r.code,0);assert(r.output.includes('VALUE:hello-中文'),r.output);
});
win('Windows: forced ConPTY cancellation completes and does not accept POSIX signal semantics', async t => {
  const root=await fixture(t);let stopped=false;
  const r=await execute(t,root,"Write-Output 'CANCEL_READY'; Start-Sleep 20",true,(text,child)=>{
    if(!stopped&&text.includes('CANCEL_READY')){stopped=true;child.kill('SIGKILL');}
  });
  assert.notEqual(r.code,0);assert.equal(r.signal,null);
});
win('Windows: native Job owns detached descendants when the adapter is terminated', async t => {
  const root=await fixture(t), marker=path.join(root,'pid.txt'), script=path.join(root,'tree.cjs');
  await fs.writeFile(script,"const cp=require('child_process');const c=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});c.unref();require('fs').writeFileSync(process.argv[2],String(c.pid));setInterval(()=>{},1000);");
  const child=spawn(windowsHostPath(),['run'],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  child.stdout.resume();child.stderr.resume();
  child.stdin.write(JSON.stringify({type:'start',protocol:1,exe:process.execPath,args:[script,marker],cwd:root,env:windowsEnvironment(process.env)})+'\n');
  let pid; t.after(()=>{child.kill();if(pid){try{process.kill(pid)}catch{}}});
  const until=Date.now()+7000;while(Date.now()<until){try{pid=Number(await fs.readFile(marker,'utf8'));break}catch{}await new Promise(r=>setTimeout(r,30));}
  assert(Number.isSafeInteger(pid));const ended=once(child,'close');child.kill();await ended;
  const deadline=Date.now()+5000;let alive=true;
  while(Date.now()<deadline){try{process.kill(pid,0)}catch{alive=false;break}await new Promise(r=>setTimeout(r,30));}
  assert.equal(alive,false,'detached child survived its owner Job');
});
for(const action of ['EOF','forced termination']) win(`Windows: blocked child input cannot prevent ${action} from terminating its Job`, async t => {
  const root=await fixture(t);
  const host=spawn(windowsHostPath(),['run'],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  host.stderr.resume();host.stdin.on('error',()=>{});
  let pending='',pid;
  const ready=new Promise((resolve,reject)=>{
    host.once('error',reject);
    host.stdout.setEncoding('utf8');host.stdout.on('data',text=>{
      pending+=text;let at;
      while((at=pending.indexOf('\n'))>=0){
        const frame=JSON.parse(pending.slice(0,at));pending=pending.slice(at+1);
        if(frame.type==='ready'){pid=frame.pid;resolve();}
      }
    });
  });
  const closed=once(host,'close');
  try {
    host.stdin.write(JSON.stringify({type:'start',protocol:1,exe:process.execPath,
    args:['-e','setInterval(()=>{},1000)'],cwd:root,env:windowsEnvironment(process.env),stdin:true})+'\n');
    await ready;
    // This child deliberately never reads stdin. Its native pipe fills, but the
    // host must keep reading cancellation / EOF from the separate parent channel.
    host.stdin.write(JSON.stringify({type:'input',data:Buffer.alloc(1024*1024,120).toString('base64')})+'\n');
    if(action==='EOF')host.stdin.end();
    else host.stdin.write(JSON.stringify({type:'terminate',force:true})+'\n');
    let timer;
    const result=await Promise.race([closed,new Promise(resolve=>{timer=setTimeout(()=>resolve(null),4000);})]);
    clearTimeout(timer);
    assert.notEqual(result,null,'blocked input prevented '+action+' cleanup');
    assert.equal(result[0],0,'host did not confirm orderly owned cleanup');
    assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
  } finally {
    // Cleanup must precede fixture deletion, including on assertion failure.
    if(host.exitCode===null&&host.signalCode===null){host.kill();await closed;}
  }
});
win('Windows: long scripts use private temporary files and clean up', async t => {
  const root=await fixture(t),cmd='# '+('a'.repeat(30000))+"\nWrite-Output 'long-script-ok'";
  const prepared=await windowsShellArgs(defaultShell(),cmd,false,false);t.after(prepared.cleanup);
  assert(prepared.args.includes('-File'));assert(!prepared.args.includes('-ExecutionPolicy'));
  const file=prepared.args.at(-1);await windowsSecurity('validate-private',file);
  const r=await execute(t,root,cmd);assert.equal(r.code,0);assert(r.output.includes('long-script-ok'));
  await prepared.cleanup();await assert.rejects(fs.stat(file),{code:'ENOENT'});
});
win('Windows: private DACL creation works without chmod and rejects a junction', async t => {
  const root=await fixture(t),dir=path.join(root,'owned'),alias=path.join(root,'alias');
  await windowsSecurity('private-dir',dir);await fs.writeFile(path.join(dir,'config.json'),'{}');await windowsSecurity('validate-private',path.join(dir,'config.json'));
  await fs.symlink(dir,alias,'junction');await assert.rejects(windowsSecurity('private-dir',alias),/reparse|private|ownership/i);
});
