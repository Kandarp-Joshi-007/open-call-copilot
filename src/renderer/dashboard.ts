import { INSTRUCTIONS_LIMIT, LANGUAGES, type DocumentInfo, type PublicSettings, type SessionConfig, type SessionKind, type SessionMode, type SessionRecord, type SessionSummary, type SttStatus } from "../shared/types";
import { $, api, clock, date, duration, errorText, h, renderMarkdown, size } from "./ui";

let settings: PublicSettings;
let sessions: SessionSummary[] = [];
let documents: DocumentInfo[] = [];
let filter: "all" | "active" | "ended" = "all";
let detail: { id: string; tab: string } | null = null;

// ---- Navigation ----------------------------------------------------------------------

type View = "sessions" | "detail" | "documents" | "settings";

function show(view: View): void {
  for (const v of ["sessions", "detail", "documents", "settings"]) $(`view-${v}`).hidden = v !== view;
  const nav = view === "detail" ? "sessions" : view;
  document.querySelectorAll<HTMLButtonElement>(".nav").forEach((b) => b.classList.toggle("active", b.dataset.view === nav));
  if (view !== "detail") detail = null;
}

document.querySelectorAll<HTMLButtonElement>(".nav").forEach((b) =>
  b.addEventListener("click", () => {
    show(b.dataset.view as View);
    if (b.dataset.view === "documents") void loadDocuments();
  }),
);
$("btn-back").addEventListener("click", () => show("sessions"));

// ---- Call Sessions ---------------------------------------------------------------------

const AVATAR_COLORS = ["#6c8cff", "#6fd3a4", "#f2b45a", "#ff8a8a", "#b59bff", "#5fc8e8"];

function avatar(name: string): HTMLElement {
  const n = name.trim() || "?";
  let hash = 0;
  for (const c of n) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
  return h("span", { class: "avatar", style: `background:${AVATAR_COLORS[hash % AVATAR_COLORS.length]}` }, n[0].toUpperCase());
}

const sessionTitle = (s: SessionSummary) => s.company || s.position || "Untitled session";
const modeLabel = (s: SessionSummary) => `${s.mode === "interview" ? "Interview" : "Regular"}${s.kind === "mock" ? " · Mock" : ""}`;
const STATE_LABEL = { ready: "Ready to Start", live: "Live", ended: "Ended" } as const;

function stateCell(s: SessionSummary): HTMLElement {
  return h("span", { class: `pill ${s.state}` }, s.generating ? "Writing notes..." : STATE_LABEL[s.state]);
}

function actionButton(s: SessionSummary): HTMLButtonElement {
  if (s.state === "live") return h("button", { class: "primary small", onclick: (e: Event) => (e.stopPropagation(), void api.focusLive()) }, "Join Session");
  if (s.state === "ready") return h("button", { class: "primary small", onclick: (e: Event) => (e.stopPropagation(), void start(s.id)) }, "Start Session");
  return h("button", { class: "small", onclick: (e: Event) => (e.stopPropagation(), void openDetail(s.id, "transcript")) }, "View Transcript");
}

function renderSessions(): void {
  const q = $<HTMLInputElement>("session-search").value.trim().toLowerCase();
  const rows = sessions.filter((s) => {
    if (filter === "active" && s.state === "ended") return false;
    if (filter === "ended" && s.state !== "ended") return false;
    return !q || `${s.company} ${s.position}`.toLowerCase().includes(q);
  });
  $("session-count").textContent = `${rows.length} Session${rows.length === 1 ? "" : "s"}`;
  $("sessions-empty").hidden = sessions.length > 0;
  $("session-rows").replaceChildren(
    ...rows.map((s) =>
      h(
        "tr",
        { onclick: () => void openDetail(s.id) },
        h("td", {}, h("div", { class: "session-cell" }, avatar(sessionTitle(s)), h("div", {}, h("b", {}, sessionTitle(s)), h("span", {}, s.company ? s.position : "")))),
        h("td", {}, modeLabel(s)),
        h("td", {}, s.state === "ended" ? duration(s.durationMs) : "—"),
        h("td", {}, date(s.createdAt)),
        h("td", {}, s.saveTranscript ? "Yes" : "No"),
        h("td", {}, stateCell(s)),
        h("td", { class: "right" }, actionButton(s)),
      ),
    ),
  );
}

async function loadSessions(): Promise<void> {
  sessions = await api.listSessions();
  renderSessions();
  if (detail) await openDetail(detail.id, detail.tab, true);
}

$("session-filter").addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("button");
  if (!btn) return;
  filter = btn.dataset.filter as typeof filter;
  $("session-filter").querySelectorAll("button").forEach((b) => b.classList.toggle("on", b === btn));
  renderSessions();
});
$("session-search").addEventListener("input", renderSessions);

async function start(id: string): Promise<void> {
  try {
    await api.startSession(id);
  } catch (err) {
    alertBox(errorText(err));
  }
}

function alertBox(message: string): void {
  // Not window.alert: it blocks the renderer. A short-lived banner instead.
  const banner = h("div", { class: "card", style: "position:fixed;right:20px;bottom:20px;z-index:20;max-width:380px;border-color:var(--danger)" }, message);
  document.body.append(banner);
  setTimeout(() => banner.remove(), 6000);
}

// ---- Session detail --------------------------------------------------------------------------

let askDraft: { el: HTMLElement; text: string } | null = null;

async function openDetail(id: string, tab?: string, refresh = false): Promise<void> {
  const r = await api.getSession(id);
  if (!r) return show("sessions");
  const tabs = r.state === "ended" ? ["notes", "transcript", ...(r.mode === "interview" ? ["feedback"] : []), "ask", "details"] : ["details"];
  const chosen = tab && tabs.includes(tab) ? tab : tabs[0];
  // Keep a half-typed Ask AI question when the record refreshes underneath it.
  if (refresh && detail?.tab === "ask" && chosen === "ask" && askDraft) return;
  detail = { id, tab: chosen };
  show("detail");

  $("detail-title").textContent = [r.company, r.position].filter(Boolean).join(" · ") || "Untitled session";
  $("detail-sub").replaceChildren(
    `${modeLabel(r)} · ${r.language} · created ${date(r.createdAt)}${r.state === "ended" ? ` · ${duration(r.durationMs)}` : ""}  `,
    stateCell(r),
  );
  $("detail-actions").replaceChildren(
    ...(r.state === "ready" ? [h("button", { class: "primary", onclick: () => void start(r.id) }, "Start Session")] : []),
    ...(r.state === "live" ? [h("button", { class: "primary", onclick: () => void api.focusLive() }, "Join Session")] : []),
    ...(r.state !== "live" ? [h("button", { onclick: () => openModal(r) }, r.state === "ended" ? "Edit details" : "Edit session")] : []),
    ...(r.state !== "live"
      ? [
          h("button", {
            class: "danger",
            onclick: async (e: Event) => {
              const btn = e.currentTarget as HTMLButtonElement;
              // Two-step delete instead of a blocking confirm() dialog.
              if (btn.dataset.armed) {
                await api.deleteSession(r.id);
                show("sessions");
              } else {
                btn.dataset.armed = "1";
                btn.textContent = "Click again to delete";
                setTimeout(() => {
                  delete btn.dataset.armed;
                  btn.textContent = "Delete";
                }, 3000);
              }
            },
          }, "Delete"),
        ]
      : []),
  );

  const labels: Record<string, string> = { notes: "AI Notes", transcript: "Transcript", feedback: "Feedback", ask: "Ask AI", details: "Call Details" };
  $("detail-tabs").replaceChildren(
    ...tabs.map((t) => h("button", { class: t === chosen ? "on" : "", onclick: () => void openDetail(id, t) }, labels[t])),
  );

  const body = $("detail-body");
  if (chosen === "notes") body.replaceChildren(markdownPanel(r, r.notes, "AI notes"));
  else if (chosen === "feedback") body.replaceChildren(markdownPanel(r, r.feedback, "feedback"));
  else if (chosen === "transcript") body.replaceChildren(transcriptPanel(r));
  else if (chosen === "ask") body.replaceChildren(askPanel(r));
  else body.replaceChildren(detailsPanel(r));
}

function markdownPanel(r: SessionRecord, text: string, what: string): HTMLElement {
  if (r.generating) return h("div", { class: "generating" }, h("span", { class: "spinner" }), `Writing ${what}...`);
  const md = h("div", { class: "md card" });
  renderMarkdown(md, text || `*No ${what} yet.*`);
  // Notes are written from the transcript, so there is nothing to regenerate without one.
  const regenerate = r.segments.length ? h("div", {}, h("button", { class: "small", onclick: () => void api.regenerateNotes(r.id) }, "Regenerate notes and feedback")) : null;
  return h("div", { class: "stack" }, md, regenerate);
}

function transcriptPanel(r: SessionRecord): HTMLElement {
  if (!r.segments.length) {
    return h("p", { class: "muted" }, r.saveTranscript ? "Nothing was transcribed in this session." : "The transcript was not saved for this session (Save transcript was off).");
  }
  const t0 = r.startedAt ?? r.createdAt;
  const them = r.kind === "mock" ? "Interviewer" : "Caller";
  const items: { at: number; el: HTMLElement }[] = r.segments.map((s) => ({
    at: s.at,
    el: h("div", { class: "line" }, h("span", { class: "t" }, clock(s.at - t0)), h("b", { class: s.speaker }, s.speaker === "me" ? "Me" : them), h("span", {}, s.text)),
  }));
  // Mynah's suggestions, shown where they happened in the call.
  for (const a of r.answers) {
    if (a.kind === "interviewer") continue;
    const md = h("div", { class: "md" });
    renderMarkdown(md, a.text);
    items.push({ at: a.at + 1, el: h("div", { class: "suggestion" }, h("div", { class: "muted small-text" }, `Mynah ${a.kind === "chat" ? "chat" : a.kind}${a.auto ? " (auto)" : ""} · ${clock(a.at - t0)}`), md) });
  }
  items.sort((a, b) => a.at - b.at);
  return h("div", { class: "transcript" }, ...items.map((i) => i.el));
}

function askPanel(r: SessionRecord): HTMLElement {
  const chat = h("div", { class: "chat" });
  const bubble = (role: "user" | "assistant", text: string) => {
    const el = h("div", { class: `bubble ${role} md` });
    renderMarkdown(el, text);
    chat.append(el);
    return el;
  };
  for (const m of r.chat) bubble(m.role, m.text);
  if (!r.chat.length) chat.append(h("p", { class: "muted" }, "Ask anything about this call, e.g. \"What did they say about the timeline?\" or \"Draft a follow-up email.\""));

  const input = h("input", { class: "grow", placeholder: "Ask about this call..." });
  const form = h(
    "form",
    {
      class: "row",
      onsubmit: (e: Event) => {
        e.preventDefault();
        const q = input.value.trim();
        if (!q || askDraft) return;
        input.value = "";
        chat.querySelector("p.muted")?.remove();
        bubble("user", q);
        askDraft = { el: bubble("assistant", "*Thinking...*"), text: "" };
        void api.askAi(r.id, q);
      },
    },
    input,
    h("button", { class: "primary", type: "submit" }, "Ask"),
  );
  return h("div", {}, chat, form);
}

api.on("ask-ai", (ev) => {
  if (!askDraft || ev.sessionId !== detail?.id) return;
  if (ev.delta) {
    askDraft.text += ev.delta;
    renderMarkdown(askDraft.el, askDraft.text);
  }
  if (ev.done) {
    if (ev.error) renderMarkdown(askDraft.el, `${askDraft.text}\n\n*${ev.error}*`);
    askDraft = null;
  }
});

function detailsPanel(r: SessionRecord): HTMLElement {
  const docName = (id: string) => documents.find((d) => d.id === id)?.name ?? "(removed)";
  const rows: [string, string][] = [
    ["Type", r.kind === "mock" ? "Mock session (AI interviewer)" : "Real session"],
    ["Mode", r.mode === "interview" ? "Interview" : "Regular call"],
    ["Company", r.company || "—"],
    ["Position / topic", r.position || "—"],
    ["Language", r.language],
    ["AI model", r.model || "Default from Settings"],
    ["Resume", r.mode === "interview" && r.resumeDocId ? docName(r.resumeDocId) : "—"],
    ["Documents", r.documentIds.map(docName).join(", ") || "—"],
    ["Save transcript", r.saveTranscript ? "Yes" : "No"],
    ["Created", new Date(r.createdAt).toLocaleString()],
    ["Started", r.startedAt ? new Date(r.startedAt).toLocaleString() : "—"],
    ["Duration", duration(r.durationMs)],
    ["Instructions", r.instructions || "—"],
  ];
  return h("dl", { class: "details card" }, ...rows.flatMap(([k, v]) => [h("dt", {}, k), h("dd", {}, v)]));
}

// ---- Create / edit session -------------------------------------------------------------------------

let editingId: string | null = null;
let formKind: SessionKind = "real";
let formMode: SessionMode = "interview";

function setKind(kind: SessionKind): void {
  formKind = kind;
  document.querySelectorAll<HTMLButtonElement>(".kind-card").forEach((c) => c.classList.toggle("on", c.dataset.kind === kind));
  // A mock session is always an interview.
  if (kind === "mock") setMode("interview");
}

function setMode(mode: SessionMode): void {
  formMode = mode;
  $("f-mode").querySelectorAll<HTMLButtonElement>("button").forEach((b) => b.classList.toggle("on", b.dataset.mode === mode));
  $("f-resume-field").hidden = mode !== "interview";
}

document.querySelectorAll<HTMLButtonElement>(".kind-card").forEach((c) => c.addEventListener("click", () => setKind(c.dataset.kind as SessionKind)));
$("f-mode").addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("button");
  if (btn && !(formKind === "mock" && btn.dataset.mode === "regular")) setMode(btn.dataset.mode as SessionMode);
});

function fillDocPickers(resumeId: string, picked: string[]): void {
  $("f-resume").replaceChildren(new Option("No resume", ""), ...documents.map((d) => new Option(d.name, d.id)));
  $<HTMLSelectElement>("f-resume").value = resumeId;
  $("f-docs").replaceChildren(
    ...(documents.length
      ? documents.map((d) => h("label", { class: "check" }, h("input", { type: "checkbox", value: d.id, checked: picked.includes(d.id) }), `${d.name} `, h("span", { class: "muted" }, size(d.size))))
      : [h("span", { class: "muted small-text" }, "No documents uploaded yet.")]),
  );
}

async function openModal(r?: SessionRecord, hint?: string): Promise<void> {
  editingId = r?.id ?? null;
  $("modal-title").textContent = r ? "Edit Session" : "Create Session";
  $("btn-modal-save").textContent = r ? "Save" : "Create Session";
  $("btn-modal-start").hidden = Boolean(r && r.state !== "ready");
  $("btn-modal-start").textContent = r ? "Save & Start" : "Create & Start";
  $("f-error").textContent = hint ?? "";

  documents = await api.listDocuments();
  const models = await api.models().catch(() => []);
  $("f-model").replaceChildren(new Option("Default from Settings", ""), ...models.map((m) => new Option(m.name, m.id)));
  $("f-language").replaceChildren(...LANGUAGES.map((l) => new Option(l, l)));

  $<HTMLInputElement>("f-company").value = r?.company ?? "";
  $<HTMLInputElement>("f-position").value = r?.position ?? "";
  $<HTMLSelectElement>("f-language").value = r?.language ?? "English";
  $<HTMLSelectElement>("f-model").value = r?.model ?? "";
  $<HTMLTextAreaElement>("f-instructions").value = r?.instructions ?? "";
  $<HTMLInputElement>("f-save").checked = r?.saveTranscript ?? true;
  fillDocPickers(r?.resumeDocId ?? documents.find((d) => /resume|cv/i.test(d.name))?.id ?? "", r?.documentIds ?? []);
  setKind(r?.kind ?? "real");
  setMode(r?.mode ?? "interview");
  updateCount();
  $("modal").hidden = false;
  $("f-company").focus();
}

function closeModal(): void {
  $("modal").hidden = true;
}

function readForm(): SessionConfig {
  return {
    company: $<HTMLInputElement>("f-company").value.trim(),
    position: $<HTMLInputElement>("f-position").value.trim(),
    mode: formMode,
    kind: formKind,
    language: $<HTMLSelectElement>("f-language").value,
    model: $<HTMLSelectElement>("f-model").value,
    resumeDocId: formMode === "interview" ? $<HTMLSelectElement>("f-resume").value : "",
    documentIds: [...$("f-docs").querySelectorAll<HTMLInputElement>("input:checked")].map((i) => i.value),
    instructions: $<HTMLTextAreaElement>("f-instructions").value.slice(0, INSTRUCTIONS_LIMIT),
    saveTranscript: $<HTMLInputElement>("f-save").checked,
  };
}

async function submitModal(startAfter: boolean): Promise<void> {
  try {
    const config = readForm();
    const s = editingId ? await api.updateSession(editingId, config) : await api.createSession(config);
    closeModal();
    await loadSessions();
    if (startAfter) await start(s.id);
    else if (editingId) await openDetail(s.id, detail?.tab);
  } catch (err) {
    $("f-error").textContent = errorText(err);
  }
}

function updateCount(): void {
  const n = $<HTMLTextAreaElement>("f-instructions").value.length;
  $("f-count").textContent = `${n.toLocaleString()} / ${INSTRUCTIONS_LIMIT.toLocaleString()}`;
}

$<HTMLTextAreaElement>("f-instructions").maxLength = INSTRUCTIONS_LIMIT;
$("f-instructions").addEventListener("input", updateCount);
$("btn-create").addEventListener("click", () => void openModal());
$("btn-modal-close").addEventListener("click", closeModal);
$("btn-modal-cancel").addEventListener("click", closeModal);
$("session-form").addEventListener("submit", (e) => {
  e.preventDefault();
  void submitModal(false);
});
$("btn-modal-start").addEventListener("click", () => void submitModal(true));

async function uploadFromModal(asResume: boolean): Promise<void> {
  try {
    const added = await api.uploadDocuments();
    if (!added.length) return;
    const config = readForm();
    documents = await api.listDocuments();
    const resume = asResume ? added[0].id : config.resumeDocId;
    fillDocPickers(resume, asResume ? config.documentIds : [...config.documentIds, ...added.map((d) => d.id)]);
  } catch (err) {
    $("f-error").textContent = errorText(err);
  }
}
$("btn-f-upload-resume").addEventListener("click", () => void uploadFromModal(true));
$("btn-f-upload-docs").addEventListener("click", () => void uploadFromModal(false));

// ---- Documents ------------------------------------------------------------------------------------

async function loadDocuments(): Promise<void> {
  documents = await api.listDocuments();
  $("docs-empty").hidden = documents.length > 0;
  $("doc-rows").replaceChildren(
    ...documents.map((d) =>
      h(
        "tr",
        {},
        h("td", {}, h("b", {}, d.name)),
        h("td", {}, d.ext.toUpperCase() || "—"),
        h("td", {}, size(d.size)),
        h("td", {}, date(d.uploadedAt)),
        h("td", { class: "right" }, h("button", { class: "ghost small", onclick: async () => (await api.deleteDocument(d.id), void loadDocuments()) }, "Remove")),
      ),
    ),
  );
}

$("btn-upload").addEventListener("click", async () => {
  $("docs-status").textContent = "Reading files...";
  try {
    const added = await api.uploadDocuments();
    $("docs-status").textContent = added.length ? `Uploaded ${added.length} file${added.length === 1 ? "" : "s"}.` : "";
  } catch (err) {
    $("docs-status").textContent = errorText(err);
  }
  await loadDocuments();
});

// ---- Settings ---------------------------------------------------------------------------------------

function showProvider(): void {
  const id = $<HTMLSelectElement>("provider").value;
  $("provider-chatgpt").hidden = id !== "chatgpt";
  $("provider-claude").hidden = id !== "claude";
}

function renderPlanCard(): void {
  const card = $("plan-card");
  if (settings.provider === "chatgpt") {
    card.replaceChildren(h("b", {}, "ChatGPT plan"), settings.chatgptAccount ?? h("span", { class: "error-text" }, "Not signed in. Open Settings."));
  } else {
    card.replaceChildren(h("b", {}, "Claude API"), settings.hasApiKey ? "API key saved" : h("span", { class: "error-text" }, "No API key. Open Settings."));
  }
}

async function renderSettings(): Promise<void> {
  $<HTMLSelectElement>("provider").value = settings.provider;
  showProvider();
  const signedIn = settings.chatgptAccount !== null;
  $("chatgpt-signed-out").hidden = signedIn;
  $("chatgpt-signed-in").hidden = !signedIn;
  $("chatgpt-account").textContent = settings.chatgptAccount ?? "";
  $("api-key-status").textContent = settings.hasApiKey ? "A key is saved (stored encrypted)." : "No key saved yet. Get one at console.anthropic.com.";
  $<HTMLSelectElement>("live-effort").value = settings.liveEffort;
  $<HTMLInputElement>("auto-answer").checked = settings.autoAnswer;
  $<HTMLInputElement>("always-on-top").checked = settings.alwaysOnTop;
  $<HTMLInputElement>("opacity").value = String(settings.opacity);
  $<HTMLInputElement>("detect-meetings").checked = settings.detectMeetings;
  $<HTMLInputElement>("model-dir").value = settings.modelDir;
  $<HTMLInputElement>("mock-questions").value = String(settings.mockQuestions);
  renderVoices();
  renderPlanCard();
  const models = await api.models().catch(() => []);
  $("default-model").replaceChildren(...models.map((m) => new Option(m.name, m.id)));
  $<HTMLSelectElement>("default-model").value = settings.provider === "chatgpt" ? settings.chatgptModel : settings.model;
}

function renderVoices(): void {
  const voices = speechSynthesis.getVoices();
  $("voice").replaceChildren(new Option("System default", ""), ...voices.map((v) => new Option(`${v.name} (${v.lang})`, v.name)));
  $<HTMLSelectElement>("voice").value = settings.interviewerVoice;
}
speechSynthesis.addEventListener("voiceschanged", () => settings && renderVoices());

$("btn-voice-test").addEventListener("click", () => {
  const u = new SpeechSynthesisUtterance("Hi, thanks for joining. Can you start by telling me a little about yourself?");
  const voice = speechSynthesis.getVoices().find((v) => v.name === $<HTMLSelectElement>("voice").value);
  if (voice) u.voice = voice;
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
});

$("provider").addEventListener("change", async () => {
  settings = await api.saveSettings({ provider: $<HTMLSelectElement>("provider").value as PublicSettings["provider"] });
  await renderSettings();
});

let signInAttempt = 0;
$("btn-chatgpt-signin").addEventListener("click", async () => {
  const btn = $<HTMLButtonElement>("btn-chatgpt-signin");
  const attempt = ++signInAttempt;
  // Stays clickable: clicking again reopens the sign-in page.
  btn.textContent = "Reopen sign-in page";
  $("chatgpt-status").textContent = "Finish signing in in your browser...";
  try {
    const next = await api.chatgptSignIn();
    if (attempt !== signInAttempt) return;
    settings = next;
    $("chatgpt-status").textContent = "";
    await renderSettings();
  } catch (err) {
    if (attempt === signInAttempt) $("chatgpt-status").textContent = errorText(err);
  } finally {
    if (attempt === signInAttempt) btn.textContent = "Continue with ChatGPT";
  }
});

$("btn-chatgpt-signout").addEventListener("click", async () => {
  const revoked = await api.chatgptSignOut();
  settings = await api.getSettings();
  $("chatgpt-status").textContent = revoked ? "Signed out." : "Signed out on this PC, but OpenAI did not confirm it. You can disconnect Mynah in ChatGPT settings.";
  await renderSettings();
});
$("btn-chatgpt-usage").addEventListener("click", () => void api.openUsage());

$("btn-settings-save").addEventListener("click", async () => {
  const key = $<HTMLInputElement>("api-key").value.trim();
  const model = $<HTMLSelectElement>("default-model").value;
  settings = await api.saveSettings({
    ...(key ? { apiKey: key } : {}),
    ...(model ? (settings.provider === "chatgpt" ? { chatgptModel: model } : { model }) : {}),
    liveEffort: $<HTMLSelectElement>("live-effort").value as PublicSettings["liveEffort"],
    autoAnswer: $<HTMLInputElement>("auto-answer").checked,
    alwaysOnTop: $<HTMLInputElement>("always-on-top").checked,
    opacity: Number($<HTMLInputElement>("opacity").value),
    detectMeetings: $<HTMLInputElement>("detect-meetings").checked,
    modelDir: $<HTMLInputElement>("model-dir").value.trim(),
    interviewerVoice: $<HTMLSelectElement>("voice").value,
    mockQuestions: Math.min(20, Math.max(2, Number($<HTMLInputElement>("mock-questions").value) || 6)),
  });
  $<HTMLInputElement>("api-key").value = "";
  await renderSettings();
  $("settings-saved").textContent = "Saved.";
  setTimeout(() => ($("settings-saved").textContent = ""), 2000);
});

// ---- Speech status and events ---------------------------------------------------------------------------

function showStt(status: SttStatus): void {
  const labels: Record<SttStatus["state"], [string, string]> = {
    ready: ["Speech: ready", "ok"],
    loading: ["Speech: loading", "warn"],
    "missing-models": ["Speech: models missing", "err"],
    error: ["Speech: error", "err"],
  };
  const [text, cls] = labels[status.state];
  const pill = $("stt-pill");
  pill.textContent = text;
  pill.className = `pill ${cls}`;
  pill.title = status.message ?? "";
}

api.on("stt-status", showStt);
api.on("sessions-changed", () => void loadSessions());
api.on("open-session", (id) => void openDetail(id, "notes"));
api.on("meeting-detected", (appName) => void openModal(undefined, `${appName} just started using your microphone. Set up the session and start it.`));

async function init(): Promise<void> {
  settings = await api.getSettings();
  documents = await api.listDocuments();
  await loadSessions();
  showStt(await api.sttStatus());
  await renderSettings();
}

void init();
