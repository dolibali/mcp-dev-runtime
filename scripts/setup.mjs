#!/usr/bin/env node
import { constants } from 'node:fs';
import { access, chmod, copyFile, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installCommand, printCommandResult } from './global-command.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const argv = process.argv.slice(2);
const allowed = new Set(['--local-only', '--force-tunnel-build', '--no-global-command', '--help', '-h']);
for (const arg of argv) {
  if (!allowed.has(arg)) throw new Error(`Unknown setup option: ${arg}. Use --help for supported options.`);
}

if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`MCP Dev Runtime setup

Usage:
  ./install.sh [--local-only] [--force-tunnel-build]
  npm run setup -- [--local-only] [--force-tunnel-build]

Options:
  --local-only          Install/build MCP Dev Runtime but skip Secure MCP Tunnel setup.
  --force-tunnel-build  Rebuild the exact Tunnel source pinned by tunnel.lock.json.
  --no-global-command  Skip registration in ~/.local/bin (for CI or embedded use).
  --help, -h            Show this help.

The setup never overwrites config.json, launcher.config.json, or runtime.env.
It does not install system packages with sudo, brew, or apt.`);
  process.exit(0);
}

if (!['darwin', 'linux'].includes(process.platform)) {
  throw new Error('This release supports macOS and Linux only; native Windows setup is not supported.');
}
const major = Number(process.versions.node.split('.')[0]);
if (!Number.isInteger(major) || major < 24) {
  throw new Error(`Node.js 24+ is required; found ${process.version}.`);
}

const localOnly = argv.includes('--local-only');
const forceTunnelBuild = argv.includes('--force-tunnel-build');
process.chdir(ROOT);

const step = message => process.stdout.write(`[setup] ${message}\n`);
function run(command, args, { capture = false, allowFailure = false, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      env,
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit'
    });
    let stdout = '', stderr = '';
    if (capture) {
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
    }
    child.once('error', error => {
      if (allowFailure) resolve({ code: null, error, stdout, stderr });
      else reject(error);
    });
    child.once('close', code => {
      const result = { code, stdout, stderr };
      if (code === 0 || allowFailure) resolve(result);
      else reject(new Error(`${command} ${args.join(' ')} failed with exit ${code}`));
    });
  });
}

async function exists(file) {
  try { await access(file, constants.F_OK); return true; }
  catch { return false; }
}

async function requireCommand(command, args, purpose) {
  const result = await run(command, args, { capture: true, allowFailure: true });
  if (result.code !== 0) {
    throw new Error(`${command} is required ${purpose}. Install it using its official/system package instructions, then rerun setup. System packages are never installed automatically.`);
  }
  return (result.stdout || result.stderr).trim().split('\n')[0] ?? '';
}

async function copyIfMissing(source, destination, mode) {
  try {
    await copyFile(path.join(ROOT, source), path.join(ROOT, destination), constants.COPYFILE_EXCL);
    if (mode) await chmod(path.join(ROOT, destination), mode);
    step(`Created ${destination} from ${source}.`);
    return true;
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    step(`Kept existing ${destination}; setup never overwrites it.`);
    return false;
  }
}

async function packageLockHash() {
  return createHash('sha256').update(await readFile(path.join(ROOT, 'package-lock.json'))).digest('hex');
}

function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === 'EPERM'; }
}

async function refuseSetupWhileManagedRuntimeIsAlive() {
  const stateFile = path.join(ROOT, '.runtime', 'supervisor.json');
  if (!(await exists(stateFile))) return;
  let state;
  try { state = JSON.parse(await readFile(stateFile, 'utf8')); }
  catch {
    throw new Error('Cannot safely inspect .runtime/supervisor.json before refreshing dependencies. Review the local runtime state first.');
  }
  if (['starting', 'ready', 'stopping'].includes(state?.state) && pidAlive(state?.pid)) {
    throw new Error('A launcher-managed MCP Dev Runtime appears to be active. Setup will not rebuild files or replace dependencies underneath a running service. Inspect active work, stop the owned instance with npm run down, then rerun setup.');
  }
}

step(`Using ${process.version} on ${process.platform}/${process.arch}.`);
await requireCommand('npm', ['--version'], 'to install project dependencies');
await refuseSetupWhileManagedRuntimeIsAlive();

const setupState = path.join(ROOT, '.runtime', 'setup');
const dependencyMarker = path.join(setupState, 'package-lock.sha256');
const lockHash = await packageLockHash();
let installedHash = '';
try { installedHash = (await readFile(dependencyMarker, 'utf8')).trim(); } catch {}
const nodeModulesPresent = await exists(path.join(ROOT, 'node_modules'));
let dependenciesCurrent = nodeModulesPresent && installedHash === lockHash;
if (dependenciesCurrent) {
  const npmTree = await run('npm', ['ls', '--depth=0', '--include=dev'], { capture: true, allowFailure: true });
  if (npmTree.code !== 0) {
    step('Installed dependencies no longer validate; npm ci will restore the exact lock.');
    dependenciesCurrent = false;
  }
}

if (dependenciesCurrent) {
  step('Dependencies already match this package-lock.json; skipping npm ci.');
} else {
  step('Installing exact npm dependencies from package-lock.json...');
  await run('npm', ['ci', '--include=dev']);
  await mkdir(setupState, { recursive: true, mode: 0o700 });
  await writeFile(dependencyMarker, lockHash + '\n', { mode: 0o600 });
}

step('Building MCP Dev Runtime...');
await run('npm', ['run', 'build']);

await copyIfMissing('config.example.json', 'config.json');
await copyIfMissing('launcher.config.example.json', 'launcher.config.json');
await copyIfMissing('.env.example', 'runtime.env', 0o600);
const envInfo = await lstat(path.join(ROOT, 'runtime.env'));
if (!envInfo.isFile() || envInfo.isSymbolicLink()) {
  throw new Error('runtime.env must be a regular local file, not a directory or symlink. Refusing to change permissions on another target.');
}
await chmod(path.join(ROOT, 'runtime.env'), 0o600);

if (localOnly) {
  step('Local-only mode selected; Secure MCP Tunnel setup was skipped.');
} else {
  let compatible = { code: 1, stdout: '', stderr: '' };
  if (!forceTunnelBuild) {
    step('Checking for an already compatible pinned Tunnel client...');
    compatible = await run('npm', ['run', '--silent', 'tunnel:setup'], { capture: true, allowFailure: true });
  }
  if (forceTunnelBuild || compatible.code !== 0) {
    step('Preparing the exact Tunnel source pinned by tunnel.lock.json...');
    await requireCommand('git', ['--version'], 'to fetch the pinned Tunnel source');
    await requireCommand('make', ['--version'], 'to build the pinned Tunnel runtime');
    await requireCommand('go', ['version'], 'to build the pinned Tunnel runtime');
    await run('npm', ['run', 'tunnel:setup', '--', '--build']);
  } else {
    step('Compatible Tunnel client found; reusing the verified local binary.');
  }
}

step('Running offline configuration diagnostics...');
await run('npm', ['run', 'doctor', '--', '--config', 'config.json', '--offline']);

if (!argv.includes('--no-global-command')) {
  step('Registering the user-level mcp-dev-runtime command...');
  printCommandResult(await installCommand());
}

console.log('');
console.log('MCP Dev Runtime setup complete.');
console.log(`Project: ${ROOT}`);
if (!argv.includes('--no-global-command')) console.log('From any directory: mcp-dev-runtime --help / status / doctor / down');
if (localOnly) {
  console.log('Next: start local HTTP with "npm start -- --config config.json", or configure stdio in your MCP client.');
} else {
  console.log('Next: edit runtime.env and replace both placeholders with your own Tunnel ID and runtime API key.');
  console.log('Then start with: npm run up -- --env-file runtime.env --background');
  console.log('Verify with: npm run doctor');
  console.log('Do not commit runtime.env or paste its API key into chat.');
}
