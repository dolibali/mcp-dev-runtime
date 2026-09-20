import { lstat, opendir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { setImmediate as yieldLoop } from 'node:timers/promises';
import { limits } from './limits.js';
import { fileIdentity, hash, inside, validPath } from './io.js';
import { loadMetadata, type Metadata } from './metadata.js';
import type { SkillsConfig } from './config.js';

export type Root = { logical: string; scope: 'project' | 'user' | 'extra' };
export type Scope = { workdir: string; project_root: string; roots: Root[]; complete: boolean; warnings: string[] };
export type RootEntry = Metadata & { id: string; file: string; skillRoot: string; relative: string; stamp: string };
export type RootSnapshot = { canonical: string; entries: RootEntry[]; complete: boolean; warnings: string[] };
const ignored = new Set(['node_modules', 'vendor', '__pycache__', 'dist', 'coverage']);

export async function resolveScope(workdir: string, home: string, codexHome: string | undefined, config: SkillsConfig, check: () => void): Promise<Scope> {
  const roots: Root[] = [], warnings: string[] = [];
  let project = workdir, found = false, current = workdir, complete = true;
  const ancestors: string[] = [];
  for (let depth = 0; depth < limits.ancestors; depth++) {
    check(); ancestors.push(current);
    try { const s = await lstat(path.join(current, '.git')); if (s.isDirectory() || s.isFile()) { project = current; found = true; break; } }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { complete = false; warnings.push('Some project markers could not be checked.'); } }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
    if (depth === limits.ancestors - 1) { complete = false; warnings.push('Project ancestor limit reached.'); }
  }
  for (const dir of found ? ancestors : [workdir]) {
    roots.push({ logical: path.join(dir, '.agents', 'skills'), scope: 'project' });
    roots.push({ logical: path.join(dir, '.codex', 'skills'), scope: 'project' });
  }
  let codex = path.join(home, '.codex');
  if (codexHome) {
    if (path.isAbsolute(codexHome) && validPath(codexHome)) codex = codexHome;
    else { complete = false; warnings.push('Relative/invalid CODEX_HOME ignored.'); }
  }
  roots.push({ logical: path.join(home, '.agents', 'skills'), scope: 'user' });
  roots.push({ logical: path.join(codex, 'skills'), scope: 'user' });
  roots.push({ logical: path.join(codex, 'skills', '.system'), scope: 'user' });
  for (const extra of config.extra_roots) roots.push({ logical: extra, scope: 'extra' });
  const seen = new Set<string>();
  const unique = roots.filter(root => !seen.has(root.logical) && !!seen.add(root.logical));
  if (unique.length > limits.rootsPerCatalog) { complete = false; warnings.push('Skill root limit reached.'); }
  return { workdir, project_root: project, roots: unique.slice(0, limits.rootsPerCatalog), complete, warnings: warnings.slice(0, limits.warnings) };
}

export async function scanRoot(canonical: string, check: () => void, disabled: readonly string[] = []): Promise<RootSnapshot> {
  const result: RootSnapshot = { canonical, entries: [], complete: true, warnings: [] };
  const warn = (message: string) => {
    result.complete = false;
    if (result.warnings.length < limits.warnings && !result.warnings.includes(message)) result.warnings.push(message);
  };
  const queue = [{ directory: canonical, depth: 0 }], seen = new Set<string>();
  let directoryCount = 0, entryCount = 0;
  const until = Date.now() + limits.scanDeadlineMs;
  for (let offset = 0; offset < queue.length; offset++) {
    check();
    if (Date.now() > until || directoryCount >= limits.directoriesPerRoot || entryCount >= limits.entriesPerRoot || result.entries.length >= limits.skillsPerRoot) {
      warn('Skill scan limit reached; inventory is incomplete.'); break;
    }
    const { directory, depth } = queue[offset]!;
    let resolved: string;
    try { resolved = await realpath(directory); } catch { warn('A skill directory is unreadable or a link is broken.'); continue; }
    if (disabled.some(p => inside(p, directory) || inside(p, resolved))) continue;
    if (seen.has(resolved)) continue;
    seen.add(resolved); directoryCount++;
    const children: { name: string; directory: boolean; link: boolean }[] = [];
    try {
      const stream = await opendir(directory);
      for await (const item of stream) {
        check(); entryCount++;
        if (entryCount > limits.entriesPerRoot) { warn('Skill entry limit reached.'); break; }
        children.push({ name: item.name, directory: item.isDirectory(), link: item.isSymbolicLink() });
      }
    } catch { check(); warn('A skill directory could not be enumerated.'); continue; }
    children.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    // A skill is a package. Its scripts/references/assets are not discovery roots.
    if (children.some(item => item.name === 'SKILL.md')) {
      try {
        const logical = path.join(directory, 'SKILL.md');
        const identity = await fileIdentity(logical, resolved);
        if (disabled.some(p => inside(p, logical) || inside(p, identity.file))) continue;
        const metadata = await loadMetadata(logical, resolved);
        const after = await fileIdentity(logical, resolved);
        if (after.stamp !== identity.stamp || after.file !== identity.file) throw new Error('Changed');
        result.entries.push({ ...metadata, id: 'skill:' + hash(identity.file).slice(0, 32), file: identity.file,
          skillRoot: resolved, relative: path.relative(canonical, logical), stamp: identity.stamp });
      } catch { warn('A SKILL.md is invalid, changed, too large, or unreadable; it was skipped.'); }
      await yieldLoop();
      continue;
    }
    for (const child of children) {
      if (child.name.startsWith('.') || ignored.has(child.name) || !validPath(child.name)) continue;
      const target = path.join(directory, child.name);
      let directoryEntry = child.directory;
      if (child.link) {
        try { directoryEntry = (await stat(target)).isDirectory(); }
        catch { warn('A skill directory link is broken or cyclic.'); continue; }
      }
      if (!directoryEntry) continue;
      if (depth >= limits.scanDepth) { warn('Skill nesting limit reached.'); continue; }
      if (queue.length >= limits.directoriesPerRoot) { warn('Skill directory limit reached.'); break; }
      queue.push({ directory: target, depth: depth + 1 });
    }
    if (offset % 8 === 0) await yieldLoop();
  }
  return result;
}
