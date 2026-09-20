import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const exec = promisify(execFile);
const sourceSetup = path.resolve('scripts/setup.mjs');
const sourceInstall = path.resolve('install.sh');

async function executable(file, text) {
  await writeFile(file, text, { mode: 0o755 });
  await chmod(file, 0o755);
}

async function fixture(t, { tunnelInitiallyReady = false, tools = ['git', 'make', 'go'] } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'mcp-dev-runtime-setup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'scripts'), { recursive: true });
  await copyFile(sourceSetup, path.join(root, 'scripts', 'setup.mjs'));
  await copyFile(path.resolve('scripts/global-command.mjs'), path.join(root, 'scripts', 'global-command.mjs'));
  // This test suite never writes to the maintainer's actual global bin directory.
  const home = path.join(root, 'test-home'); await mkdir(home);
  await mkdir(path.join(root, 'dist', 'launcher'), { recursive: true });
  await writeFile(path.join(root, 'dist', 'launcher', 'cli.js'), '// Test-only built entry point\n');
  await writeFile(path.join(root, 'package-lock.json'), '{"lockfileVersion":3}\n');
  await writeFile(path.join(root, 'config.example.json'), '{"transport":"http","host":"127.0.0.1","port":3001,"cwd":".","shell":"/bin/bash"}\n');
  await writeFile(path.join(root, 'launcher.config.example.json'), '{"runtime_config":"config.json","state_dir":".runtime","tunnel_health_port":9098}\n');
  await writeFile(path.join(root, '.env.example'), 'CONTROL_PLANE_TUNNEL_ID=tunnel_' + '0'.repeat(32) + '\nCONTROL_PLANE_API_KEY=replace-me\n');

  const bin = path.join(root, 'bin'), log = path.join(root, 'calls.log');
  await mkdir(bin);
  if (tunnelInitiallyReady) await writeFile(path.join(root, '.fake-tunnel-ready'), '');
  const npm = `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path');
const args=process.argv.slice(2);
fs.appendFileSync(process.env.SETUP_TEST_LOG,args.join(' ')+'\\n');
if(args[0]==='--version'){console.log('10.0.0');process.exit(0);}
if(args[0]==='ci'){fs.mkdirSync(path.join(process.env.SETUP_TEST_ROOT,'node_modules'),{recursive:true});process.exit(0);}
if(args[0]==='run'&&args[1]==='--silent'&&args[2]==='tunnel:setup'){
  if(fs.existsSync(path.join(process.env.SETUP_TEST_ROOT,'.fake-tunnel-ready'))){console.log('{"variant":"tunnel-client-runtime"}');process.exit(0);}
  process.exit(1);
}
if(args[0]==='run'&&args[1]==='tunnel:setup'){fs.writeFileSync(path.join(process.env.SETUP_TEST_ROOT,'.fake-tunnel-ready'),'');process.exit(0);}
process.exit(0);
`;
  await executable(path.join(bin, 'npm'), npm);
  for (const name of tools) {
    await executable(path.join(bin, name), `#!/bin/sh\necho "${name} test-version"\n`);
  }
  const env = {
    ...process.env,
    HOME: home,
    PATH: bin,
    SETUP_TEST_ROOT: root,
    SETUP_TEST_LOG: log
  };
  const run = (args = []) => exec(process.execPath, [path.join(root, 'scripts', 'setup.mjs'), ...args], {
    cwd: root, env, timeout: 15000, maxBuffer: 1024 * 1024
  });
  return { root, bin, log, env, run, home };
}

test('setup: first full install builds pinned Tunnel path and creates private config without overwriting on rerun', async t => {
  const f = await fixture(t);
  const first = await f.run();
  assert.match(first.stdout, /setup complete/i);
  assert.equal((await stat(path.join(f.home, '.local/bin/mcp-dev-runtime'))).mode & 0o777, 0o755);
  await assert.rejects(stat(path.join(f.home, '.local/bin/mdr')), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(f.root, 'config.json'), 'utf8'), await readFile(path.join(f.root, 'config.example.json'), 'utf8'));
  assert.equal(await readFile(path.join(f.root, 'launcher.config.json'), 'utf8'), await readFile(path.join(f.root, 'launcher.config.example.json'), 'utf8'));
  assert.equal((await stat(path.join(f.root, 'runtime.env'))).mode & 0o777, 0o600);
  let calls = (await readFile(f.log, 'utf8')).trim().split('\n');
  assert(calls.includes('ci --include=dev'));
  assert(calls.includes('run build'));
  assert(calls.includes('run --silent tunnel:setup'));
  assert(calls.includes('run tunnel:setup -- --build'));
  assert(calls.includes('run doctor -- --config config.json --offline'));

  await writeFile(path.join(f.root, 'config.json'), '{"user":"keep-me"}\n');
  await writeFile(path.join(f.root, 'runtime.env'), 'PRIVATE=keep-me\n');
  const second = await f.run();
  assert.match(second.stdout, /skipping npm ci/i);
  assert.match(second.stdout, /Kept existing config\.json/);
  assert.match(second.stdout, /Compatible Tunnel client found/);
  assert.equal(await readFile(path.join(f.root, 'config.json'), 'utf8'), '{"user":"keep-me"}\n');
  assert.equal(await readFile(path.join(f.root, 'runtime.env'), 'utf8'), 'PRIVATE=keep-me\n');
  calls = (await readFile(f.log, 'utf8')).trim().split('\n');
  assert.equal(calls.filter(x => x === 'ci --include=dev').length, 1);
  assert.equal(calls.filter(x => x === 'run tunnel:setup -- --build').length, 1);
});

test('setup: embedded mode leaves the user global command directory untouched', async t => {
  const f = await fixture(t, { tools: [] });
  await f.run(['--local-only', '--no-global-command']);
  await assert.rejects(stat(path.join(f.home, '.local/bin')), { code: 'ENOENT' });
});

test('setup: local-only path never requires or invokes Tunnel build tools', async t => {
  const f = await fixture(t, { tools: [] });
  const result = await f.run(['--local-only']);
  assert.match(result.stdout, /Local-only mode selected/);
  const calls = await readFile(f.log, 'utf8');
  assert(!calls.includes('tunnel:setup'));
  assert(calls.includes('run doctor -- --config config.json --offline'));
});

test('setup: missing system build prerequisite fails clearly without pretending Tunnel is installed', async t => {
  const f = await fixture(t, { tools: ['git', 'make'] });
  await assert.rejects(f.run(), error => {
    assert.match(error.stderr, /go is required to build the pinned Tunnel runtime/);
    return true;
  });
  assert.equal(await readFile(path.join(f.root, '.fake-tunnel-ready'), 'utf8').catch(() => null), null);
});

test('setup: dependency refresh refuses to modify node_modules under an apparently live managed runtime', async t => {
  const f = await fixture(t);
  await mkdir(path.join(f.root, '.runtime'), { recursive: true });
  await writeFile(path.join(f.root, '.runtime', 'supervisor.json'), JSON.stringify({
    pid: process.pid, run_id: 'test-active-runtime', state: 'ready'
  }));
  await assert.rejects(f.run(), error => {
    assert.match(error.stderr, /appears to be active/);
    return true;
  });
  const calls = await readFile(f.log, 'utf8');
  assert(!calls.includes('ci --include=dev'));
});

test('setup: existing runtime.env symlink is rejected without chmodding its target', async t => {
  const f = await fixture(t, { tunnelInitiallyReady: true });
  const target = path.join(f.root, 'outside-secret');
  await writeFile(target, 'outside\n', { mode: 0o644 });
  await import('node:fs/promises').then(fs => fs.symlink(target, path.join(f.root, 'runtime.env')));
  await assert.rejects(f.run(), error => {
    assert.match(error.stderr, /runtime\.env must be a regular local file/);
    return true;
  });
  assert.equal((await stat(target)).mode & 0o777, 0o644);
  assert.equal(await readFile(target, 'utf8'), 'outside\n');
});

test('setup: help works through the public install.sh wrapper without touching the checkout', async () => {
  const before = await stat('config.json').catch(() => null);
  const result = await exec(sourceInstall, ['--help'], { cwd: path.resolve('.'), timeout: 5000 });
  assert.match(result.stdout, /--local-only/);
  const after = await stat('config.json').catch(() => null);
  assert.equal(Boolean(after), Boolean(before));
});
