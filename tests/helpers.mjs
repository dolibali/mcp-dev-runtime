import { mkdtemp, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { configSchema } from '../dist/config.js';
import { ExecManager } from '../dist/runtime/exec-manager.js';
export const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
export const nodeCmd = code => `${quote(process.execPath)} -e ${quote(code)}`;
export async function fixture(t, overrides = {}) {
  const cwd = await realpath(await mkdtemp(path.join(tmpdir(), 'local-dev-mcp-test-')));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return configSchema.parse({ cwd, shell: '/bin/bash', port: 0, log_level: 'silent', history:{enabled:false}, ...overrides });
}
export async function manager(t, overrides = {}) {
  const config = await fixture(t, overrides); const m = new ExecManager(config);
  t.after(async () => { const r = await m.close(); if (r.remaining.length) throw new Error(`Unclosed sessions: ${r.remaining}`); });
  return m;
}
export async function finish(m, first, { tokens = 4000, deadline = 10000 } = {}) {
  let result = first, output = result.output ?? ''; const end = Date.now() + deadline;
  while (['running', 'terminating'].includes(result.state) || result.has_more) {
    if (Date.now() > end) throw new Error(`Process did not finish: ${JSON.stringify(result)}`);
    result = await m.write({ session_id: result.session_id, yield_time_ms: 1000, max_output_tokens: tokens });
    output += result.output;
  }
  return { ...result, output };
}
