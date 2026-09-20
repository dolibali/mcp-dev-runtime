import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, rm, symlink, rename, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { skillsFixture, skill, allSkills } from '../skills-helper.mjs';
import { limits } from '../../dist/skills/limits.js';
import { BoundedCache } from '../../dist/skills/cache.js';
import { terms } from '../../dist/skills/search.js';
import { loadConfig } from '../../dist/config.js';
import { isUnifiedUserConfig } from '../../dist/user-config.js';
const exec = promisify(execFile);

test('skills: globals, CODEX_HOME compatibility, .system and project ancestors/worktree are discovered', async t => {
  const f = await skillsFixture(t), nested = path.join(f.project, 'apps/web'); await mkdir(nested, { recursive: true });
  await skill(f.global, 'global'); await skill(f.codex, 'legacy'); await skill(path.join(f.codex, '.system'), 'built-in');
  await skill(f.local, 'root'); await skill(path.join(f.project, 'apps/.agents/skills'), 'app');
  await skill(path.join(nested, '.codex/skills'), 'nested');
  const result = await f.service.discover({ workdir: nested, limit: 20 });
  const names = (await allSkills(f.service, nested)).map(s => s.name);
  assert.deepEqual(names.sort(), ['app','built-in','global','legacy','nested','root']);
  assert.equal(result.project_root, f.project); assert.equal(result.catalog_complete, true);
});

test('skills: without repo markers only cwd skills are discovered, not arbitrary ancestors', async t => {
  const f = await skillsFixture(t), standalone = path.join(f.root, 'standalone'); await mkdir(standalone);
  await skill(path.join(f.root, '.agents/skills'), 'not-a-project');
  await skill(path.join(standalone, '.agents/skills'), 'here');
  assert.deepEqual((await allSkills(f.service, standalone)).map(s => s.name), ['here']);
});

test('skills: project scope cannot read another project ID', async t => {
  const f = await skillsFixture(t); await skill(f.local, 'private-project');
  const id = (await allSkills(f.service, f.project))[0].id;
  await assert.rejects(f.service.read({ workdir: f.other, skill: id }), { code: 'SKILL_NOT_AVAILABLE' });
});

test('skills: linked directories deduplicate canonical identity and do not recurse into assets', async t => {
  const f = await skillsFixture(t); const item = await skill(f.global, 'original');
  await mkdir(f.codex, { recursive: true }); await symlink(item.dir, path.join(f.codex, 'linked'));
  await skill(path.join(item.dir, 'references'), 'not-a-skill');
  assert.deepEqual((await allSkills(f.service, f.project)).map(s => s.name), ['original']);
});

test('skills: symlink loops and broken roots are bounded; valid siblings still load', async t => {
  const f = await skillsFixture(t); await skill(f.global, 'ok');
  await symlink(f.global, path.join(f.global, 'cycle')); await symlink('missing-target', path.join(f.global, 'broken'));
  const result = await f.service.discover({ workdir: f.project });
  assert.equal(result.skills[0].name, 'ok'); assert.equal(result.catalog_complete, false); assert(result.warnings.length);
});

test('skills: same name has distinct IDs and is never silently overridden', async t => {
  const f = await skillsFixture(t); await skill(f.global, 'g', { name: 'same' }); await skill(f.local, 'l', { name: 'same' });
  const rows = await allSkills(f.service, f.project); assert.equal(rows.length, 2); assert.notEqual(rows[0].id, rows[1].id);
  await assert.rejects(f.service.read({ workdir: f.project, skill: 'same' }), { code: 'AMBIGUOUS_SKILL' });
  assert.equal((await f.service.read({ workdir: f.project, skill: rows[0].id })).id, rows[0].id);
});

test('skills: exact newly installed skill name may be read without prior discovery', async t => {
  const f = await skillsFixture(t); await f.service.discover({ workdir: f.project });
  const item = await skill(f.local, 'new');
  const result = await f.service.read({ workdir: f.project, skill: 'new', explicit: true });
  assert.equal(result.contents, item.text); assert.equal(result.content_complete, true);
});

test('skills: explicit-only policy is browsable but excluded from task search', async t => {
  const f = await skillsFixture(t);
  const item = await skill(f.local, 'deploy', { description: 'deployment release', policy: 'policy:\n  allow_implicit_invocation: false\n' });
  assert.equal((await f.service.discover({ workdir: f.project, query: 'deployment' })).skills.length, 0);
  assert.equal((await allSkills(f.service, f.project))[0].implicit_allowed, false);
  await assert.rejects(f.service.read({ workdir: f.project, skill: 'deploy' }), { code: 'EXPLICIT_SKILL_REQUIRED' });
  assert.equal((await f.service.read({ workdir: f.project, skill: 'deploy', explicit: true })).contents, item.text);
});

test('skills: malformed policy fails closed for implicit use; never exposes YAML source in errors', async t => {
  const f = await skillsFixture(t);
  await skill(f.local, 'broken-policy', { policy: 'policy: [not valid secret-content\n' });
  const rows = await allSkills(f.service, f.project); assert.equal(rows[0].implicit_allowed, false);
  assert(!JSON.stringify(rows).includes('secret-content'));
  await assert.rejects(f.service.read({ workdir: f.project, skill: rows[0].id }), { code: 'EXPLICIT_SKILL_REQUIRED' });
  const read = await f.service.read({ workdir: f.project, skill: rows[0].id, explicit: true }); assert(read.warnings.length);
});

test('skills: changed policy is checked even with a warm catalog and read cache', async t => {
  const f = await skillsFixture(t); const item = await skill(f.local, 'change-policy', { policy: 'policy:\n  allow_implicit_invocation: true\n' });
  await f.service.read({ workdir: f.project, skill: 'change-policy' });
  await writeFile(path.join(item.dir, 'agents/openai.yaml'), 'policy:\n  allow_implicit_invocation: false\n');
  await assert.rejects(f.service.read({ workdir: f.project, skill: 'change-policy' }), { code: 'EXPLICIT_SKILL_REQUIRED' });
});

test('skills: invalid SKILL metadata/oversized headers/aliases are isolated from valid siblings', async t => {
  const f = await skillsFixture(t);
  await skill(f.local, 'ok', { raw: '---\nname: ok\ndescription: >\n  multiline Solid\n  animation workflow\n---\nComplete instructions.\n' });
  await skill(f.local, 'duplicate', { raw: '---\nname: x\nname: y\ndescription: invalid\n---\n' });
  await skill(f.local, 'alias', { raw: '---\nname: &n test\ndescription: *n\n---\n' });
  await skill(f.local, 'huge', { raw: '---\nname: huge\ndescription: ' + 'a'.repeat(20_000) + '\n---\n' });
  const result = await f.service.discover({ workdir: f.project });
  assert.deepEqual(result.skills.map(s => s.name), ['ok']); assert.equal(result.catalog_complete, false);
  assert(result.skills[0].description.includes('Solid animation'));
});

test('skills: dependencies are informational and scripts are never automatically executed', async t => {
  const f = await skillsFixture(t), marker = path.join(f.root, 'must-not-run');
  const item = await skill(f.local, 'scripts', { policy: 'dependencies:\n  tools:\n    - type: mcp\n      value: browser\n      command: never-execute-this\n', body: '# Workflow\nRun scripts/test.sh only with appropriate user authorization.\n' });
  await mkdir(path.join(item.dir, 'scripts')); await writeFile(path.join(item.dir, 'scripts/test.sh'), '#!/bin/sh\ntouch ' + JSON.stringify(marker));
  const result = await f.service.read({ workdir: f.project, skill: 'scripts' });
  assert.deepEqual(result.dependencies, ['mcp:browser']); assert.equal(result.dependencies_verified, false);
  await f.service.read({ workdir: f.project, skill: 'scripts', resource: 'scripts/test.sh' });
  await assert.rejects(stat(marker), { code: 'ENOENT' });
});

test('skills: disabled directory is skipped including symlink aliases and direct reads', async t => {
  const f = await skillsFixture(t); const item = await skill(f.global, 'disabled');
  f.config.skills.disabled_paths.push(item.dir);
  await mkdir(f.local, { recursive: true }); await symlink(item.dir, path.join(f.local, 'alias'));
  assert.deepEqual(await allSkills(f.service, f.project), []);
  await assert.rejects(f.service.read({ workdir: f.project, skill: 'disabled', explicit: true }), { code: 'SKILL_NOT_AVAILABLE' });
});

test('skills: resources resolve from skill_root and cannot traverse or follow escaping symlinks', async t => {
  const f = await skillsFixture(t); const item = await skill(f.global, 'resources');
  await mkdir(path.join(item.dir, 'references')); await writeFile(path.join(item.dir, 'references/a.md'), 'the right reference');
  await writeFile(path.join(f.project, 'a.md'), 'wrong workspace reference');
  await symlink(path.join(f.project, 'a.md'), path.join(item.dir, 'escape.md'));
  assert.equal((await f.service.read({ workdir: f.project, skill: 'resources', resource: 'references/a.md' })).contents, 'the right reference');
  for (const resource of ['../a.md','references/../../a.md','/etc/passwd','https://example.invalid/x','.env','references\\x']) {
    await assert.rejects(f.service.read({ workdir: f.project, skill: 'resources', resource }), { code: 'INVALID_RESOURCE' });
  }
  await assert.rejects(f.service.read({ workdir: f.project, skill: 'resources', resource: 'escape.md' }), { code: 'RESOURCE_OUTSIDE_SKILL' });
});

test('skills: symlink replacement invalidates a cached skill identity', async t => {
  const f = await skillsFixture(t); const first = await skill(path.join(f.root, 'packages'), 'first'); const second = await skill(path.join(f.root, 'packages'), 'second');
  await mkdir(f.local, { recursive: true }); const link = path.join(f.local, 'linked'); await symlink(first.dir, link);
  const id = (await allSkills(f.service, f.project))[0].id;
  await rm(link); await symlink(second.dir, link);
  await assert.rejects(f.service.read({ workdir: f.project, skill: id }), { code: 'SKILL_CHANGED' });
});

test('skills: special files, binary and oversized resources fail without blocking', async t => {
  const f = await skillsFixture(t); const item = await skill(f.local, 'files');
  await writeFile(path.join(item.dir, 'binary.dat'), Buffer.from([1,0,255]));
  await writeFile(path.join(item.dir, 'huge.md'), 'x'.repeat(limits.fileBytes + 1));
  await exec('/usr/bin/mkfifo', [path.join(item.dir, 'pipe')]);
  await assert.rejects(f.service.read({ workdir: f.project, skill: 'files', resource: 'binary.dat' }), { code: 'INVALID_SKILL_TEXT' });
  await assert.rejects(f.service.read({ workdir: f.project, skill: 'files', resource: 'huge.md' }), { code: 'SKILL_TOO_LARGE' });
  await assert.rejects(f.service.read({ workdir: f.project, skill: 'files', resource: 'pipe' }), { code: 'INVALID_SKILL_FILE' });
});

test('skills: UTF-8 pagination is complete, bounded and has no missing/duplicate bytes', async t => {
  const f = await skillsFixture(t); const item = await skill(f.local, 'large', { body: '中文 😀 "quoted"\\\n'.repeat(5000) });
  let cursor, text = '', pages = 0;
  do {
    const result = await f.service.read({ workdir: f.project, skill: 'large', ...(cursor ? { cursor } : {}) });
    assert(Buffer.byteLength(JSON.stringify(result)) <= limits.readBytes);
    assert(!result.contents.includes('\uFFFD')); text += result.contents; pages++;
    assert.equal(result.content_complete, result.next_cursor === null); cursor = result.next_cursor;
  } while (cursor);
  assert(pages > 1); assert.equal(text, item.text);
});

test('skills: file edits between pages fail explicitly instead of mixing versions', async t => {
  const f = await skillsFixture(t); const item = await skill(f.local, 'large', { body: 'a'.repeat(50_000) });
  const first = await f.service.read({ workdir: f.project, skill: 'large' }); assert(first.next_cursor);
  await writeFile(item.file, item.text.replace('a'.repeat(20), 'b'.repeat(20)));
  await assert.rejects(f.service.read({ workdir: f.project, skill: 'large', cursor: first.next_cursor }), { code: 'SKILL_CHANGED' });
});

test('skills: continuation expiry requires a new read, not silently rereading a new snapshot', async t => {
  const f = await skillsFixture(t); await skill(f.local, 'large', { body: 'a'.repeat(40_000) });
  const first = await f.service.read({ workdir: f.project, skill: 'large' });
  f.advance(limits.bodyTtlMs + 1);
  await assert.rejects(f.service.read({ workdir: f.project, skill: 'large', cursor: first.next_cursor }), { code: 'CURSOR_EXPIRED' });
});

test('skills: list/read cursors cannot be forged, reused across workdirs or used for another resource', async t => {
  const f = await skillsFixture(t); await skill(f.global, 'large', { body: 'a'.repeat(40_000) }); await skill(f.global, 'second');
  const list = await f.service.discover({ workdir: f.project, limit: 1 }); assert(list.next_cursor);
  await assert.rejects(f.service.discover({ workdir: f.other, cursor: list.next_cursor }), { code: 'INVALID_SKILL_CURSOR' });
  await assert.rejects(f.service.discover({ workdir: f.project, cursor: list.next_cursor.slice(0, -3) + 'bad' }), { code: 'INVALID_SKILL_CURSOR' });
  const read = await f.service.read({ workdir: f.project, skill: 'large' });
  await assert.rejects(f.service.read({ workdir: f.other, skill: 'large', cursor: read.next_cursor }), { code: 'INVALID_SKILL_CURSOR' });
  await assert.rejects(f.service.read({ workdir: f.project, skill: 'second', cursor: read.next_cursor }), { code: 'INVALID_SKILL_CURSOR' });
});

test('skills: catalog pagination stays query-bound and detects refreshed mutations', async t => {
  const f = await skillsFixture(t); for (let i = 0; i < 12; i++) await skill(f.local, 'task-'+i, { description: 'animation ' + 'bounded description '.repeat(30) });
  const first = await f.service.discover({ workdir: f.project, query: 'animation', limit: 20 }); assert(first.next_cursor);
  assert(Buffer.byteLength(JSON.stringify(first)) <= limits.discoveryBytes);
  await assert.rejects(f.service.discover({ workdir: f.project, query: 'elsewhere', cursor: first.next_cursor }), { code: 'CATALOG_CHANGED' });
  await skill(f.local, 'added', { description: 'animation' }); await f.service.discover({ workdir: f.project, refresh: true });
  await assert.rejects(f.service.discover({ workdir: f.project, query: 'animation', cursor: first.next_cursor }), { code: 'CATALOG_CHANGED' });
  assert.equal((await allSkills(f.service, f.project, 'animation')).length, 13);
});

test('skills: BM25/Han terms favor relevant metadata, unrelated queries return no fabricated match', async t => {
  const f = await skillsFixture(t); await skill(f.local, 'animation', { description: 'SolidJS spring animation transition 侧边栏 动画展开与收起' });
  await skill(f.global, 'database', { description: 'SQL migrations PostgreSQL database' });
  assert.equal((await f.service.discover({ workdir: f.project, query: 'SolidJS 面板动画 spring' })).skills[0].name, 'animation');
  assert.equal((await f.service.discover({ workdir: f.project, query: 'PostgreSQL migration' })).skills[0].name, 'database');
  assert.equal((await f.service.discover({ workdir: f.project, query: 'astronomy telescope' })).skills.length, 0);
  assert(terms('动画设计').includes('动画'));
});

test('skills: hot calls share scans; TTL and refresh detect metadata edits/new files', async t => {
  const f = await skillsFixture(t); const item = await skill(f.global, 'before', { description: 'animation' });
  await Promise.all(Array.from({ length: 4 }, () => f.service.discover({ workdir: f.project })));
  assert.equal(f.service.diagnostics().root_scans, 1);
  await f.service.discover({ workdir: f.other }); assert.equal(f.service.diagnostics().root_scans, 1);
  await writeFile(item.file, item.text.replace('animation', 'database')); await skill(f.global, 'new');
  f.advance(limits.catalogTtlMs + 1);
  const results = await f.service.discover({ workdir: f.project, query: 'database' }); assert.equal(results.skills[0].name, 'before');
  assert.equal((await allSkills(f.service, f.project)).length, 2);
});

test('skills: explicit extra roots, missing roots and configurable disabled paths are supported', async t => {
  const f = await skillsFixture(t), extra = path.join(f.root, 'extra'); await skill(extra, 'external');
  f.config.skills.extra_roots.push(extra, path.join(f.root, 'absent'));
  const result = await f.service.discover({ workdir: f.project }); assert.equal(result.skills[0].scope, 'extra'); assert.equal(result.catalog_complete, true);
});

test('skills: closing clears caches and rejects new work; active scans do not revive cache', async t => {
  const f = await skillsFixture(t); await skill(f.local, 'one');
  const pending = f.service.discover({ workdir: f.project }); f.service.close();
  await assert.rejects(pending, { code: 'SKILLS_CLOSED' });
  assert.equal(f.service.diagnostics().accounted_cache_bytes, 0);
  await assert.rejects(f.service.read({ workdir: f.project, skill: 'one' }), { code: 'SKILLS_CLOSED' });
});

test('skills: invalid/relative workdir and unexpected arguments fail before reading', async t => {
  const f = await skillsFixture(t);
  await assert.rejects(f.service.discover({ workdir: '.' }), { code: 'INVALID_WORKDIR' });
  await assert.rejects(f.service.discover({ workdir: f.project, unknown: true }), { code: 'INVALID_ARGUMENTS' });
  await assert.rejects(f.service.read({ workdir: f.project, skill: 'x', command: 'touch nope' }), { code: 'INVALID_ARGUMENTS' });
});

test('skills: byte/count-bounded LRU does not grow indefinitely', () => {
  let time = 0; const cache = new BoundedCache(2, 100, () => time);
  cache.set('a', 1, 40, 10); cache.set('b', 2, 40, 10); assert.equal(cache.get('a'), 1);
  cache.set('c', 3, 40, 10); assert.equal(cache.get('b'), undefined); assert.equal(cache.bytes, 80);
  cache.set('huge', 0, 101, 10); assert.equal(cache.get('huge'), undefined);
  time = 11; assert.equal(cache.get('a'), undefined); cache.clear(); assert.equal(cache.bytes, 0);
});

test('skills: unified and legacy configuration resolve only new skill paths without misdetecting format', async t => {
  const f = await skillsFixture(t), configDir = path.join(f.root, 'config-dir'); await mkdir(configDir);
  const file = path.join(configDir, 'settings.json');
  const settings = { extra_roots: ['../shared'], disabled_paths: ['../disabled'] };
  assert.equal(isUnifiedUserConfig({ cwd: f.project, skills: settings }), false);
  for (const value of [{ cwd: f.project, shell: '/bin/bash', skills: settings }, { schema_version: 1, runtime: { cwd: '../project', shell: '/bin/bash' }, skills: settings }]) {
    await writeFile(file, JSON.stringify(value)); const c = await loadConfig(file);
    assert.equal(c.cwd, f.project); assert.deepEqual(c.skills.extra_roots, [path.join(f.root, 'shared')]);
    assert.deepEqual(c.skills.disabled_paths, [path.join(f.root, 'disabled')]); assert.equal(c.tools.allow.length, 6);
  }
});

test('skills: UTF-8 BOM and CRLF are preserved in complete instruction content', async t => {
  const f = await skillsFixture(t);
  const text = '\uFEFF---\r\nname: bom\r\ndescription: UTF-8 byte preservation\r\n---\r\n# 中文 😀\r\n';
  await skill(f.local, 'bom', { raw: text });
  const result = await f.service.read({ workdir: f.project, skill: 'bom' }); assert.equal(result.contents, text);
});

test('skills: a stale exact name never silently selects its renamed replacement', async t => {
  const f = await skillsFixture(t); const item = await skill(f.local, 'original');
  await f.service.discover({ workdir: f.project });
  await writeFile(item.file, item.text.replace('"original"', '"renamed"'));
  await assert.rejects(f.service.read({ workdir: f.project, skill: 'original' }), { code: 'SKILL_CHANGED' });
  assert.equal((await f.service.read({ workdir: f.project, skill: 'renamed' })).name, 'renamed');
});

test('skills: removed files cannot be read from cached content, and refresh removes them', async t => {
  const f = await skillsFixture(t); const item = await skill(f.local, 'remove');
  await f.service.read({ workdir: f.project, skill: 'remove' }); await rm(item.file);
  await assert.rejects(f.service.read({ workdir: f.project, skill: 'remove' }), { code: 'SKILL_CHANGED' });
  assert.equal((await f.service.discover({ workdir: f.project, refresh: true })).skills.length, 0);
});

test('skills: concurrent saturation is explicit without growing an unbounded queue', async t => {
  const f = await skillsFixture(t); await skill(f.local, 'load');
  const results = await Promise.allSettled(Array.from({ length: 8 }, () => f.service.discover({ workdir: f.project })));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 4);
  for (const result of results.filter(r => r.status === 'rejected')) assert.equal(result.reason.code, 'SKILLS_BUSY');
  assert.equal(f.service.diagnostics().active, 0);
});

test('skills: body capacity eviction has a deterministic continuation error', async t => {
  const f = await skillsFixture(t); const item = await skill(f.local, 'pages', { body: 'x'.repeat(30_000) });
  const first = await f.service.read({ workdir: f.project, skill: 'pages' });
  for (let i = 0; i < limits.bodyCacheEntries; i++) {
    const resource = 'ref-'+i+'.md'; await writeFile(path.join(item.dir, resource), 'x'.repeat(30_000));
    await f.service.read({ workdir: f.project, skill: 'pages', resource });
  }
  assert.equal(f.service.diagnostics().body_entries, limits.bodyCacheEntries);
  await assert.rejects(f.service.read({ workdir: f.project, skill: 'pages', cursor: first.next_cursor }), { code: 'CURSOR_EXPIRED' });
});

test('skills: depth limit reports incomplete inventory and sidecar links cannot escape', async t => {
  const f = await skillsFixture(t); let dir = f.local;
  for (let i = 0; i < limits.scanDepth + 2; i++) dir = path.join(dir, 'nested');
  await skill(dir, 'too-deep');
  const item = await skill(f.local, 'linked-policy'); await mkdir(path.join(item.dir, 'agents'));
  const outside = path.join(f.root, 'policy.yaml'); await writeFile(outside, 'policy:\n  allow_implicit_invocation: true\n');
  await symlink(outside, path.join(item.dir, 'agents/openai.yaml'));
  const result = await f.service.discover({ workdir: f.project });
  assert.equal(result.catalog_complete, false); assert.equal(result.skills.length, 1); assert.equal(result.skills[0].implicit_allowed, false);
});
