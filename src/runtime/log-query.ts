import { ToolError } from './errors.js';

export type LogChunk = {
  output: string; output_start: number; next_output_cursor: number; has_more: boolean;
  retained_from: number; output_gap: boolean; total_output_bytes: number;
};
export type LogSource = {
  end: number; retainedFrom: number;
  read: (cursor: number, budget: number) => LogChunk | Promise<LogChunk>;
};
export type LogQuery = { tail_lines?: number; search?: string; max_matches?: number; output_cursor?: number };
const SCAN_BYTES = 1024 * 1024;
const continuation = (n: number) => (n & 0xc0) === 0x80;
export function utf8Prefix(bytes: Buffer, maximum: number): Buffer {
  let end = Math.min(bytes.length, Math.max(0, maximum));
  while (end > 0 && end < bytes.length && continuation(bytes[end]!)) end--;
  return bytes.subarray(0, end);
}
function boundary(bytes: Buffer, at: number): number {
  while (at < bytes.length && continuation(bytes[at]!)) at++;
  return at;
}
export function validateQuery(q: LogQuery, chars = ''): void {
  if (q.tail_lines !== undefined && (!Number.isInteger(q.tail_lines) || q.tail_lines < 1 || q.tail_lines > 10000))
    throw new ToolError('INVALID_QUERY', 'tail_lines must be between 1 and 10000.');
  if (q.search !== undefined && (!q.search.length || Buffer.byteLength(q.search) > 1024))
    throw new ToolError('INVALID_QUERY', 'search must contain 1 to 1024 UTF-8 bytes; matching is literal and case-sensitive.');
  if (q.tail_lines !== undefined && (q.search !== undefined || q.output_cursor !== undefined))
    throw new ToolError('INVALID_QUERY', 'tail_lines cannot be combined with search or output_cursor.');
  if (q.max_matches !== undefined && (q.search === undefined || !Number.isInteger(q.max_matches) || q.max_matches < 1 || q.max_matches > 100))
    throw new ToolError('INVALID_QUERY', 'max_matches requires search and must be between 1 and 100.');
  if (chars && (q.tail_lines !== undefined || q.search !== undefined))
    throw new ToolError('INVALID_QUERY', 'Tail and search are read-only; send terminal input separately.');
}

/** Bounded read-only queries. They never touch the execution's default cursor. */
export async function queryLog(source: LogSource, q: LogQuery, budget: number) {
  validateQuery(q);
  if (q.tail_lines !== undefined) {
    // A chosen window may start inside a multibyte codepoint; move forward only.
    let from = Math.max(source.retainedFrom, source.end - SCAN_BYTES);
    let chunk: LogChunk | undefined;
    for (let n = 0; n < 4; n++, from++) {
      try { chunk = await source.read(from, SCAN_BYTES); break; }
      catch (e) { if (!(e instanceof ToolError) || e.code !== 'INVALID_CURSOR') throw e; }
    }
    if (!chunk) throw new ToolError('INVALID_CURSOR', 'Could not locate a UTF-8 tail boundary.');
    const bytes = Buffer.from(chunk.output);
    let at = bytes.length, lines = 0;
    // Ignore a final newline when counting logical lines, but preserve it in output.
    let i = bytes.length - 1;
    if (i >= 0 && bytes[i] === 10) i--;
    for (; i >= 0; i--) if (bytes[i] === 10 && ++lines === q.tail_lines) { at = i + 1; break; }
    if (i < 0) at = 0;
    const windowLimited = from > source.retainedFrom && i < 0;
    const desired = at;
    at = boundary(bytes, Math.max(at, bytes.length - budget));
    return { output: bytes.subarray(at).toString('utf8'), output_start: chunk.output_start + at,
      next_output_cursor: chunk.next_output_cursor, has_more: false, retained_from: source.retainedFrom,
      output_gap: false, total_output_bytes: source.end, read_mode: 'tail',
      tail_truncated: at > desired || windowLimited, tail_window_limited: windowLimited };
  }
  if (q.search === undefined) throw new ToolError('INVALID_QUERY', 'A tail or search query is required.');
  const requested = q.output_cursor ?? source.retainedFrom;
  const chunk = await source.read(requested, SCAN_BYTES);
  const bytes = Buffer.from(chunk.output), needle = Buffer.from(q.search);
  const matches: { byte_offset: number; text: string; preview_truncated: boolean }[] = [];
  let at = 0, consumed = 0, used = 0;
  const limit = q.max_matches ?? 20;
  for (;;) {
    const found = bytes.indexOf(needle, at);
    if (found < 0) { consumed = bytes.length; break; }
    let left = Math.max(0, found - 100);
    left = boundary(bytes, left);
    const newline = bytes.lastIndexOf(10, Math.max(0, found - 1));
    if (newline >= left && newline < found) left = newline + 1;
    let right = Math.min(bytes.length, found + needle.length + 200);
    const endline = bytes.indexOf(10, found + needle.length);
    if (endline >= 0) right = Math.min(right, endline);
    const preview = utf8Prefix(bytes.subarray(left, right), Math.min(512, Math.max(0, budget - used - 96)));
    const cost = preview.length + 96;
    if (matches.length >= limit || used + cost > budget || (!preview.length && needle.length)) {
      consumed = found; break;
    }
    matches.push({ byte_offset: chunk.output_start + found, text: preview.toString('utf8'),
      preview_truncated: left > newline + 1 || left + preview.length < (endline < 0 ? bytes.length : endline) });
    used += cost; at = found + needle.length; consumed = at;
    if (at >= bytes.length) break;
  }
  // Carry sufficient overlap into the next scan so a match across the window is not lost.
  if (consumed === bytes.length && chunk.has_more) {
    consumed = Math.max(at, bytes.length - needle.length + 1);
    while (consumed > at && consumed < bytes.length && continuation(bytes[consumed]!)) consumed--;
  }
  const next = chunk.output_start + consumed;
  return { output: '', output_start: chunk.output_start, next_output_cursor: chunk.output_start,
    has_more: false, retained_from: source.retainedFrom, output_gap: chunk.output_gap, total_output_bytes: source.end,
    read_mode: 'search', matches, search_next_cursor: next, search_has_more: next < source.end,
    search_scan_start: chunk.output_start, search_scan_end: chunk.next_output_cursor };
}
