import path from 'node:path';
import { homedir } from 'node:os';
import { layout } from './layout.js';
import { writePrivateIfMissing } from './private-files.js';

// No downloads, subprocesses, credentials lookup, or automatic service start.
export async function initializeUser() {
  const l = layout();
  if (l.mode !== 'binary') throw new Error('Source checkouts use ./install.sh; init is for precompiled distributions.');
  const runtime = { transport: 'http', host: '127.0.0.1', port: 3001, cwd: homedir(), shell: '/bin/bash',
    history: { directory: path.join(l.state_dir, 'history') } };
  // Do not persist a version-specific binary path: each release selects its own Tunnel.
  const launcher = { runtime_config: 'config.json', state_dir: l.state_dir, logs_dir: l.logs_dir, env_file: 'runtime.env', shell_env: false };
  const entries: Record<string, string> = {
    'config.json': JSON.stringify(runtime, null, 2) + '\n',
    'launcher.config.json': JSON.stringify(launcher, null, 2) + '\n',
    'runtime.env': '# Fill locally; never share this file or commit it.\nCONTROL_PLANE_TUNNEL_ID=\nCONTROL_PLANE_API_KEY=\nNO_PROXY=localhost,127.0.0.1,::1\n'
  };
  const created: string[] = [], preserved: string[] = [];
  for (const [name, content] of Object.entries(entries)) {
    const file = path.join(l.config_dir, name);
    (await writePrivateIfMissing(file, content) ? created : preserved).push(file);
  }
  return { created, preserved, env_file: path.join(l.config_dir, 'runtime.env') };
}
