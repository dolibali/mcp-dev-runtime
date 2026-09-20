import {execFileSync} from 'node:child_process';
import {readFileSync,lstatSync} from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {CONTRACT_VERSION} from '../dist/version.js';
const root=process.cwd();
const pkg=JSON.parse(readFileSync('package.json','utf8'));
const npmLock=JSON.parse(readFileSync('package-lock.json','utf8'));
const tunnel=JSON.parse(readFileSync('tunnel.lock.json','utf8'));
assert.equal(pkg.version,npmLock.version);assert.equal(pkg.version,npmLock.packages[''].version);
assert.equal(pkg.version,tunnel.runtime_version);assert.equal(pkg.license,'Apache-2.0');
assert.equal(CONTRACT_VERSION,tunnel.contract_version);
const toolchain=JSON.parse(readFileSync('release-toolchain.lock.json','utf8'));
assert.equal(readFileSync('.node-version','utf8').trim(),toolchain.node_version);
const tools=JSON.parse(readFileSync('contracts/tools.json','utf8')).tools;
assert.equal(tools.length,6);for(const t of tools){assert(t.inputSchema);assert(t.outputSchema);}
for(const name of ['LICENSE','NOTICE','THIRD_PARTY_NOTICES.md','SECURITY.md','CONTRIBUTING.md'])assert(readFileSync(name).length>0);
for(const name of ['install.sh','scripts/setup.mjs']){const s=lstatSync(name);assert(s.isFile(),name+' must be a regular file');assert((s.mode&0o111)!==0,name+' must be executable');}
let files;
try{files=execFileSync('git',['ls-files','--cached','--others','--exclude-standard','-z'],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).split('\0').filter(Boolean);}
catch{files=JSON.parse(readFileSync('SOURCE_MANIFEST.json','utf8')).files.map(x=>x.path);}
const privateDirectory=/(?:^|\/)(?:reports|\.runtime|\.mcp-dev-runtime|artifacts|node_modules|dist|\.kilo|\.idea|\.vscode|__pycache__|coverage|\.nyc_output)(?:\/|$)/;
const privateFile=/(?:^|\/)(?:config\.json|launcher\.config\.json|runtime\.env|\.npmrc|\.DS_Store|\._[^/]*|\.env(?!\.example$)[^/]*|[^/]+\.(?:pem|key|p12|pfx|pyc|pyo|tsbuildinfo))$/;
const secrets=/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bsk-(?:proj-)?[A-Za-z0-9_-]{24,}/;
// Generic checks, not a maintainer's personal username embedded in source.
const localPaths=/(?:\/Users\/|\/Volumes\/|[A-Za-z]:\\Users\\)[A-Za-z0-9._-]+/;
const errors=[];
for(const file of [...new Set(files)]){
  if(file!=='reports/.gitkeep' && (privateDirectory.test(file)||privateFile.test(file)))errors.push('Private/build file in release candidates: '+file);
  if(file==='vendor/tunnel-client')continue;
  if(file.startsWith('vendor/'))errors.push('Unexpected vendored file; keep the pinned gitlink only: '+file);
  const stat=lstatSync(file);
  if(!stat.isFile()){errors.push('Non-regular source candidate: '+file);continue;}
  const text=readFileSync(file,'utf8');
  if(secrets.test(text))errors.push('Potential secret in '+file);
  if(localPaths.test(text))errors.push('Machine-specific user or volume path in '+file);
}
const modules=readFileSync('.gitmodules','utf8');assert(modules.includes(tunnel.upstream.repository));
try{const index=execFileSync('git',['ls-files','--stage','vendor/tunnel-client'],{encoding:'utf8',stdio:['ignore','pipe','pipe']});assert(index.includes(tunnel.upstream.commit),'Gitlink must match tunnel.lock.json');}
catch(e){if(!readFileSync('SOURCE_MANIFEST.json','utf8'))throw e;}
if(errors.length)throw new Error(errors.join('\n'));
console.log(JSON.stringify({release_check:'passed',version:pkg.version,tools:tools.length,candidate_files:files.length,tunnel_commit:tunnel.upstream.commit,scope:'static candidate checks, not a complete secret audit'},null,2));
