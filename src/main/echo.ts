// Without headphones the mic also hears the other side through the speakers,
// so their words come back as a "me" segment. A "me" segment is dropped when
// most of its words match something "them" said moments before or after.

const WINDOW_MS = 8000;
const MIN_OVERLAP = 0.6;

const words = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];

export function overlap(a: string, b: string): number {
  const wa = words(a);
  if (!wa.length) return 0;
  const wb = new Set(words(b));
  return wa.filter((w) => wb.has(w)).length / wa.length;
}

export function isEcho(mine: { text: string; at: number }, theirs: { text: string; at: number }[]): boolean {
  return theirs.some((t) => Math.abs(t.at - mine.at) < WINDOW_MS && overlap(mine.text, t.text) >= MIN_OVERLAP);
}
