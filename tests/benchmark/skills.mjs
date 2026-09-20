import assert from 'node:assert/strict';
import { mkdtemp, realpath, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { configSchema } from '../../dist/config.js';
import { Runtime } from '../../dist/runtime/runtime.js';
import { startHttp } from '../../dist/mcp/http.js';
import { defaultToolAllowlist } from '../../dist/mcp/tool-registry.js';
const root = await realpath(await mkdtemp(path.join(tmpdir(), 'mdr-skills-bench-')));
const home = path.join(root, 'home'), project = path.join(root, 'project');
await mkdir(home); await mkdir(project);
const oldHome = process.env.HOME, oldCodex = process.env.CODEX_HOME;
process.env.HOME = home; process.env.CODEX_HOME = path.join(home, '.codex');
const common = { cwd: project, shell: '/bin/bash', port: 0, history: { enabled: false }, log_level: 'silent' };
const scopes = [], report = { baseline_head: null, samples: {}, limits: {}, correctness: {}, limitations: [
  'Local Node/SDK plus loopback HTTP; no model inference, Tunnel WAN or hosted-client trigger-rate measurement.',
  'Wire bytes include the intentional text/structuredContent compatibility mirror; bytes are not exact model tokens.',
  'Cache memory is conservative accounting, not an OS RSS hard limit; active parsing needs temporary memory.',
  'One machine; compare repeated/interleaved samples, not a guaranteed SLA.'
] };
const summary = values => {
  const sorted = [...values].sort((a,b)=>a-b);
  return { count: values.length, p50_ms: sorted[Math.floor(sorted.length * .5)], p95_ms: sorted[Math.ceil(sorted.length * .95)-1] };
};
async function connection(allow) {
  const runtime = new Runtime(configSchema.parse({ ...common, tools: { allow } }));
  const server = await startHttp(runtime), client = new Client({ name: 'skill-bench', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(server.url))); scopes.push({ runtime, server, client });
  return { runtime, server, client, call: async (name, args) => {
    const r = await client.callTool({ name, arguments: args }); assert.equal(r.isError, false, JSON.stringify(r)); return r;
  } };
}
try {
  for (let i = 0; i < 100; i++) {
    const dir = path.join(home, '.agents/skills', 'skill-'+String(i).padStart(3,'0')); await mkdir(path.join(dir, 'references'), { recursive: true });
    const subject = i % 2 ? 'database PostgreSQL SQL migrations' : 'SolidJS animation spring 侧边栏 动画';
    await writeFile(path.join(dir, 'SKILL.md'), `---\nname: skill-${String(i).padStart(3,'0')}\ndescription: ${subject} project workflow\n---\n# Instructions\nRead references/guide.md if needed.\n`);
    await writeFile(path.join(dir, 'references/guide.md'), '中文 😀 output correctness\n'.repeat(4000));
  }
  const off = await connection(defaultToolAllowlist), on = await connection([...defaultToolAllowlist, 'discover_skills','read_skill']);
  const latency = { off: [], enabled_unused: [], hot_discovery: [], warm_read: [], concurrent_exec: [], health_during_scan: [] };
  const invoke = client => client.call('exec_command', { cmd: 'printf same-output', yield_time_ms: 1000 });
  for (let warmup = 0; warmup < 5; warmup++) { await invoke(off); await invoke(on); }
  for (let i = 0; i < 40; i++) {
    for (const [name, c] of i % 2 ? [['enabled_unused', on], ['off', off]] : [['off', off], ['enabled_unused', on]]) {
      const started = performance.now(); const r = await invoke(c); latency[name].push(performance.now()-started);
      assert.equal(r.structuredContent.exit_code, 0); assert.equal(r.structuredContent.output, 'same-output');
    }
  }
  let start = performance.now(); const found = await on.call('discover_skills', { workdir: project, query: 'SolidJS animation 动画' });
  report.cold_discovery_ms = performance.now()-start;
  assert.equal(found.structuredContent.skills.length, 5);
  report.discovery_wire_bytes = Buffer.byteLength(JSON.stringify(found));
  for (let i = 0; i < 40; i++) {
    start = performance.now(); await on.call('discover_skills', { workdir: project, query: 'SolidJS animation 动画' }); latency.hot_discovery.push(performance.now()-start);
  }
  const id = found.structuredContent.skills[0].id;
  const main = await on.call('read_skill', { workdir: project, skill: id }); report.main_wire_bytes = Buffer.byteLength(JSON.stringify(main));
  for (let i = 0; i < 25; i++) {
    start = performance.now(); await on.call('read_skill', { workdir: project, skill: id }); latency.warm_read.push(performance.now()-start);
  }
  const loop = monitorEventLoopDelay({ resolution: 5 }); loop.enable(); let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      const started = performance.now(); const r = await fetch(on.server.url.replace('/mcp','/healthz')); assert.equal(r.status,200); await r.arrayBuffer();
      latency.health_during_scan.push(performance.now()-started); await new Promise(r=>setTimeout(r,5));
    }
  })();
  try {
    for (let i = 0; i < 8; i++) {
      const [_, result] = await Promise.all([
        on.call('discover_skills', { workdir: project, query: 'SolidJS', refresh: true }),
        (async () => { const s=performance.now(); const r=await invoke(on); latency.concurrent_exec.push(performance.now()-s); return r; })()
      ]);
      assert.equal(result.structuredContent.output,'same-output');
    }
  } finally { sampling=false; await sampler; loop.disable(); }
  report.event_loop_p95_during_scan_ms = loop.percentile(95)/1e6;
  let text='', cursor, count=0, totalWire=0;
  do {
    const r = await on.call('read_skill', { workdir: project, skill: id, resource: 'references/guide.md', ...(cursor?{cursor}:{}) });
    text += r.structuredContent.contents; cursor = r.structuredContent.next_cursor; count++; totalWire += Buffer.byteLength(JSON.stringify(r));
  } while(cursor);
  const expected = '中文 😀 output correctness\n'.repeat(4000); assert.equal(text,expected);
  report.correctness = { unique_utf8_bytes: Buffer.byteLength(text), duplicate_bytes: 0, missing_bytes: 0, resource_calls: count, total_wire_bytes: totalWire };
  report.samples = Object.fromEntries(Object.entries(latency).map(([k,v])=>[k,summary(v)]));
  // Diagnostic access only; never invoke a hidden tool to collect this metric.
  report.cache = (await on.runtime.skillsTask).diagnostics();
  report.recorded_at = new Date().toISOString(); report.platform = process.platform; report.arch = process.arch; report.node=process.version;
  try { report.baseline_head=(await readFile('.runtime/skills-dev/baseline-head.txt','utf8')).trim(); } catch {}
  await mkdir('reports',{recursive:true}); await writeFile('reports/skills-benchmark.json',JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
} finally {
  for (const s of scopes) { await s.client.close(); assert.deepEqual((await s.server.close()).remaining, []); }
  if(oldHome===undefined)delete process.env.HOME;else process.env.HOME=oldHome;
  if(oldCodex===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=oldCodex;
  await rm(root,{recursive:true,force:true});
}
