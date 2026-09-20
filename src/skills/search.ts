import type { Metadata } from './metadata.js';

const stop = new Set(['a', 'an', 'the', 'to', 'of', 'in', 'is', 'and', 'or', 'for', 'with', 'this', 'that', 'use', 'skill', 'skills']);
export function terms(text: string, maximum = 1024): string[] {
  const out: string[] = [];
  // Han bigrams supplement word matching; this is not semantic translation.
  for (const word of text.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    for (const piece of word.match(/\p{Script=Han}+|[^\p{Script=Han}]+/gu) ?? []) {
      if (/\p{Script=Han}/u.test(piece)) {
        const chars = [...piece];
        if (chars.length === 1) out.push(piece);
        for (let i = 0; i + 1 < chars.length && out.length < maximum; i++) out.push(chars[i]! + chars[i + 1]!);
      } else if (!stop.has(piece)) out.push(piece);
      if (out.length >= maximum) return out.slice(0, maximum);
    }
  }
  return out;
}

export class SearchIndex {
  private documents: { tf: Map<string, number>; length: number }[];
  private df = new Map<string, number>();
  private average: number;
  constructor(private readonly entries: readonly Metadata[]) {
    this.documents = entries.map(entry => {
      const tf = new Map<string, number>();
      for (const [text, weight] of [[entry.name, 3], [entry.description, 1], [entry.short_description ?? '', 1.2], [entry.compatibility ?? '', 0.5]] as const) {
        for (const term of terms(text)) tf.set(term, (tf.get(term) ?? 0) + weight);
      }
      for (const term of tf.keys()) this.df.set(term, (this.df.get(term) ?? 0) + 1);
      return { tf, length: [...tf.values()].reduce((a, b) => a + b, 0) };
    });
    this.average = Math.max(1, this.documents.reduce((n, d) => n + d.length, 0) / Math.max(1, entries.length));
  }
  rank(query: string): number[] {
    const queryTerms = [...new Set(terms(query, 128))];
    const name = query.trim().normalize('NFKC').toLowerCase();
    return this.documents.map((doc, index) => {
      let score = this.entries[index]!.name.normalize('NFKC').toLowerCase() === name ? 100 : 0;
      for (const term of queryTerms) {
        const tf = doc.tf.get(term) ?? 0;
        if (!tf) continue;
        const idf = Math.log(1 + (this.documents.length - (this.df.get(term) ?? 0) + 0.5) / ((this.df.get(term) ?? 0) + 0.5));
        score += idf * (tf * 2.2) / (tf + 1.2 * (0.4 + 0.6 * doc.length / this.average));
      }
      return { index, score };
    }).filter(item => item.score > 0).sort((a, b) => b.score - a.score || a.index - b.index).map(item => item.index);
  }
}
