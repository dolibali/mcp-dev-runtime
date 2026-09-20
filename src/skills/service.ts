import { homedir } from 'node:os';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { setImmediate as yieldLoop } from 'node:timers/promises';
import type { Config } from '../config.js';
import { ToolError } from '../runtime/errors.js';
import { BoundedCache } from './cache.js';
import { discoverArgs, readArgs } from './arguments.js';
import { canonicalDirectory, fileIdentity, hash, inside, readText, resourcePath, utf8Prefix } from './io.js';
import { limits } from './limits.js';
import { displayDescription, loadMetadata } from './metadata.js';
import { resolveScope, scanRoot, type RootEntry, type RootSnapshot, type Scope } from './scan.js';
import { SearchIndex } from './search.js';

type Entry = RootEntry & { sourceRoot: string; canonicalRoot: string; scope: 'project' | 'user' | 'extra' };
type Catalog = Scope & { entries: Entry[]; index: SearchIndex; revision: string };
type Body = { bytes: Buffer; stamp: string; file: string; metadataRevision: string; scope: string; id: string; resource: string; revision: string };
type Cursor = { kind: 'list' | 'read'; scope: string; revision: string; offset: number; query?: string; key?: string };
export type ServiceEnvironment = { home?: string; codexHome?: string; now?: () => number };

export class SkillsService {
  private readonly home: string;
  private readonly codexHome: string | undefined;
  private readonly secret = randomBytes(32);
  private readonly rootCache: BoundedCache<RootSnapshot>;
  private readonly catalogs: BoundedCache<Catalog>;
  private readonly bodies: BoundedCache<Body>;
  private readonly rootLoads = new Map<string, Promise<RootSnapshot>>();
  private readonly catalogLoads = new Map<string, Promise<Catalog>>();
  private active = 0;
  private closed = false;
  private counts = { root_scans: 0, catalog_builds: 0, discoveries: 0, reads: 0 };

  constructor(private readonly config: Config, environment: ServiceEnvironment = {}) {
    this.home = path.resolve(environment.home ?? homedir());
    this.codexHome = environment.codexHome ?? process.env.CODEX_HOME;
    this.rootCache = new BoundedCache(limits.rootCacheEntries, limits.rootCacheBytes, environment.now);
    this.catalogs = new BoundedCache(limits.scopeCacheEntries, limits.scopeCacheBytes, environment.now);
    this.bodies = new BoundedCache(limits.bodyCacheEntries, limits.bodyCacheBytes, environment.now);
  }

  // Local tests/benchmarks may inspect counters; no query or document text is logged.
  diagnostics() { return { ...this.counts, active: this.active, root_entries: this.rootCache.size, scope_entries: this.catalogs.size,
    body_entries: this.bodies.size, accounted_cache_bytes: this.rootCache.bytes + this.catalogs.bytes + this.bodies.bytes, closed: this.closed }; }
  close() { this.closed = true; this.rootCache.clear(); this.catalogs.clear(); this.bodies.clear(); }

  private async request<T>(fn: (check: () => void) => Promise<T>): Promise<T> {
    if (this.closed) throw new ToolError('SKILLS_CLOSED', 'Skill service is shutting down.');
    if (this.active >= 4) throw new ToolError('SKILLS_BUSY', 'Too many concurrent skill requests; retry later.');
    this.active++;
    const until = Date.now() + limits.requestDeadlineMs;
    const check = () => {
      if (this.closed) throw new ToolError('SKILLS_CLOSED', 'Skill service is shutting down.');
      if (Date.now() > until) throw new ToolError('SKILLS_TIMEOUT', 'Skill request exceeded its cooperative time budget.');
    };
    try { const value = await fn(check); check(); return value; }
    finally { this.active--; }
  }

  private encode(cursor: Cursor): string {
    const data = Buffer.from(JSON.stringify(cursor)).toString('base64url');
    return data + '.' + createHmac('sha256', this.secret).update(data).digest('base64url');
  }
  private decode(value: string, kind: Cursor['kind'], scope: string): Cursor {
    try {
      const [data, mac, extra] = value.split('.');
      if (!data || !mac || extra) throw new Error();
      const received = Buffer.from(mac, 'base64url'), expected = createHmac('sha256', this.secret).update(data).digest();
      if (received.length !== expected.length || !timingSafeEqual(received, expected)) throw new Error();
      const cursor = JSON.parse(Buffer.from(data, 'base64url').toString('utf8')) as Cursor;
      if (cursor.kind !== kind || cursor.scope !== scope || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0) throw new Error();
      return cursor;
    } catch { throw new ToolError('INVALID_SKILL_CURSOR', 'Cursor is invalid, from another scope, or from an earlier server instance.'); }
  }

  private async disabledPaths(): Promise<string[]> {
    const disabled = new Set(this.config.skills.disabled_paths);
    for (const file of this.config.skills.disabled_paths) {
      try { disabled.add(await realpath(file)); } catch { /* Keep the logical path too, including missing/broken entries. */ }
    }
    return [...disabled];
  }
  private disabled(entry: Entry, paths: string[]): boolean {
    const logical = path.join(entry.sourceRoot, entry.relative);
    return paths.some(disabled => inside(disabled, logical) || inside(disabled, entry.file));
  }

  private async catalog(workdir: string, refresh: boolean, check: () => void): Promise<Catalog> {
    check();
    if (!refresh) { const hit = this.catalogs.get(workdir); if (hit) return hit; }
    const existing = this.catalogLoads.get(workdir);
    if (existing) return existing;
    const loading = (async () => {
      this.counts.catalog_builds++;
      const scope = await resolveScope(workdir, this.home, this.codexHome, this.config.skills, check);
      const excluded = await this.disabledPaths();
      const entries: Entry[] = [], seen = new Set<string>(), roots = new Set<string>();
      let measured = 0;
      const warn = (message: string) => {
        scope.complete = false;
        if (scope.warnings.length < limits.warnings && !scope.warnings.includes(message)) scope.warnings.push(message);
      };
      for (const root of scope.roots) {
        check();
        let canonical: string;
        try { canonical = await realpath(root.logical); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') warn('A skill root is not accessible.'); continue; }
        if (roots.has(canonical)) continue;
        roots.add(canonical);
        const rootKey = canonical + '\0' + hash(JSON.stringify(excluded));
        if (refresh) this.rootCache.delete(rootKey);
        let snapshot = this.rootCache.get(rootKey);
        if (!snapshot) {
          let loading = this.rootLoads.get(rootKey);
          if (!loading) {
            loading = (async () => {
              this.counts.root_scans++;
              const result = await scanRoot(canonical, check, excluded);
              check();
              this.rootCache.set(rootKey, result, Buffer.byteLength(JSON.stringify(result)) * 4 + 1024, limits.catalogTtlMs);
              return result;
            })();
            this.rootLoads.set(rootKey, loading);
          }
          try { snapshot = await loading; } finally { if (this.rootLoads.get(rootKey) === loading) this.rootLoads.delete(rootKey); }
        }
        if (!snapshot.complete) for (const message of snapshot.warnings) warn(message);
        for (const skill of snapshot.entries) {
          if (seen.has(skill.id)) continue;
          const entry: Entry = { ...skill, sourceRoot: root.logical, canonicalRoot: canonical, scope: root.scope };
          const bytes = Buffer.byteLength(JSON.stringify(entry)) * 4 + 1024;
          if (entries.length >= limits.skillsPerCatalog || measured + bytes > limits.scopeCacheBytes / 2) { warn('Combined skill catalog reached its bounded size.'); break; }
          measured += bytes; seen.add(skill.id); entries.push(entry);
        }
      }
      check(); await yieldLoop();
      const index = new SearchIndex(entries);
      const revision = hash(JSON.stringify([scope.roots, scope.complete, entries.map(e => [e.id, e.sourceRoot, e.stamp, e.metadata_revision])]));
      const catalog = { ...scope, entries, index, revision };
      check(); this.catalogs.set(workdir, catalog, measured + 2048, limits.catalogTtlMs);
      return catalog;
    })();
    this.catalogLoads.set(workdir, loading);
    try { return await loading; } finally { if (this.catalogLoads.get(workdir) === loading) this.catalogLoads.delete(workdir); }
  }

  async discover(input: unknown): Promise<Record<string, unknown>> {
    const args = discoverArgs.safeParse(input);
    if (!args.success) throw new ToolError('INVALID_ARGUMENTS', 'Invalid discover_skills arguments; pass absolute workdir and bounded query/limit/cursor.');
    const a = args.data;
    if (a.refresh && a.cursor) throw new ToolError('INVALID_ARGUMENTS', 'Do not combine refresh with a continuation cursor.');
    return this.request(async check => {
      this.counts.discoveries++;
      const workdir = await canonicalDirectory(a.workdir), scopeId = hash(workdir);
      const catalog = await this.catalog(workdir, a.refresh, check), disabled = await this.disabledPaths();
      const queryHash = hash(a.query ?? '');
      const eligible = (a.query ? catalog.index.rank(a.query) : catalog.entries.map((_, index) => index))
        .map(index => catalog.entries[index]!)
        .filter(entry => !this.disabled(entry, disabled) && (!a.query || entry.implicit_allowed));
      const revision = hash(catalog.revision + JSON.stringify(disabled));
      const cursor = a.cursor ? this.decode(a.cursor, 'list', scopeId) : undefined;
      if (cursor && (cursor.revision !== revision || cursor.query !== queryHash)) throw new ToolError('CATALOG_CHANGED', 'Catalog or query changed; begin a new discovery.');
      const start = cursor?.offset ?? 0;
      if (start > eligible.length) throw new ToolError('INVALID_SKILL_CURSOR', 'Catalog cursor is out of range.');
      const rows: Record<string, unknown>[] = [];
      const make = (end: number) => ({
        workdir, project_root: catalog.project_root, catalog_revision: revision, catalog_complete: catalog.complete,
        skills: rows, warnings: catalog.warnings,
        next_cursor: end < eligible.length ? this.encode({ kind: 'list', scope: scopeId, revision, query: queryHash, offset: end }) : null
      });
      let end = start;
      for (; end < eligible.length && rows.length < a.limit; end++) {
        const entry = eligible[end]!;
        const origin = path.join(entry.sourceRoot, entry.relative);
        rows.push({ id: entry.id, name: entry.name, ...displayDescription(entry), scope: entry.scope,
          origin: utf8Prefix(origin, 512), origin_truncated: Buffer.byteLength(origin) > 512,
          implicit_allowed: entry.implicit_allowed,
          ...(entry.compatibility ? { compatibility: utf8Prefix(entry.compatibility, 256) } : {}),
          ...(entry.dependencies.length ? { dependencies: entry.dependencies.slice(0, 4), dependencies_complete: entry.dependencies.length <= 4 } : {}) });
        if (Buffer.byteLength(JSON.stringify(make(end + 1))) > limits.discoveryBytes) { rows.pop(); break; }
      }
      if (!rows.length && start < eligible.length) throw new ToolError('SKILL_RESPONSE_LIMIT', 'A catalog entry exceeds the response budget; use its exact skill name to read or shorten metadata.');
      const result = make(end);
      if (Buffer.byteLength(JSON.stringify(result)) > limits.discoveryBytes) throw new ToolError('SKILL_RESPONSE_LIMIT', 'Workspace metadata exceeds the discovery response budget.');
      check(); return result;
    });
  }

  private async assertLocation(entry: Entry) {
    try {
      if (await realpath(entry.sourceRoot) !== entry.canonicalRoot ||
          await realpath(path.join(entry.sourceRoot, entry.relative)) !== entry.file ||
          await realpath(path.dirname(path.join(entry.sourceRoot, entry.relative))) !== entry.skillRoot) throw new Error();
    } catch { throw new ToolError('SKILL_CHANGED', 'The discovered skill location changed or was removed; refresh discovery.'); }
  }

  async read(input: unknown): Promise<Record<string, unknown>> {
    const args = readArgs.safeParse(input);
    if (!args.success) throw new ToolError('INVALID_ARGUMENTS', 'Invalid read_skill arguments; pass workdir, selected skill, and optional relative resource.');
    const a = args.data;
    return this.request(async check => {
      this.counts.reads++;
      const workdir = await canonicalDirectory(a.workdir), scopeId = hash(workdir);
      let catalog = await this.catalog(workdir, false, check);
      let candidates = catalog.entries.filter(e => e.id === a.skill || e.name === a.skill);
      // Exact newly installed skills need no separate discovery tool call.
      if (!candidates.length && !a.cursor) { catalog = await this.catalog(workdir, true, check); candidates = catalog.entries.filter(e => e.id === a.skill || e.name === a.skill); }
      const disabled = await this.disabledPaths();
      candidates = candidates.filter(e => !this.disabled(e, disabled));
      if (!candidates.length) throw new ToolError('SKILL_NOT_AVAILABLE', 'Skill is not available in this workdir or is disabled.');
      if (candidates.length !== 1) throw new ToolError('AMBIGUOUS_SKILL', 'Several skills share this name; discover candidates and pass the exact ID.', {
        candidates: candidates.slice(0, 5).map(e => ({ id: e.id, scope: e.scope, origin: utf8Prefix(path.join(e.sourceRoot, e.relative), 256) }))
      });
      const entry = candidates[0]!;
      await this.assertLocation(entry);
      const logical = path.join(entry.sourceRoot, entry.relative);
      const metadata = await loadMetadata(logical, entry.skillRoot);
      if (!a.skill.startsWith('skill:') && metadata.name !== a.skill) throw new ToolError('SKILL_CHANGED', 'Skill name changed since discovery; refresh and select its current identity.');
      if (!a.explicit && !metadata.implicit_allowed) throw new ToolError('EXPLICIT_SKILL_REQUIRED', 'This skill does not allow implicit use. Only set explicit=true when the user actually selected it.');
      const file = a.resource === 'SKILL.md' ? logical : resourcePath(entry.skillRoot, a.resource);
      const identity = await fileIdentity(file, entry.skillRoot);
      if (identity.size > limits.fileBytes) throw new ToolError('SKILL_TOO_LARGE', 'Text resource exceeds 256 KiB; split it into references.');
      const key = hash([scopeId, entry.id, a.resource].join('\0'));
      const cursor = a.cursor ? this.decode(a.cursor, 'read', scopeId) : undefined;
      if (cursor && cursor.key !== key) throw new ToolError('INVALID_SKILL_CURSOR', 'Cursor belongs to a different skill or resource.');
      let body = this.bodies.get(key);
      if (cursor && !body) throw new ToolError('CURSOR_EXPIRED', 'Read snapshot expired or was evicted; read this resource from the beginning.');
      if (body && (body.file !== identity.file || body.stamp !== identity.stamp || body.metadataRevision !== metadata.metadata_revision)) {
        this.bodies.delete(key); body = undefined;
        if (cursor) throw new ToolError('SKILL_CHANGED', 'Resource or invocation policy changed; read from the beginning.');
      }
      if (!body) {
        const data = await readText(file, limits.fileBytes, entry.skillRoot);
        body = { bytes: Buffer.from(data.text), file: data.file, stamp: data.stamp, metadataRevision: metadata.metadata_revision,
          scope: scopeId, id: entry.id, resource: a.resource, revision: 'sha256:' + hash(data.text) };
        check(); this.bodies.set(key, body, body.bytes.length + 2048, limits.bodyTtlMs);
      }
      if (cursor && (cursor.revision !== body.revision || cursor.offset > body.bytes.length ||
          (cursor.offset < body.bytes.length && (body.bytes[cursor.offset]! & 0xc0) === 0x80))) throw new ToolError('SKILL_CHANGED', 'Read cursor does not match this snapshot.');
      await this.assertLocation(entry);
      const latest = await loadMetadata(logical, entry.skillRoot);
      if (latest.metadata_revision !== metadata.metadata_revision || this.disabled(entry, await this.disabledPaths())) {
        this.bodies.delete(key); throw new ToolError('SKILL_CHANGED', 'Skill invocation policy changed while reading; start again.');
      }
      const start = cursor?.offset ?? 0;
      const make = (end: number) => ({ id: entry.id, name: metadata.name, workdir, skill_root: entry.skillRoot,
        resource: a.resource, revision: body!.revision,
        contents: body!.bytes.subarray(start, end).toString('utf8'), content_complete: end === body!.bytes.length,
        next_cursor: end < body!.bytes.length ? this.encode({ kind: 'read', scope: scopeId, revision: body!.revision, offset: end, key }) : null,
        ...(metadata.compatibility ? { compatibility: metadata.compatibility } : {}),
        ...(metadata.dependencies.length ? { dependencies: metadata.dependencies, dependencies_verified: false } : {}),
        warnings: metadata.warnings });
      let low = start, high = Math.min(body.bytes.length, start + limits.readBytes);
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (Buffer.byteLength(JSON.stringify(make(mid))) <= limits.readBytes) low = mid; else high = mid - 1;
      }
      let end = low;
      while (end > start && end < body.bytes.length && (body.bytes[end]! & 0xc0) === 0x80) end--;
      if (end === start && start < body.bytes.length || Buffer.byteLength(JSON.stringify(make(end))) > limits.readBytes) throw new ToolError('SKILL_RESPONSE_LIMIT', 'Resource metadata exceeds the response budget.');
      check(); return make(end);
    });
  }
}
