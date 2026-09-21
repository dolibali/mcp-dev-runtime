import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {windowsHostPath} from '../../dist/platform/windows-host.js';
const exec=promisify(execFile);
const win=(name,fn)=>test(name,{skip:process.platform!=='win32',timeout:45000},fn);
async function setup(t){
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'mdr-source-install-'));
  const root=path.join(temp,'source 中文'),home=path.join(temp,'home'),bin=path.join(temp,'commands');
  t.after(()=>fs.rm(temp,{recursive:true,force:true,maxRetries:8,retryDelay:200}));
  await fs.mkdir(path.join(root,'scripts','windows'),{recursive:true});
  await fs.mkdir(path.join(root,'.runtime','bin'),{recursive:true});
  await fs.mkdir(path.join(root,'dist','launcher'),{recursive:true});
  await fs.mkdir(path.join(root,'.git'));await fs.mkdir(home);
  for(const file of ['source.mjs','common.mjs','uninstall.mjs'])await fs.copyFile(path.resolve('scripts/windows',file),path.join(root,'scripts','windows',file));
  await fs.copyFile(path.resolve('uninstall.ps1'),path.join(root,'uninstall.ps1'));
  await fs.copyFile(windowsHostPath(),path.join(root,'.runtime','bin','mdr-windows-host.exe'));
  await fs.writeFile(path.join(root,'package.json'),JSON.stringify({name:'mcp-dev-runtime',type:'module'}));
  await fs.writeFile(path.join(root,'dist','launcher','cli.js'),'console.log(JSON.stringify(process.argv.slice(2)));\n');
  await fs.writeFile(path.join(root,'user-work.txt'),'keep source work');
  // Unlike the self-contained binary package, a source checkout requires Node.
  const env={...process.env,USERPROFILE:home,HOME:home,LOCALAPPDATA:path.join(home,'Local'),APPDATA:path.join(home,'Roaming'),PATH:path.dirname(process.execPath)+';'+path.join(process.env.SystemRoot,'System32'),NODE_OPTIONS:'',MDR_WINDOWS_HOST:''};
  for(const key of Object.keys(env))if(key.toLowerCase()==='path'&&key!=='PATH')delete env[key];
  const run=(args)=>exec(process.execPath,[path.join(root,'scripts','windows','source.mjs'),'--commands-only','--bin-dir',bin,...args],{env,windowsHide:true,timeout:20000});
  return {root,home,bin,env,run};
}
win('Windows source: command registration and targeted removal preserve the other alias',async t=>{
  const f=await setup(t);
  await f.run([]);await f.run(['--name','mdr']);
  const argument="quote' \" 中文 & % !";
  const r=await exec(path.join(f.bin,'mdr.exe'),[argument],{env:f.env,windowsHide:true,timeout:10000});
  assert.deepEqual(JSON.parse(r.stdout),[argument]);
  await f.run(['--remove']);await assert.rejects(fs.stat(path.join(f.bin,'mcp-dev-runtime.exe')),{code:'ENOENT'});
  assert((await fs.stat(path.join(f.bin,'mdr.exe'))).isFile());
  await f.run(['--remove','--name','mdr']);await assert.rejects(fs.stat(path.join(f.bin,'mdr-command.json')),{code:'ENOENT'});
  assert.equal(await fs.readFile(path.join(f.root,'user-work.txt'),'utf8'),'keep source work');
});
win('Windows source: a foreign registration is never adopted or removed',async t=>{
  const f=await setup(t);await fs.mkdir(f.bin);
  const text=JSON.stringify({project:'another-project',kind:'source',root:f.root});
  const file=path.join(f.bin,'mdr-command.json');await fs.writeFile(file,text);
  await assert.rejects(f.run(['--remove']),/Another installation owns/);
  assert.equal(await fs.readFile(file,'utf8'),text);
});
win('Windows source: complete staged uninstall keeps the checkout and shared Skills',async t=>{
  const f=await setup(t);await f.run([]);
  await fs.writeFile(path.join(f.root,'config.json'),JSON.stringify({schema_version:1,runtime:{cwd:f.root},tunnel:{enabled:false}}));
  await fs.writeFile(path.join(f.root,'runtime.env'),'# synthetic empty configuration\n');
  const shared=path.join(f.home,'.agents','skills');await fs.mkdir(shared,{recursive:true});await fs.writeFile(path.join(shared,'KEEP'),'shared');
  const ps=path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
  const result=await new Promise((resolve,reject)=>{
    const child=spawn(ps,['-NoLogo','-NoProfile','-File',path.join(f.root,'uninstall.ps1'),'--bin-dir',f.bin],{env:f.env,windowsHide:true,stdio:['pipe','pipe','pipe']});
    let stdout='',stderr='';const timer=setTimeout(()=>{child.kill();reject(new Error('Source uninstall timed out.'))},25000);
    child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);child.once('error',reject);
    child.once('close',code=>{clearTimeout(timer);code===0?resolve(stdout):reject(new Error(stderr+'\n'+stdout))});child.stdin.end('y\r\n');
  });
  assert.match(result,/completely uninstalled/);
  for(const file of ['.runtime','dist','config.json','runtime.env'])await assert.rejects(fs.stat(path.join(f.root,file)),{code:'ENOENT'});
  assert((await fs.stat(path.join(f.root,'.git'))).isDirectory());
  assert.equal(await fs.readFile(path.join(f.root,'user-work.txt'),'utf8'),'keep source work');
  assert.equal(await fs.readFile(path.join(shared,'KEEP'),'utf8'),'shared');
});
