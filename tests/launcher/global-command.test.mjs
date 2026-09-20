import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, chmod, symlink, cp, realpath } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import { installCommand, removeCommand } from '../../scripts/global-command.mjs';
import { stopManaged } from '../../dist/launcher/supervisor.js';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const exec = promisify(execFile);
const repo = process.cwd();
async function fixture(t) {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'gcli-')));
  const root = path.join(dir, "项目 ' $HOME"), binDir = path.join(dir, 'user bin'), caller = path.join(dir, 'elsewhere');
  await mkdir(path.join(root, 'dist/launcher'), { recursive: true });
  await mkdir(caller);
  // CJS test entry point lets wrapper tests see argv/cwd without invoking services.
  await writeFile(path.join(root, 'dist/launcher/cli.js'), 'console.log(JSON.stringify({args:process.argv.slice(2),cwd:process.cwd()}));');
  const f = { dir, root, binDir, caller, cleanup: [] };
  t.after(async () => { for (const close of f.cleanup.reverse()) await close(); await rm(dir, { recursive: true, force: true }); });
  return f;
}

test('global command: handles spaces, quotes, Unicode and literal arguments without changing caller cwd', async t => {
  const f = await fixture(t), result = await installCommand(f);
  assert.equal(result.status, 'created');
  assert.equal((await stat(result.path)).mode & 0o777, 0o755);
  const args = ['literal space', "'quoted'", '中文', '$(touch unwanted)', '--config=relative file'];
  const r = await exec(result.path, args, { cwd: f.caller, env: { ...process.env, PATH: '/bin' } });
  assert.deepEqual(JSON.parse(r.stdout), { args, cwd: f.caller });
  assert.equal(result.in_path, false);
  await assert.rejects(stat(path.join(f.caller, 'unwanted')), { code: 'ENOENT' });
});

test('global command: repeated installation repairs only its own mode and removal preserves project files', async t => {
  const f = await fixture(t), r = await installCommand(f);
  const text = await readFile(r.path, 'utf8');
  await chmod(r.path, 0o600);
  assert.equal((await installCommand(f)).status, 'unchanged');
  assert.equal(await readFile(r.path, 'utf8'), text);
  assert.equal((await stat(r.path)).mode & 0o777, 0o755);
  await writeFile(r.path, text + '# previous managed wrapper\n');
  assert.equal((await installCommand(f)).status, 'updated');
  assert.equal(await readFile(r.path, 'utf8'), text);
  assert.equal((await removeCommand(f)).status, 'removed');
  assert.equal((await removeCommand(f)).status, 'absent');
  assert((await stat(path.join(f.root, 'dist/launcher/cli.js'))).isFile());
});

test('global command: PATH membership and earlier command shadowing are reported accurately', async t => {
  const f = await fixture(t), old = process.env.PATH;
  const earlier = path.join(f.dir, 'earlier'); await mkdir(earlier);
  const other = path.join(earlier, 'mcp-dev-runtime'); await writeFile(other, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  try {
    process.env.PATH = f.binDir + ':/bin';
    const r = await installCommand(f); assert.equal(r.in_path, true); assert.equal(r.shadowed_by, null);
    process.env.PATH = earlier + ':' + process.env.PATH;
    const q = await installCommand(f); assert.equal(q.in_path, true); assert.equal(q.shadowed_by, other);
  } finally { if (old === undefined) delete process.env.PATH; else process.env.PATH = old; }
});

test('global command: never overwrites or uninstalls another program or a different checkout', async t => {
  const f = await fixture(t); await mkdir(f.binDir);
  const file = path.join(f.binDir, 'mcp-dev-runtime'); await writeFile(file, 'unrelated');
  await assert.rejects(installCommand(f), /another installation or program/);
  await assert.rejects(removeCommand(f), /another installation or program/);
  assert.equal(await readFile(file, 'utf8'), 'unrelated');
  await rm(file); await installCommand(f);
  const other = path.join(f.dir, 'other'); await mkdir(path.join(other, 'dist/launcher'), { recursive: true });
  await writeFile(path.join(other, 'dist/launcher/cli.js'), '');
  await assert.rejects(installCommand({ ...f, root: other }), /another installation or program/);
  await assert.rejects(removeCommand({ ...f, root: other }), /another installation or program/);
});

test('global command: dangling links and directories are refused, not followed or deleted', async t => {
  const f = await fixture(t); await mkdir(f.binDir);
  const file = path.join(f.binDir, 'mcp-dev-runtime');
  await symlink(path.join(f.dir, 'missing-target'), file);
  await assert.rejects(installCommand(f), /unrelated command/);
  await assert.rejects(removeCommand(f), /unrelated command/);
  await rm(file); await mkdir(file);
  await assert.rejects(installCommand(f), /unrelated command/);
  assert((await stat(file)).isDirectory());
});

test('global command: removed project reports an actionable error, not a silent startup failure', async t => {
  const f = await fixture(t), r = await installCommand(f);
  await rm(path.join(f.root, 'dist/launcher/cli.js'));
  await assert.rejects(exec(r.path, ['status']), e => e.code === 1 && e.stderr.includes('moved or removed'));
});

test('global command: missing build never creates a command; concurrent installs never produce a partial wrapper', async t => {
  const f = await fixture(t);
  await rm(path.join(f.root, 'dist/launcher/cli.js'));
  await assert.rejects(installCommand(f), /Build is missing/);
  await assert.rejects(stat(f.binDir), { code: 'ENOENT' });
  await writeFile(path.join(f.root, 'dist/launcher/cli.js'), 'console.log("complete");');
  const results = await Promise.allSettled([installCommand(f), installCommand(f)]);
  assert(results.some(r => r.status === 'fulfilled'));
  assert.equal((await exec(path.join(f.binDir, 'mcp-dev-runtime'))).stdout, 'complete\n');
});

async function port() {
  return new Promise((resolve, reject) => {
    const s = createServer(); s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

async function installation(t) {
  const f = await fixture(t);
  await cp(path.join(repo, 'dist'), path.join(f.root, 'dist'), { recursive: true });
  await cp(path.join(repo, 'contracts'), path.join(f.root, 'contracts'), { recursive: true });
  await mkdir(path.join(f.root, 'scripts'));
  for (const n of ['doctor.mjs', 'smoke.mjs']) await cp(path.join(repo, 'scripts', n), path.join(f.root, 'scripts', n));
  await symlink(path.join(repo, 'node_modules'), path.join(f.root, 'node_modules'), 'dir');
  await cp(path.join(repo, 'package.json'), path.join(f.root, 'package.json'));
  await cp(path.join(repo, 'tunnel.lock.json'), path.join(f.root, 'tunnel.lock.json'));
  f.mp = await port(); f.tp = await port();
  while (f.tp === f.mp) f.tp = await port();
  f.state = path.join(f.dir, 'state');
  f.config = { transport: 'http', host: '127.0.0.1', port: f.mp, cwd: '.', shell: '/bin/bash', history: { enabled: false }, log_level: 'silent' };
  await writeFile(path.join(f.root, 'config.json'), JSON.stringify(f.config));
  const fake = path.join(f.dir, 'fake.cjs');
  await writeFile(fake, `#!${process.execPath}
const http=require('node:http'),args=process.argv.slice(2);
if(args.includes('--version')){console.log('0.0.14 git sha: 70bb5a7 go: test flavor=runtime');process.exit(0);}
if(args.includes('--help')){console.log('  run  Mock only');process.exit(0);}
const port=Number(args.find(x=>x.startsWith('--health.listen-addr=')).split(':').at(-1));
const s=http.createServer((q,r)=>r.end('ready'));s.listen(port,'127.0.0.1');
process.on('SIGTERM',()=>s.close(()=>process.exit(0)));
`, { mode: 0o755 });
  const envFile = path.join(f.dir, 'test.env');
  await writeFile(envFile, 'CONTROL_PLANE_TUNNEL_ID=tunnel_' + '0'.repeat(32) + '\nCONTROL_PLANE_API_KEY=local-mock-only\n');
  const launcher = { runtime_config: 'config.json', state_dir: f.state, tunnel_bin: fake, tunnel_health_port: f.tp, env_file: envFile };
  await writeFile(path.join(f.root, 'launcher.config.json'), JSON.stringify(launcher));
  f.command = (await installCommand(f)).path;
  f.env = { ...process.env, CONTROL_PLANE_TUNNEL_ID: '', CONTROL_PLANE_API_KEY: '', OPENAI_API_KEY: '', NODE_TEST_CONTEXT: '' };
  f.run = (args, cwd = f.caller) => exec(f.command, args, { cwd, env: f.env, timeout: 25000, maxBuffer: 1024 * 1024 });
  f.cleanup.push(async () => { await stopManaged(f.state).catch(() => {}); });
  return f;
}

test('global CLI: default config, doctor, smoke, repeat up and down address one installation from different directories', async t => {
  const f = await installation(t);
  // A same-named config in the caller's directory must NOT redirect management.
  await writeFile(path.join(f.caller, 'config.json'), '{"unexpected":true}');
  const first = JSON.parse((await f.run(['up', '--background', '--env-file', '../test.env'])).stdout);
  assert.equal(first.state, 'ready');
  const again = JSON.parse((await f.run(['up', '--background'], f.dir)).stdout);
  assert.equal(again.run_id, first.run_id); assert.equal(again.already_running, true);
  const d = JSON.parse((await f.run(['doctor', '--json'])).stdout);
  assert.equal(d.ok, true); assert.equal(d.cwd, f.root); assert.equal(d.protocol.commands_executed, 0);
  assert.equal(d.supervisor.run_id, first.run_id);
  assert.match((await f.run(['smoke'])).stdout, /LOCAL MCP SMOKE PASSED/);
  assert.equal(JSON.parse((await f.run(['status'])).stdout).run_id, first.run_id);
  assert.equal(JSON.parse((await f.run(['down'], f.dir)).stdout).state, 'stopped');
});

test('global CLI: relative --config and --launcher-config paths are caller-relative, including --flag=value', async t => {
  const f = await installation(t);
  await writeFile(path.join(f.caller, 'runtime file.json'), JSON.stringify({ ...f.config, cwd: f.caller }));
  const d = JSON.parse((await f.run(['doctor', '--config=runtime file.json', '--offline', '--json'])).stdout);
  assert.equal(d.cwd, f.caller); assert.equal(d.configuration_file, path.join(f.caller, 'runtime file.json'));
  await writeFile(path.join(f.caller, 'launch file.json'), JSON.stringify({ runtime_config: 'runtime file.json', state_dir: 'other-state' }));
  const q = JSON.parse((await f.run(['doctor', '--launcher-config', 'launch file.json', '--offline', '--json'])).stdout);
  assert.equal(q.configuration_file, path.join(f.caller, 'runtime file.json'));
  await assert.rejects(f.run(['doctor', '--config', '--json']), /Missing path/);
  await assert.rejects(f.run(['smoke', 'one', 'two']), /at most one endpoint/);
});

test('global CLI: stdio serve keeps the caller workspace and returns no command-registration banner', async t => {
  const f = await installation(t);
  const config = path.join(f.caller, 'stdio.json');
  await writeFile(config, JSON.stringify({ ...f.config, transport: 'stdio' }));
  const client = new Client({ name: 'global-cli-stdio-test', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: f.command, args: ['serve', '--transport', 'stdio', '--config', config], cwd: f.caller, env: f.env, stderr: 'pipe' });
  f.cleanup.push(() => client.close());
  await client.connect(transport);
  assert.equal((await client.listTools()).tools.length, 6);
  const r = await client.callTool({ name: 'exec_command', arguments: { cmd: 'pwd', yield_time_ms: 1000 } });
  assert.equal(r.structuredContent.exit_code, 0); assert.equal(r.structuredContent.output.trim(), f.caller);
  await client.close();
});
