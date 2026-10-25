import type { AnswerEvent, PublicSettings, SessionRecord, SttStatus } from "../shared/types";
import { Capture } from "./capture";
import { $, api, clock, h, renderMarkdown } from "./ui";

let record: SessionRecord | null = null;
let settings: PublicSettings;
const capture = new Capture();
let capturing = false;
const startedAt = () => record?.startedAt ?? Date.now();
const themLabel = () => (record?.kind === "mock" ? "Interviewer" : "Caller");

// ---- Audio capture (started by the main process, with a user gesture) ------------------------

window.__startCapture = async () => {
  await ready; // need the session to know whether to capture call audio
  try {
    await capture.start({ system: record?.kind !== "mock", mic: true }, (speaker, samples) => api.sendAudio(speaker, samples));
    capturing = true;
    meterLoop();
  } catch (err) {
    const message = (err as Error).message;
    warn(`Audio capture failed: ${message}`);
    api.captureFailed(message);
  }
};

function meterLoop(): void {
  if (!capturing) return;
  $("lvl-them").style.width = `${capture.level("them") * 100}%`;
  $("lvl-me").style.width = `${capture.level("me") * 100}%`;
  requestAnimationFrame(meterLoop);
}

function warn(text: string): void {
  $("cap-warn").textContent = text;
  $("cap-warn").hidden = !text;
}

// ---- Captions --------------------------------------------------------------------------------

api.on("segment", (seg) => {
  if (seg.speaker === "them") {
    $("cap-them").textContent = seg.text;
    $("cap-them").classList.remove("muted");
    $("cap-meta").textContent = `${themLabel()} · ${clock(seg.at - startedAt())}`;
  } else {
    $("cap-me").textContent = `You: ${seg.text}`;
  }
});

api.on("stt-status", (s: SttStatus) => warn(s.state === "ready" ? "" : `Speech-to-text: ${s.message ?? s.state}`));

// ---- Answer cards ------------------------------------------------------------------------------

interface Card {
  el: HTMLElement;
  body: HTMLElement;
  foot: HTMLElement;
  text: string;
  frame: number;
  ev: AnswerEvent;
}
const cards = new Map<number, Card>();
// Answers up to this id were cleared; their late "Stopped." events are ignored.
let clearedUpTo = 0;

function label(ev: AnswerEvent): string {
  const name = { answer: "Answer", screenshot: "Screenshot", chat: "Chat", interviewer: "Interviewer" }[ev.kind];
  return `${name}${ev.auto ? " (auto)" : ""} · ${clock(ev.at - startedAt())}`;
}

function nearBottom(): boolean {
  const c = $("cards");
  return c.scrollHeight - c.scrollTop - c.clientHeight < 80;
}

function createCard(ev: AnswerEvent): Card {
  $("cards-empty").hidden = true;
  const body = h("div", { class: "md pending" }, ev.kind === "screenshot" ? "Reading your screen..." : ev.kind === "interviewer" ? "..." : "Thinking...");
  const stop = h("button", { class: "ghost small", onclick: () => void api.cancelAnswer() }, "Stop");
  const foot = h("div", { class: "card-foot" }, h("span", {}, label(ev)), ev.kind === "interviewer" ? "" : stop);
  const el = h("div", { class: `answer-card ${ev.kind}` }, ev.kind === "chat" ? h("div", { class: "you" }, `You: ${ev.question}`) : "", body, foot);
  const stick = nearBottom();
  $("cards").append(el);
  if (stick) el.scrollIntoView({ block: "end" });
  const card = { el, body, foot, text: "", frame: 0, ev };
  cards.set(ev.id, card);
  return card;
}

function paint(card: Card): void {
  const stick = nearBottom();
  card.body.className = "md";
  // The interviewer's words are spoken plain text; everything else is Markdown.
  if (card.ev.kind === "interviewer") card.body.textContent = card.text;
  else renderMarkdown(card.body, card.text);
  if (stick) $("cards").scrollTop = $("cards").scrollHeight;
}

api.on("answer", (ev) => {
  if (ev.id <= clearedUpTo) return;
  const card = cards.get(ev.id) ?? createCard(ev);
  if (ev.delta) {
    card.text += ev.delta;
    // Re-render at most once per frame while tokens stream in.
    card.frame ||= requestAnimationFrame(() => {
      card.frame = 0;
      paint(card);
    });
  }
  if (ev.done) {
    cancelAnimationFrame(card.frame);
    card.frame = 0;
    card.foot.querySelector("button")?.remove();
    if (ev.error && !card.text) {
      card.el.classList.add("error");
      card.body.className = "md";
      card.body.textContent = ev.error;
    } else {
      if (ev.error) card.text += `\n\n*${ev.error}*`;
      paint(card);
    }
  }
});

$("btn-clear").addEventListener("click", () => {
  void api.clearAnswers();
  clearedUpTo = Math.max(clearedUpTo, ...cards.keys());
  cards.clear();
  $("cards").replaceChildren($("cards-empty"));
  $("cards-empty").hidden = false;
});

// ---- Mock interviewer voice ----------------------------------------------------------------------

api.on("speak", (text) => {
  const u = new SpeechSynthesisUtterance(text);
  const voice = speechSynthesis.getVoices().find((v) => v.name === settings.interviewerVoice);
  if (voice) u.voice = voice;
  const done = () => {
    // A short tail so the mic does not catch the end of the voice as your answer.
    setTimeout(() => api.speakingDone(), 600);
    $("cap-meta").textContent = `${themLabel()} · your turn to answer`;
  };
  u.onend = done;
  u.onerror = done;
  $("cap-meta").textContent = `${themLabel()} is speaking...`;
  speechSynthesis.speak(u);
});

// ---- Controls ------------------------------------------------------------------------------------------

$("btn-answer").addEventListener("click", () => void api.answerNow());
$("btn-shot").addEventListener("click", () => void api.screenshot());
$<HTMLInputElement>("auto").addEventListener("change", (e) => void api.setAutoAnswer((e.target as HTMLInputElement).checked));
api.on("auto-answer", (on) => ($<HTMLInputElement>("auto").checked = on));

$("msg-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = $<HTMLInputElement>("msg");
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  void api.sendMessage(text);
});

$("btn-end").addEventListener("click", async () => {
  $<HTMLButtonElement>("btn-end").disabled = true;
  $("btn-end").textContent = "Ending...";
  speechSynthesis.cancel();
  capturing = false;
  await capture.stop();
  await api.endSession();
});

setInterval(() => {
  if (record) $("timer").textContent = clock(Date.now() - startedAt());
}, 500);

async function init(): Promise<void> {
  [record, settings] = await Promise.all([api.liveSession(), api.getSettings()]);
  if (!record) return;
  $("title").textContent = [record.company, record.position].filter(Boolean).join(" · ") || "Live session";
  $<HTMLInputElement>("auto").checked = settings.autoAnswer;
  if (record.kind === "mock") {
    $("cap-them").textContent = "The interviewer will start in a moment...";
    // The interviewer runs the conversation; auto-answering it would answer for you.
    $<HTMLInputElement>("auto").checked = false;
    void api.setAutoAnswer(false);
  }
  const stt = await api.sttStatus();
  if (stt.state !== "ready") warn(`Speech-to-text: ${stt.message ?? stt.state}`);
}

const ready = init();
