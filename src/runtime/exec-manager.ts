import { randomInt, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { Config } from '../config.js';
import { expandPath } from '../config.js';
import { ToolError } from './errors.js';
import { RetryCache } from './retry-cache.js';
import { OutputLog } from './output-log.js';
import { startPipe, type ProcessHandle } from './pipe-process.js';
import { startPty } from './pty-process.js';
import { HistoryStore, matchesFilter, type HistoryFilter } from './history-store.js';
import { queryLog, validateQuery, type LogQuery } from './log-query.js';

export type ExecArgs = {
  cmd: string; workdir?: string; shell?: string; login?: boolean; tty?: boolean;
  yield_time_ms?: number; max_output_tokens?: number; timeout_ms?: number; request_id?: string;
  label?: string; capture_output?: boolean
};
export type InputArgs = {
  session_id: number; chars?: string; yield_time_ms?: number; max_output_tokens?: number;
  output_cursor?: number; request_id?: string; archive_id?: string;
  tail_lines?: number; search?: string; max_matches?: number
};
export type ExecState = 'running' | 'exited' | 'terminating' | 'terminated' | 'timed_out' | 'start_failed';
const terminalState = (s: ExecState) => s !== 'running' && s !== 'terminating';
type Session = {
  id: number; seq: number; cmd: string; cwd: string; tty: boolean; requestId?: string;
  state: ExecState; created: number; ended: number | null; exitCode: number | null; signal: string | null;
  log: OutputLog; cursor: number; busy: boolean; events: EventEmitter; handle?: ProcessHandle;
  timeout?: NodeJS.Timeout; escalation?: NodeJS.Timeout; reason?: 'timeout' | 'terminate'; error?: string;
  lastOutput: number; label?: string; archiveId?: string;
};
export class ExecManager {
  readonly instanceId = randomUUID();
  readonly history: HistoryStore;
  private records = new Map<number, Session>();
  private seq = 0;
  private accepting = true;
  private cachedOutputBytes = 0;
  private maintenance: NodeJS.Timeout;
  constructor(readonly config: Config, private retry = new RetryCache(config.request_cache_ttl_ms, config.request_cache_entries)) {
    this.history = new HistoryStore(config, this.instanceId);
    this.maintenance = setInterval(() => this.sweep(), config.exec.maintenance_interval_ms);
    this.maintenance.unref();
  }
  private get(id: number): Session {
    this.sweep();
    const s = this.records.get(id);
    if (!s) throw new ToolError('UNKNOWN_SESSION', 'No in-memory execution with this session_id. It may have been evicted or belong to another instance. Query list_exec_sessions with scope=history; never rerun a side-effecting command merely to recover logs.', { instance_id: this.instanceId });
    return s;
  }
  private normalize(a: ExecArgs) {
    return { ...a, workdir: expandPath(a.workdir ?? '.', this.config.cwd), shell: a.shell ?? this.config.shell,
      login: a.login ?? this.config.exec.default_login, tty: a.tty ?? this.config.exec.default_tty,
      yield_time_ms: Math.min(a.yield_time_ms ?? this.config.exec.default_yield_time_ms, this.config.exec.max_yield_time_ms),
      max_output_tokens: Math.min(a.max_output_tokens ?? this.config.exec.default_max_output_tokens, this.config.exec.max_output_tokens) };
  }
  exec(args: ExecArgs) {
    if (args.label !== undefined && (typeof args.label !== 'string' || args.label.length > 120)) throw new ToolError('INVALID_ARGUMENT', 'label must be at most 120 characters.');
    const a = this.normalize(args);
    return this.retry.run('exec_command', a.request_id, a, async () => {
      if (!this.accepting) throw new ToolError('SERVER_CLOSING', 'The service is shutting down.');
      this.sweep();
      if (this.activeCount >= this.config.exec.max_active_sessions) throw new ToolError('SESSION_LIMIT', 'The configured active execution limit has been reached.');
      let id: number;
      do { id = randomInt(1, 281474976710655); } while (this.records.has(id));
      const events = new EventEmitter(); events.setMaxListeners(64);
      // Retained records need a preview, not arbitrarily large shell source.
      const preview = a.cmd.length > 512 ? a.cmd.slice(0,512).replace(/[\uD800-\uDBFF]$/u,'') + '…' : a.cmd;
      const s: Session = { id, seq: ++this.seq, cmd: preview, cwd: a.workdir, tty: a.tty,
        requestId: a.request_id, state: 'running', created: Date.now(), ended: null, exitCode: null, signal: null,
        log: new OutputLog(this.config.exec.per_session_output_bytes), cursor: 0, busy: true, events, lastOutput: Date.now(), label: a.label };
      // Reserve the active slot before any asynchronous validation or spawn.
      this.records.set(id, s);
      const releaseRetry = this.retry.pin(a.request_id);
      const archiveEnd = () => this.history.finish(s.archiveId, { state:s.state,exit_code:s.exitCode,signal:s.signal,
        ended_at:s.ended===null?null:new Date(s.ended).toISOString(),total_output_bytes:s.log.end,
        error:s.error?{code:s.state==='start_failed'?'START_FAILED':'PROCESS_ERROR',message:s.error}:undefined });
      try {
        s.archiveId = await this.history.start({ session_id:s.id,instance_id:this.instanceId,state:s.state,
          exit_code:s.exitCode,signal:s.signal,tty:s.tty,workdir:s.cwd,created_at:new Date(s.created).toISOString(),ended_at:null,
          label:s.label,cmd:a.cmd,total_output_bytes:0,
          capture_output:a.capture_output ?? this.config.history.record_output });
        if (!(await stat(a.workdir)).isDirectory()) throw new Error('workdir is not a directory.');
        if (!path.isAbsolute(a.shell)) throw new Error('shell must be an absolute executable path.');
        const env = { ...process.env };
        delete env.CONTROL_PLANE_API_KEY; delete env.OPENAI_ADMIN_KEY;
        // Node test-runner context is private to the host, not the child task.
        delete env.NODE_TEST_CONTEXT;
        const processArgs = [a.login ? '-lc' : '-c', a.cmd];
        const events = {
          output: (text: string) => {
            this.history.append(s.archiveId, text);
            const before = s.log.size; s.log.append(text);
            this.cachedOutputBytes += s.log.size - before;
            s.lastOutput = Date.now(); this.enforceOutputBudget(); s.events.emit('change');
          },
          closed: (code: number | null, signal: string | null, error?: string) => {
            if (s.timeout) clearTimeout(s.timeout);
            if (s.escalation) clearTimeout(s.escalation);
            s.exitCode = signal || error ? null : code; s.signal = signal; s.ended = Date.now();
            s.error = error ?? s.error;
            s.state = error ? 'start_failed' : s.reason === 'timeout' ? 'timed_out' : s.reason ? 'terminated' : 'exited';
            // ChildProcess.spawnargs/PTY objects can retain the full command and buffers.
            s.handle = undefined;
            releaseRetry();
            archiveEnd();
            s.events.emit('change');
          }
        };
        s.handle = a.tty ? startPty(a.shell, processArgs, a.workdir, env, events) : startPipe(a.shell, processArgs, a.workdir, env, events);
        if (!this.accepting || s.reason) this.beginTermination(s, true, s.reason ?? 'terminate');
        if (a.timeout_ms !== undefined && !terminalState(s.state) && !s.reason) {
          s.timeout = setTimeout(() => this.beginTermination(s, false, 'timeout'), a.timeout_ms); s.timeout.unref();
        }
      } catch (error) {
        s.error = error instanceof Error ? error.message : String(error);
        s.state = 'start_failed'; s.ended = Date.now(); s.events.emit('change');
        s.handle = undefined;
        releaseRetry();
        archiveEnd();
      }
      try { await this.wait(s, 0, a.yield_time_ms, true); return this.read(s, undefined, a.max_output_tokens, a.yield_time_ms); }
      finally { s.busy = false; }
    });
  }
  write(args: InputArgs) {
    const chars = args.chars ?? '';
    validateQuery(args, chars);
    if (args.archive_id !== undefined) {
      if (chars) throw new ToolError('ARCHIVED_SESSION_READ_ONLY', 'Archived logs cannot receive input or resume a process.');
      if (!args.archive_id.endsWith(`.${args.session_id}`)) throw new ToolError('INVALID_HISTORY_ID', 'archive_id and session_id do not agree.');
      const tokens=Math.min(args.max_output_tokens??this.config.exec.default_max_output_tokens,this.config.exec.max_output_tokens);
      return this.retry.run('write_stdin',args.request_id,{...args,chars,max_output_tokens:tokens},()=>this.history.read(args.archive_id!,args,tokens));
    }
    const a = { ...args, chars,
      yield_time_ms: Math.min(args.yield_time_ms ?? (chars ? this.config.exec.default_input_yield_time_ms : this.config.exec.default_poll_yield_time_ms), this.config.exec.max_yield_time_ms),
      max_output_tokens: Math.min(args.max_output_tokens ?? this.config.exec.default_max_output_tokens, this.config.exec.max_output_tokens) };
    return this.retry.run('write_stdin', a.request_id, a, async () => {
      const s = this.get(a.session_id);
      if (a.tail_lines !== undefined || a.search !== undefined) {
        const output = await queryLog(s.log, a as LogQuery, Math.min(a.max_output_tokens * 4,65536));
        return {...this.summary(s),...output,budget_kind:'approximate',max_output_tokens:a.max_output_tokens,effective_yield_time_ms:0,
          error:s.error?{code:s.state==='start_failed'?'START_FAILED':'PROCESS_ERROR',message:s.error}:undefined};
      }
      const exclusive = chars.length > 0 || a.output_cursor === undefined;
      if (exclusive && s.busy) throw new ToolError('SESSION_BUSY', 'A default-cursor read or input is already in progress for this session.');
      if (exclusive) s.busy = true;
      try {
        const cursor = a.output_cursor ?? s.cursor;
        // Validate an explicit cursor before performing input side effects.
        s.log.read(cursor, 0);
        if (chars) {
          if (!s.tty) throw new ToolError('STDIN_CLOSED', 'Pipe stdin is closed. Start a tty=true session for interactive input.');
          if (terminalState(s.state) || !s.handle) throw new ToolError('SESSION_ENDED', 'The process no longer accepts input.');
          s.handle.write(chars);
        }
        await this.wait(s, cursor, a.yield_time_ms);
        return this.read(s, a.output_cursor, a.max_output_tokens, a.yield_time_ms);
      } finally { if (exclusive) s.busy = false; }
    });
  }
  private read(s: Session, explicit: number | undefined, tokens: number, wait: number) {
    const result = s.log.read(explicit ?? s.cursor, Math.min(tokens * 4, 65536));
    if (explicit === undefined) s.cursor = result.next_output_cursor;
    return { ...this.summary(s), ...result, budget_kind: 'approximate', max_output_tokens: tokens,
      effective_yield_time_ms: wait, error: s.error ? { code: s.state === 'start_failed' ? 'START_FAILED' : 'PROCESS_ERROR', message: s.error } : undefined };
  }
  private wait(s: Session, cursor: number, milliseconds: number, finalOnly = false): Promise<void> {
    const ready = () => terminalState(s.state) || (!finalOnly && (s.log.end > cursor || s.log.retainedFrom > cursor));
    if (ready() || milliseconds === 0) return Promise.resolve();
    return new Promise(resolve => {
      const finish = () => { clearTimeout(timer); s.events.off('change', onChange); resolve(); };
      const onChange = () => { if (ready()) finish(); };
      const timer = setTimeout(finish, milliseconds);
      s.events.on('change', onChange);
      onChange();
    });
  }
  private summary(s: Session) {
    return { session_id: s.id, instance_id: this.instanceId, state: s.state, exit_code: s.exitCode,
      signal: s.signal, tty: s.tty, workdir: s.cwd, created_at: new Date(s.created).toISOString(),
      ended_at: s.ended === null ? null : new Date(s.ended).toISOString(), label:s.label, archive_id:s.archiveId,
      history_state:this.history.status.state,
      history_warning:this.history.status.state==='degraded'?this.history.status.warnings.at(-1):undefined };
  }
  list(args: HistoryFilter = {}) {
    this.sweep();
    const f = {...args,workdir:args.workdir?expandPath(args.workdir,this.config.cwd):undefined};
    const filters = JSON.stringify([f.state??null,f.workdir??null,f.label??null,f.outcome??null,f.order??'asc']);
    const descending = f.order === 'desc';
    let after = descending ? Number.MAX_SAFE_INTEGER : 0, ceiling = this.seq;
    if (args.cursor) {
      try {
        const page = JSON.parse(Buffer.from(args.cursor, 'base64url').toString('utf8'));
        if (page.instance !== this.instanceId || page.filters !== filters ||
          !Number.isSafeInteger(page.after) || !Number.isSafeInteger(page.ceiling) || page.after < 0 || page.ceiling < 0) throw new Error();
        after = page.after; ceiling = page.ceiling;
      } catch { throw new ToolError('INVALID_CURSOR', 'Invalid or mismatched execution-list cursor.'); }
    }
    const eligible = [...this.records.values()].filter(s => (descending?s.seq<after:s.seq>after) && s.seq<=ceiling && matchesFilter(this.summary(s),f))
      .sort((a,b)=>descending?b.seq-a.seq:a.seq-b.seq);
    const selected = eligible.slice(0, args.limit ?? 20);
    const next = selected.at(-1)?.seq;
    return { instance_id: this.instanceId, sessions: selected.map(s => ({ ...this.summary(s),
      cmd: s.cmd.length > 512 ? s.cmd.slice(0, 512) + '…' : s.cmd, request_id: s.requestId ?? null,
      next_output_cursor: s.cursor, total_output_bytes: s.log.end, retained_from: s.log.retainedFrom })),
      next_cursor: eligible.length > selected.length && next !== undefined
        ? Buffer.from(JSON.stringify({ instance: this.instanceId, filters, after: next, ceiling })).toString('base64url') : null };
  }
  terminate(args: { session_id: number; force?: boolean; request_id?: string }) {
    const a = { ...args, force: args.force ?? false };
    return this.retry.run('terminate_exec_session', a.request_id, a, async () => {
      const s = this.get(a.session_id);
      this.beginTermination(s, a.force, 'terminate');
      await this.wait(s, s.log.end, a.force ? 1000 : this.config.exec.termination_grace_ms + 1000, true);
      return { ...this.summary(s), termination_confirmed: terminalState(s.state),
        error: s.error ? { code: 'TERMINATION_ERROR', message: s.error } : undefined };
    });
  }
  private beginTermination(s: Session, force: boolean, reason: 'timeout' | 'terminate'): void {
    if (terminalState(s.state)) return;
    s.reason ??= reason; s.state = 'terminating';
    const signal = (name: NodeJS.Signals) => {
      if (terminalState(s.state)) return;
      try { s.handle?.kill(name); } catch (error) { s.error = error instanceof Error ? error.message : String(error); }
      s.events.emit('change');
    };
    signal(force ? 'SIGKILL' : 'SIGTERM');
    if (!force && !s.escalation) {
      s.escalation = setTimeout(() => signal('SIGKILL'), this.config.exec.termination_grace_ms); s.escalation.unref();
    }
  }
  private enforceOutputBudget(): void {
    let total = this.cachedOutputBytes;
    const max = this.config.exec.total_output_bytes;
    if (total <= max) return;
    for (const s of [...this.records.values()].sort((a, b) => a.lastOutput - b.lastOutput || a.seq - b.seq)) {
      const before = s.log.size;
      s.log.trimTo(Math.max(0, before - (total - max)));
      total -= before - s.log.size;
      this.cachedOutputBytes = total;
      if (total <= max) break;
    }
  }
  sweep(): void {
    const ttl = this.config.exec.retained_session_ms;
    if ((ttl === null || ttl === 0) && this.records.size <= this.config.exec.max_ended_sessions) {
      this.retry.sweep(); return;
    }
    const ended = [...this.records.values()].filter(s => terminalState(s.state) && !s.busy).sort((a, b) => a.ended! - b.ended!);
    let count = ended.length;
    for (const s of ended) if ((ttl !== null && ttl > 0 && Date.now() - s.ended! >= ttl) || count > this.config.exec.max_ended_sessions) {
      this.cachedOutputBytes -= s.log.size;
      this.records.delete(s.id); count--;
    }
    this.retry.sweep();
  }
  get activeCount(): number { return [...this.records.values()].filter(s => !terminalState(s.state)).length; }
  get outputBytes(): number { return this.cachedOutputBytes; }
  get diagnostics() {
    return { active_sessions:this.activeCount,max_active_sessions:this.config.exec.max_active_sessions,
      retained_sessions:this.records.size,retained_output_bytes:this.outputBytes,max_output_bytes:this.config.exec.total_output_bytes,
      retained_session_ms:this.config.exec.retained_session_ms,max_ended_sessions:this.config.exec.max_ended_sessions,
      retry:this.retry.stats,history:this.history.status };
  }
  async close(): Promise<{ remaining: number[] }> {
    this.accepting = false; clearInterval(this.maintenance);
    const active = [...this.records.values()].filter(s => !terminalState(s.state));
    for (const s of active) this.beginTermination(s, false, 'terminate');
    await Promise.all(active.map(s => this.wait(s, s.log.end, this.config.exec.termination_grace_ms + 1500, true)));
    await this.history.close();
    return { remaining: active.filter(s => !terminalState(s.state)).map(s => s.id) };
  }
}
