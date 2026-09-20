// Caches hold data, never a claim about what any ChatGPT conversation remembers.
export class BoundedCache<T> {
  private entries = new Map<string, { value: T; bytes: number; until: number }>();
  bytes = 0;
  constructor(private readonly capacity: number, private readonly maxBytes: number, private readonly now = Date.now) {}
  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.until <= this.now()) { this.delete(key); return undefined; }
    this.entries.delete(key); this.entries.set(key, entry);
    return entry.value;
  }
  set(key: string, value: T, bytes: number, ttl: number) {
    this.delete(key);
    if (bytes > this.maxBytes) return;
    while (this.entries.size >= this.capacity || this.bytes + bytes > this.maxBytes) this.delete(this.entries.keys().next().value!);
    this.entries.set(key, { value, bytes, until: this.now() + ttl }); this.bytes += bytes;
  }
  delete(key: string) { const entry = this.entries.get(key); if (entry) { this.bytes -= entry.bytes; this.entries.delete(key); } }
  clear() { this.entries.clear(); this.bytes = 0; }
  get size() { return this.entries.size; }
}
