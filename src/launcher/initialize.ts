import path from 'node:path';
import { homedir } from 'node:os';
import { layout } from './layout.js';
import { writePrivateIfMissing } from './private-files.js';
import { defaultToolAllowlist } from '../mcp/tool-registry.js';

// No downloads, subprocesses, credentials lookup, or automatic service start.
export async function initializeUser() {
  const l = layout();
  if (l.mode !== 'binary') throw new Error('Source checkouts use ./install.sh; init is for precompiled distributions.');
  const config = {
    schema_version: 1,
    mcp: { transport: 'http', host: '127.0.0.1', port: 3001, path: '/mcp', health_path: '/healthz' },
    tunnel: { enabled: true, health_port: 9098, ready_timeout_ms: 30000, health_interval_ms: 5000 },
    tools: { allow: [...defaultToolAllowlist] },
    runtime: { cwd: homedir(), shell: '/bin/bash', env_file: 'runtime.env', shell_env: false },
    exec: { retained_session_ms: null, max_ended_sessions: 512, maintenance_interval_ms: 30000 },
    history: { enabled: true, directory: path.join(l.state_dir, 'history'), record_command: false, record_output: false },
    logging: { level: 'info', max_bytes: 10485760, files: 3 },
    request_cache: { ttl_ms: 600000 }
  };
  const entries: Record<string, string> = {
    'config.json': JSON.stringify(config, null, 2) + '\n',
    'runtime.env': '# Fill locally; never share this file or commit it.\nCONTROL_PLANE_TUNNEL_ID=\nCONTROL_PLANE_API_KEY=\nNO_PROXY=localhost,127.0.0.1,::1\n'
  };
  const created: string[] = [], preserved: string[] = [];
  for (const [name, content] of Object.entries(entries)) {
    const file = path.join(l.config_dir, name);
    (await writePrivateIfMissing(file, content) ? created : preserved).push(file);
  }
  return { created, preserved, env_file: path.join(l.config_dir, 'runtime.env') };
}
