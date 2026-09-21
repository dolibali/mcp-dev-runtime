import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { cp, mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { initializeUser } from '../../dist/launcher/initialize.js';
import { verifyBundle } from '../release/bundle-lib.mjs';
import { directories, project, info, json, hash, safeRoot, inside, security, atomicJson, renameOwned, requireMarker, installationPaths, currentState, commandConflict } from './common.mjs';

if(process.platform!=='win32')throw new Error('Use install.sh on macOS/Linux.');
const app=fileURLToPath(new URL('../../',import.meta.url)),bundle=path.dirname(app),helper=path.join(app,'native','mdr-windows-host.exe');
const {values}=parseArgs({options:{prefix:{type:'string'},'bin-dir':{type:'string'},'no-global-command':{type:'boolean'},help:{type:'boolean'}}});
if(values.help){console.log('Windows binary install: install.ps1 [--prefix PATH] [--bin-dir PATH] [--no-global-command]\nNo administrator rights or permanent policy changes. Existing configuration is preserved.');process.exit(0)}
const defaults=directories(),prefix=safeRoot(path.resolve(values.prefix??defaults.prefix)),bin=safeRoot(path.resolve(values['bin-dir']??defaults.bin)),data=defaults.data;
const overlap=(a,b)=>inside(a,b)||inside(b,a);
if(overlap(prefix,bundle)||overlap(prefix,data)||overlap(bin,bundle)||overlap(bin,data)||overlap(prefix,bin))throw new Error('Program, command, download and user-data roots must be separate.');
const manifest=await verifyBundle(bundle);
if(process.version!=='v'+manifest.node.version)throw new Error('Use the package bundled Node runtime.');
await security(helper,'private-dir',data);
const recordPath=path.join(data,'windows-install.json'),record=await json(recordPath);
if(record&&(record.project!==project||record.prefix!==prefix||record.bin!==bin))throw new Error('Another Windows MDR installation owns this user data directory.');
await requireMarker(prefix);
const selected=await installationPaths(data);
if(await currentState(selected.state))throw new Error('Stop the selected managed instance before install/upgrade. No service was stopped automatically.');
const commandFile=path.join(bin,'mdr-command.json'),oldCommands=await json(commandFile);
if(oldCommands&&(oldCommands.project!==project||oldCommands.kind!=='binary'||oldCommands.prefix!==prefix))throw new Error('Another installation owns the command directory.');
const names=[];
if(!values['no-global-command']){
  await commandConflict(bin,'mcp-dev-runtime',oldCommands);names.push('mcp-dev-runtime');
  try{await commandConflict(bin,'mdr',oldCommands);names.push('mdr')}catch(e){console.log('Skipped short command: '+e.message)}
}
// Check all known conflicts before publishing a version pointer.
const stable=path.join(data,'uninstall.ps1'),previous=await info(stable);
if(previous&&(!previous.isFile()||previous.isSymbolicLink()||!(await readFile(stable,'utf8')).startsWith('# MDR Windows uninstaller v1')))throw new Error('Refusing to replace an unrelated uninstall script.');
for(const filename of ['config.json','runtime.env','windows-install.json','uninstaller.json']){
  const file=path.join(data,filename);
  if(await info(file))await security(helper,'validate-private',file);
}
if(names.length)await security(helper,'private-dir',bin);
await security(helper,'private-dir',prefix);
if(!await info(path.join(prefix,'.mdr-releases.json')))await atomicJson(path.join(prefix,'.mdr-releases.json'),{project,schema_version:1,platform:'win32'});
const lock=path.join(prefix,'.install-lock');await mkdir(lock).catch(e=>{if(e.code==='EEXIST')throw new Error('Another install or interrupted install lock exists; inspect it first.');throw e});
const staging=path.join(prefix,'.incoming-'+randomUUID()),version=path.join(prefix,manifest.version);
try{
  if(await info(version)){
    const existing=await verifyBundle(version);
    if(JSON.stringify(existing)!==JSON.stringify(manifest))throw new Error('This version is already installed with different contents. Do not overwrite an immutable version.');
  }else{await cp(bundle,staging,{recursive:true,errorOnExist:true,force:false,dereference:false});await verifyBundle(staging);await renameOwned(staging,version)}
  await initializeUser();
  const commands={...(oldCommands?.commands??{})};
  if(names.length){
    await security(helper,'private-dir',bin);
    for(const name of names){
      const target=path.join(bin,name+'.exe');
      // Existing verified protocol-1 wrappers select current.json and need not
      // be overwritten just because the installed application changed version.
      if(!await info(target))await cp(helper,target,{errorOnExist:true,force:false});
      commands[name+'.exe']=await hash(target);console.log('Registered: '+target);
    }
    await atomicJson(commandFile,{project,schema_version:1,kind:'binary',prefix,commands});
  }
  await atomicJson(recordPath,{project,schema_version:1,prefix,bin});
  await atomicJson(path.join(data,'uninstaller.json'),{project,schema_version:1,prefix});
  await writeFile(stable,await readFile(path.join(bundle,'uninstall.ps1'),'utf8'));
  // Publish last: failures above must not switch a working installation to a
  // partially prepared version. No symlink privileges or loaded-EXE replacement.
  await atomicJson(path.join(prefix,'current.json'),{project,schema_version:1,version:manifest.version});
  console.log('Installed: '+version+'\nConfig: '+path.join(data,'config.json')+'\nSecrets: '+path.join(data,'runtime.env')+'\nComplete uninstall: '+stable);
  if(names.length&&!((process.env.PATH??'').split(path.delimiter).some(p=>path.resolve(p).toLowerCase()===bin.toLowerCase())))console.log('Add this directory to your USER Path (not system Path), then open a new terminal:\n'+bin+'\nNo registry or shell profile was modified.');
}finally{await rm(staging,{recursive:true,force:true,maxRetries:4,retryDelay:150});await rm(lock,{recursive:true,force:true});}
