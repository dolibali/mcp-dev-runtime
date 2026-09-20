import { createHash } from 'node:crypto';
import { ToolError } from './errors.js';

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]));
  return value;
}
type Entry = { digest: string; promise: Promise<unknown>; completed: number | null; pins: number };
/** Register before scheduling any effect. In-flight entries are never evicted. */
export class RetryCache {
  private entries = new Map<string, Entry>();
  constructor(private ttl = 600000, private capacity = 128) {}
  run<T>(method: string, id: string | undefined, args: unknown, action: () => Promise<T>): Promise<T> {
    if (!id) return action();
    this.sweep();
    const digest = createHash('sha256').update(JSON.stringify(canonical({ method, args }))).digest('hex');
    const previous = this.entries.get(id);
    if (previous) {
      if (previous.digest !== digest) return Promise.reject(new ToolError('REQUEST_ID_CONFLICT', 'request_id was used for a different operation.'));
      return previous.promise as Promise<T>;
    }
    if (this.entries.size >= this.capacity) {
      const removable = [...this.entries].find(([, e]) => e.completed !== null && e.pins === 0);
      if (!removable) return Promise.reject(new ToolError('REQUEST_CACHE_FULL', 'All retry entries are currently in flight.'));
      this.entries.delete(removable[0]);
    }
    const entry: Entry = { digest, promise: Promise.resolve(), completed: null, pins: 0 };
    this.entries.set(id, entry);
    const promise = Promise.resolve().then(action).finally(() => { entry.completed = Date.now(); });
    entry.promise = promise;
    return promise;
  }
  /** Pin the original response while its command is active, independently of TTL. */
  pin(id: string | undefined): () => void {
    const entry = id ? this.entries.get(id) : undefined;
    if (!entry) return () => {};
    entry.pins++;
    let released = false;
    return () => {
      if (released) return;
      released = true; entry.pins--;
      // Completion retention starts no earlier than the end of the command.
      if (entry.pins === 0 && entry.completed !== null) entry.completed = Date.now();
    };
  }
  get stats() {
    return { entries: this.entries.size, capacity: this.capacity, ttl_ms: this.ttl,
      protected_entries: [...this.entries.values()].filter(e => e.pins > 0 || e.completed === null).length };
  }
  sweep(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) if (entry.pins === 0 && entry.completed !== null && now - entry.completed >= this.ttl) this.entries.delete(key);
  }
}
