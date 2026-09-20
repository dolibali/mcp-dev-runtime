// Patch grammar and matching sequence adapted with reference to OpenAI Codex.
// Upstream Apache-2.0 license and pinned provenance: reference/codex/LICENSE and SOURCE.json.
// Codex-style grammar; independent TypeScript implementation. Reference and
// intentional differences are recorded in docs/COMPATIBILITY.md.
import { ToolError } from './errors.js';
export type PatchLine = { text: string; oldIndex: number | null };
export type Chunk = { context?: string; old: string[]; replacement: PatchLine[]; eof: boolean };
export type Hunk = { operation: 'add' | 'delete' | 'update'; path: string; move?: string; text?: string; chunks: Chunk[] };
const fail = (message: string, line: number): never => { throw new ToolError('INVALID_PATCH', message, { line }); };
const header = (line: string) => /^\*\*\* (?:Add File: |Delete File: |Update File: |End Patch$)/.test(line);
export function parsePatch(patch: string): Hunk[] {
  const lines = patch.trim().replace(/\r\n/g, '\n').split('\n');
  if (lines[0] !== '*** Begin Patch' || lines.at(-1) !== '*** End Patch') fail('Expected *** Begin Patch and *** End Patch envelope.', 1);
  const hunks: Hunk[] = [];
  let i = 1;
  while (i < lines.length - 1) {
    const found = /^\*\*\* (Add|Delete|Update) File: (.+)$/.exec(lines[i]!);
    if (!found) fail('Expected Add File, Delete File or Update File. Environment IDs and heredoc wrappers are not supported.', i + 1);
    const h: Hunk = { operation: found![1]!.toLowerCase() as Hunk['operation'], path: found![2]!, chunks: [] };
    if (h.path.includes('\0')) fail('NUL is not valid in a file path.', i + 1);
    i++;
    if (h.operation === 'add') {
      const added: string[] = [];
      while (i < lines.length - 1 && !header(lines[i]!)) {
        if (!lines[i]!.startsWith('+')) fail('Every added file line must start with +.', i + 1);
        added.push(lines[i++]!.slice(1));
      }
      h.text = added.length ? added.join('\n') + '\n' : '';
    } else if (h.operation === 'update') {
      if (lines[i]?.startsWith('*** Move to: ')) { h.move = lines[i++]!.slice('*** Move to: '.length); if (!h.move) fail('Empty move destination.', i); }
      while (i < lines.length - 1 && !header(lines[i]!)) {
        const chunk: Chunk = { old: [], replacement: [], eof: false };
        if (lines[i] === '@@') i++;
        else if (lines[i]!.startsWith('@@ ')) chunk.context = lines[i++]!.slice(3);
        else if (h.chunks.length) fail('Expected a new @@ hunk.', i + 1);
        while (i < lines.length - 1 && !header(lines[i]!) && lines[i] !== '@@' && !lines[i]!.startsWith('@@ ')) {
          const line = lines[i]!;
          if (line === '*** End of File') { chunk.eof = true; i++; break; }
          const prefix = line[0];
          if (prefix === ' ') {
            chunk.replacement.push({ text: line.slice(1), oldIndex: chunk.old.length }); chunk.old.push(line.slice(1));
          } else if (prefix === '-') chunk.old.push(line.slice(1));
          else if (prefix === '+') chunk.replacement.push({ text: line.slice(1), oldIndex: null });
          else fail('Hunk lines must begin with a space, + or -.', i + 1);
          i++;
        }
        if (!chunk.old.length && !chunk.replacement.length) fail('Empty update hunk.', i + 1);
        if (chunk.eof && i < lines.length - 1 && !header(lines[i]!)) fail('End of File must finish the update.', i + 1);
        h.chunks.push(chunk);
      }
      if (!h.chunks.length && !h.move) fail('Update needs changes or Move to.', i + 1);
    }
    hunks.push(h);
  }
  if (!hunks.length) fail('Patch contains no file operations.', 1);
  return hunks;
}

type Line = { text: string; eol: string };
function splitLines(text: string): Line[] {
  const lines: Line[] = [];
  let offset = 0;
  while (offset < text.length) {
    const end = text.indexOf('\n', offset);
    if (end < 0) { lines.push({ text: text.slice(offset), eol: '' }); break; }
    const cr = end > offset && text[end - 1] === '\r';
    lines.push({ text: text.slice(offset, cr ? end - 1 : end), eol: cr ? '\r\n' : '\n' }); offset = end + 1;
  }
  return lines;
}
// Matching order follows the pinned Codex seek_sequence algorithm. No edit
// distance or arbitrary similarity matching. Context lines retain source bytes.
function normalize(s: string): string {
  return s.trim().replace(/[\u2010-\u2015\u2212]/g, '-').replace(/[\u2018-\u201b]/g, "'")
    .replace(/[\u201c-\u201f]/g, '"').replace(/[\u00a0\u2002-\u200a\u202f\u205f\u3000]/g, ' ');
}
export function seekSequence(lines: string[], pattern: string[], start: number, eof = false): number {
  if (!pattern.length) return start;
  if (pattern.length > lines.length) return -1;
  const first = eof ? Math.max(start, lines.length - pattern.length) : start;
  for (const transform of [(s: string) => s, (s: string) => s.trimEnd(), (s: string) => s.trim(), normalize]) {
    const expected = pattern.map(transform);
    for (let i = first; i <= lines.length - pattern.length; i++) {
      if (expected.every((p, j) => transform(lines[i + j]!) === p)) return i;
    }
  }
  return -1;
}
export function updateText(text: string, chunks: Chunk[]): string {
  if (!chunks.length) return text;
  const source = splitLines(text), content = source.map(l => l.text);
  const counts = new Map<string, number>();
  for (const l of source) if (l.eol) counts.set(l.eol, (counts.get(l.eol) ?? 0) + 1);
  const defaultEol = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '\n';
  const hadFinalNewline = source.length === 0 || source.at(-1)!.eol !== '';
  const replacements: { at: number; remove: number; lines: Line[] }[] = [];
  let searchFrom = 0;
  for (const chunk of chunks) {
    if (chunk.context !== undefined) {
      const contextAt = seekSequence(content, [chunk.context], searchFrom);
      if (contextAt < 0) throw new ToolError('CONTEXT_MISMATCH', 'The @@ context was not found.', { context: chunk.context });
      searchFrom = contextAt + 1;
    }
    const at = chunk.old.length ? seekSequence(content, chunk.old, searchFrom, chunk.eof)
      : chunk.context !== undefined ? searchFrom : source.length;
    if (at < 0) throw new ToolError('CONTEXT_MISMATCH', 'Patch lines were not found in order.', { expected: chunk.old.slice(0, 5) });
    const newLines = chunk.replacement.map(l => l.oldIndex === null
      ? { text: l.text, eol: defaultEol } : { ...source[at + l.oldIndex]! });
    replacements.push({ at, remove: chunk.old.length, lines: newLines });
    searchFrom = at + chunk.old.length;
  }
  const output: Line[] = []; let previous = 0;
  for (const r of replacements) {
    if (r.at < previous) throw new ToolError('OVERLAPPING_HUNKS', 'Update hunks overlap or appear out of order.');
    output.push(...source.slice(previous, r.at), ...r.lines); previous = r.at + r.remove;
  }
  output.push(...source.slice(previous));
  for (let i = 0; i < output.length - 1; i++) if (!output[i]!.eol) output[i] = { ...output[i]!, eol: defaultEol };
  if (output.length) output[output.length - 1] = { ...output.at(-1)!, eol: hadFinalNewline ? output.at(-1)!.eol || defaultEol : '' };
  return output.map(l => l.text + l.eol).join('');
}
