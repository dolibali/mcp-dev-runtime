import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { Runtime } from '../../dist/runtime/runtime.js';
import { startHttp } from '../../dist/mcp/http.js';
import { defaultToolAllowlist } from '../../dist/mcp/tool-registry.js';
import { skillsFixture, skill } from '../skills-helper.mjs';
import { assertOutput } from '../output-contract-helper.mjs';
const exec = promisify(execFile);
const both = [...defaultToolAllowlist, 'discover_skills', 'read_skill'];

async function setup(t, allow = both) {
  const f = await skillsFixture(t);
  const oldHome = process.env.HOME, oldCodex = process.env.CODEX_HOME;
  process.env.HOME = f.home; process.env.CODEX_HOME = path.join(f.home, '.codex');
  t.after(() => {
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    if (oldCodex === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldCodex;
  });
  f.config.tools.allow = allow;
  const runtime = new Runtime(f.config), server = await startHttp(runtime); t.after(() => server.close());
  const client = new Client({ name: 'skill-protocol-tests', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(server.url))); t.after(() => client.close());
  return { ...f, runtime, server, client, call: async (name, args) => assertOutput(name, await client.callTool({ name, arguments: args })) };
}
async function instructions(url) {
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-11-25' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } } }) });
  const text = await response.text();
  const value = response.headers.get('content-type').includes('text/event-stream')
    ? JSON.parse(text.split('\n').find(line => line.startsWith('data:')).slice(5)) : JSON.parse(text);
  assert(!value.error, JSON.stringify(value)); return value.result.instructions;
}

test('skills HTTP: enabled discovery/schema and complete read use real MCP results', async t => {
  const f = await setup(t); const item = await skill(f.local, 'animation', { description: 'SolidJS animation spring' });
  const tools = (await f.client.listTools()).tools;
  assert.deepEqual(tools.map(x => x.name), both);
  const contracts = JSON.parse(await readFile('contracts/tools.json', 'utf8')).tools;
  for (const expected of contracts) {
    const actual = tools.find(t => t.name === expected.name);
    assert.deepEqual(actual.inputSchema, expected.inputSchema); assert.deepEqual(actual.outputSchema, expected.outputSchema);
    assert.equal(actual.annotations.readOnlyHint, expected.annotations.readOnlyHint);
  }
  const found = await f.call('discover_skills', { workdir: f.project, query: 'SolidJS animation' }); assert(!found.isError);
  const read = await f.call('read_skill', { workdir: f.project, skill: found.skills[0].id }); assert(!read.isError);
  assert.equal(read.contents, item.text); assert.equal(read.content_complete, true);
  assert.equal((await f.call('exec_command', { cmd: 'printf unchanged' })).output, 'unchanged');
});

test('skills HTTP: disabled tools are not advertised or directly executable; no skill prompt is added', async t => {
  const f = await setup(t, [...defaultToolAllowlist]);
  assert.equal((await f.client.listTools()).tools.length, 6);
  const disabled = await f.runtime.invoke('read_skill', { workdir: f.project, skill: 'anything' });
  assert.equal(disabled.structuredContent.error.code, 'TOOL_DISABLED');
  const prompt = await instructions(f.server.url);
  assert(!prompt.includes('discover_skills')); assert(!prompt.includes('read_skill'));
});

test('skills HTTP: short routing prefix covers task trigger, read completeness, exclusions and permissions', async t => {
  const f = await setup(t);
  const prompt = await instructions(f.server.url), prefix = prompt.slice(0, 512);
  for (const term of ['new substantive project task','discover_skills','read_skill','fully','polling','never grant permissions']) assert(prefix.includes(term), term);
  assert(prompt.includes('No Codex agent or model is invoked.'));
});

test('skills HTTP: single-tool enablement does not implicitly enable its counterpart', async t => {
  const f = await setup(t, ['read_skill']); await skill(f.local, 'one');
  assert.deepEqual((await f.client.listTools()).tools.map(t => t.name), ['read_skill']);
  const prompt = await instructions(f.server.url); assert(prompt.includes('Discovery is unavailable')); assert(!prompt.includes('discover_skills'));
  assert.equal((await f.call('read_skill', { workdir: f.project, skill: 'one', explicit: true })).content_complete, true);
});

test('skills HTTP: error schemas, unknown arguments and disabled policies are deterministic', async t => {
  const f = await setup(t); await skill(f.local, 'only', { policy: 'policy:\n  allow_implicit_invocation: false\n' });
  const denied = await f.call('read_skill', { workdir: f.project, skill: 'only' }); assert(denied.isError); assert.equal(denied.error.code, 'EXPLICIT_SKILL_REQUIRED');
  const invalid = await f.runtime.invoke('discover_skills', { workdir: f.project, unknown: true });
  assert.equal(invalid.structuredContent.error.code, 'INVALID_ARGUMENTS');
  assert.equal((await f.call('list_exec_sessions', {})).sessions.length, 0);
});

test('skills HTTP: reconnect preserves read cursor, not model-memory assumptions', async t => {
  const f = await setup(t); const item = await skill(f.local, 'large', { body: 'content\n'.repeat(10_000) });
  let r = await f.call('read_skill', { workdir: f.project, skill: 'large' }), text = r.contents;
  assert(r.next_cursor); await f.client.close();
  const next = new Client({ name: 'reconnected', version: '1' }); await next.connect(new StreamableHTTPClientTransport(new URL(f.server.url))); t.after(() => next.close());
  while (r.next_cursor) {
    r = await assertOutput('read_skill', await next.callTool({ name: 'read_skill', arguments: { workdir: f.project, skill: 'large', cursor: r.next_cursor } }));
    assert(!r.isError); text += r.contents;
  }
  assert.equal(text, item.text);
});

test('skills stdio: discover/read then use the existing execution tool, with isolated HOME', async t => {
  const f = await skillsFixture(t); const item = await skill(f.local, 'script', { body: 'Read scripts/check.sh, then execute it in the project.\n' });
  await mkdir(path.join(item.dir, 'scripts')); await writeFile(path.join(item.dir, 'scripts/check.sh'), '#!/bin/sh\nprintf skill-script-ok\n');
  const file = path.join(f.root, 'settings.json');
  await writeFile(file, JSON.stringify({ ...f.config, tools: { allow: both } }));
  const client = new Client({ name: 'skills-stdio', version: '1' }); t.after(() => client.close());
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: [path.resolve('dist/main.js'), '--transport', 'stdio', '--config', file],
    env: { ...process.env, HOME: f.home, CODEX_HOME: path.join(f.home, '.codex') }, stderr: 'pipe' }));
  const found = await assertOutput('discover_skills', await client.callTool({ name: 'discover_skills', arguments: { workdir: f.project, query: 'script' } }));
  const loaded = await assertOutput('read_skill', await client.callTool({ name: 'read_skill', arguments: { workdir: f.project, skill: found.skills[0].id } }));
  assert.equal(loaded.contents, item.text);
  const result = await assertOutput('exec_command', await client.callTool({ name: 'exec_command', arguments: { workdir: f.project, cmd: 'bash ' + JSON.stringify(path.join(loaded.skill_root, 'scripts/check.sh')) } }));
  assert.equal(result.output, 'skill-script-ok'); assert.equal(result.exit_code, 0);
});

test('skills lazy loading: disabled and enabled-but-unused servers never resolve YAML/service modules', async t => {
  const f = await skillsFixture(t);
  for (const allow of [[...defaultToolAllowlist], both]) {
    const script = `
      import { registerHooks } from 'node:module';
      registerHooks({ resolve(spec, context, next) {
        if(spec === 'yaml' || spec.endsWith('/skills/service.js')) throw new Error('SKILL_MODULE_WAS_LOADED');
        return next(spec, context);
      }});
      const {configSchema}=await import('./dist/config.js');
      const {Runtime}=await import('./dist/runtime/runtime.js');
      const {startHttp}=await import('./dist/mcp/http.js');
      const config=configSchema.parse({cwd:${JSON.stringify(f.project)},shell:'/bin/bash',port:0,log_level:'silent',history:{enabled:false},tools:{allow:${JSON.stringify(allow)}}});
      const runtime=new Runtime(config);const server=await startHttp(runtime);
      try {const r=await runtime.invoke('exec_command',{cmd:'printf lazy-ok'});if(r.structuredContent.output!=='lazy-ok')throw new Error('bad command');console.log('LAZY_PASS');}
      finally {await server.close();}
    `;
    const r = await exec(process.execPath, ['--input-type=module', '-e', script], { cwd: process.cwd(), timeout: 20_000 });
    assert(r.stdout.includes('LAZY_PASS'));
  }
});
