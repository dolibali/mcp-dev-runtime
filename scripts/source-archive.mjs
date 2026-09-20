import {execFileSync} from 'node:child_process';
import {mkdtemp,readFile,writeFile,mkdir,copyFile,rm,lstat} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';import {createHash} from 'node:crypto';
const pkg=JSON.parse(await readFile('package.json','utf8'));const root=process.cwd();
let files;
try { files=[...new Set(execFileSync('git',['ls-files','--cached','--others','--exclude-standard','-z'],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).split('\0').filter(Boolean))]; }
catch { files=JSON.parse(await readFile('SOURCE_MANIFEST.json','utf8')).files.map(x=>x.path); }
const tmp=await mkdtemp(path.join(os.tmpdir(),'mcp-source-export-'));const prefix=`${pkg.name}-${pkg.version}`;
const out=path.join(tmp,prefix);await mkdir(out);const manifest=[];
try{
  for(const file of files){
    if(file.startsWith('vendor/'))continue;
    if(/(?:^|\/)(?:\.mcp-dev-runtime|\.runtime)(?:\/|$)/.test(file))continue;
    if(!(await lstat(file)).isFile())continue;
    const target=path.join(out,file);await mkdir(path.dirname(target),{recursive:true});await copyFile(file,target);
    manifest.push({path:file,sha256:createHash('sha256').update(await readFile(file)).digest('hex')});
  }
  await writeFile(path.join(out,'SOURCE_MANIFEST.json'),JSON.stringify({project:pkg.name,version:pkg.version,optional_submodule:'Use tunnel.lock.json to obtain pinned upstream source; no local binaries or credentials included.',files:manifest},null,2)+'\n');
  await mkdir('artifacts',{recursive:true});const filename=path.join(root,'artifacts',prefix+'-source.tar.gz');
  execFileSync('tar',['-czf',filename,'-C',tmp,prefix]);
  const sha=createHash('sha256').update(await readFile(filename)).digest('hex');await writeFile(filename+'.sha256',sha+'  '+path.basename(filename)+'\n');
  console.log(JSON.stringify({archive:filename,sha256:sha,files:manifest.length}));
}finally{await rm(tmp,{recursive:true,force:true});}
