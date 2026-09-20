import { cp, lstat, mkdir, readFile, readlink, realpath, rename, rm, symlink, unlink, writeFile, access, link, chmod } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { layout } from '../../dist/launcher/layout.js';
import { options } from '../../dist/launcher/options.js';
import { current } from '../../dist/launcher/supervisor.js';
import { initializeUser } from '../../dist/launcher/initialize.js';
import { privateDirectory } from '../../dist/launcher/private-files.js';
import { shellQuote, verifyBundle } from './bundle-lib.mjs';

const { values } = parseArgs({ options: { prefix: { type: 'string' }, 'bin-dir': { type: 'string' },
  'no-global-command': { type: 'boolean' }, unregister: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } } });
if (values.help) {
  console.log('Precompiled MDR installer (offline; no system Node/npm/Go required)\ninstall.sh [--prefix DIR] [--bin-dir DIR] [--no-global-command]\ninstall.sh --unregister [--prefix DIR] [--bin-dir DIR]\nNo sudo, shell-profile changes, automatic service restart or credential migration.');
  process.exit(0);
}
const l = layout();
if (l.mode !== 'binary') throw new Error('Run this installer from an extracted precompiled bundle.');
const source = await realpath(l.bundle_root);
const prefix = path.resolve(values.prefix ?? l.releases_dir);
const bin = path.resolve(values['bin-dir'] ?? path.join(homedir(), '.local', 'bin'));
if ([prefix, bin].some(s => /[\0\r\n]/.test(s))) throw new Error('Invalid installation path.');
if ([prefix, bin].some(p => p === source || p.startsWith(source + path.sep))) throw new Error('The install prefix and command directory must be outside the extracted package.');
const header = '#!/bin/sh\n# mcp-dev-runtime binary command v1\n# install-prefix: ' + Buffer.from(prefix).toString('base64') + '\n';
const commandText = header + 'exec ' + shellQuote(path.join(prefix, 'current', 'runtime', 'node')) + ' ' +
  shellQuote(path.join(prefix, 'current', 'app', 'dist', 'launcher', 'cli.js')) + ' "$@"\n';
async function existing(file) { try { return await lstat(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }
async function ownedCommand(file) {
  const s = await existing(file);
  if (!s) return false;
  if (!s.isFile() || s.isSymbolicLink() || s.uid !== process.getuid() || !(await readFile(file, 'utf8')).startsWith(header)) throw new Error('Command conflict; no foreign command will be overwritten: ' + file);
  return true;
}
async function shortConflict() {
  try { await ownedCommand(path.join(bin, 'mdr')); } catch (e) { return e.message; }
  const own = path.resolve(bin, 'mdr');
  for (const dir of new Set((process.env.PATH ?? '').split(path.delimiter))) {
    const candidate = path.resolve(dir || '.', 'mdr');
    if (candidate === own) continue;
    try {
      await access(candidate, constants.X_OK);
      if ((await lstat(candidate)).isDirectory()) continue;
      if (await realpath(candidate) === await realpath(own).catch(() => null)) continue;
      return 'Existing mdr on PATH: ' + candidate;
    } catch (e) { if (!['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ELOOP'].includes(e.code)) throw e; }
  }
  return null;
}
async function register(name) {
  const destination = path.join(bin, name);
  const owned = await ownedCommand(destination);
  const before = owned ? await lstat(destination) : null;
  const temporary = path.join(bin, '.mdr-command-' + randomUUID());
  try {
    await writeFile(temporary, commandText, { flag: 'wx', mode: 0o755 });
    if (before) {
      const now = await lstat(destination);
      if (before.ino !== now.ino || before.dev !== now.dev || before.mtimeMs !== now.mtimeMs) throw new Error('Command changed during registration; refusing replacement: ' + destination);
      await ownedCommand(destination);
      await rename(temporary, destination);
    } else await link(temporary, destination); // Exclusive: a concurrent foreign entry cannot be overwritten.
  } finally { await unlink(temporary).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
  console.log('Registered: ' + destination);
}
async function installStableUninstaller() {
  const destination = path.join(l.config_dir, 'uninstall.sh');
  const uninstallHeader = '#!/bin/sh\n# mcp-dev-runtime binary uninstaller v1\n# install-prefix: ' + Buffer.from(prefix).toString('base64') + '\n';
  const text = uninstallHeader + 'set -eu\nexec ' +
    shellQuote(path.join(prefix, 'current', 'runtime', 'node')) + ' ' +
    shellQuote(path.join(prefix, 'current', 'app', 'scripts', 'release', 'uninstall.mjs')) +
    ' --prefix ' + shellQuote(prefix) + ' --bin-dir ' + shellQuote(bin) + ' "$@"\n';
  const current = await existing(destination);
  let before = null;
  if (current) {
    if (!current.isFile() || current.isSymbolicLink() || current.uid !== process.getuid()) {
      throw new Error('Refusing to replace unrelated uninstaller: ' + destination);
    }
    const prior = await readFile(destination, 'utf8');
    if (!prior.startsWith('#!/bin/sh\n# mcp-dev-runtime binary uninstaller v1\n')) {
      throw new Error('Refusing to replace unrelated uninstaller: ' + destination);
    }
    before = current;
  }
  const temporary = destination + '.tmp-' + randomUUID();
  try {
    await writeFile(temporary, text, { flag: 'wx', mode: 0o700 });
    await chmod(temporary, 0o700);
    if (before) {
      const now = await lstat(destination);
      if (!now.isFile() || now.isSymbolicLink() || before.dev !== now.dev || before.ino !== now.ino ||
          before.mtimeMs !== now.mtimeMs || before.size !== now.size) {
        throw new Error('Uninstaller changed during installation; refusing replacement: ' + destination);
      }
      await rename(temporary, destination);
    } else {
      await link(temporary, destination); // Exclusive: never overwrite a concurrently created file.
      await unlink(temporary);
    }
  } finally { await unlink(temporary).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
  console.log('Uninstaller: ' + destination);
}
if (values.unregister) {
  for (const name of ['mcp-dev-runtime', 'mdr']) {
    const file = path.join(bin, name);
    if (await ownedCommand(file)) { await unlink(file); console.log('Unregistered: ' + file); }
  }
  console.log('Installed versions, configuration, logs and running services were not removed.');
  process.exit(0);
}

const manifest = await verifyBundle(source);
// Check the canonical entry before installing; --no-global-command permits coexisting with a source checkout.
if (!values['no-global-command']) await ownedCommand(path.join(bin, 'mcp-dev-runtime'));
await privateDirectory(prefix);
const marker = path.join(prefix, '.mdr-releases.json');
if (await existing(marker)) {
  const s = await lstat(marker);
  if (!s.isFile() || s.isSymbolicLink() || JSON.parse(await readFile(marker, 'utf8')).project !== manifest.project) throw new Error('Foreign installation prefix.');
} else await writeFile(marker, JSON.stringify({ project: manifest.project, schema_version: 1 }) + '\n', { flag: 'wx', mode: 0o600 });
const lock = path.join(prefix, '.install.lock');
await mkdir(lock, { mode: 0o700 }).catch(e => { if (e.code === 'EEXIST') throw new Error('Another installation is in progress (or an interrupted install lock needs inspection): ' + lock); throw e; });
let staging;
try {
  const o = await options();
  const state = await current(o.state_dir);
  if (!['stopped', 'stale'].includes(state.state)) throw new Error('The selected managed service is active or unreachable. Inspect tasks and stop it with mcp-dev-runtime down before changing installed versions.');
  const currentLink = path.join(prefix, 'current');
  const cur = await existing(currentLink);
  if (cur) {
    if (!cur.isSymbolicLink()) throw new Error('Refusing to replace a non-symlink current entry.');
    const target = await readlink(currentLink);
    if (path.isAbsolute(target) || path.dirname(target) !== '.') throw new Error('Refusing a current link outside this version directory.');
  }
  const versionDir = manifest.version + '-' + manifest.platform + '-' + manifest.arch;
  const destination = path.join(prefix, versionDir);
  if (await existing(destination)) {
    const info = await lstat(destination);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Refusing a foreign/symlink version directory.');
    const old = await verifyBundle(destination);
    if (JSON.stringify(old) !== JSON.stringify(manifest)) throw new Error('This version directory contains different files. Refusing to overwrite a release in place.');
    console.log('Reusing verified installation: ' + destination);
  } else {
    staging = path.join(prefix, '.install-' + randomUUID());
    await cp(source, staging, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false });
    await verifyBundle(staging);
    await rename(staging, destination); staging = null;
  }
  const config = await initializeUser();
  const nextLink = path.join(prefix, '.current-' + randomUUID());
  try { await symlink(versionDir, nextLink); await rename(nextLink, currentLink); }
  finally { await unlink(nextLink).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
  await installStableUninstaller();
  if (!values['no-global-command']) {
    await mkdir(bin, { recursive: true });
    await register('mcp-dev-runtime');
    const conflict = await shortConflict();
    if (conflict) console.log('Skipped short command mdr: ' + conflict);
    else {
      try { await register('mdr'); }
      catch (e) {
        if (e.code === 'EEXIST' || e.message.startsWith('Command conflict')) console.log('Skipped short command mdr: ' + e.message);
        else throw e;
      }
    }
    if (!(process.env.PATH ?? '').split(path.delimiter).map(p => path.resolve(p || '.')).includes(bin)) {
      console.log('Add to your shell PATH (profiles were not edited):\nexport PATH=' + shellQuote(bin) + ':"$PATH"');
    }
  }
  console.log('Installed: ' + destination);
  console.log('Configuration preserved; fill missing credentials locally in: ' + config.env_file);
  console.log('Complete uninstall: ' + path.join(l.config_dir, 'uninstall.sh'));
  console.log('Run: ' + shellQuote(path.join(destination, 'bin', 'mcp-dev-runtime')) + ' doctor --offline');
  console.log('Then: mcp-dev-runtime up --background');
  console.log('Publisher signing/notarization: SKIPPED. Verify SHA256SUMS from the release before running.');
} finally {
  if (staging) await rm(staging, { recursive: true, force: true });
  await rm(lock, { recursive: true });
}
