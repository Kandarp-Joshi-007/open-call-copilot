// Parakeet punctuates its output, so a trailing "?" catches most questions.
// The patterns below cover prompts that are questions without a question mark
// ("Tell me about a time you...", "Walk me through your design").
const STARTS = /^(what|why|how|when|where|who|which|can|could|would|will|do|does|did|is|are|have|has|should|tell me|walk me|explain|describe|give me|talk about|share|imagine|suppose|let's say|design|implement|write)\b/i;
const CONTAINS = /\b(tell me about|walk me through|how would you|what would you|can you explain|what is your|what's your|why do you|have you ever)\b/i;

export function looksLikeQuestion(text: string): boolean {
  const t = text.trim();
  if (t.split(/\s+/).length < 3) return false;
  return t.endsWith("?") || STARTS.test(t) || CONTAINS.test(t);
}
