import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseArgs } from 'node:util';

const root = fileURLToPath(new URL('../', import.meta.url));
const tools = JSON.parse(await readFile(path.join(root, 'release-toolchain.lock.json'), 'utf8'));
const { values } = parseArgs({ options: { arch: { type: 'string' }, out: { type: 'string' } } });
const arch = values.arch ?? process.arch;
if (!['x64', 'arm64'].includes(arch)) throw new Error('Windows adapter supports x64 and arm64 only.');
const goarch = arch === 'x64' ? 'amd64' : 'arm64';
const destination = values.out ? path.resolve(values.out) : path.join(root, '.runtime', 'bin', 'mdr-windows-host.exe');
if ((process.platform !== 'win32' || arch !== process.arch) && !values.out) throw new Error('Cross-builds require --out to avoid replacing the active host architecture.');
const source = path.join(root, 'native', 'windows-host');
const env = { ...process.env, GOOS: 'windows', GOARCH: goarch, CGO_ENABLED: '0', GOWORK: 'off', GOTOOLCHAIN: 'go'+tools.go_version };
await mkdir(path.dirname(destination), { recursive: true });
execFileSync('go', ['build', '-mod=readonly', '-trimpath', '-buildvcs=false', '-o', destination, '.'], {
  cwd: source, env, stdio: 'inherit', windowsHide: true, timeout: 600000
});
const sha256 = createHash('sha256').update(await readFile(destination)).digest('hex');
await writeFile(destination+'.json', JSON.stringify({ protocol: 1, go: tools.go_version, target: 'windows-'+goarch, sha256 }, null, 2)+'\n');
console.log('Built Windows '+arch+' OS adapter: '+destination);
