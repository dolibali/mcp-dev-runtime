import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import type { Runtime } from '../runtime/runtime.js';
import { makeServer } from './server.js';
export function startStdio(runtime: Runtime) {
  const transport = new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: runtime.config.max_http_body_bytes });
  const handle = serveStdio(() => makeServer(runtime), { transport, legacy: 'serve',
    onerror: e => { if (runtime.config.log_level !== 'silent') process.stderr.write(`MCP stdio: ${e.message}\n`); } });
  return { close: async () => { const result = await runtime.close(); await handle.close(); return result; } };
}
