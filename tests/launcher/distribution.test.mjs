import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { userDirectories, layout } from '../../dist/launcher/layout.js';
import { writePrivateIfMissing, privateDirectory } from '../../dist/launcher/private-files.js';
import { inventory, verifyBundle } from '../../scripts/release/bundle-lib.mjs';
import { signBundle } from '../../scripts/release/sign.mjs';

const exec = promisify(execFile), repo = process.cwd();
async function temporary(t) { const d = await realpath(await mkdtemp(path.join(tmpdir(), 'mdr-dist-'))); t.after(() => rm(d, { recursive: true, force: true })); return d; }

test('distribution: source layout remains local, with no speculative user directory output', () => {
  const l = layout(); assert.equal(l.mode, 'source'); assert.equal(l.state_dir, path.join(repo, '.runtime'));
  assert.equal(l.bundle_root, null);
});
test('distribution: platform paths honor absolute XDG overrides and ignore relative values', () => {
  const home = '/sample-home';
  const mac = userDirectories('darwin', home, {});
  assert.equal(mac.logs_dir, path.join(home, 'Library/Logs/mcp-dev-runtime'));
  assert.notEqual(mac.state_dir, mac.logs_dir);
  const linux = userDirectories('linux', home, { XDG_CONFIG_HOME: '/cfg', XDG_STATE_HOME: 'relative', XDG_CACHE_HOME: '', XDG_DATA_HOME: '/data' });
  assert.equal(linux.config_dir, '/cfg/mcp-dev-runtime');
  assert.equal(linux.state_dir, path.join(home, '.local/state/mcp-dev-runtime'));
  assert.equal(linux.releases_dir, '/data/mcp-dev-runtime/releases');
  assert.throws(() => userDirectories('win32', home), /macOS and Linux/);
});
test('distribution: private configuration is exclusive, idempotent and refuses symlinks', async t => {
  const d = await temporary(t), dir = path.join(d, 'private'), file = path.join(dir, 'runtime.env');
  assert(await writePrivateIfMissing(file, 'initial\n'));
  assert.equal(await writePrivateIfMissing(file, 'replacement\n'), false);
  assert.equal(await readFile(file, 'utf8'), 'initial\n');
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  const target = path.join(d, 'elsewhere'); await mkdir(target); const link = path.join(d, 'link'); await symlink(target, link);
  await assert.rejects(privateDirectory(link), /unsafe private directory/);
  await symlink(file, path.join(dir, 'symlink.env'));
  await assert.rejects(writePrivateIfMissing(path.join(dir, 'symlink.env'), 'wrong'), /unsafe existing configuration/);
});

async function binaryFixture(t) {
  const d = await temporary(t), app = path.join(d, 'bundle', 'app'), home = path.join(d, 'home');
  await mkdir(app, { recursive: true }); await mkdir(home);
  await cp('dist', path.join(app, 'dist'), { recursive: true });
  await cp('package.json', path.join(app, 'package.json')); await cp('tunnel.lock.json', path.join(app, 'tunnel.lock.json'));
  await symlink(path.join(repo, 'node_modules'), path.join(app, 'node_modules'), 'dir');
  const pkg = JSON.parse(await readFile('package.json', 'utf8'));
  await writeFile(path.join(app, 'distribution.json'), JSON.stringify({ schema_version: 1, kind: 'binary', version: pkg.version,
    platform: process.platform, arch: process.arch, node_version: process.versions.node, tunnel_sha256: '0'.repeat(64) }));
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, 'cfg'), XDG_STATE_HOME: path.join(home, 'state'), XDG_DATA_HOME: path.join(home, 'data') };
  const call = args => exec(process.execPath, [path.join(app, 'dist/launcher/cli.js'), ...args], { cwd: d, env, timeout: 10000 });
  return { d, app, home, call };
}
test('distribution CLI: paths and init use only user directories and preserve existing configuration', async t => {
  const f = await binaryFixture(t);
  const first = JSON.parse((await f.call(['paths', '--json'])).stdout);
  assert(first.state_dir.startsWith(f.home)); assert(first.logs_dir.startsWith(f.home));
  assert(!('npm_user_defaults' in first)); assert.equal(first.runtime_config, null);
  assert.deepEqual(await readdir(f.home), []);
  await f.call(['init']);
  const p = JSON.parse((await f.call(['paths', '--json'])).stdout);
  const before = await readFile(p.runtime_config, 'utf8');
  const c = JSON.parse(before);
  assert.equal(p.configuration_mode, 'unified'); assert.equal(p.config_file, p.runtime_config); assert.equal(p.launcher_config, null);
  assert.equal(c.runtime.cwd, f.home); assert(!c.history.directory.startsWith(f.app)); assert.equal(c.tunnel.enabled, true); assert.equal(c.tools.allow.length, 6);
  await f.call(['init']); assert.equal(await readFile(p.runtime_config, 'utf8'), before);
  assert.equal(await stat(path.join(f.app, 'config.json')).catch(() => null), null);
  assert.equal(c.runtime.env_file, 'runtime.env'); assert.equal(await stat(path.join(path.dirname(p.runtime_config), 'launcher.config.json')).catch(() => null), null);
});
test('distribution CLI: explicit log/state overrides remain caller-relative', async t => {
  const f = await binaryFixture(t);
  const p = JSON.parse((await f.call(['paths', '--state-dir', 'state space', '--logs-dir', 'log space', '--json'])).stdout);
  assert.equal(p.state_dir, path.join(f.d, 'state space')); assert.equal(p.logs_dir, path.join(f.d, 'log space'));
});
test('bundle integrity: detects changed content, unexpected files and external symlinks', async t => {
  const d = await temporary(t); await writeFile(path.join(d, 'tool'), 'original', { mode: 0o755 });
  const manifest = { schema_version: 1, project: 'mcp-dev-runtime', version: '1.0.0', platform: process.platform, arch: process.arch, files: await inventory(d) };
  await writeFile(path.join(d, 'BUILD-MANIFEST.json'), JSON.stringify(manifest));
  await verifyBundle(d);
  await writeFile(path.join(d, 'tool'), 'modified'); await assert.rejects(verifyBundle(d), /integrity/);
  await writeFile(path.join(d, 'tool'), 'original'); await writeFile(path.join(d, 'unexpected'), 'extra'); await assert.rejects(verifyBundle(d), /integrity/);
  await rm(path.join(d, 'unexpected')); await symlink('/etc', path.join(d, 'outside')); await assert.rejects(verifyBundle(d), /External bundle symlink/);
});
test('signing boundary: explicit skip records unsigned state; unconfigured signing fails closed', async () => {
  const result = await signBundle('/unused', 'skip'); assert.equal(result.publisher_signature, 'skipped');
  await assert.rejects(signBundle('/unused', 'required'), /not configured/);
});
