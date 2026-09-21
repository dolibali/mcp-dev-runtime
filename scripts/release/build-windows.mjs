import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, writeFile, rm, lstat, readdir, rename } from 'node:fs/promises';
import { tmpdir, release as osRelease } from 'node:os';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { digest, inventory } from './bundle-lib.mjs';
import { signBundle } from './sign.mjs';

if(process.platform!=='win32'||!['x64','arm64'].includes(process.arch))throw new Error('Build Windows releases on matching native Windows x64/ARM64 hosts.');
const root=fileURLToPath(new URL('../../',import.meta.url));process.chdir(root);
const {values}=parseArgs({options:{'allow-dirty':{type:'boolean'},'native-dir':{type:'string'}}});
if(values['native-dir']&&!values['allow-dirty'])throw new Error('--native-dir is for local testing only and requires --allow-dirty. Production must rebuild its native sources.');
const run=(exe,args,cwd=root,env=process.env)=>execFileSync(exe,args,{cwd,env,stdio:'inherit',windowsHide:true,timeout:20*60000});
const capture=(exe,args,cwd=root)=>execFileSync(exe,args,{cwd,encoding:'utf8',windowsHide:true,timeout:60000,stdio:['ignore','pipe','pipe']}).trim();
const pkg=JSON.parse(await readFile('package.json','utf8')),tools=JSON.parse(await readFile('release-toolchain.lock.json','utf8')),pin=JSON.parse(await readFile('tunnel.lock.json','utf8'));
let commit,dirty;
try{commit=capture('git',['rev-parse','HEAD']);dirty=!!capture('git',['status','--porcelain','--untracked-files=normal']);}
catch(e){if(!values['allow-dirty'])throw e;const snapshot=JSON.parse(await readFile('SOURCE_MANIFEST.json','utf8'));commit=snapshot.source_commit;dirty=true;}
dirty=dirty||!!values['native-dir'];
if(dirty&&!values['allow-dirty'])throw new Error('Release builds require a clean checkout.');
if(pin.runtime_version!==pkg.version)throw new Error('Version/lock mismatch.');
const target='win32-'+process.arch,goarch=process.arch==='x64'?'amd64':'arm64',expected=tools.node_archives[target];
if(!/^[a-f0-9]{64}$/.test(expected??''))throw new Error('Pinned Node checksum missing for '+target);
const work=await mkdtemp(path.join(tmpdir(),'mdr-win-build-')),name=`${pkg.name}-${pkg.version}-${target}`;
const bundle=path.join(work,name),app=path.join(bundle,'app'),downloads=path.join(root,'.runtime','release-downloads');
const archiveName=`node-v${tools.node_version}-win-${process.arch}.zip`,download=path.join(downloads,archiveName);
const tar=path.join(process.env.SystemRoot??'C:\\Windows','System32','tar.exe');
const curl=path.join(process.env.SystemRoot??'C:\\Windows','System32','curl.exe');
console.log('[windows release] '+name+' '+commit+(dirty?' (local test; not publishable)':''));
try{
  await mkdir(downloads,{recursive:true});
  if(await digest(download).catch(()=>'')!==expected){
    run(curl,['--fail','--location','--silent','--show-error','--retry','3','--connect-timeout','20','--max-time','600',tools.node_base_url+archiveName,'--output',download+'.partial']);
    if(await digest(download+'.partial')!==expected)throw new Error('Official Node archive checksum mismatch.');
    await rename(download+'.partial',download);
  }
  run(tar,['-xf',download,'-C',work]);
  const nodeRoot=path.join(work,`node-v${tools.node_version}-win-${process.arch}`),node=path.join(nodeRoot,'node.exe');
  if(capture(node,['--version'])!=='v'+tools.node_version)throw new Error('Pinned Node version mismatch.');
  if(capture(node,['-p','process.arch'])!==process.arch)throw new Error('Native architecture mismatch.');
  const env={...process.env,PATH:nodeRoot+path.delimiter+(process.env.PATH??''),SHARP_IGNORE_GLOBAL_LIBVIPS:'1',npm_config_audit:'false',npm_config_fund:'false'};
  await mkdir(path.join(app,'scripts','windows'),{recursive:true});await mkdir(path.join(app,'scripts','release'),{recursive:true});
  for(const file of ['package.json','package-lock.json'])await cp(path.join(root,file),path.join(app,file));
  // Windows does not use node-pty: no install scripts or MSVC downloads are run.
  // Sharp's matching N-API prebuild is an optional locked npm package.
  run(node,[path.join(nodeRoot,'node_modules','npm','bin','npm-cli.js'),'ci','--omit=dev','--include=optional','--ignore-scripts','--no-audit','--no-fund'],app,env);
  await rm(path.join(app,'node_modules','node-pty'),{recursive:true,force:true});
  await rm(path.join(app,'node_modules','.bin'),{recursive:true,force:true});
  await rm(path.join(app,'node_modules','.package-lock.json'),{force:true});
  await rm(path.join(app,'package-lock.json'));
  run(process.execPath,[path.join(root,'node_modules','typescript','bin','tsc'),'-p','tsconfig.json']);
  for(const file of ['dist','contracts','tunnel.lock.json'])await cp(path.join(root,file),path.join(app,file),{recursive:true});
  for(const file of ['doctor.mjs','smoke.mjs','verify-deployed.mjs'])await cp(path.join(root,'scripts',file),path.join(app,'scripts',file));
  await cp(path.join(root,'scripts','windows'),path.join(app,'scripts','windows'),{recursive:true});
  await cp(path.join(root,'scripts','release','bundle-lib.mjs'),path.join(app,'scripts','release','bundle-lib.mjs'));
  const dependencies={...pkg.dependencies};delete dependencies['node-pty'];
  await writeFile(path.join(app,'package.json'),JSON.stringify({name:pkg.name,version:pkg.version,type:'module',private:true,description:pkg.description,license:pkg.license,engines:pkg.engines,dependencies},null,2)+'\n');
  for(const file of ['docs','LICENSE','NOTICE','THIRD_PARTY_NOTICES.md','SECURITY.md'])await cp(path.join(root,file),path.join(bundle,file),{recursive:true});
  await mkdir(path.join(bundle,'reference','codex'),{recursive:true});
  for(const file of ['LICENSE','SOURCE.json'])await cp(path.join(root,'reference','codex',file),path.join(bundle,'reference','codex',file));
  await writeFile(path.join(bundle,'README.md'),`# MCP Dev Runtime ${pkg.version}\n\nWindows ${process.arch}: verify SHA256SUMS, extract and run install.ps1. No administrator, Node/npm/Go/compiler installation is required. Keep runtime.env private.\n\n[English guide](docs/WINDOWS.md) | [简体中文安装](docs/WINDOWS.zh-CN.md)\n\nComplete removal: uninstall.ps1, then explicitly enter y. Shared Skills are not removed. Publisher signing is skipped.\n`);
  async function rewriteLinks(dir){
    for(const entry of await readdir(dir,{withFileTypes:true})){
      const file=path.join(dir,entry.name);if(entry.isDirectory()){await rewriteLinks(file);continue}if(!entry.name.endsWith('.md'))continue;
      let text=await readFile(file,'utf8');
      for(const match of [...text.matchAll(/\]\(([^\s)]+)\)/g)]){
        const href=match[1];if(/^[a-z][a-z0-9+.-]*:/i.test(href)||href.startsWith('#'))continue;
        const [target,anchor]=href.split('#'),to=path.resolve(path.dirname(file),decodeURIComponent(target));
        if(await lstat(to).catch(()=>null)&&!(anchor&&to===path.join(bundle,'README.md')))continue;
        const rel=path.relative(bundle,to).split(path.sep).join('/');if(rel.startsWith('../'))continue;
        text=text.replaceAll(']('+href+')',`](${pkg.repository.url.replace('git+','').replace('.git','')}/blob/v${pkg.version}/${rel}${anchor?'#'+anchor:''})`);
      }await writeFile(file,text);
    }
  }
  await rewriteLinks(path.join(bundle,'docs'));
  await mkdir(path.join(bundle,'runtime'));await cp(node,path.join(bundle,'runtime','node.exe'));
  await mkdir(path.join(app,'native'));await mkdir(path.join(bundle,'tunnel'));await mkdir(path.join(bundle,'licenses','go'),{recursive:true});
  await cp(path.join(nodeRoot,'LICENSE'),path.join(bundle,'licenses','NODE-LICENSE'));
  const helper=path.join(app,'native','mdr-windows-host.exe'),tunnel=path.join(bundle,'tunnel','tunnel-client-runtime.exe');
  let source=path.join(root,pin.submodule_path),modules=[];
  const native=path.resolve(values['native-dir']??'.');
  if(values['native-dir']){
    for(const [name,to] of [['mdr-windows-host.exe',helper],['tunnel-client-runtime.exe',tunnel]])await cp(path.join(native,name),to);
  }else{
    if(capture('go',['env','GOVERSION'])!=='go'+tools.go_version)throw new Error('Use the pinned Go toolchain.');
    await cp(path.join(capture('go',['env','GOROOT']),'LICENSE'),path.join(bundle,'licenses','GO-LICENSE'));
    run(process.execPath,[path.join(root,'scripts','build-windows-host.mjs'),'--arch',process.arch,'--out',helper]);
    source=path.join(work,'tunnel-source');run('git',['clone','--filter=blob:none','--no-checkout',pin.upstream.repository,source]);run('git',['fetch','origin',pin.upstream.commit],source);run('git',['checkout','--detach',pin.upstream.commit],source);
    if(capture('git',['rev-parse','HEAD'],source)!==pin.upstream.commit)throw new Error('Tunnel source pin mismatch.');
    run('go',['build','-mod=readonly','-trimpath','-buildvcs=false','-ldflags',`-X github.com/openai/tunnel-client/pkg/version.GitSHA=${pin.upstream.commit.slice(0,7)} -X github.com/openai/tunnel-client/pkg/version.Flavor=runtime`,'-o',tunnel,'./cmd/client-runtime'],source,{...env,CGO_ENABLED:'0',GOOS:'windows',GOARCH:goarch});
    for(const cwd of [source,path.join(root,'native','windows-host')]){
      const list=JSON.parse('['+capture('go',['list','-m','-json','all'],cwd).replace(/}\s*\{/g,'},{')+']');
      for(const mod of list){modules.push({name:mod.Path,version:mod.Version??(cwd===source?pin.upstream.commit:commit)});if(!mod.Dir)continue;
        const dest=path.join(bundle,'licenses','go',mod.Path.replaceAll('/','_'));
        for(const name of await readdir(mod.Dir))if(/^(licen[cs]e|copying|notice|copyright)([._-]|$)/i.test(name)&&((await lstat(path.join(mod.Dir,name))).isFile())){await mkdir(dest,{recursive:true});await cp(path.join(mod.Dir,name),path.join(dest,name))}
      }
    }
  }
  const reported=capture(tunnel,['--version']);
  if(!reported.includes(pin.upstream.source_version)||!reported.includes(pin.upstream.commit.slice(0,7)))throw new Error('Pinned Tunnel identity mismatch.');
  if(capture(helper,['--version'])!=='mdr-windows-host protocol=1')throw new Error('Windows helper protocol mismatch.');
  for(const name of ['LICENSE','NOTICE'])try{await cp(path.join(source,name),path.join(bundle,'licenses','TUNNEL-'+name))}catch(e){if(e.code!=='ENOENT')throw e;if(!dirty)throw e;}
  await writeFile(path.join(bundle,'licenses','GO-MODULES.json'),JSON.stringify({modules,test_prebuilt_components:!!values['native-dir']},null,2)+'\n');
  const tunnelHash=await digest(tunnel),helperHash=await digest(helper);
  await writeFile(path.join(app,'distribution.json'),JSON.stringify({schema_version:1,kind:'binary',version:pkg.version,platform:'win32',arch:process.arch,node_version:tools.node_version,tunnel_sha256:tunnelHash,windows_host_sha256:helperHash},null,2)+'\n');
  await mkdir(path.join(bundle,'bin'));
  for(const name of ['mdr.exe','mcp-dev-runtime.exe'])await cp(helper,path.join(bundle,'bin',name));
  await writeFile(path.join(bundle,'bin','mdr-command.json'),JSON.stringify({project:pkg.name,schema_version:1,kind:'portable'})+'\n');
  await cp(path.join(root,'install.ps1'),path.join(bundle,'install.ps1'));
  await cp(path.join(root,'scripts','windows','uninstall-bootstrap.ps1'),path.join(bundle,'uninstall.ps1'));
  const npmLock=JSON.parse(await readFile(path.join(root,'package-lock.json'),'utf8')),packages=[];
  for(const [relative,entry] of Object.entries(npmLock.packages)){
    if(!relative||entry.dev)continue;let dep;try{dep=JSON.parse(await readFile(path.join(app,relative,'package.json'),'utf8'))}catch{continue}
    packages.push({SPDXID:'SPDXRef-'+createHash('sha256').update(relative).digest('hex').slice(0,20),name:dep.name,versionInfo:dep.version,downloadLocation:entry.resolved??'NOASSERTION',filesAnalyzed:false,licenseConcluded:'NOASSERTION',licenseDeclared:typeof dep.license==='string'?dep.license:'NOASSERTION',copyrightText:'NOASSERTION'});
  }
  for(const [name,version,license] of [['node',tools.node_version,'MIT'],['tunnel-client-runtime',pin.upstream.commit,'Apache-2.0'],['mdr-windows-host',pkg.version,'Apache-2.0']])packages.push({SPDXID:'SPDXRef-'+name,name,versionInfo:version,downloadLocation:'NOASSERTION',filesAnalyzed:false,licenseConcluded:'NOASSERTION',licenseDeclared:license,copyrightText:'NOASSERTION'});
  const created=new Date().toISOString();
  await writeFile(path.join(bundle,'SBOM.spdx.json'),JSON.stringify({spdxVersion:'SPDX-2.3',dataLicense:'CC0-1.0',SPDXID:'SPDXRef-DOCUMENT',name,documentNamespace:`https://github.com/dolibali/mcp-dev-runtime/sbom/${commit}/${target}`,creationInfo:{created,creators:['Tool: mcp-dev-runtime-release']},packages,relationships:packages.map(p=>({spdxElementId:'SPDXRef-DOCUMENT',relationshipType:'DESCRIBES',relatedSpdxElement:p.SPDXID}))},null,2)+'\n');
  const signing=await signBundle(bundle);
  await writeFile(path.join(bundle,'BUILD-MANIFEST.json'),JSON.stringify({schema_version:1,project:pkg.name,version:pkg.version,source_commit:commit,dirty,platform:'win32',arch:process.arch,build_os:osRelease(),tested_baseline:tools.minimum_tested_platforms[target],created_at:created,node:{version:tools.node_version,archive:archiveName,archive_sha256:expected},tunnel:{repository:pin.upstream.repository,commit:pin.upstream.commit,reported_version:reported,sha256:tunnelHash},windows_host:{protocol:1,sha256:helperHash},signing,files:await inventory(bundle,{normalize:true})},null,2)+'\n');
  const checkHome=path.join(work,'check-home');await mkdir(checkHome);
  const checkEnv={...env,HOME:checkHome,USERPROFILE:checkHome,LOCALAPPDATA:path.join(checkHome,'Local'),APPDATA:path.join(checkHome,'Roaming'),TUNNEL_BIN:'',NODE_OPTIONS:'',CODEX_HOME:path.join(checkHome,'.codex')};
  run(path.join(bundle,'bin','mdr.exe'),['--version'],work,checkEnv);
  run(path.join(bundle,'bin','mdr.exe'),['tunnel-setup'],work,checkEnv);
  await mkdir(path.join(root,'artifacts'),{recursive:true});const archive=path.join(root,'artifacts',name+'.zip');
  run(tar,['-a','-cf',archive,'-C',work,name]);
  await writeFile(archive+'.sha256',await digest(archive)+'  '+path.basename(archive)+'\n');
  console.log('[windows release] Created '+archive);
}finally{await rm(work,{recursive:true,force:true,maxRetries:6,retryDelay:300});}
