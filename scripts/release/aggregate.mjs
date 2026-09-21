import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { digest } from './bundle-lib.mjs';

const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const pin = JSON.parse(await readFile('tunnel.lock.json', 'utf8'));
const toolchain = JSON.parse(await readFile('release-toolchain.lock.json', 'utf8'));
const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const targets = ['darwin-arm64', 'darwin-x64', 'linux-arm64-gnu', 'linux-x64-gnu', 'win32-x64', 'win32-arm64'];
const checksums = [], reports = [];
for (const target of targets) {
  const windows=target.startsWith('win32-');
  const name = `${pkg.name}-${pkg.version}-${target}`, file = path.join('artifacts', name + (windows?'.zip':'.tar.gz'));
  const checksum = await digest(file);
  assert.equal((await readFile(file + '.sha256', 'utf8')).trim(), checksum + '  ' + path.basename(file));
  const manifest = JSON.parse(execFileSync(windows?'unzip':'tar', windows?['-p',file,name+'/BUILD-MANIFEST.json']:['-xOf', file, name + '/BUILD-MANIFEST.json'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }));
  assert.equal(manifest.version, pkg.version); assert.equal(manifest.source_commit, sha); assert.equal(manifest.dirty, false);
  assert.equal(manifest.platform + '-' + manifest.arch + (manifest.platform === 'linux' ? '-gnu' : ''), target);
  assert.equal(manifest.node.version, toolchain.node_version); assert.equal(manifest.tunnel.commit, pin.upstream.commit);
  assert.equal(manifest.signing.publisher_signature, 'skipped');
  const verification = JSON.parse(await readFile(path.join('artifacts', name + '.verification.json'), 'utf8'));
  assert.equal(verification.status, 'passed'); assert.equal(verification.source_commit, sha); assert.equal(verification.version, pkg.version);
  if(windows){assert.equal(verification.platform,'win32');assert.equal(verification.arch,target.slice(6));assert.equal(verification.archive_sha256,checksum);assert.equal(manifest.windows_host.protocol,1);assert.match(manifest.windows_host.sha256,/^[a-f0-9]{64}$/);}
  reports.push({ asset: path.basename(file), sha256: checksum, node_version: manifest.node.version, tunnel_commit: manifest.tunnel.commit,
    tested_baseline: manifest.tested_baseline, signing: manifest.signing, verification });
  checksums.push(checksum + '  ' + path.basename(file));
}
await writeFile('artifacts/SHA256SUMS', checksums.sort().join('\n') + '\n');
await writeFile('artifacts/VERIFICATION.json', JSON.stringify({ project: pkg.name, version: pkg.version, source_commit: sha,
  scope: 'Native runner checks of exact extracted archives; cloud lifecycle uses explicit test doubles, not real user credentials.', packages: reports }, null, 2) + '\n');
console.log('All six native release archives verified against ' + sha);
