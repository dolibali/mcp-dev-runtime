import { NAME, VERSION } from '../version.js';
import { createServer, type IncomingMessage } from 'node:http';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import type { Runtime } from '../runtime/runtime.js';
import { makeServer } from './server.js';

async function readJson(req: IncomingMessage, maximum: number): Promise<unknown> {
  if (Number(req.headers['content-length'] ?? 0) > maximum) throw new RangeError('Request body exceeds limit.');
  const chunks: Buffer[] = []; let size = 0;
  for await (const part of req.iterator({ destroyOnReturn: false })) {
    const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
    size += chunk.length;
    if (size > maximum) throw new RangeError('Request body exceeds limit.');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
export async function startHttp(runtime: Runtime) {
  const { config } = runtime;
  const sdk = createMcpHandler(() => makeServer(runtime), { legacy: 'stateless', responseMode: 'json' });
  const mcp = toNodeHandler(sdk, { onerror: e => { if (config.log_level !== 'silent') process.stderr.write(`MCP transport: ${e.message}\n`); } });
  let closing = false;
  const server = createServer(async (req, res) => {
    try {
      const route = new URL(req.url ?? '/', 'http://localhost').pathname;
      if (route === config.health_path && req.method === 'GET') {
        res.writeHead(closing ? 503 : 200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ status: closing ? 'closing' : 'ok', server: NAME, version: VERSION,
          instance_id: runtime.exec.instanceId, ...runtime.exec.diagnostics,
          uptime_seconds:process.uptime(),rss_bytes:process.memoryUsage().rss })); return;
      }
      if (route !== config.mcp_path) { res.writeHead(404); res.end('Not found'); return; }
      if (closing) { res.writeHead(503); res.end('Service closing'); return; }
      const body = req.method === 'POST' ? await readJson(req, config.max_http_body_bytes) : undefined;
      // All discovery/era routing/envelopes remain SDK responsibilities.
      await mcp(req, res, body);
    } catch (error) {
      if (!res.headersSent && !res.destroyed) {
        res.writeHead(error instanceof RangeError ? 413 : error instanceof SyntaxError ? 400 : 500,
          { 'Content-Type': 'application/json', Connection: 'close' });
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Request failed' }));
      }
      req.resume();
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => { server.off('error', reject); resolve(); });
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : config.port;
  return { server, port, url: `http://${config.host.includes(':') ? `[${config.host}]` : config.host}:${port}${config.mcp_path}`,
    close: async () => {
      closing = true;
      const stopped = new Promise<void>(resolve => server.close(() => resolve()));
      const result = await runtime.close();
      await sdk.close(); server.closeAllConnections(); await stopped;
      return result;
    }
  };
}
