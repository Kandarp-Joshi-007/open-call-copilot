import type { ChatMessage, Effort, SessionRecord } from "../shared/types";
import type { DocumentStore } from "./store";

const BASE = `You are Mynah, a real-time assistant running on the user's own computer during a live conversation. You see a speech-to-text transcript, so expect recognition errors and infer the intended words.

Ground everything in the user's context below (resume, documents, instructions). Never invent experience, employers, numbers or projects that are not in the context: where a detail is missing, give the structure of a good answer and mark the gap as [add your example]. Write so the user can say it out loud.`;

const ANSWER_FORMAT = `Format every answer like this, in Markdown:
💬 **Question**: the question in one line

---

⭐ **Answer**: the direct answer in one sentence the user can say immediately.

- 2-4 short bullets to speak from, first person ("I...")

Behavioural questions: a compact STAR outline using the user's real experience. Technical questions: key idea first, then trade-offs; include code only when the question asks for code. Keep it under 150 words unless code is needed.`;

const MODE_RULES = {
  interview: `The user is the candidate in a job interview. "Caller" lines are the interviewer.`,
  regular: `The user is in a regular call or meeting (sales, client, team). "Caller" lines are the other participants. Suggest what the user could say next and bring in facts from their documents.`,
};

export function systemPrompt(s: SessionRecord): string {
  const who = [s.company && `Company: ${s.company}`, s.position && `Role / topic: ${s.position}`].filter(Boolean).join("\n");
  return [BASE, MODE_RULES[s.mode], ANSWER_FORMAT, who, `Always answer in ${s.language || "English"}.`].filter(Boolean).join("\n\n");
}

/** After the call: notes and feedback, without the live answer format. */
export function reviewPrompt(s: SessionRecord): string {
  const who = [s.company && `Company: ${s.company}`, s.position && `Role / topic: ${s.position}`].filter(Boolean).join("\n");
  return [
    `You review a call the user has finished, using its speech-to-text transcript (expect recognition errors). Be specific and honest, and ground everything in what was actually said and in the user's context below. Follow the requested sections exactly.`,
    MODE_RULES[s.mode],
    who,
    `Write in ${s.language || "English"}.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** The AI interviewer for mock sessions. Its words are read aloud, so no Markdown. */
export function interviewerPrompt(s: SessionRecord): string {
  return `You are a realistic, friendly but rigorous interviewer${s.company ? ` at ${s.company}` : ""}, interviewing the candidate for ${s.position || "the role"}. This is a spoken mock interview: everything you write is read aloud by text-to-speech.

Rules:
- Speak naturally in 1-3 short sentences. Plain text only: no Markdown, lists, emoji or stage directions.
- Ask exactly one question at a time. Mix behavioural, role-specific technical and situational questions, tailored to the candidate's resume and the instructions.
- React briefly and neutrally to the candidate's last answer before the next question. Do not coach, score or correct them during the interview; feedback comes afterwards.
- If an answer is vague, you may ask one short follow-up instead of a new question.
- Speak in ${s.language || "English"}.`;
}

/** Stable context block: sent as the cached prefix, so it must not change during a call. */
export function buildContext(s: SessionRecord, docs: DocumentStore): string {
  const parts: string[] = [];
  // Like a regular call, only interviews use the resume.
  if (s.mode === "interview" && s.resumeDocId) {
    const resume = docs.text(s.resumeDocId);
    if (resume) parts.push(`<resume>\n${resume}\n</resume>`);
  }
  for (const id of s.documentIds) {
    const doc = docs.get(id);
    if (doc) parts.push(`<document name="${doc.name}">\n${docs.text(id)}\n</document>`);
  }
  if (s.instructions.trim()) parts.push(`<instructions>\n${s.instructions.trim()}\n</instructions>`);
  return parts.length ? parts.join("\n\n") : "(The user has not added a resume, documents or instructions for this session.)";
}

/** Provider-neutral user turn: text, optionally with one screenshot. */
export interface Prompt {
  text: string;
  imageJpegBase64?: string;
}

export interface StreamRequest {
  system: string;
  /** Resume/documents/instructions: large and stable, so providers put it in the cached prefix. */
  context: string;
  /** Earlier turns of a conversation (Ask AI), oldest first. */
  history?: ChatMessage[];
  prompt: Prompt;
  /** Overrides the provider's default model; "" or undefined keeps it. */
  model?: string;
  effort: Effort;
  maxTokens: number;
  signal: AbortSignal;
  onText?: (delta: string) => void;
}

export interface LlmProvider {
  /** Whether credentials are present (an API key, or a ChatGPT sign-in). */
  ready(): boolean;
  /** What to tell the user when ready() is false. */
  readonly notReadyMessage: string;
  stream(req: StreamRequest): Promise<string>;
  describeError(err: unknown): string;
}

const wrap = (transcript: string) => `<transcript>\n${transcript || "(nothing said yet)"}\n</transcript>`;

export const prompts = {
  answer: (transcript: string, question: string): Prompt => ({
    text: `${wrap(transcript)}\n\nThe caller just asked:\n<question>\n${question}\n</question>\n\nGive me the answer now.`,
  }),

  screenshot: (transcript: string, imageJpegBase64: string): Prompt => ({
    imageJpegBase64,
    text: `${wrap(transcript)}\n\nThis is a screenshot of my screen. If it shows a coding or technical problem, solve it:
💬 **Question**: the problem in one or two lines
⭐ **Answer**: the approach and why it works, time and space complexity, then clean working code in the language shown on screen (Python if none is shown), then edge cases to mention.
Otherwise, tell me briefly what on the screen matters for the conversation and what I could say.`,
  }),

  chat: (transcript: string, message: string): Prompt => ({
    text: `${wrap(transcript)}\n\nMy message to you (not said on the call):\n${message}`,
  }),

  interviewerTurn: (transcript: string, asked: number, total: number): Prompt => ({
    text: `${wrap(transcript)}\n\nYou have asked ${asked} of ${total} questions. ${
      asked === 0
        ? "Greet the candidate in one sentence and ask the first question."
        : asked < total
          ? "React briefly to the candidate's last answer, then ask the next question (or one follow-up if the answer was vague)."
          : "Thank the candidate and close the interview in one or two sentences. Do not ask another question."
    }\nReply with only the words you say.`,
  }),

  notes: (s: SessionRecord, transcript: string): Prompt => ({
    text: `${wrap(transcript)}\n\nThe call has ended. Write the call notes in Markdown, in ${s.language || "English"}, with exactly these sections:

## Call Details
One sentence: who the call was with and what it was about${s.company || s.position ? ` (${[s.company, s.position].filter(Boolean).join(", ")})` : ""}.

## Summary
One short paragraph on what was discussed.

## Questions
Every question the other side asked, as a bullet list.

## Key Points
Decisions, facts and commitments worth remembering, as bullets.

## Next Steps
Action items with owners if known. Write "None mentioned." if there were none.`,
  }),

  feedback: (transcript: string): Prompt => ({
    text: `${wrap(transcript)}\n\nThe interview is over. Give me honest feedback in Markdown:

## Overall
A score out of 10 and two sentences on how it went.

## Question by question
For each question I was asked: the question, a score out of 10, what was good, what was missing, and a stronger version of my answer in 3-5 bullets (grounded in my real experience).

## Habits
Patterns across answers: filler words, rambling, missing results or numbers, unclear structure.

## Practise next
The three things to work on first.`,
  }),

  askSystem: (s: SessionRecord, transcript: string): string =>
    `You answer the user's questions about a call they finished. Use the transcript and notes below; say so when something was not covered. Be concise. Answer in ${s.language || "English"}.

${wrap(transcript)}

<notes>
${s.notes || "(no notes)"}
</notes>`,
};
