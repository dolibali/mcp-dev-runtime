import path from 'node:path';
import { homedir } from 'node:os';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { NAME, VERSION } from '../version.js';

// A shipped marker, not cwd/node_modules heuristics, selects the binary layout.
export const PACKAGE_ROOT = fileURLToPath(new URL('../../', import.meta.url));
export type Distribution = { schema_version: 1; kind: 'binary'; version: string; platform: string; arch: string; node_version: string; tunnel_sha256: string };
export function distribution(root = PACKAGE_ROOT): Distribution | null {
  let text: string;
  try { text = readFileSync(path.join(root, 'distribution.json'), 'utf8'); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
  const d = JSON.parse(text) as Distribution;
  if (d.schema_version !== 1 || d.kind !== 'binary' || d.version !== VERSION ||
      d.platform !== process.platform || d.arch !== process.arch || !/^[a-f0-9]{64}$/.test(d.tunnel_sha256)) {
    throw new Error('Invalid or incompatible distribution metadata. Download the package for this OS/architecture.');
  }
  if (d.node_version !== process.versions.node) throw new Error('Use the bundled bin/mcp-dev-runtime entry, which selects this release\'s matching Node runtime.');
  return d;
}

export function userDirectories(platform: string = process.platform, home = homedir(), env: NodeJS.ProcessEnv = process.env) {
  if (!path.isAbsolute(home)) throw new Error('An absolute home directory is required.');
  if (platform === 'darwin') {
    const config = path.join(home, 'Library', 'Application Support', NAME);
    return { config_dir: config, state_dir: path.join(config, 'runtime'), logs_dir: path.join(home, 'Library', 'Logs', NAME),
      cache_dir: path.join(home, 'Library', 'Caches', NAME), releases_dir: path.join(config, 'releases') };
  }
  if (platform === 'linux') {
    // XDG requires absolute paths; invalid relative overrides are ignored.
    const base = (key: string, fallback: string) => env[key] && path.isAbsolute(env[key]!) ? env[key]! : path.join(home, fallback);
    const state = path.join(base('XDG_STATE_HOME', '.local/state'), NAME);
    return { config_dir: path.join(base('XDG_CONFIG_HOME', '.config'), NAME), state_dir: state, logs_dir: path.join(state, 'logs'),
      cache_dir: path.join(base('XDG_CACHE_HOME', '.cache'), NAME), releases_dir: path.join(base('XDG_DATA_HOME', '.local/share'), NAME, 'releases') };
  }
  throw new Error('Binary distributions support macOS and Linux only.');
}

export function layout() {
  const d = distribution();
  if (d) return { mode: 'binary' as const, package_root: PACKAGE_ROOT, bundle_root: path.resolve(PACKAGE_ROOT, '..'),
    working_dir: homedir(), ...userDirectories() };
  return { mode: 'source' as const, package_root: PACKAGE_ROOT, bundle_root: null, working_dir: PACKAGE_ROOT,
    config_dir: PACKAGE_ROOT, state_dir: path.join(PACKAGE_ROOT, '.runtime'), logs_dir: path.join(PACKAGE_ROOT, '.runtime'),
    cache_dir: path.join(PACKAGE_ROOT, '.runtime'), releases_dir: null };
}
export function launcherConfigPath(file?: string) { return path.resolve(file ?? path.join(layout().config_dir, 'launcher.config.json')); }
export function userConfigPath(file?: string) { return path.resolve(file ?? path.join(layout().config_dir, 'config.json')); }
