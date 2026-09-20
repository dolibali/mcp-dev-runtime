import { ToolError } from './errors.js';

type Block = { bytes: Buffer; start: number; used: number };
const BLOCK = 16384;
const continuation = (n: number) => (n & 0xc0) === 0x80;
/** Bounded UTF-8 log. Fixed-size blocks avoid per-character object growth. */
export class OutputLog {
  private blocks: Block[] = [];
  private head = 0;
  retainedFrom = 0;
  end = 0;
  constructor(public readonly capacity: number) {}
  get size(): number { return this.end - this.retainedFrom; }
  append(text: string): void {
    const bytes = Buffer.from(text, 'utf8');
    let source = 0;
    while (source < bytes.length) {
      let tail = this.blocks.at(-1);
      if (!tail || tail.used === BLOCK) {
        tail = { bytes: Buffer.allocUnsafe(BLOCK), start: this.end, used: 0 }; this.blocks.push(tail);
      }
      const n = Math.min(BLOCK - tail.used, bytes.length - source);
      bytes.copy(tail.bytes, tail.used, source, source + n);
      tail.used += n; source += n; this.end += n;
    }
    this.trimTo(this.capacity);
  }
  private byteAt(offset: number): number {
    for (let i = this.head; i < this.blocks.length; i++) {
      const b = this.blocks[i]!;
      if (offset >= b.start && offset < b.start + b.used) return b.bytes[offset - b.start]!;
    }
    return 0;
  }
  trimTo(bytes: number): void {
    let from = Math.max(this.retainedFrom, this.end - Math.max(0, bytes));
    while (from < this.end && continuation(this.byteAt(from))) from++;
    this.retainedFrom = from;
    while (this.head < this.blocks.length && this.blocks[this.head]!.start + this.blocks[this.head]!.used <= from) this.head++;
    if (this.head === this.blocks.length) { this.blocks = []; this.head = 0; }
    else if (this.head > 32 && this.head * 2 > this.blocks.length) { this.blocks = this.blocks.slice(this.head); this.head = 0; }
  }
  read(cursor: number, budget: number) {
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > this.end) throw new ToolError('INVALID_CURSOR', 'Output cursor is outside this log.', { end: this.end });
    const output_gap = cursor < this.retainedFrom;
    const start = Math.max(cursor, this.retainedFrom);
    if (start < this.end && continuation(this.byteAt(start))) throw new ToolError('INVALID_CURSOR', 'Output cursor must be on a UTF-8 boundary. Use a returned cursor.');
    let end = Math.min(this.end, start + budget);
    while (end > start && end < this.end && continuation(this.byteAt(end))) end--;
    const parts: Buffer[] = [];
    for (let i = this.head; i < this.blocks.length; i++) {
      const b = this.blocks[i]!;
      if (b.start >= end) break;
      const left = Math.max(start, b.start), right = Math.min(end, b.start + b.used);
      if (right > left) parts.push(b.bytes.subarray(left - b.start, right - b.start));
    }
    return { output: Buffer.concat(parts).toString('utf8'), output_start: start, next_output_cursor: end,
      has_more: end < this.end, retained_from: this.retainedFrom, output_gap, total_output_bytes: this.end };
  }
}
