import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { uninstallSource } from '../../scripts/uninstall.mjs';
import { confirmCompleteUninstall } from '../../scripts/uninstall-lib.mjs';

test('uninstall confirmation: only explicit y/Y proceeds; empty, n and EOF cancel', async () => {
  async function answer(text) {
    const input = new PassThrough(), output = new PassThrough();
    input.end(text);
    return confirmCompleteUninstall(['/tmp/example-only'], input, output);
  }
  assert.equal(await answer('y\n'), true);
  assert.equal(await answer('Y\r\n'), true);
  assert.equal(await answer('n\n'), false);
  assert.equal(await answer('\n'), false);
  assert.equal(await answer(''), false);
});

test('source uninstall: cancellation is a no-op and confirmed uninstall keeps the checkout', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'mdr-uninstall-src-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = path.join(root, 'user-bin');
  await mkdir(bin);
  const oldPath = process.env.PATH;
  process.env.PATH = bin + path.delimiter + (oldPath ?? '');
  t.after(() => { process.env.PATH = oldPath; });
  await mkdir(path.join(root, '.git'));
  await writeFile(path.join(root, '.git', 'KEEP'), 'source checkout');
  for (const dir of ['.runtime', '.mcp-dev-runtime', 'custom-state', 'custom-logs', 'custom-history', 'dist', 'node_modules']) {
    await mkdir(path.join(root, dir), { recursive: true });
    await writeFile(path.join(root, dir, 'generated'), dir);
  }
  await writeFile(path.join(root, 'config.json'), JSON.stringify({ cwd: root, history: { directory: 'custom-history' } }) + '\n');
  await writeFile(path.join(root, 'launcher.config.json'), JSON.stringify({ state_dir: 'custom-state', logs_dir: 'custom-logs' }) + '\n');
  await writeFile(path.join(root, 'runtime.env'), 'CONTROL_PLANE_API_KEY=synthetic-test-only\n');
  const canonicalRoot = await realpath(root);
  const header = '#!/bin/sh\n# mcp-dev-runtime managed command v1\n# source-root: ' + Buffer.from(canonicalRoot).toString('base64') + '\n';
  for (const name of ['mcp-dev-runtime', 'mdr']) await writeFile(path.join(bin, name), header + 'exit 0\n', { mode: 0o755 });

  const cancelled = await uninstallSource({ root, confirm: async () => false, log: () => {} });
  assert.equal(cancelled.status, 'cancelled');
  assert((await stat(path.join(root, 'runtime.env'))).isFile());
  assert((await stat(path.join(bin, 'mdr'))).isFile());

  const result = await uninstallSource({ root, confirm: async () => true, log: () => {} });
  assert.equal(result.status, 'removed');
  assert.deepEqual(result.external_kept, []);
  for (const target of ['.runtime', '.mcp-dev-runtime', 'custom-state', 'custom-logs', 'custom-history', 'dist', 'node_modules', 'config.json', 'launcher.config.json', 'runtime.env']) {
    await assert.rejects(stat(path.join(root, target)), { code: 'ENOENT' });
  }
  for (const name of ['mcp-dev-runtime', 'mdr']) await assert.rejects(stat(path.join(bin, name)), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(root, '.git', 'KEEP'), 'utf8'), 'source checkout');
});

test('source uninstall: a state/log/history value resolving to the checkout root never deletes the checkout', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'mdr-uninstall-root-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, '.git'));
  await writeFile(path.join(root, '.git', 'KEEP'), 'git metadata');
  await writeFile(path.join(root, 'user-work.txt'), 'must survive');
  await writeFile(path.join(root, 'config.json'), JSON.stringify({ cwd: root, history: { directory: '.' } }) + '\n');
  await writeFile(path.join(root, 'launcher.config.json'), JSON.stringify({ state_dir: '.', logs_dir: '.' }) + '\n');
  await writeFile(path.join(root, 'runtime.env'), 'CONTROL_PLANE_API_KEY=synthetic-test-only\n');
  const result = await uninstallSource({ root, binDir: path.join(root, 'missing-bin'), confirm: async () => true, log: () => {} });
  assert.equal(result.status, 'removed');
  assert.equal(await readFile(path.join(root, '.git', 'KEEP'), 'utf8'), 'git metadata');
  assert.equal(await readFile(path.join(root, 'user-work.txt'), 'utf8'), 'must survive');
  for (const name of ['config.json', 'launcher.config.json', 'runtime.env']) await assert.rejects(stat(path.join(root, name)), { code: 'ENOENT' });
});
