import {readFile,writeFile} from 'node:fs/promises';
const pkg=JSON.parse(await readFile('package.json','utf8'));
const npmLock=JSON.parse(await readFile('package-lock.json','utf8'));
if(npmLock.version!==pkg.version || npmLock.packages[''].version!==pkg.version) throw new Error('Run npm version or update the npm lock before syncing the compatibility record.');
const tunnel=JSON.parse(await readFile('tunnel.lock.json','utf8'));
tunnel.runtime_version=pkg.version;
await writeFile('tunnel.lock.json',JSON.stringify(tunnel,null,2)+'\n');
console.log(`Project association updated to ${pkg.version}; upstream Tunnel commit unchanged.`);
