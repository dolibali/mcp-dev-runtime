import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Config } from '../config.js';
import { expandPath } from '../config.js';
import { ToolError } from './errors.js';
import { queryLog, utf8Prefix, type LogQuery } from './log-query.js';

export type HistoryRecord = {
  version: 1; seq: number; archive_id: string; session_id: number; instance_id: string;
  state: string; exit_code: number | null; signal: string | null; tty: boolean; workdir: string;
  created_at: string; ended_at: string | null; cmd: string; label?: string; request_id: null;
  total_output_bytes: number; captured_output_bytes: number; capture_output: boolean;
  output_truncated: boolean; warning?: string; error?: { code: string; message: string };
};
type Entry = { record: HistoryRecord; metaBytes: number; logBytes: number; reservedBytes: number; pending: Buffer[]; queued: boolean; accepting: boolean; writeFailed: boolean };
export type HistoryFilter = { state?: string; workdir?: string; label?: string; outcome?: 'success' | 'failure' | 'unknown'; limit?: number; cursor?: string; order?: 'asc' | 'desc' };
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[1-9][0-9]{0,15}$/;
const closedState = (state: string) => !['running', 'terminating'].includes(state);
const nofollow = constants.O_NOFOLLOW ?? 0;
const missing = (e: unknown) => (e as NodeJS.ErrnoException).code === 'ENOENT';
const MAX_META = 24576;
export type HistoryHooks = { beforeWrite?: (kind:'metadata'|'log',id:string) => void | Promise<void> };
export function matchesFilter(r: { state: string; exit_code: number | null; workdir: string; label?: string }, f: HistoryFilter) {
  if (f.state && r.state !== f.state) return false;
  if (f.workdir && r.workdir !== f.workdir) return false;
  if (f.label && !(r.label ?? '').includes(f.label)) return false;
  if (f.outcome === 'success' && !(r.state === 'exited' && r.exit_code === 0)) return false;
  if (f.outcome === 'failure' && !(closedState(r.state) && r.state !== 'unknown' && !(r.state === 'exited' && r.exit_code === 0))) return false;
  if (f.outcome === 'unknown' && r.state !== 'unknown') return false;
  return true;
}

/** Single-writer, bounded, local execution archive. No command replay or process recovery. */
export class HistoryStore {
  readonly directory: string;
  private entries = new Map<string, Entry>();
  private active = new Set<string>();
  private serial: Promise<void> = Promise.resolve();
  readonly ready: Promise<void>;
  private sequence = 0;
  private bytes = 0;
  private pendingBytes = 0;
  private lockToken = randomUUID();
  private locked = false;
  private initialized = false;
  private closed = false;
  private closing = false;
  private closePromise?: Promise<void>;
  private state: 'disabled' | 'starting' | 'ready' | 'degraded';
  private warnings: string[] = [];
  private evicted = 0;
  constructor(readonly config: Config, readonly instanceId: string, private hooks:HistoryHooks = {}) {
    this.directory = expandPath(config.history.directory, config.cwd);
    this.state = config.history.enabled ? 'starting' : 'disabled';
    this.ready = config.history.enabled ? this.initialize().catch(e => { this.problem('HISTORY_INIT_FAILED', e); }) : Promise.resolve();
  }
  get status() {
    return { state: this.state, directory: this.directory, records: this.entries.size, bytes: this.bytes,
      pending_bytes: this.pendingBytes, max_records: this.config.history.max_records,
      max_total_bytes: this.config.history.max_total_bytes, record_command: this.config.history.record_command,
      record_output: this.config.history.record_output, evicted_records: this.evicted, warnings: [...this.warnings] };
  }
  private problem(code: string, error?: unknown) {
    const detail = error instanceof Error ? error.message : error ? String(error) : '';
    const message = `${code}${detail ? ': ' + detail.slice(0, 300) : ''}`;
    if (!this.warnings.includes(message)) { this.warnings.push(message); if (this.warnings.length > 8) this.warnings.shift(); }
    if (this.state !== 'disabled') this.state = 'degraded';
  }
  private filename(id: string, extension: 'json' | 'log' | 'tmp') {
    if (!ID.test(id)) throw new ToolError('INVALID_HISTORY_ID', 'archive_id is not a valid execution archive identifier.');
    return path.join(this.directory, `${id}.${extension}`);
  }
  private async initialize() {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const dirStat = await fs.lstat(this.directory);
    if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) throw new Error('History directory must be a real dedicated directory, not a symlink.');
    await fs.chmod(this.directory, 0o700);
    const lock = path.join(this.directory, '.writer-lock');
    try { await fs.mkdir(lock, { mode: 0o700 }); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const s = await fs.lstat(lock);
      if (!s.isDirectory() || s.isSymbolicLink()) throw new Error('Invalid history writer lock.');
      const owner = JSON.parse(await fs.readFile(path.join(lock, 'owner.json'), 'utf8'));
      if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0 || typeof owner.token !== 'string') throw new Error('Unverifiable history writer lock.');
      let live = true;
      try { process.kill(owner.pid, 0); } catch (err) { if ((err as NodeJS.ErrnoException).code === 'ESRCH') live = false; }
      if (live) throw new Error('History directory is already in use; each concurrent server needs its own history directory.');
      // Only the recognized dead-owner files are removed, never arbitrary directories.
      await fs.unlink(path.join(lock, 'owner.json')); await fs.rmdir(lock);
      await fs.mkdir(lock, { mode: 0o700 });
    }
    this.locked = true;
    await fs.writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, token: this.lockToken }), { flag: 'wx', mode: 0o600 });
    const names = await fs.readdir(this.directory);
    for (const name of names) {
      const id = name.slice(0, -5);
      if (!name.endsWith('.json') || !ID.test(id)) continue;
      const file = this.filename(id, 'json'), s = await fs.lstat(file);
      if (!s.isFile() || s.isSymbolicLink() || s.size > MAX_META) throw new Error(`Invalid history metadata file: ${name}`);
      const handle = await fs.open(file, constants.O_RDONLY | nofollow);
      let r: HistoryRecord;
      try { r = JSON.parse(await handle.readFile('utf8')); } finally { await handle.close(); }
      this.validateRecord(r, id);
      let logBytes = 0;
      try {
        const ls = await fs.lstat(this.filename(id, 'log'));
        if (!ls.isFile() || ls.isSymbolicLink()) throw new Error('History log is not a regular file.');
        logBytes = ls.size;
      } catch (e) { if (!missing(e)) throw e; }
      if (r.capture_output && logBytes < r.captured_output_bytes) { r.warning = 'ARCHIVE_LOG_SHORTENED'; r.output_truncated = true; }
      if (!closedState(r.state)) {
        // A record is evidence of a launch, not proof of the eventual process outcome.
        r.state = 'unknown'; r.exit_code = null; r.signal = null; r.ended_at = null;
        // There is no final capture boundary, so completeness cannot be asserted.
        r.output_truncated ||= r.capture_output;
        r.warning = 'PREVIOUS_INSTANCE_OUTCOME_UNCONFIRMED';
      }
      r.captured_output_bytes = logBytes;
      r.total_output_bytes = Math.max(r.total_output_bytes, logBytes);
      this.entries.set(id, { record: r, metaBytes: s.size, logBytes, reservedBytes:logBytes, pending: [], queued: false, accepting: false, writeFailed:false });
      this.bytes += s.size + logBytes; this.sequence = Math.max(this.sequence, r.seq);
    }
    // Stale temporary files and orphan logs are ours only after exclusive ownership is acquired.
    for (const name of names) {
      const match = /^(.*)\.(tmp|log)$/.exec(name);
      if (match && ID.test(match[1]!) && (match[2] === 'tmp' || !this.entries.has(match[1]!))) {
        const file = path.join(this.directory, name), st = await fs.lstat(file);
        if (!st.isFile() || st.isSymbolicLink()) throw new Error('Unexpected entry in history directory.');
        await fs.unlink(file);
      }
    }
    await this.makeRoom(0, 0);
    this.initialized = true;
    this.state = 'ready';
  }
  private validateRecord(r: HistoryRecord, id: string) {
    if (r.version !== 1 || r.archive_id !== id || !Number.isSafeInteger(r.session_id) || r.session_id < 1 ||
        id !== `${r.instance_id}.${r.session_id}` || !Number.isSafeInteger(r.seq) || r.seq < 1 ||
        !['running','terminating','exited','terminated','timed_out','start_failed','unknown'].includes(r.state) ||
        typeof r.workdir !== 'string' || typeof r.cmd !== 'string' || typeof r.tty !== 'boolean' ||
        typeof r.capture_output !== 'boolean' || !Number.isSafeInteger(r.total_output_bytes) || r.total_output_bytes < 0 ||
        !Number.isSafeInteger(r.captured_output_bytes) || r.captured_output_bytes < 0 ||
        typeof r.created_at !== 'string' || !Number.isFinite(Date.parse(r.created_at)) ||
        !(r.ended_at === null || (typeof r.ended_at === 'string' && Number.isFinite(Date.parse(r.ended_at)))) ||
        !(r.exit_code === null || Number.isInteger(r.exit_code)) || !(r.signal === null || typeof r.signal === 'string'))
      throw new Error(`Invalid history record: ${id}`);
  }
  private enqueue(action: () => Promise<void>): Promise<void> {
    const work = this.serial.then(action);
    this.serial = work.catch(e => { this.problem('HISTORY_IO_FAILED', e); });
    return this.serial;
  }
  private async remove(id: string) {
    const e = this.entries.get(id);
    if (!e || this.active.has(id)) return;
    for (const ext of ['log', 'json'] as const) await fs.unlink(this.filename(id, ext)).catch(err => { if (!missing(err)) throw err; });
    this.bytes -= e.metaBytes + e.logBytes; this.entries.delete(id); this.evicted++;
  }
  private async makeRoom(extraBytes: number, extraRecords: number, protect?: string) {
    // Keep the old metadata allocation as a reserve for atomic-replacement temporary files.
    const limit = this.config.history.max_total_bytes;
    if (this.bytes + extraBytes <= limit && this.entries.size + extraRecords <= this.config.history.max_records) return;
    for (const [id] of [...this.entries].sort((a,b) => a[1].record.seq - b[1].record.seq)) {
      if (id === protect || this.active.has(id)) continue;
      await this.remove(id);
      if (this.bytes + extraBytes <= limit && this.entries.size + extraRecords <= this.config.history.max_records) return;
    }
    if (this.bytes + extraBytes > limit || this.entries.size + extraRecords > this.config.history.max_records)
      throw new ToolError('HISTORY_CAPACITY', 'History capacity is occupied by protected active records; execution continues without additional archive data.');
  }
  private async save(e: Entry) {
    const text = JSON.stringify(e.record) + '\n', size = Buffer.byteLength(text);
    if (size > MAX_META) throw new Error('History metadata exceeds its bounded size.');
    await this.makeRoom(size, 0, e.record.archive_id);
    await this.hooks.beforeWrite?.('metadata',e.record.archive_id);
    const temporary = this.filename(e.record.archive_id, 'tmp');
    const handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | nofollow, 0o600);
    try {
      try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
      await fs.rename(temporary, this.filename(e.record.archive_id, 'json'));
    } catch (err) { await fs.unlink(temporary).catch(() => {}); throw err; }
    this.bytes += size - e.metaBytes; e.metaBytes = size;
  }
  async start(data: Omit<HistoryRecord, 'version' | 'seq' | 'archive_id' | 'cmd' | 'captured_output_bytes' | 'output_truncated' | 'request_id'> & { cmd: string }): Promise<string | undefined> {
    await this.ready;
    if (!this.locked || !this.initialized || this.closing) return undefined;
    const id = `${this.instanceId}.${data.session_id}`;
    let started = false;
    await this.enqueue(async () => {
      await this.makeRoom(MAX_META, 1);
      const record: HistoryRecord = { ...data, version: 1, seq: ++this.sequence, archive_id: id, request_id: null,
        cmd: this.config.history.record_command ? utf8Prefix(Buffer.from(data.cmd), 4096).toString() : '[not recorded]',
        captured_output_bytes: 0, output_truncated: false };
      const e: Entry = { record, metaBytes: 0, logBytes: 0, reservedBytes:0, pending: [], queued: false, accepting: record.capture_output, writeFailed:false };
      this.entries.set(id, e); this.active.add(id);
      try {
        if (record.capture_output) {
          const f = await fs.open(this.filename(id, 'log'), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | nofollow, 0o600);
          await f.close();
        }
        await this.save(e); started = true;
      } catch (err) {
        this.active.delete(id); this.entries.delete(id);
        for (const ext of ['json','log','tmp'] as const) await fs.unlink(this.filename(id, ext)).catch(() => {});
        throw err;
      }
    });
    return started ? id : undefined;
  }
  append(id: string | undefined, text: string) {
    if (!id || this.closing) return;
    const e = this.entries.get(id);
    if (!e || !e.record.capture_output || !e.accepting) return;
    const bytes = Buffer.from(text);
    const maximum = Math.min(this.config.history.max_log_bytes - e.reservedBytes,
      this.config.history.max_pending_bytes - this.pendingBytes);
    const kept = utf8Prefix(bytes, maximum);
    if (kept.length < bytes.length) {
      e.accepting = false; e.record.output_truncated = true;
      e.record.warning = maximum < this.config.history.max_log_bytes - e.reservedBytes ? 'ARCHIVE_QUEUE_LIMIT' : 'ARCHIVE_LOG_LIMIT';
    }
    if (!kept.length) return;
    // Copy the slice so a small retained prefix cannot hold a large process-output buffer alive.
    e.pending.push(Buffer.from(kept)); this.pendingBytes += kept.length; e.reservedBytes += kept.length;
    if (!e.queued) {
      e.queued = true;
      void this.enqueue(async () => {
        const chunk = Buffer.concat(e.pending); e.pending = []; e.queued = false;
        try {
          if (e.writeFailed) return;
          await this.makeRoom(chunk.length + MAX_META, 0, id);
          await this.hooks.beforeWrite?.('log',id);
          const file = await fs.open(this.filename(id, 'log'), constants.O_WRONLY | constants.O_APPEND | nofollow);
          try { await file.writeFile(chunk); } finally { await file.close(); }
          e.logBytes += chunk.length; this.bytes += chunk.length; e.record.captured_output_bytes = e.logBytes;
        } catch (err) {
          e.accepting = false; e.writeFailed = true; e.record.output_truncated = true; e.record.warning = 'ARCHIVE_WRITE_FAILED';
          // Account for a partial disk write without claiming complete capture.
          try { const s = await fs.stat(this.filename(id,'log')); this.bytes += s.size - e.logBytes; e.logBytes = s.size; e.record.captured_output_bytes = s.size; } catch {}
          throw err;
        } finally { this.pendingBytes -= chunk.length; }
      });
    }
  }
  finish(id: string | undefined, result: { state: string; exit_code: number | null; signal: string | null; ended_at: string | null; total_output_bytes: number; error?: {code: string; message: string} }) {
    if (!id) return;
    void this.enqueue(async () => {
      const e = this.entries.get(id); if (!e) return;
      Object.assign(e.record, result);
      if (e.record.error) e.record.error = { code: e.record.error.code, message: e.record.error.message.slice(0, 1000) };
      e.accepting = false;
      try {
        if (e.record.capture_output) {
          const f = await fs.open(this.filename(id, 'log'), constants.O_RDONLY | nofollow);
          try { await f.sync(); } finally { await f.close(); }
          e.record.output_truncated ||= e.logBytes < result.total_output_bytes;
        }
        await this.save(e);
      } catch (err) {
        e.record.warning='ARCHIVE_FINALIZE_FAILED';
        e.record.output_truncated ||= e.record.capture_output;
        throw err;
      } finally { this.active.delete(id); }
    });
  }
  async flush() { await this.ready; await this.serial; }
  private async available() {
    await this.flush();
    if (this.closed || !this.locked || !this.initialized || this.state === 'disabled') throw new ToolError('HISTORY_UNAVAILABLE', 'History is disabled, closed or unavailable.', { history: this.status });
  }
  async list(f: HistoryFilter = {}) {
    await this.available();
    const order = f.order ?? 'desc', filters = JSON.stringify([f.state ?? null,f.workdir ?? null,f.label ?? null,f.outcome ?? null,order]);
    let ceiling = this.sequence, after = order === 'desc' ? Number.MAX_SAFE_INTEGER : 0;
    if (f.cursor) {
      try {
        const c = JSON.parse(Buffer.from(f.cursor,'base64url').toString());
        if (c.instance !== this.instanceId || c.filters !== filters || !Number.isSafeInteger(c.ceiling) || !Number.isSafeInteger(c.after) || c.ceiling < 0 || c.after < 0) throw new Error();
        ceiling = c.ceiling; after = c.after;
      } catch { throw new ToolError('INVALID_CURSOR','History cursor is invalid, from another instance or for different filters.'); }
    }
    const eligible = [...this.entries.values()].map(e=>e.record).filter(r=>r.seq<=ceiling && (order==='desc'?r.seq<after:r.seq>after) && matchesFilter(r,f))
      .sort((a,b)=>order==='desc'?b.seq-a.seq:a.seq-b.seq);
    const selected = eligible.slice(0, f.limit ?? 20), last = selected.at(-1)?.seq;
    return { instance_id: this.instanceId, scope: 'history', sessions: selected.map(r=>({
      session_id:r.session_id,instance_id:r.instance_id,state:r.state,exit_code:r.exit_code,signal:r.signal,tty:r.tty,
      workdir:r.workdir,created_at:r.created_at,ended_at:r.ended_at,cmd:r.cmd,request_id:null,label:r.label,
      next_output_cursor:0,total_output_bytes:r.total_output_bytes,retained_from:0,archive_id:r.archive_id,
      capture_output:r.capture_output,archive_output_bytes:r.captured_output_bytes,archive_truncated:r.output_truncated,history_warning:r.warning
    })), next_cursor: eligible.length>selected.length && last!==undefined ? Buffer.from(JSON.stringify({instance:this.instanceId,filters,ceiling,after:last})).toString('base64url') : null,
      history_status: this.status };
  }
  async read(id: string, q: LogQuery & { output_cursor?: number }, tokens: number) {
    await this.available();
    this.filename(id,'json');
    const e = this.entries.get(id);
    if (!e) throw new ToolError('HISTORY_NOT_FOUND','Archive was not found or was removed by capacity rotation.');
    if (!e.record.capture_output) throw new ToolError('OUTPUT_NOT_RECORDED','This execution saved metadata only. Enable capture_output when starting a task to archive its output.');
    const r = { ...e.record }, end = e.logBytes;
    const file = await fs.open(this.filename(id,'log'), constants.O_RDONLY | nofollow);
    try {
      const reader = { end, retainedFrom:0, read:async(cursor:number,budget:number) => {
        if (!Number.isSafeInteger(cursor)||cursor<0||cursor>end) throw new ToolError('INVALID_CURSOR','Cursor outside archived log.',{end});
        const buffer = Buffer.alloc(Math.min(end-cursor, budget+4));
        let n=0;
        while(n<buffer.length){const part=await file.read(buffer,n,buffer.length-n,cursor+n);if(!part.bytesRead)break;n+=part.bytesRead;}
        if (n && (buffer[0]! & 0xc0) === 0x80) throw new ToolError('INVALID_CURSOR','Archived output cursor must lie on a UTF-8 boundary.');
        const selected = utf8Prefix(buffer.subarray(0,n),budget);
        let decoded:string;
        try { decoded = new TextDecoder('utf-8',{fatal:true}).decode(selected); }
        catch { throw new ToolError('HISTORY_LOG_CORRUPT','Archived bytes contain an incomplete or invalid UTF-8 sequence; output cannot be presented as intact.'); }
        if (cursor+selected.length<end && !selected.length && budget>3) throw new ToolError('HISTORY_LOG_SHORTENED','Archived file was shortened or changed after it was indexed.');
        return {output:decoded,output_start:cursor,next_output_cursor:cursor+selected.length,has_more:cursor+selected.length<end,
          retained_from:0,output_gap:false,total_output_bytes:end};
      }};
      const budget=Math.min(tokens*4,65536);
      const output=q.tail_lines!==undefined||q.search!==undefined?await queryLog(reader,q,budget):await reader.read(q.output_cursor??0,budget);
      return {session_id:r.session_id,instance_id:r.instance_id,state:r.state,exit_code:r.exit_code,signal:r.signal,tty:r.tty,
        workdir:r.workdir,created_at:r.created_at,ended_at:r.ended_at,...output,total_output_bytes:r.total_output_bytes,
        budget_kind:'approximate',max_output_tokens:tokens,effective_yield_time_ms:0,source:'history',archive_id:id,
        archive_output_bytes:end,archive_truncated:r.output_truncated,history_warning:r.warning,label:r.label,error:r.error};
    } finally { await file.close(); }
  }
  async clear() {
    await this.available();
    if (this.active.size) throw new ToolError('HISTORY_BUSY','Cannot clear history with active archived tasks.');
    await this.enqueue(async()=>{for(const id of [...this.entries.keys()])await this.remove(id);});
    return this.status;
  }
  close(): Promise<void> {
    return this.closePromise ??= (async()=>{
      this.closing=true;await this.flush();
      if(this.locked){
        const lock=path.join(this.directory,'.writer-lock');
        try {const owner=JSON.parse(await fs.readFile(path.join(lock,'owner.json'),'utf8'));
          if(owner.token===this.lockToken){await fs.unlink(path.join(lock,'owner.json'));await fs.rmdir(lock);}
        } catch(e){this.problem('HISTORY_UNLOCK_FAILED',e);}
      }
      this.locked=false;this.closed=true;
    })();
  }
}
