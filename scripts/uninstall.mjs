#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { confirmCompleteUninstall, dedupeDeletionRoots, expandConfiguredPath, isInside, readJsonIfPresent, removeOwnedCommand, removeOwnedPath, stopManagedState } from './uninstall-lib.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
export async function uninstallSource({
  root = ROOT,
  binDir,
  confirm = confirmCompleteUninstall,
  log = message => console.log(message)
} = {}) {
  root = await realpath(path.resolve(root));
  const launcherFile = path.join(root, 'launcher.config.json');
  const launcher = await readJsonIfPresent(launcherFile).catch(error => { throw new Error('Cannot inspect launcher.config.json safely: ' + error.message); });
  const runtime = await readJsonIfPresent(path.join(root, 'config.json')).catch(error => { throw new Error('Cannot inspect config.json safely: ' + error.message); });
  const unified = !!runtime && typeof runtime === 'object' && (
    runtime.schema_version === 1 || runtime.mcp || runtime.tunnel || runtime.runtime || runtime.logging || runtime.request_cache
  );
  const unifiedRuntime = unified && runtime.runtime && typeof runtime.runtime === 'object' ? runtime.runtime : {};
  const resolveLocal = value => typeof value === 'string' && value ? path.resolve(root, value) : null;
  const stateDir = resolveLocal(launcher?.state_dir) ?? resolveLocal(unifiedRuntime.state_dir) ?? path.join(root, '.runtime');
  const logsDir = resolveLocal(launcher?.logs_dir) ?? resolveLocal(unifiedRuntime.logs_dir) ?? stateDir;
  const cwdValue = unified
    ? (typeof unifiedRuntime.cwd === 'string' && unifiedRuntime.cwd ? unifiedRuntime.cwd : root)
    : (typeof runtime?.cwd === 'string' && runtime.cwd ? runtime.cwd : root);
  let historyBase = expandConfiguredPath(cwdValue, root);
  historyBase = await realpath(historyBase).catch(() => historyBase);
  const historyValue = typeof runtime?.history?.directory === 'string' && runtime.history.directory
    ? runtime.history.directory
    : '.mcp-dev-runtime/history';
  let historyDir = expandConfiguredPath(historyValue, historyBase);
  historyDir = await realpath(historyDir).catch(() => historyDir);
  const external = [stateDir, logsDir, historyDir].filter(p => !isInside(root, p));
  const generatedInsideCheckout = p => isInside(root, p) && path.resolve(p) !== root ? p : null;
  const localGenerated = dedupeDeletionRoots([
    path.join(root, '.runtime'),
    path.join(root, '.mcp-dev-runtime'),
    generatedInsideCheckout(stateDir),
    generatedInsideCheckout(logsDir),
    generatedInsideCheckout(historyDir),
    path.join(root, 'config.json'),
    launcherFile,
    path.join(root, 'runtime.env'),
    path.join(root, 'dist'),
    path.join(root, 'node_modules')
  ]);
  const displayBin = binDir ?? path.join(process.env.HOME ?? '~', '.local', 'bin');
  const commandHeader = '#!/bin/sh\n# mcp-dev-runtime managed command v1\n# source-root: ' + Buffer.from(root).toString('base64') + '\n';
  const commandDirs = [...new Set([
    path.resolve(binDir ?? path.join(homedir(), '.local', 'bin')),
    ...(process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map(dir => path.resolve(dir))
  ])];
  const lines = [
    path.join(displayBin, 'mcp-dev-runtime') + ' (only if owned by this checkout)',
    path.join(displayBin, 'mdr') + ' (only if owned by this checkout)',
    'Any matching owned mcp-dev-runtime/mdr wrapper currently on PATH',
    ...localGenerated,
    'Git checkout kept: ' + root
  ];
  if (external.length) lines.push(...external.map(p => 'External custom runtime path kept for safety: ' + p));
  if (!await confirm(lines)) {
    log('Uninstall cancelled. Nothing was removed.');
    return { status: 'cancelled', removed: [] };
  }
  // Stop the selected managed instance before deleting any files. Never signal a PID loaded from disk.
  await stopManagedState(stateDir);
  const removed = [];
  for (const dir of commandDirs) {
    for (const name of ['mcp-dev-runtime', 'mdr']) {
      const result = await removeOwnedCommand(path.join(dir, name), commandHeader);
      if (result.status === 'removed') { removed.push(result.path); log('Removed command: ' + result.path); }
    }
  }
  for (const target of localGenerated) {
    if (await removeOwnedPath(target, { root })) { removed.push(target); log('Removed: ' + target); }
  }
  if (external.length) log('External custom state/log/history paths were stopped when applicable but kept; remove them manually after verifying ownership.');
  log('Source uninstall complete. The Git checkout itself was kept.');
  return { status: 'removed', removed, external_kept: external };
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log('MCP Dev Runtime source uninstall\n\n./uninstall.sh\n\nCompletely removes this checkout\'s MDR commands, local configuration, credentials, runtime/history state and generated build/dependency directories. The Git checkout itself is never deleted.');
  } else {
    if (args.length) throw new Error('uninstall.sh takes no options. Run it and confirm with y when prompted.');
    await uninstallSource();
  }
}
