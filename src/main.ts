#!/usr/bin/env node
import { NAME, VERSION, CONTRACT_VERSION } from './version.js';
import { parseArgs } from 'node:util';
import { loadConfig } from './config.js';
import { Runtime } from './runtime/runtime.js';
import { startHttp } from './mcp/http.js';
import { startStdio } from './mcp/stdio.js';

async function main() {
  const { values } = parseArgs({ options: {
    config: { type: 'string' }, transport: { type: 'string' }, host: { type: 'string' }, port: { type: 'string' },
    cwd: { type: 'string' }, shell: { type: 'string' }, 'log-level': { type: 'string' },
    help: { type: 'boolean', short: 'h' }, version: { type: 'boolean' }
  } });
  if (values.version) { console.log(`${NAME} ${VERSION} (contract ${CONTRACT_VERSION})`); return; }
  if (values.help) {
    console.log('mcp-dev-runtime serve --transport http|stdio [--config config.json] [--cwd PATH]\n' +
      '  --host 127.0.0.1  --port 3001  --shell /bin/zsh  --log-level info|debug|warn|silent\n' +
      'HTTP routes: /mcp and /healthz. Six direct host tools; no Codex/model calls.'); return;
  }
  const overrides: Record<string, unknown> = {};
  for (const key of ['transport', 'host', 'cwd', 'shell'] as const) if (values[key] !== undefined) overrides[key] = values[key];
  if (values.port !== undefined) overrides.port = Number(values.port);
  if (values['log-level'] !== undefined) overrides.log_level = values['log-level'];
  const config = await loadConfig(values.config, overrides);
  const runtime = new Runtime(config);
  let service: Awaited<ReturnType<typeof startHttp>> | ReturnType<typeof startStdio>;
  try { service = config.transport === 'http' ? await startHttp(runtime) : startStdio(runtime); }
  catch (error) { await runtime.close(); throw error; }
  if (config.log_level !== 'silent') process.stderr.write(JSON.stringify({ event: 'started', transport: config.transport,
    url: 'url' in service ? service.url : null, cwd: config.cwd, instance_id: runtime.exec.instanceId }) + '\n');
  let stopping = false;
  const stop = async () => {
    if (stopping) return; stopping = true;
    const emergency = setTimeout(() => { process.stderr.write('Shutdown did not finish; exiting with code 1.\n'); process.exit(1); }, 15000);
    emergency.unref();
    try {
      const result = await service.close();
      clearTimeout(emergency);
      if (result.remaining.length) process.stderr.write(JSON.stringify({ event: 'shutdown_incomplete', sessions: result.remaining }) + '\n');
      process.exit(result.remaining.length ? 1 : 0);
    } catch (error) { process.stderr.write(String(error) + '\n'); process.exit(1); }
  };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  if (config.transport === 'stdio') process.stdin.once('end', stop);
}
main().catch(error => { process.stderr.write(`${NAME}: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
