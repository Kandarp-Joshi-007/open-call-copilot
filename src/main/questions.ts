// Decides whether something the caller said should be answered automatically.
// Parakeet punctuates its output, so a "?" catches most questions. The
// patterns cover prompts without one ("Tell me about a time you...") and
// questions whose "?" the recognizer dropped.
//
// Each pattern needs the shape of a question, not just its first word:
// "Will do, thanks" and "When I joined, we had no tests" are not questions.

const SUBJECT = "(?:you|your|we|our|i|they|their|he|she|it|its|there|this|that|these|those|the|a|an|any|anyone|anybody|someone|somebody|everyone)";
const AUX = "(?:can|could|would|will|do|does|did|is|are|was|were|have|has|had|should|shall|may|might)";

const PATTERNS = [
  // Inverted: "Do you...", "Is there...", "Have you...". The \b after the
  // auxiliary keeps contractions out: "Can't wait" is not a question.
  new RegExp(`^${AUX}\\b(?!['’])\\s+${SUBJECT}\\b`, "i"),
  // "What is...", "How would you...", "Why did...", "How many...".
  new RegExp(`^(?:so |and |okay |ok |now |well )*(?:what|why|how|when|where|who|which)(?:'s|’s)?\\s+(?:${AUX}|about|many|much|long|often|far|big|large|kind|sort|type)\\b`, "i"),
  // Requests: "Tell me about...", "Walk me through...", "Explain how...".
  /^(?:so |and |okay |ok |now |well |please )*(?:tell me|tell us|walk me|walk us|talk me|explain|describe|give me|give us|talk about|imagine|suppose|let's say|let’s say)\b/i,
  // Tasks: "Design a rate limiter", "Write a function that...".
  /^(?:so |and |okay |ok |now |well |please )*(?:design|implement|write|build|share)\s+(?:a|an|the|me|us|your|some)\b/i,
  /\b(?:tell me about|walk me through|how would you|what would you|can you explain|could you explain|what is your|what's your|what’s your|why do you|why did you|have you ever)\b/i,
];

const wordCount = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;

export function looksLikeQuestion(text: string): boolean {
  const t = text.trim();
  if (wordCount(t) < 3) return false;
  // Sentence by sentence, so a question followed by "Take your time." still
  // counts and a statement followed by "Right?" does not.
  const sentences = t.match(/[^.!?]+[.!?]*/g) ?? [t];
  return sentences.some((raw) => {
    const s = raw.trim();
    if (s.endsWith("?")) return wordCount(s) >= 3;
    return PATTERNS.some((p) => p.test(s));
  });
}
