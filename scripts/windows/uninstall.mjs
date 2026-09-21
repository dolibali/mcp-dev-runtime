import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { cp, readFile, writeFile, rm, unlink, readdir } from 'node:fs/promises';
import { directories, project, info, json, hash, safeRoot, inside, security, atomicJson, requireMarker, installationPaths, stopState, confirm } from './common.mjs';

if(process.platform!=='win32')throw new Error('This uninstaller is for Windows only.');
const {values}=parseArgs({options:{prepare:{type:'boolean'},plan:{type:'string'},prefix:{type:'string'},'bin-dir':{type:'string'},source:{type:'string'},help:{type:'boolean'}}});
if(values.help){console.log('Run uninstall.ps1 and enter y to remove MDR-owned program/data. Shared Skills and source checkouts are never deleted.');process.exit(0)}
if(values.prepare){
  const app=fileURLToPath(new URL('../../',import.meta.url)),defaults=directories();
  const record=await json(path.join(defaults.data,'windows-install.json'));
  const kind=values.source?'source':'binary',root=values.source?path.resolve(values.source):undefined;
  const prefix=values.prefix??record?.prefix??defaults.prefix,bin=values['bin-dir']??record?.bin??defaults.bin;
  const helper=kind==='source'?path.join(root,'.runtime','bin','mdr-windows-host.exe'):path.join(app,'native','mdr-windows-host.exe');
  if(kind==='binary'){
    if(!await requireMarker(safeRoot(path.resolve(prefix))))throw new Error('No verified Windows installation to uninstall.');
  }else if((await json(path.join(root,'package.json')))?.name!==project)throw new Error('Not an MDR source checkout.');
  const stage=path.join(tmpdir(),'mdr-uninstall-'+randomUUID());
  await security(helper,'private-dir',stage);
  for(const [from,to] of [[process.execPath,'node.exe'],[helper,'mdr-windows-host.exe'],[fileURLToPath(import.meta.url),'uninstall.mjs'],[fileURLToPath(new URL('common.mjs',import.meta.url)),'common.mjs']])await cp(from,path.join(stage,to),{errorOnExist:true,force:false});
  const plan=path.join(stage,'plan.json');
  await atomicJson(plan,{project,schema_version:1,kind,root,prefix:path.resolve(prefix),bin:path.resolve(bin),data:kind==='source'?root:defaults.data,helper:path.join(stage,'mdr-windows-host.exe')});
  console.log(JSON.stringify({directory:stage,node:path.join(stage,'node.exe'),script:path.join(stage,'uninstall.mjs'),plan}));
}else{
  if(!values.plan)throw new Error('Use uninstall.ps1; it runs the uninstaller from a temporary runtime so Windows can delete the installed executables.');
  const plan=await json(values.plan);
  if(plan?.project!==project||plan.schema_version!==1||!['source','binary'].includes(plan.kind))throw new Error('Invalid uninstall plan.');
  const {kind,root,bin,data,helper}=plan,prefix=safeRoot(plan.prefix);
  safeRoot(bin);safeRoot(data);
  if(kind==='source'&&path.resolve(data)!==path.resolve(root))throw new Error('Source uninstall data root mismatch.');
  if(kind==='binary'&&path.resolve(data).toLowerCase()!==path.resolve(directories().data).toLowerCase())throw new Error('User-data directory does not match this user installation.');
  if(inside(prefix,data)||inside(data,prefix)||inside(prefix,bin)||inside(bin,prefix)||inside(data,bin)||inside(bin,data))throw new Error('Refusing overlapping uninstall roots.');
  const selected=await installationPaths(data,kind),marker=kind==='binary'?await requireMarker(prefix):null;
  if(kind==='binary'){
    if(!marker)throw new Error('Installation marker is missing; nothing was removed.');
    const record=await json(path.join(data,'windows-install.json'));
    if(record?.project!==project||record.prefix!==prefix||record.bin!==bin)throw new Error('Uninstall registration does not match this installation.');
    await security(helper,'validate-private',data);if(marker)await security(helper,'validate-private',prefix);
  }else if((await json(path.join(root,'package.json')))?.name!==project)throw new Error('Source ownership cannot be confirmed.');
  const commandFile=path.join(bin,'mdr-command.json'),commands=await json(commandFile);
  const own=commands?.project===project&&(kind==='binary'?commands.kind==='binary'&&commands.prefix===prefix:commands.kind==='source'&&commands.root===root);
  const extra=[selected.state,selected.logs,selected.history].filter(p=>p&&!inside(data,p));
  const generated=kind==='binary'?[prefix,data]:['.runtime','.mcp-dev-runtime','dist','node_modules','config.json','launcher.config.json','runtime.env'].map(p=>path.join(root,p));
  if(!await confirm([...generated,...(own?Object.keys(commands.commands??{}).map(n=>path.join(bin,n)):[]),...extra.map(p=>'External path kept: '+p),...(kind==='source'?['Source repository kept: '+root]:[])])){console.log('Uninstall cancelled. Nothing was removed.');process.exit(0)}
  await stopState(selected.state);
  if(own){
    for(const [name,digest] of Object.entries(commands.commands??{})){
      if(!['mdr.exe','mcp-dev-runtime.exe'].includes(name))continue;
      const f=path.join(bin,name),s=await info(f);
      if(s?.isFile()&&!s.isSymbolicLink()&&await hash(f)===digest)await unlink(f);else if(s)console.log('Kept changed/unrelated command: '+f);
    }
    await unlink(commandFile);
  }
  for(const target of generated)await rm(target,{recursive:true,force:true,maxRetries:6,retryDelay:200});
  if((await readdir(bin).catch(()=>['missing'])).length===0)await rm(bin,{recursive:true});
  console.log('MCP Dev Runtime has been completely uninstalled.'+(extra.length?' External custom directories were kept.':''));
}
