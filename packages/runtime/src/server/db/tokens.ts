/** Lowercase words (letters and digits, any script) with how often each occurs: what a search index stores for a document. */
export function tokenize(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const term of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) counts.set(term, (counts.get(term) ?? 0) + 1);
  return counts;
}

/** The largest code point: the exclusive upper end of "every term that starts with this prefix". */
export const PREFIX_END = "\u{10FFFF}";
