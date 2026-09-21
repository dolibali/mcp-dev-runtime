import * as fs from 'node:fs/promises';
import { isUtf8 } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Config } from '../config.js';
import { expandPath } from '../config.js';
import { ToolError, Mutex } from './errors.js';
import { RetryCache } from './retry-cache.js';
import { parsePatch, updateText, type Hunk } from './patch-parser.js';

const hash = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const missing = (e: unknown) => (e as NodeJS.ErrnoException).code === 'ENOENT';
type Snapshot = { path: string; actual: string; signature: string; content?: Buffer; mode: number; symlink: boolean };
type Prepared = { hunk: Hunk; source: string; target: string; snapshot?: Snapshot; data?: Buffer; canonicalTarget: string };
export type PatchChange = { operation: string; path: string; from?: string; to?: string; source_removed?: boolean };
// Hooks are available for deterministic fault/race tests, never MCP inputs.
export type PatchHooks = { beforeCommit?: () => Promise<void>; beforeWrite?: (index: number, path: string) => Promise<void> };
export class PatchEngine {
  private mutex = new Mutex();
  constructor(private config: Config, private retry: RetryCache, private hooks: PatchHooks = {}) {}
  apply(args: { patch: string; workdir?: string; request_id?: string }) {
    const a = { ...args, workdir: expandPath(args.workdir ?? '.', this.config.cwd) };
    return this.retry.run('apply_patch', a.request_id, a, () => this.applyOnce(a.patch, a.workdir));
  }
  private async snapshot(filename: string, readContent: boolean): Promise<Snapshot> {
    const l = await fs.lstat(filename);
    if (!l.isFile() && !l.isSymbolicLink()) throw new ToolError('NOT_A_FILE', 'Patch target must be a file or symlink.', { path: filename });
    const link = l.isSymbolicLink() ? await fs.readlink(filename) : null;
    const actual = readContent ? await fs.realpath(filename) : filename;
    const s = readContent ? await fs.stat(actual) : l;
    if (readContent && !s.isFile()) throw new ToolError('NOT_A_FILE', 'Update target is not a regular file.', { path: filename });
    if (readContent && s.size > this.config.patch.max_file_bytes) throw new ToolError('FILE_TOO_LARGE', 'File exceeds patch input budget.', { path: filename });
    const content = readContent ? await fs.readFile(actual) : undefined;
    if (content && content.length > this.config.patch.max_file_bytes) throw new ToolError('FILE_TOO_LARGE', 'File grew beyond patch input budget.', { path: filename });
    const signature = JSON.stringify({ link, actual, l: [l.dev, l.ino, l.mode, l.size, l.mtimeMs, l.ctimeMs],
      s: [s.dev, s.ino, s.mode, s.size, s.mtimeMs, s.ctimeMs], hash: content ? hash(content) : null });
    return { path: filename, actual, signature, content, mode: s.mode & 0o7777, symlink: l.isSymbolicLink() };
  }
  private async assertMissing(filename: string): Promise<void> {
    try { await fs.lstat(filename); } catch (e) { if (missing(e)) return; throw e; }
    throw new ToolError('TARGET_EXISTS', 'Add/Move destination already exists.', { path: filename });
  }
  private async canonical(filename: string): Promise<string> {
    try { return await fs.realpath(filename); }
    catch (e) {
      if (!missing(e)) throw e;
      const parent = path.dirname(filename);
      if (parent === filename) throw e;
      return path.join(await this.canonical(parent), path.basename(filename));
    }
  }
  private async verify(p: Prepared): Promise<void> {
    if (p.snapshot) {
      let now: Snapshot;
      try { now = await this.snapshot(p.source, p.hunk.operation === 'update'); }
      catch { throw new ToolError('FILE_CHANGED', 'Source changed after patch preparation.', { path: p.source }); }
      if (now.signature !== p.snapshot.signature) throw new ToolError('FILE_CHANGED', 'Source changed after patch preparation.', { path: p.source });
    }
    if (p.hunk.operation === 'add' || p.hunk.move) {
      await this.assertMissing(p.target);
      if (await this.canonical(p.target) !== p.canonicalTarget) throw new ToolError('FILE_CHANGED', 'Destination parent changed after preparation.', { path: p.target });
    }
  }
  private async ensureParent(filename: string, created: string[]): Promise<void> {
    const parent = path.dirname(filename);
    try { if (!(await fs.stat(parent)).isDirectory()) throw new ToolError('NOT_A_DIRECTORY', 'Destination parent is not a directory.', { path: parent }); return; }
    catch (e) { if (!missing(e)) throw e; }
    await this.ensureParent(parent, created);
    try { await fs.mkdir(parent); created.push(parent); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
  }
  private async writeAtomic(filename: string, data: Buffer, mode: number | undefined, exclusive: boolean, warnings: string[]): Promise<void> {
    const tmp = path.join(path.dirname(filename), `.local-dev-mcp-${randomUUID()}.tmp`);
    let handle: fs.FileHandle | undefined;
    try {
      handle = await fs.open(tmp, 'wx', mode ?? 0o666);
      await handle.writeFile(data);
      if (mode !== undefined) await handle.chmod(mode);
      await handle.close(); handle = undefined;
      if (exclusive) { await fs.link(tmp, filename); } // EEXIST cannot overwrite a raced Add/Move destination.
      else if (process.platform === 'win32') {
        const { windowsReplaceFile } = await import('../platform/windows-host.js');
        await windowsReplaceFile(tmp, filename);
      } else await fs.rename(tmp, filename);
    } finally {
      if (handle) await handle.close().catch(() => {});
      await fs.unlink(tmp).catch(e => {
        if (!missing(e)) warnings.push(`Temporary file cleanup failed: ${tmp}: ${e.message}`);
      });
    }
  }
  private async applyOnce(patch: string, cwd: string) {
    if (Buffer.byteLength(patch) > this.config.patch.max_patch_bytes) throw new ToolError('PATCH_TOO_LARGE', 'Patch exceeds configured byte budget.');
    if (!(await fs.stat(cwd)).isDirectory()) throw new ToolError('INVALID_WORKDIR', 'workdir is not a directory.');
    const hunks = parsePatch(patch);
    if (hunks.length > this.config.patch.max_files) throw new ToolError('PATCH_TOO_LARGE', 'Too many file operations.');
    const prepared: Prepared[] = [], touched = new Set<string>(); let total = 0;
    for (const hunk of hunks) {
      const source = expandPath(hunk.path, cwd), target = hunk.move ? expandPath(hunk.move, cwd) : source;
      const snapshot = hunk.operation === 'add' ? undefined : await this.snapshot(source, hunk.operation === 'update');
      if (hunk.operation === 'add' || hunk.move) await this.assertMissing(target);
      const canonicalTarget = await this.canonical(target);
      const keys = [source, hunk.operation === 'delete' ? source : snapshot?.actual ?? canonicalTarget, target, canonicalTarget]
        .map(p => process.platform === 'win32' ? p.toLowerCase() : p);
      for (const key of new Set(keys)) if (touched.has(key)) throw new ToolError('DUPLICATE_PATH', 'Patch operations share a source or destination.', { path: key });
      for (const key of keys) touched.add(key);
      let data: Buffer | undefined;
      if (hunk.operation === 'add') data = Buffer.from(hunk.text!, 'utf8');
      else if (hunk.operation === 'update') {
        const bytes = snapshot!.content!;
        if (!isUtf8(bytes) || bytes.includes(0)) throw new ToolError('NOT_TEXT', 'Update requires UTF-8 text without NUL bytes.', { path: source });
        data = Buffer.from(updateText(bytes.toString('utf8'), hunk.chunks), 'utf8');
      }
      total += (snapshot?.content?.length ?? 0) + (data?.length ?? 0);
      if (total > this.config.patch.max_total_file_bytes) throw new ToolError('PATCH_TOO_LARGE', 'Total file preparation budget exceeded.');
      prepared.push({ hunk, source, target, snapshot, data, canonicalTarget });
    }
    await this.hooks.beforeCommit?.();
    return this.mutex.run(async () => {
      for (const p of prepared) await this.verify(p);
      const changes: PatchChange[] = [], createdDirectories: string[] = [], warnings: string[] = [];
      let failedPath = '';
      try {
        for (let index = 0; index < prepared.length; index++) {
          const p = prepared[index]!; failedPath = p.source;
          await this.hooks.beforeWrite?.(index, p.source);
          await this.verify(p);
          if (p.hunk.operation === 'delete') {
            await fs.unlink(p.source); changes.push({ operation: 'delete', path: p.source });
          } else if (p.hunk.operation === 'add') {
            await this.ensureParent(p.target, createdDirectories);
            await this.writeAtomic(p.target, p.data!, undefined, true, warnings);
            changes.push({ operation: 'add', path: p.target });
          } else if (p.hunk.move) {
            await this.ensureParent(p.target, createdDirectories);
            await this.writeAtomic(p.target, p.data!, p.snapshot!.mode, true, warnings);
            const change: PatchChange = { operation: 'move', path: p.target, from: p.source, to: p.target, source_removed: false };
            changes.push(change);
            // Detect a source change occurring while the destination was written.
            const current = await this.snapshot(p.source, true);
            if (current.signature !== p.snapshot!.signature) throw new ToolError('FILE_CHANGED', 'Move source changed before unlink.', { path: p.source });
            await fs.unlink(p.source); change.source_removed = true;
          } else {
            await this.writeAtomic(p.snapshot!.actual, p.data!, p.snapshot!.mode, false, warnings);
            changes.push({ operation: 'update', path: p.source });
          }
        }
      } catch (e) {
        const partial = changes.length > 0 || createdDirectories.length > 0;
        throw new ToolError(partial ? 'PARTIAL_APPLY' : e instanceof ToolError ? e.code : 'PATCH_IO_ERROR',
          e instanceof Error ? e.message : String(e), { applied: false, partial, changes, failed_path: failedPath, created_directories: createdDirectories, warnings });
      }
      return { applied: true, partial: false, changes, created_directories: createdDirectories, warnings };
    });
  }
}
