#!/usr/bin/env node
// User-owned command registration. No global npm install, shell-profile edits,
// credentials, service startup, or duplicate runtime installation.
import { constants } from 'node:fs';
import { access, link, lstat, mkdir, open, realpath, rename, stat, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const NAME = 'mcp-dev-runtime';
const SHORT_NAME = 'mdr';
const quote = text => "'" + text.replaceAll("'", "'\\''") + "'";
const absent = async file => {
  try { return await lstat(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};

async function selectedPaths(root, binDir, name) {
  if (![NAME, SHORT_NAME].includes(name)) throw new Error('Command name must be mcp-dev-runtime or mdr.');
  if (typeof binDir !== 'string' || !binDir || typeof root !== 'string' || !root) throw new Error('A nonempty source root and bin directory are required.');
  root = await realpath(root);
  binDir = path.resolve(binDir);
  for (const p of [root, binDir]) {
    if (/[\r\n\0]/.test(p)) throw new Error('Command paths cannot contain newline or NUL characters.');
  }
  const header = '#!/bin/sh\n# mcp-dev-runtime managed command v1\n# source-root: ' +
    Buffer.from(root).toString('base64') + '\n';
  return { root, binDir, name, destination: path.join(binDir, name), header };
}

async function ownedCommand(destination, header) {
  const info = await absent(destination);
  if (!info) return null;
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid()) {
    throw new Error(`Refusing to replace or remove an unrelated command: ${destination}`);
  }
  const handle = await open(destination, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const current = await handle.stat();
    if (current.ino !== info.ino || current.dev !== info.dev || current.size > 32768) {
      throw new Error(`Command changed during inspection: ${destination}`);
    }
    const text = await handle.readFile('utf8');
    if (!text.startsWith(header)) {
      throw new Error(`Command already belongs to another installation or program: ${destination}. No file was overwritten.`);
    }
    return { info: current, text };
  } finally { await handle.close(); }
}

async function checkUnchanged(destination, previous) {
  const now = await absent(destination);
  if (!now || !now.isFile() || now.ino !== previous.ino || now.dev !== previous.dev ||
      now.size !== previous.size || now.mtimeMs !== previous.mtimeMs) {
    throw new Error(`Command changed concurrently; refusing to replace or remove it: ${destination}`);
  }
}

async function executableFile(file) {
  try { await access(file, constants.X_OK); return (await stat(file)).isFile(); }
  catch (error) {
    if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ELOOP'].includes(error.code)) return false;
    throw error;
  }
}

async function refuseShortNameConflict({ name, destination }) {
  if (name !== SHORT_NAME) return;
  const ownPath = await realpath(destination).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  // Check every PATH entry, including later entries that our new wrapper
  // would shadow. Never execute a foreign command to identify its owner.
  for (const dir of new Set((process.env.PATH ?? '').split(path.delimiter))) {
    const candidate = path.resolve(dir || '.', name);
    if (await executableFile(candidate) && await realpath(candidate) !== ownPath) {
      throw new Error(`Short command mdr conflicts with an existing executable: ${candidate}. No command was installed. Keep using mcp-dev-runtime; do not remove the other program to force this alias.`);
    }
  }
}

async function pathStatus(binDir, destination, name) {
  let first = null, inPath = false;
  const canonical = await realpath(binDir);
  for (const item of (process.env.PATH ?? '').split(path.delimiter)) {
    const dir = path.resolve(item || '.');
    if (await realpath(dir).catch(() => null) === canonical) inPath = true;
    if (!first) {
      const candidate = path.join(dir, name);
      if (await executableFile(candidate)) first = candidate;
    }
  }
  const shadows = first && await realpath(first).catch(() => first) !== await realpath(destination);
  return { in_path: inPath, shadowed_by: shadows ? first : null };
}

export async function installCommand({ root = ROOT, binDir = path.join(homedir(), '.local', 'bin'), node = process.execPath, name = NAME } = {}) {
  if (!['darwin', 'linux'].includes(process.platform)) throw new Error('Global command setup supports macOS/Linux only.');
  const p = await selectedPaths(root, binDir, name);
  node = await realpath(node);
  if (/[\r\n\0]/.test(node)) throw new Error('Invalid Node executable path.');
  await access(node, constants.X_OK);
  const entry = path.join(p.root, 'dist', 'launcher', 'cli.js');
  if (!(await absent(entry))?.isFile()) throw new Error('Build is missing. Run npm run build before registering the command.');
  const text = p.header + '# Uses the Node selected at registration; rerun command:install after moving/removing it.\n' +
    'if [ ! -x ' + quote(node) + ' ]; then\n' +
    "  printf '%s\\n' 'MCP Dev Runtime: registered Node no longer exists; rerun npm run command:install from the project.' >&2\n  exit 1\nfi\n" +
    'if [ ! -f ' + quote(entry) + ' ]; then\n' +
    "  printf '%s\\n' 'MCP Dev Runtime: project build was moved or removed; rebuild and register the command again.' >&2\n  exit 1\nfi\n" +
    'exec ' + quote(node) + ' ' + quote(entry) + ' "$@"\n';
  const existing = await ownedCommand(p.destination, p.header);
  await refuseShortNameConflict(p);
  await mkdir(p.binDir, { recursive: true });
  let status = 'unchanged';
  if (existing?.text === text) {
    await checkUnchanged(p.destination, existing.info);
    // Repair mode only for the command owned by this checkout.
    const handle = await open(p.destination, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const now = await handle.stat();
      if (now.ino !== existing.info.ino || now.dev !== existing.info.dev) throw new Error('Command changed during mode repair.');
      await handle.chmod(0o755);
    } finally { await handle.close(); }
  } else {
    const tmp = path.join(p.binDir, `.${name}-${randomUUID()}.tmp`);
    try {
      const handle = await open(tmp, 'wx', 0o700);
      try { await handle.writeFile(text); await handle.chmod(0o755); await handle.sync(); }
      finally { await handle.close(); }
      if (existing) {
        await checkUnchanged(p.destination, existing.info);
        await rename(tmp, p.destination);
        status = 'updated';
      } else {
        // Atomic no-clobber publication of a complete executable file.
        await link(tmp, p.destination);
        status = 'created';
      }
    } finally { await unlink(tmp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
  return { status, name, path: p.destination, source_root: p.root, node, ...await pathStatus(p.binDir, p.destination, name) };
}

export async function removeCommand({ root = ROOT, binDir = path.join(homedir(), '.local', 'bin'), name = NAME } = {}) {
  const p = await selectedPaths(root, binDir, name);
  const existing = await ownedCommand(p.destination, p.header);
  if (!existing) return { status: 'absent', path: p.destination };
  await checkUnchanged(p.destination, existing.info);
  await unlink(p.destination);
  return { status: 'removed', path: p.destination };
}

export function printCommandResult(result) {
  console.log(`Global command ${result.status}: ${result.path}`);
  if (result.in_path === false) {
    console.log('Add this directory to PATH for your terminal (shell profiles are not edited automatically):');
    console.log('export PATH=' + quote(path.dirname(result.path)) + ':"$PATH"');
    console.log('Put that export in your shell profile for future terminals, or use the full command path now.');
  }
  if (result.shadowed_by) console.log(`Warning: an earlier PATH entry takes precedence: ${result.shadowed_by}`);
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  try {
    const { values } = parseArgs({ options: { 'bin-dir': { type: 'string' }, name: { type: 'string' }, remove: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } } });
    if (values.help) console.log('node scripts/global-command.mjs [--bin-dir PATH] [--name mcp-dev-runtime|mdr] [--remove]\nDefault: mcp-dev-runtime. Opt in to mdr only when no other mdr executable is on PATH.\nRegister/remove only the selected command owned by this checkout. No services or shell profiles are changed.');
    else printCommandResult(await (values.remove ? removeCommand : installCommand)({ binDir: values['bin-dir'], name: values.name }));
  } catch (error) { console.error(`MCP Dev Runtime command: ${error.message}`); process.exitCode = 1; }
}
