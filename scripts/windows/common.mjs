import path from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, mkdir, writeFile, rename, unlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { request } from 'node:http';

const exec=promisify(execFile);
export const project='mcp-dev-runtime';
export function directories(){
  const base=process.env.LOCALAPPDATA&&path.isAbsolute(process.env.LOCALAPPDATA)?process.env.LOCALAPPDATA:path.join(homedir(),'AppData','Local');
  return {data:path.join(base,project),prefix:path.join(base,'Programs',project,'releases'),bin:path.join(base,'Programs',project,'bin')};
}
export async function info(file){try{return await lstat(file)}catch(e){if(e.code==='ENOENT')return null;throw e}}
export function inside(root,file){const r=path.relative(root,file);return r===''||(!r.startsWith('..'+path.sep)&&r!=='..'&&!path.isAbsolute(r));}
export function safeRoot(root){
  if(!path.isAbsolute(root)||/[\x00\r\n]/.test(root)||path.parse(root).root===root||inside(root,homedir()))throw new Error('Refusing broad or ambiguous installation root: '+root);
  return path.resolve(root);
}
export async function json(file){const s=await info(file);if(!s)return null;if(!s.isFile()||s.isSymbolicLink()||s.size>1024*1024)throw new Error('Unsafe metadata: '+file);return JSON.parse(await readFile(file,'utf8'));}
export async function hash(file){const h=createHash('sha256');for await(const chunk of createReadStream(file))h.update(chunk);return h.digest('hex');}
export async function security(helper,operation,file){
  try{await exec(helper,[operation,file],{windowsHide:true,timeout:10000,maxBuffer:16384});}
  catch(e){throw new Error(e.stderr?.trim().slice(0,2048)||'Windows ACL verification failed.');}
}
export async function atomicJson(file,value){
  const temp=file+'.tmp-'+randomUUID();
  try{await writeFile(temp,JSON.stringify(value,null,2)+'\n',{flag:'wx'});await renameOwned(temp,file);}
  finally{await unlink(temp).catch(e=>{if(e.code!=='ENOENT')throw e});}
}
// Windows scanners can briefly hold a freshly written file/directory. Retry the
// same atomic rename for a bounded interval; never delete the destination or
// replace it with a non-atomic copy on an access/sharing failure.
export async function renameOwned(source,destination){
  for(let attempt=0;;attempt++){
    try{await rename(source,destination);return}
    catch(error){
      if(!['EPERM','EACCES','EBUSY'].includes(error.code)||attempt>=7)throw error;
      await new Promise(r=>setTimeout(r,50*(attempt+1)));
    }
  }
}
export async function requireMarker(prefix){
  const s=await info(prefix);if(!s)return null;
  if(!s.isDirectory()||s.isSymbolicLink())throw new Error('Installation prefix must be a real directory.');
  const marker=await json(path.join(prefix,'.mdr-releases.json'));
  if(marker?.project!==project||marker.schema_version!==1||marker.platform!=='win32')throw new Error('No matching Windows MDR installation marker: '+prefix);
  return marker;
}
export async function currentState(state){
  const s=await json(path.join(state,'supervisor.json'));if(!s)return null;
  if(typeof s.control_socket!=='string'||!s.control_socket.startsWith('\\\\.\\pipe\\mdr-')||typeof s.run_id!=='string'||!Number.isSafeInteger(s.pid)||s.pid<=0)throw new Error('Invalid Windows supervisor identity; stop the service before installation.');
  return s;
}
export async function stopState(state){
  const s=await currentState(state);if(!s)return;
  await new Promise((resolve,reject)=>{
    const req=request({socketPath:s.control_socket,path:'/stop',method:'POST',headers:{'X-Run-ID':s.run_id}},res=>{
      let text='';res.on('data',b=>{text+=b;if(text.length>65536)res.destroy(new Error('Oversized control response'))});
      res.on('error',reject);res.on('end',()=>{try{const r=JSON.parse(text);if(res.statusCode!==200||r.run_id!==s.run_id)throw new Error('Supervisor identity mismatch');resolve()}catch(e){reject(e)}});
    });req.on('error',reject);req.setTimeout(3000,()=>req.destroy(new Error('Cannot safely stop the installed service.')));req.end();
  });
  const until=performance.now()+25000;
  while(performance.now()<until){const now=await currentState(state);if(!now)return;if(now.run_id!==s.run_id)throw new Error('A different instance appeared during uninstall.');await new Promise(r=>setTimeout(r,100));}
  throw new Error('Service shutdown was not confirmed; no files were removed.');
}
export async function installationPaths(data,kind='binary'){
  const c=await json(path.join(data,'config.json'))??{},legacy=await json(path.join(data,'launcher.config.json'));
  const from=v=>v?path.resolve(data,v==='~'?homedir():/^~[\\/]/.test(v)?path.join(homedir(),v.slice(2)):v):undefined;
  const state=from(legacy?.state_dir??c.runtime?.state_dir)??path.join(data,kind==='source'?'.runtime':'state');
  const logs=from(legacy?.logs_dir??c.runtime?.logs_dir)??(kind==='source'?state:path.join(data,'logs'));
  const workspace=from(c.runtime?.cwd??c.cwd)??(kind==='source'?data:homedir());
  const history=c.history?.directory?path.resolve(workspace,c.history.directory):path.join(workspace,'.mcp-dev-runtime','history');
  return {state,logs,history};
}
export async function confirm(lines){
  console.log('MDR will be completely uninstalled.\n'+lines.map(s=>'  '+s).join('\n')+'\nConfiguration, credentials and owned history/logs will be deleted.');
  process.stdout.write('Continue? [y/N]: ');
  return new Promise(resolve=>{
    let text='',done=false;
    const finish=x=>{if(done)return;done=true;process.stdin.off('data',data);process.stdin.off('end',end);process.stdin.pause();resolve(x)};
    const data=b=>{text+=b;const i=text.search(/[\r\n]/);if(i>=0)finish(text.slice(0,i).trim().toLowerCase()==='y');else if(text.length>256)finish(false)};
    const end=()=>finish(text.trim().toLowerCase()==='y');process.stdin.on('data',data);process.stdin.once('end',end);if(process.stdin.readableEnded)end();
  });
}

export async function commandConflict(bin,name,owned){
  const filename=name+'.exe',target=path.join(bin,filename),s=await info(target);
  if(s){if(!s.isFile()||s.isSymbolicLink()||owned?.commands?.[filename]!==await hash(target))throw new Error('Foreign command at '+target);}
  for(const suffix of ['.cmd','.bat','.com','.ps1'])if(await info(path.join(bin,name+suffix)))throw new Error('Conflicting command in destination directory: '+name+suffix);
  for(const dir of (process.env.PATH??'').split(path.delimiter).filter(Boolean)){
    if(path.resolve(dir).toLowerCase()===path.resolve(bin).toLowerCase())continue;
    for(const suffix of ['.exe','.cmd','.bat','.com','.ps1'])if(await info(path.join(dir,name+suffix)))throw new Error('Existing command on PATH: '+name);
  }
}
