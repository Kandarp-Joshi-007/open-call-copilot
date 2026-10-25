import type { AnswerEvent, AnswerKind, Effort, MainEvent, SessionRecord, Settings, Speaker } from "../shared/types";
import { buildContext, interviewerPrompt, prompts, reviewPrompt, systemPrompt, type LlmProvider, type Prompt } from "./assistant";
import { isEcho } from "./echo";
import { looksLikeQuestion } from "./questions";
import type { DocumentStore, SessionStore } from "./store";
import type { Transcriber } from "./stt";

// Wait this long after the caller stops talking before deciding it was a
// question, so a question split across two VAD segments is answered once.
const QUESTION_SETTLE_MS = 900;
// The matching caller segment may still be decoding when the mic copy arrives.
const ECHO_HOLD_MS = 1500;
// Mock interview: the candidate is done answering after this much silence.
const MOCK_ANSWER_PAUSE_MS = 3500;
const LIVE_TRANSCRIPT_CHARS = 6000;
// If the voice never reports that it finished, stop ignoring the mic after
// roughly the time the words take to say, so the interview cannot stall.
const SPEAK_MS_PER_WORD = 600;
const SPEAK_GRACE_MS = 8000;

export interface LiveDeps {
  provider(): LlmProvider;
  settings(): Settings;
  docs: DocumentStore;
  store: SessionStore;
  transcriber: Transcriber;
  /** Sends to the live session window. */
  send(channel: MainEvent, payload: unknown): void;
  sessionsChanged(): void;
  captureScreen(): Promise<string>;
}

/** The one session that is live: its transcript, answers and (for mock sessions) the AI interviewer. */
export class LiveController {
  record: SessionRecord | null = null;
  autoAnswer = true;
  private context = "";
  private nextSegment = 1;
  private nextAnswer = 1;
  private answeredUpTo = 0;
  private inflight: AbortController | null = null;
  private pendingThem: string[] = [];
  private questionTimer: NodeJS.Timeout | undefined;
  // Mock interview state
  private asked = 0;
  private speaking = false;
  private interviewerBusy = false;
  private answerSinceTurn = false;
  private turnTimer: NodeJS.Timeout | undefined;
  private speakTimer: NodeJS.Timeout | undefined;
  private interviewerCtrl: AbortController | null = null;

  constructor(private deps: LiveDeps) {}

  get active(): boolean {
    return this.record?.state === "live";
  }

  start(record: SessionRecord): void {
    Object.assign(record, { state: "live", startedAt: Date.now(), endedAt: null, durationMs: 0, segments: [], answers: [], notes: "", feedback: "", chat: [] });
    this.record = record;
    this.context = buildContext(record, this.deps.docs);
    this.autoAnswer = this.deps.settings().autoAnswer;
    this.nextSegment = 1;
    this.nextAnswer = 1;
    this.answeredUpTo = 0;
    this.pendingThem = [];
    this.asked = 0;
    this.speaking = false;
    this.interviewerBusy = false;
    this.answerSinceTurn = false;
    this.deps.store.save(record);
    this.deps.sessionsChanged();
  }

  /** Called once the live window is ready, so the interviewer's first words are not missed. */
  windowReady(): void {
    if (this.record?.kind === "mock" && this.asked === 0 && !this.interviewerBusy) void this.interviewerTurn();
  }

  onSegment(speaker: Speaker, text: string): void {
    const r = this.record;
    if (!r || !this.active) return;

    if (speaker === "me") {
      // In a mock interview the mic hears the interviewer's voice while it speaks.
      if (r.kind === "mock" && this.speaking) return;
      const heard = { text, at: Date.now() };
      setTimeout(() => {
        if (!this.active || isEcho(heard, r.segments.filter((s) => s.speaker === "them"))) return;
        this.addSegment("me", text);
        if (r.kind === "mock") {
          this.answerSinceTurn = true;
          this.scheduleInterviewerTurn();
        }
      }, ECHO_HOLD_MS);
      return;
    }

    if (r.kind === "mock") return; // the interviewer is us, not the call audio
    this.addSegment("them", text);
    this.pendingThem.push(text);
    clearTimeout(this.questionTimer);
    this.questionTimer = setTimeout(() => {
      const said = this.pendingThem.join(" ");
      this.pendingThem = [];
      if (this.autoAnswer && looksLikeQuestion(said)) void this.answer(said, true);
    }, QUESTION_SETTLE_MS);
  }

  /** "Answer" button / hotkey: answer what the caller said since the last answer. */
  answerNow(): Promise<void> {
    clearTimeout(this.questionTimer);
    this.pendingThem = [];
    const r = this.record;
    if (!r) return Promise.resolve();
    const fresh = r.segments.filter((s) => s.speaker === "them" && s.id > this.answeredUpTo);
    const question = fresh.length
      ? fresh.map((s) => s.text).join(" ")
      : (r.segments.findLast((s) => s.speaker === "them")?.text ?? "");
    if (!question) {
      this.emitError("answer", "", "Nothing to answer yet: the caller has not said anything.");
      return Promise.resolve();
    }
    return this.answer(question, false);
  }

  async screenshot(): Promise<void> {
    let image: string;
    try {
      image = await this.deps.captureScreen();
    } catch (err) {
      this.emitError("screenshot", "Screenshot", (err as Error).message);
      return;
    }
    await this.run("screenshot", "Screenshot", prompts.screenshot(this.transcript(LIVE_TRANSCRIPT_CHARS), image), false, "medium");
  }

  sendMessage(text: string): Promise<void> {
    return this.run("chat", text, prompts.chat(this.transcript(LIVE_TRANSCRIPT_CHARS), text), false, this.deps.settings().liveEffort);
  }

  cancel(): void {
    this.inflight?.abort();
  }

  speakingDone(): void {
    clearTimeout(this.speakTimer);
    this.speaking = false;
  }

  /** Stops listening and returns the record; notes are written afterwards by the caller. */
  async end(): Promise<SessionRecord | null> {
    const r = this.record;
    if (!r || !this.active) return null;
    await this.deps.transcriber.flush();
    await new Promise((res) => setTimeout(res, ECHO_HOLD_MS + 100));
    clearTimeout(this.questionTimer);
    clearTimeout(this.turnTimer);
    clearTimeout(this.speakTimer);
    this.inflight?.abort();
    this.interviewerCtrl?.abort();
    r.state = "ended";
    r.endedAt = Date.now();
    r.durationMs = r.endedAt - (r.startedAt ?? r.endedAt);
    this.deps.store.save(r);
    this.record = null;
    return r;
  }

  transcript(maxChars = Infinity): string {
    const r = this.record;
    return r ? formatTranscript(r, maxChars) : "";
  }

  // ---- internals ---------------------------------------------------------------

  private addSegment(speaker: Speaker, text: string): void {
    const r = this.record!;
    const seg = { id: this.nextSegment++, speaker, text, at: Date.now() };
    r.segments.push(seg);
    this.deps.send("segment", seg);
  }

  private answer(question: string, auto: boolean): Promise<void> {
    this.answeredUpTo = this.nextSegment - 1;
    return this.run("answer", question, prompts.answer(this.transcript(LIVE_TRANSCRIPT_CHARS), question), auto, this.deps.settings().liveEffort);
  }

  private async run(kind: AnswerKind, question: string, prompt: Prompt, auto: boolean, effort: Effort): Promise<void> {
    const r = this.record;
    if (!r) return;
    // A new question replaces the one being answered.
    this.inflight?.abort();
    const ctrl = new AbortController();
    this.inflight = ctrl;
    await this.stream(kind, question, auto, ctrl, systemPrompt(r), prompt, effort);
    if (this.inflight === ctrl) this.inflight = null;
  }

  private scheduleInterviewerTurn(): void {
    clearTimeout(this.turnTimer);
    this.turnTimer = setTimeout(() => {
      if (this.active && this.answerSinceTurn && !this.speaking && !this.interviewerBusy) void this.interviewerTurn();
    }, MOCK_ANSWER_PAUSE_MS);
  }

  private async interviewerTurn(): Promise<void> {
    const r = this.record;
    if (!r) return;
    const total = this.deps.settings().mockQuestions;
    if (this.asked > total) return; // closing line already said
    this.interviewerBusy = true;
    this.answerSinceTurn = false;
    const ctrl = new AbortController();
    this.interviewerCtrl = ctrl;
    const text = await this.stream(
      "interviewer",
      "",
      false,
      ctrl,
      interviewerPrompt(r),
      prompts.interviewerTurn(this.transcript(LIVE_TRANSCRIPT_CHARS), this.asked, total),
      "low",
    );
    this.interviewerBusy = false;
    if (this.interviewerCtrl === ctrl) this.interviewerCtrl = null;
    if (!text || !this.active) return;
    this.asked++;
    this.addSegment("them", text);
    this.speaking = true;
    this.deps.send("speak", text);
    clearTimeout(this.speakTimer);
    this.speakTimer = setTimeout(() => this.speakingDone(), text.split(/\s+/).length * SPEAK_MS_PER_WORD + SPEAK_GRACE_MS);
  }

  /** Streams one model reply to the live window and records it. Resolves to the text ("" on failure). */
  private async stream(kind: AnswerKind, question: string, auto: boolean, ctrl: AbortController, system: string, prompt: Prompt, effort: Effort): Promise<string> {
    const r = this.record!;
    const provider = this.deps.provider();
    const base = { id: this.nextAnswer++, kind, question, auto, at: Date.now() };
    const emit = (ev: Partial<AnswerEvent>) => this.deps.send("answer", { ...base, ...ev });
    emit({});
    if (!provider.ready()) {
      emit({ done: true, error: provider.notReadyMessage });
      return "";
    }
    try {
      const text = await provider.stream({
        system,
        context: this.context,
        prompt,
        model: r.model,
        effort,
        maxTokens: 16000,
        signal: ctrl.signal,
        onText: (delta) => emit({ delta }),
      });
      if (r.state === "live") r.answers.push({ id: base.id, kind, question, text, auto, at: base.at });
      emit({ done: true });
      return text;
    } catch (err) {
      emit({ done: true, error: ctrl.signal.aborted ? "Stopped." : provider.describeError(err) });
      return "";
    }
  }

  private emitError(kind: AnswerKind, question: string, error: string): void {
    this.deps.send("answer", { id: this.nextAnswer++, kind, question, auto: false, at: Date.now(), done: true, error });
  }
}

export function formatTranscript(r: SessionRecord, maxChars = Infinity): string {
  const them = r.kind === "mock" ? "Interviewer" : "Caller";
  const lines: string[] = [];
  let size = 0;
  for (let i = r.segments.length - 1; i >= 0; i--) {
    const s = r.segments[i];
    const line = `${s.speaker === "me" ? "Me" : them}: ${s.text}`;
    if (size + line.length > maxChars && lines.length) break;
    lines.unshift(line);
    size += line.length + 1;
  }
  return lines.join("\n");
}

/** Writes AI notes (and interview feedback) for an ended session. */
export async function writeNotes(r: SessionRecord, deps: Pick<LiveDeps, "provider" | "docs" | "store" | "sessionsChanged">): Promise<void> {
  const provider = deps.provider();
  r.generating = true;
  deps.store.save(r);
  deps.sessionsChanged();
  const transcript = formatTranscript(r);
  const context = buildContext(r, deps.docs);
  const ask = async (prompt: Prompt) => {
    try {
      return await provider.stream({ system: reviewPrompt(r), context, prompt, model: r.model, effort: "medium", maxTokens: 32000, signal: new AbortController().signal });
    } catch (err) {
      return `*Could not write this: ${provider.describeError(err)}*`;
    }
  };

  if (!r.segments.length && r.notes) {
    // Transcript was not saved: keep the notes written when the call ended.
  } else if (!r.segments.length) {
    r.notes = "*Nothing was transcribed during this call.*";
  } else if (!provider.ready()) {
    r.notes = `*${provider.notReadyMessage}*`;
  } else {
    const [notes, feedback] = await Promise.all([ask(prompts.notes(r, transcript)), r.mode === "interview" ? ask(prompts.feedback(transcript)) : Promise.resolve("")]);
    r.notes = notes;
    r.feedback = feedback;
  }
  // "Save transcript" off: keep the notes, drop what was said.
  if (!r.saveTranscript) {
    r.segments = [];
    r.answers = [];
  }
  r.generating = false;
  // Deleted while the notes were being written: do not write the file back.
  if (deps.store.get(r.id) !== r) return;
  deps.store.save(r);
  deps.sessionsChanged();
}
