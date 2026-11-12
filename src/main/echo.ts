// Without headphones the mic also hears the other side through the speakers,
// so their words come back as a "me" segment. A "me" segment is dropped when
// most of its words match something "them" said moments before or after.
// Short replies often reuse the question's words ("Do you know Python?" "I know
// Python."), so they only count as an echo when they are an exact phrase of it.

const WINDOW_MS = 8000;
const MIN_OVERLAP = 0.6;
const SHORT_WORDS = 5;

const words = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];

export function overlap(a: string, b: string): number {
  const wa = words(a);
  if (!wa.length) return 0;
  const wb = new Set(words(b));
  return wa.filter((w) => wb.has(w)).length / wa.length;
}

const isPhraseOf = (a: string, b: string) => ` ${words(b).join(" ")} `.includes(` ${words(a).join(" ")} `);

export function isEcho(mine: { text: string; at: number }, theirs: { text: string; at: number }[]): boolean {
  const short = words(mine.text).length <= SHORT_WORDS;
  return theirs.some((t) => Math.abs(t.at - mine.at) < WINDOW_MS && (short ? isPhraseOf(mine.text, t.text) : overlap(mine.text, t.text) >= MIN_OVERLAP));
}
