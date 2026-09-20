import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { mkdtemp, mkdir, readdir, readFile, writeFile, rename, rm, stat, lstat, symlink, readlink, chmod, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import path from 'node:path';
import { verifyBundle, inventory } from './bundle-lib.mjs';

const exec = promisify(execFile);
const archive = path.resolve(process.argv[2] ?? '');
assert(archive.endsWith('.tar.gz'), 'Pass the exact release archive to verify.');
const temp = await realpath(await mkdtemp(path.join(tmpdir(), 'mdr-vfy-')));
const checks = [];
let app, node, entry, env, bundle;
const pass = name => { checks.push(name); console.log('PASS: ' + name); };
const run = (cmd, args, extra = {}) => exec(cmd, args, { env, timeout: 60000, maxBuffer: 4 * 1024 * 1024, ...extra });
const cli = args => run(entry, args, { cwd: temp });
async function port() { return new Promise((resolve, reject) => { const s = createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); }); }
try {
  const list = (await exec('tar', ['-tzf', archive])).stdout.trim().split('\n');
  assert(list.every(p => !p.startsWith('/') && !p.split('/').includes('..')), 'Unsafe archive member.');
  await exec('tar', ['-xzf', archive, '-C', temp]);
  const unpacked = (await readdir(temp))[0];
  bundle = path.join(temp, "bundle 中文 ' space"); await rename(path.join(temp, unpacked), bundle);
  const manifest = await verifyBundle(bundle); pass('archive integrity, platform and relocatable internal symlinks');
  app = path.join(bundle, 'app'); node = path.join(bundle, 'runtime', 'node'); entry = path.join(bundle, 'bin', 'mcp-dev-runtime');
  const home = path.join(temp, 'home'), guarded = path.join(temp, 'minimal-bin'), workspace = path.join(temp, 'work space');
  await Promise.all([mkdir(home), mkdir(guarded), mkdir(workspace)]);
  const forbidden = path.join(temp, 'forbidden-tool-ran');
  for (const name of ['node', 'npm', 'npx', 'go', 'make', 'gcc', 'g++', 'git', 'curl', 'wget']) {
    await writeFile(path.join(guarded, name), '#!/bin/sh\nprintf forbidden > ' + JSON.stringify(forbidden) + '\nexit 94\n', { mode: 0o755 });
  }
  for (const name of ['dirname', 'uname', 'sleep', 'cat']) {
    const actual = '/usr/bin/' + name;
    const fallback = '/bin/' + name;
    await symlink(await stat(actual).then(() => actual, () => fallback), path.join(guarded, name));
  }
  env = { ...process.env, HOME: home, PATH: guarded, SHELL: '/bin/bash', NODE_TEST_CONTEXT: '', NODE_OPTIONS: '',
    XDG_CONFIG_HOME: path.join(home, 'config'), XDG_STATE_HOME: path.join(home, 'state'), XDG_CACHE_HOME: path.join(home, 'cache'), XDG_DATA_HOME: path.join(home, 'data'),
    CONTROL_PLANE_API_KEY: '', OPENAI_API_KEY: '', OPENAI_ADMIN_KEY: '', CONTROL_PLANE_TUNNEL_ID: '', TUNNEL_BIN: '',
    HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: 'localhost,127.0.0.1,::1', no_proxy: 'localhost,127.0.0.1,::1' };
  // doctor intentionally inspects tool availability, so only count forbidden execution before doctor.
  const installer = path.join(bundle, 'install.sh');
  const prefix = path.join(home, 'versions'), bin = path.join(home, '.local', 'bin');
  const installArgs = ['--prefix', prefix, '--bin-dir', bin];
  await run(installer, installArgs);
  assert.equal(await stat(forbidden).catch(() => null), null); pass('offline installation with no system Node/npm/Go/compiler/download tools');
  const installed = path.join(prefix, await readlink(path.join(prefix, 'current')));
  const installedEntry = path.join(bin, 'mcp-dev-runtime');
  assert((await run(installedEntry, ['--version'])).stdout.includes(manifest.version));
  assert((await run(path.join(bin, 'mdr'), ['--version'])).stdout.includes(manifest.version));
  const paths = JSON.parse((await run(installedEntry, ['paths', '--json'])).stdout);
  assert(!paths.state_dir.startsWith(installed)); assert(!paths.logs_dir.startsWith(installed));
  assert.notEqual(paths.logs_dir, paths.state_dir); pass('user-scoped configuration/state/logs and both global commands');
  const configFile = paths.runtime_config, launchFile = paths.launcher_config;
  const before = await readFile(configFile, 'utf8');
  await run(installer, installArgs); assert.equal(await readFile(configFile, 'utf8'), before); pass('idempotent reinstall preserves configuration');
  await assert.rejects(cli(['up']), /Missing CONTROL_PLANE/); pass('missing credentials fail locally without a fabricated ready state');
  const realTunnel = JSON.parse((await cli(['tunnel-setup'])).stdout);
  assert.equal(realTunnel.sha256, manifest.tunnel.sha256); assert(realTunnel.path.startsWith(bundle));
  await assert.rejects(cli(['tunnel-setup', '--build']), /separate source checkout/); pass('actual bundled Tunnel identity and no implicit source-build fallback');
  const mp = await port(); let tp = await port(); while (tp === mp) tp = await port();
  const runtime = JSON.parse(before); runtime.port = mp; runtime.cwd = workspace;
  await writeFile(configFile, JSON.stringify(runtime, null, 2) + '\n');
  const launch = JSON.parse(await readFile(launchFile, 'utf8'));
  launch.state_dir = path.join(home, 'very long state directory ' + 's'.repeat(65));
  launch.logs_dir = path.join(home, 'separate logs'); launch.tunnel_health_port = tp;
  const mock = path.join(temp, 'mock-tunnel.cjs');
  // Explicit local test double; no cloud request or real credentials.
  await writeFile(mock, '#!' + node + '\n' + `const http=require('node:http'); const a=process.argv.slice(2);
if(a.includes('--version')){console.log(${JSON.stringify(manifest.tunnel.reported_version)});process.exit(0);}
if(a.includes('--help')){console.log('  run  Test only');process.exit(0);}
const p=Number(a.find(s=>s.startsWith('--health.listen-addr=')).split(':').at(-1));
const s=http.createServer((q,r)=>r.end('ready')); s.listen(p,'127.0.0.1');
process.on('SIGTERM',()=>s.close(()=>process.exit(0)));\n`, { mode: 0o755 });
  // The mock shebang must not contain a space: invoke it through a short helper path.
  const shortNode = path.join(temp, 'n'); await symlink(node, shortNode);
  await writeFile(mock, (await readFile(mock, 'utf8')).replace('#!' + node, '#!' + shortNode), { mode: 0o755 });
  launch.tunnel_bin = mock;
  await writeFile(launchFile, JSON.stringify(launch, null, 2) + '\n');
  const envFile = path.join(path.dirname(launchFile), 'runtime.env');
  await writeFile(envFile, 'CONTROL_PLANE_TUNNEL_ID=tunnel_' + '0'.repeat(32) + '\nCONTROL_PLANE_API_KEY=local-bundle-test-only\n', { mode: 0o600 });
  const first = JSON.parse((await cli(['up', '--background'])).stdout);
  assert.equal(first.state, 'ready'); assert(first.control_socket.length <= 100);
  const state = JSON.parse((await cli(['status', '--json'])).stdout);
  assert.equal(state.health.availability, 'ready'); assert.equal(state.log_directory, launch.logs_dir);
  assert((await cli(['status'])).stdout.includes('Uptime')); assert((await cli(['status', '--verbose'])).stdout.includes('MCP PID'));
  await assert.rejects(run(installer, installArgs), /active or unreachable/); pass('managed lifecycle, separate logs, long-path IPC and active-upgrade guard (mock Tunnel)');
  env.MDR_VERIFICATION_REPORT_DIR = path.join(temp, 'reports');
  const verification = await run(node, [path.join(app, 'scripts', 'verify-deployed.mjs'), `http://127.0.0.1:${mp}/mcp`]);
  console.log(verification.stdout);
  const report = JSON.parse(await readFile(path.join(temp, 'reports', 'deployed-verification.json'), 'utf8'));
  assert.equal(report.status, 'passed'); assert.equal(report.checks.length, 20); pass('all six tools including PTY, images, patches, output/history and termination from the extracted bundle');
  // Tool availability probing may execute --version, but does not determine doctor PASS.
  const doctor = JSON.parse((await cli(['doctor', '--json'])).stdout); assert.equal(doctor.ok, true);
  await cli(['down']);
  const stopped = JSON.parse((await cli(['status', '--json'])).stdout); assert.equal(stopped.state, 'stopped');
  const req = createRequire(path.join(app, 'package.json'));
  const { Client } = await import(pathToFileURL(req.resolve('@modelcontextprotocol/client')));
  const { StdioClientTransport } = await import(pathToFileURL(req.resolve('@modelcontextprotocol/client/stdio')));
  const stdioConfig = path.join(temp, 'stdio.json');
  await writeFile(stdioConfig, JSON.stringify({ cwd: workspace, shell: '/bin/bash', history: { enabled: false } }));
  const client = new Client({ name: 'bundle-stdio-verification', version: '1.0.0' });
  try {
    await client.connect(new StdioClientTransport({ command: entry, args: ['serve', '--transport', 'stdio', '--config', stdioConfig], env }));
    assert.equal((await client.listTools()).tools.length, 6);
    const r = await client.callTool({ name: 'exec_command', arguments: { cmd: "printf 'stdio-bundle-ok'" } });
    assert.equal(r.structuredContent.output, 'stdio-bundle-ok'); assert.equal(r.structuredContent.exit_code, 0);
  } finally { await client.close(); }
  pass('stdio subprocess executes using only the bundled runtime');
  await verifyBundle(bundle); await verifyBundle(installed); pass('runtime and diagnostics never modified either program tree');
  const preserved = await readFile(configFile, 'utf8');
  // Exercise real version switching using a synthetic previous package, never uploaded.
  const saved = new Map();
  for (const rel of ['app/package.json', 'app/distribution.json', 'app/tunnel.lock.json', 'BUILD-MANIFEST.json']) saved.set(rel, await readFile(path.join(bundle, rel), 'utf8'));
  try {
    for (const rel of ['app/package.json', 'app/distribution.json']) { const d = JSON.parse(saved.get(rel)); d.version = '0.9.9'; await writeFile(path.join(bundle, rel), JSON.stringify(d, null, 2) + '\n'); }
    const lock = JSON.parse(saved.get('app/tunnel.lock.json')); lock.runtime_version = '0.9.9'; await writeFile(path.join(bundle, 'app/tunnel.lock.json'), JSON.stringify(lock, null, 2) + '\n');
    const old = { ...manifest, version: '0.9.9', files: await inventory(bundle) }; await writeFile(path.join(bundle, 'BUILD-MANIFEST.json'), JSON.stringify(old, null, 2) + '\n');
    await run(installer, installArgs); assert((await run(installedEntry, ['--version'])).stdout.includes('0.9.9'));
  } finally { for (const [rel, text] of saved) await writeFile(path.join(bundle, rel), text); }
  await run(installer, installArgs); assert((await run(installedEntry, ['--version'])).stdout.includes(manifest.version));
  assert.equal(await readFile(configFile, 'utf8'), preserved); assert((await readdir(prefix)).some(p => p.startsWith('0.9.9-')));
  pass('upgrade/rollback pointer switching with preserved configuration and previous version (synthetic previous package)');
  await run(installer, [...installArgs, '--unregister']);
  const foreign = path.join(guarded, 'mdr'); await writeFile(foreign, '#!/bin/sh\nexit 95\n', { mode: 0o755 });
  const conflicted = await run(installer, installArgs); assert(conflicted.stdout.includes('Skipped short command'));
  assert.equal(await lstat(path.join(bin, 'mdr')).catch(() => null), null); assert((await lstat(installedEntry)).isFile());
  assert.equal(await readFile(foreign, 'utf8'), '#!/bin/sh\nexit 95\n'); pass('foreign short-command conflict skips only mdr');
  const output = { status: 'passed', platform: process.platform, arch: process.arch, source_commit: manifest.source_commit, version: manifest.version,
    checks, cloud_scope: 'No real Tunnel credentials or cloud round trip. Lifecycle tests use an explicit mock; the real bundled Tunnel identity is separately verified.' };
  await writeFile(archive.replace(/\.tar\.gz$/, '.verification.json'), JSON.stringify(output, null, 2) + '\n');
  console.log('BUNDLE_VERIFICATION_PASS ' + checks.length + ' groups');
} finally {
  if (entry && env) await cli(['down']).catch(() => {});
  await rm(temp, { recursive: true, force: true });
}
