import { homedir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { readFile, realpath } from 'node:fs/promises';
import { layout } from '../../dist/launcher/layout.js';
import { options } from '../../dist/launcher/options.js';
import { loadConfig } from '../../dist/config.js';
import { confirmCompleteUninstall, dedupeDeletionRoots, expandConfiguredPath, info, isInside, removeOwnedCommand, removeOwnedPath, requireOwnedDirectory, stopManagedState } from '../uninstall-lib.mjs';

const { values } = parseArgs({ options: { prefix: { type: 'string' }, 'bin-dir': { type: 'string' }, help: { type: 'boolean', short: 'h' } } });
if (values.help) {
  console.log('MCP Dev Runtime precompiled uninstall\n\nuninstall.sh\n\nStops the owned managed instance, then permanently removes MDR commands, all installed versions, configuration, credentials, state/history, logs and cache. Confirmation with y is required.');
  process.exit(0);
}
const l = layout();
if (l.mode !== 'binary') throw new Error('Run the source checkout ./uninstall.sh instead.');
const prefix = path.resolve(values.prefix ?? l.releases_dir);
const bin = path.resolve(values['bin-dir'] ?? path.join(homedir(), '.local', 'bin'));
if ([prefix, bin].some(s => /[\0\r\n]/.test(s))) throw new Error('Invalid uninstall path.');

// A non-default prefix is trusted only when it carries our installation marker.
const marker = path.join(prefix, '.mdr-releases.json');
const markerInfo = await info(marker);
if (markerInfo) {
  if (!markerInfo.isFile() || markerInfo.isSymbolicLink() || markerInfo.uid !== process.getuid()) throw new Error('Refusing unsafe installation marker: ' + marker);
  const value = JSON.parse(await readFile(marker, 'utf8'));
  if (value.project !== 'mcp-dev-runtime' || value.schema_version !== 1) throw new Error('Foreign installation prefix; refusing uninstall: ' + prefix);
  await requireOwnedDirectory(prefix, 'installation prefix');
} else if (await info(prefix)) {
  throw new Error('Installation prefix exists without the MDR marker; refusing recursive deletion: ' + prefix);
}

const o = await options();
const stateDir = o.state_dir;
const logsDir = o.logs_dir ?? o.state_dir;
const knownRoots = [l.config_dir, l.state_dir, l.logs_dir, l.cache_dir, prefix];
let historyDir = path.join(l.state_dir, 'history');
if (o.runtime_config && await info(o.runtime_config)) {
  const runtime = await loadConfig(o.runtime_config);
  historyDir = expandConfiguredPath(runtime.history.directory, runtime.cwd);
  historyDir = await realpath(historyDir).catch(() => historyDir);
}
const external = [...new Set([stateDir, logsDir, historyDir].filter(p => !knownRoots.some(root => isInside(root, p))))];
const commandHeader = '#!/bin/sh\n# mcp-dev-runtime binary command v1\n# install-prefix: ' + Buffer.from(prefix).toString('base64') + '\n';
const commandFiles = ['mcp-dev-runtime', 'mdr'].map(name => path.join(bin, name));
const deletionRoots = dedupeDeletionRoots([prefix, l.config_dir, l.state_dir, l.logs_dir, l.cache_dir]);
const lines = [
  ...commandFiles.map(p => p + ' (only if owned by this MDR installation)'),
  ...deletionRoots,
  ...external.map(p => 'External custom runtime path kept for safety: ' + p)
];
if (!await confirmCompleteUninstall(lines)) {
  console.log('\nUninstall cancelled. Nothing was removed.');
  process.exit(0);
}

// Stop before the first deletion. If an alive instance cannot be reached, fail closed.
await stopManagedState(stateDir);

for (const file of commandFiles) {
  const result = await removeOwnedCommand(file, commandHeader);
  if (result.status === 'removed') console.log('Removed command: ' + file);
  else if (result.status === 'foreign') console.log('Kept unrelated command: ' + file);
}

for (const target of deletionRoots) {
  if (await removeOwnedPath(target)) console.log('Removed: ' + target);
}
if (external.length) console.log('External custom state/log/history paths were stopped when applicable but kept; remove them manually after verifying ownership.');
console.log('MCP Dev Runtime has been completely uninstalled.');
