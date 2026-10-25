import { app, BrowserWindow, desktopCapturer, dialog, globalShortcut, ipcMain, Notification, screen, session, shell } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { MainEvent, ModelOption, SessionConfig, Settings, SettingsUpdate, Speaker } from "../shared/types";
import { buildContext, prompts, type LlmProvider } from "./assistant";
import { ChatGPTAuth } from "./chatgpt-auth";
import { LiveController, formatTranscript, writeNotes } from "./live";
import { MeetingDetector } from "./meetings";
import { ChatGPTProvider, listChatGPTModels, pickFastModel } from "./providers/chatgpt";
import { CLAUDE_MODELS, ClaudeProvider } from "./providers/claude";
import { loadSettings, saveSettings, toPublic } from "./settings";
import { DocumentStore, SessionStore, summarize } from "./store";
import { Transcriber } from "./stt";

const here = path.dirname(fileURLToPath(import.meta.url));
const USAGE_URL = "https://chatgpt.com/settings/usage";

let dashboard: BrowserWindow | null = null;
let overlay: BrowserWindow | null = null;
// Created once the app is ready: they use safeStorage and app paths.
let settings: Settings;
let chatgptAuth: ChatGPTAuth;
let provider: LlmProvider;
let sessions: SessionStore;
let docs: DocumentStore;
let live: LiveController;
let meetings: MeetingDetector;
const transcriber = new Transcriber();
let ending = false;

const toDashboard = (channel: MainEvent, payload?: unknown) => dashboard?.webContents.send(channel, payload);
const toOverlay = (channel: MainEvent, payload?: unknown) => overlay?.webContents.send(channel, payload);
const sessionsChanged = () => toDashboard("sessions-changed");
const publicSettings = () => toPublic(settings, chatgptAuth.account);

function makeProvider(): LlmProvider {
  return settings.provider === "chatgpt"
    ? new ChatGPTProvider(chatgptAuth, settings.chatgptModel)
    : new ClaudeProvider(settings.apiKey, settings.model);
}

// The catalog is a network call (~1 s), and the dashboard asks for it whenever
// the session form or Settings opens, so keep it for a while per account.
const MODEL_CACHE_MS = 10 * 60 * 1000;
let modelCache: { account: string; list: ModelOption[]; at: number } | null = null;

async function chatgptModels(): Promise<ModelOption[]> {
  const account = chatgptAuth.account;
  if (!account) return [];
  if (modelCache?.account === account && Date.now() - modelCache.at < MODEL_CACHE_MS) return modelCache.list;
  const list = await listChatGPTModels(chatgptAuth);
  modelCache = { account, list, at: Date.now() };
  return list;
}

async function models(): Promise<ModelOption[]> {
  return settings.provider === "claude" ? CLAUDE_MODELS : chatgptModels();
}

/** Chooses the fast default when no ChatGPT model is set, or the saved one is gone. */
async function ensureChatGPTModel(): Promise<void> {
  const list = await chatgptModels();
  if (list.length && !list.some((m) => m.id === settings.chatgptModel)) {
    settings = { ...settings, chatgptModel: pickFastModel(list) };
    saveSettings(settings);
    provider = makeProvider();
  }
}

// ---- Windows -------------------------------------------------------------------

const webPreferences = () => ({
  preload: path.join(here, "preload.cjs"),
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
});

function createDashboard(): void {
  dashboard = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 860,
    minHeight: 520,
    title: "Mynah",
    backgroundColor: "#111318",
    titleBarStyle: "hidden",
    titleBarOverlay: { color: "#111318", symbolColor: "#c9cdd6", height: 36 },
    webPreferences: webPreferences(),
  });
  dashboard.loadFile(path.join(here, "renderer", "dashboard.html"));
  dashboard.on("closed", () => {
    dashboard = null;
    if (!overlay) app.quit();
  });
}

function showDashboard(): void {
  if (!dashboard) createDashboard();
  else {
    if (dashboard.isMinimized()) dashboard.restore();
    dashboard.show();
    dashboard.focus();
  }
}

function createOverlay(): BrowserWindow {
  const area = screen.getPrimaryDisplay().workArea;
  const win = new BrowserWindow({
    width: 460,
    height: 720,
    x: area.x + area.width - 480,
    y: area.y + 40,
    minWidth: 360,
    minHeight: 420,
    title: "Mynah - Live",
    backgroundColor: "#111318",
    titleBarStyle: "hidden",
    titleBarOverlay: { color: "#111318", symbolColor: "#c9cdd6", height: 40 },
    webPreferences: webPreferences(),
  });
  win.setAlwaysOnTop(settings.alwaysOnTop, "floating");
  win.setOpacity(Math.min(1, Math.max(0.3, settings.opacity)));
  win.loadFile(path.join(here, "renderer", "overlay.html"));
  // Closing the live window ends the session.
  win.on("close", () => {
    if (live.active) void endLive();
  });
  win.on("closed", () => {
    overlay = null;
    // A close from the page (window.close) emits only "closed", not "close".
    if (live.active) void endLive();
    // While ending, endLive reopens the dashboard to show the notes.
    else if (!dashboard && !ending) app.quit();
  });
  return win;
}

async function captureScreen(): Promise<string> {
  const display = overlay ? screen.getDisplayMatching(overlay.getBounds()) : screen.getPrimaryDisplay();
  const px = { w: display.size.width * display.scaleFactor, h: display.size.height * display.scaleFactor };
  // Long edge up to 1920 px keeps code readable and the image small.
  const scale = Math.min(1, 1920 / Math.max(px.w, px.h));
  const thumbnailSize = { width: Math.round(px.w * scale), height: Math.round(px.h * scale) };
  // Hide our window so it does not cover the problem in the screenshot.
  const wasVisible = overlay?.isVisible() ?? false;
  if (wasVisible) overlay!.hide();
  await new Promise((r) => setTimeout(r, 200));
  try {
    const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize });
    const source = sources.find((s) => s.display_id === String(display.id)) ?? sources[0];
    if (!source) throw new Error("No screen available to capture.");
    return source.thumbnail.toJPEG(85).toString("base64");
  } finally {
    if (wasVisible) overlay!.showInactive();
  }
}

// ---- Live sessions -----------------------------------------------------------------

async function startLive(id: string): Promise<void> {
  if (live.active) throw new Error("Another session is already live. End it first.");
  const record = sessions.get(id);
  if (!record) throw new Error("Session not found.");
  live.start(record);
  overlay = createOverlay();
  registerHotkeys();
  await new Promise<void>((res) => overlay!.webContents.once("did-finish-load", () => res()));
  // Run with a user gesture so getDisplayMedia (call audio) is allowed without a click.
  await overlay.webContents.executeJavaScript("window.__startCapture()", true);
  live.windowReady();
}

async function endLive(): Promise<void> {
  if (ending) return;
  ending = true;
  try {
    const record = await live.end();
    globalShortcut.unregisterAll();
    if (overlay && !overlay.isDestroyed()) overlay.destroy();
    const reopened = !dashboard;
    showDashboard();
    // A new dashboard would miss "open-session" sent before its page loads.
    if (reopened) await new Promise<void>((res) => dashboard!.webContents.once("did-finish-load", () => res()));
    if (record) {
      toDashboard("open-session", record.id);
      await writeNotes(record, { provider: () => provider, docs, store: sessions, sessionsChanged });
    }
  } finally {
    ending = false;
    if (!dashboard && !overlay) app.quit();
  }
}

function registerHotkeys(): void {
  globalShortcut.register("CommandOrControl+Alt+Enter", () => void live.answerNow());
  globalShortcut.register("CommandOrControl+Alt+S", () => void live.screenshot());
  globalShortcut.register("CommandOrControl+Alt+H", () => {
    if (!overlay) return;
    if (overlay.isVisible()) overlay.hide();
    else overlay.showInactive();
  });
}

transcriber.on("status", (status) => {
  toDashboard("stt-status", status);
  toOverlay("stt-status", status);
});
transcriber.on("error", (err) => console.error("[stt]", err));
transcriber.on("segment", (speaker: Speaker, text: string) => live.onSegment(speaker, text));

// ---- IPC -------------------------------------------------------------------------------

function registerIpc(): void {
  // Settings and accounts
  ipcMain.handle("settings:get", () => publicSettings());
  ipcMain.handle("settings:set", (_e, update: SettingsUpdate) => {
    const previous = settings;
    settings = { ...settings, ...update, apiKey: update.apiKey ?? previous.apiKey };
    if (!settings.modelDir?.trim()) settings.modelDir = previous.modelDir;
    saveSettings(settings);
    provider = makeProvider();
    if (settings.modelDir !== previous.modelDir) void transcriber.load(settings.modelDir);
    if (settings.detectMeetings) meetings.start();
    else meetings.stop();
    overlay?.setAlwaysOnTop(settings.alwaysOnTop, "floating");
    overlay?.setOpacity(Math.min(1, Math.max(0.3, settings.opacity)));
    return publicSettings();
  });
  ipcMain.handle("chatgpt:signin", async () => {
    await chatgptAuth.signIn();
    modelCache = null;
    showDashboard();
    await ensureChatGPTModel();
    provider = makeProvider();
    return publicSettings();
  });
  ipcMain.handle("chatgpt:signout", async () => {
    const revoked = await chatgptAuth.signOut();
    provider = makeProvider();
    return revoked;
  });
  ipcMain.handle("models", () => models());
  ipcMain.handle("open:usage", () => shell.openExternal(USAGE_URL));
  ipcMain.handle("stt:status", () => transcriber.status);

  // Sessions
  ipcMain.handle("sessions:list", () => sessions.list());
  ipcMain.handle("sessions:get", (_e, id: string) => sessions.get(id));
  ipcMain.handle("sessions:create", (_e, config: SessionConfig) => {
    const r = sessions.create(config);
    sessionsChanged();
    return summarize(r);
  });
  ipcMain.handle("sessions:update", (_e, id: string, config: SessionConfig) => {
    const r = sessions.get(id);
    if (!r) throw new Error("Session not found.");
    if (r.state === "live") throw new Error("A live session cannot be edited.");
    const { company, position, mode, kind, language, model, resumeDocId, documentIds, instructions, saveTranscript } = config;
    Object.assign(r, { company, position, mode, kind, language, model, resumeDocId, documentIds, instructions, saveTranscript });
    sessions.save(r);
    sessionsChanged();
    return summarize(r);
  });
  ipcMain.handle("sessions:delete", (_e, id: string) => {
    if (live.record?.id === id) throw new Error("End the session before deleting it.");
    sessions.delete(id);
    sessionsChanged();
  });
  ipcMain.handle("sessions:start", (_e, id: string) => startLive(id));
  ipcMain.handle("live:focus", () => {
    overlay?.show();
    overlay?.focus();
  });
  ipcMain.handle("sessions:regenerate", (_e, id: string) => {
    const r = sessions.get(id);
    // Without a saved transcript there is nothing to rewrite the notes from.
    if (r && r.state === "ended" && !r.generating && r.segments.length) void writeNotes(r, { provider: () => provider, docs, store: sessions, sessionsChanged });
  });
  ipcMain.handle("ask-ai", async (_e, id: string, question: string) => {
    const r = sessions.get(id);
    if (!r) return;
    const emit = (ev: { delta?: string; done?: boolean; error?: string }) => toDashboard("ask-ai", { sessionId: id, ...ev });
    if (!provider.ready()) return emit({ done: true, error: provider.notReadyMessage });
    try {
      const text = await provider.stream({
        system: prompts.askSystem(r, formatTranscript(r)),
        context: buildContext(r, docs),
        history: r.chat,
        prompt: { text: question },
        model: r.model,
        effort: "low",
        maxTokens: 8000,
        signal: new AbortController().signal,
        onText: (delta) => emit({ delta }),
      });
      r.chat.push({ role: "user", text: question }, { role: "assistant", text });
      sessions.save(r);
      emit({ done: true });
      // Shows the reply if the user left the Ask AI tab while it was streaming.
      sessionsChanged();
    } catch (err) {
      emit({ done: true, error: provider.describeError(err) });
    }
  });

  // Documents
  ipcMain.handle("docs:list", () => docs.list());
  ipcMain.handle("docs:upload", async () => {
    const result = await dialog.showOpenDialog(dashboard!, {
      properties: ["openFile", "multiSelections"],
      filters: [
        { name: "Documents", extensions: ["pdf", "txt", "md", "markdown", "json", "csv", "html"] },
        { name: "Code", extensions: ["py", "js", "ts", "java", "go", "cs", "cpp", "c", "rb", "kt", "sql"] },
        { name: "All files", extensions: ["*"] },
      ],
    });
    return result.canceled ? [] : docs.add(result.filePaths);
  });
  ipcMain.handle("docs:delete", (_e, id: string) => docs.delete(id));

  // Live window
  ipcMain.handle("live:session", () => live.record);
  ipcMain.on("audio:chunk", (_e, speaker: Speaker, samples: Float32Array) => {
    if (live.active) transcriber.feed(speaker, samples);
  });
  ipcMain.handle("live:answer", () => live.answerNow());
  ipcMain.handle("live:screenshot", () => live.screenshot());
  ipcMain.handle("live:message", (_e, text: string) => live.sendMessage(text));
  ipcMain.handle("live:auto", (_e, on: boolean) => {
    live.autoAnswer = on;
    toOverlay("auto-answer", on);
  });
  ipcMain.handle("live:clear", () => live.cancel());
  ipcMain.handle("live:cancel", () => live.cancel());
  ipcMain.on("live:speaking-done", () => live.speakingDone());
  ipcMain.handle("live:end", () => endLive());
  ipcMain.on("live:capture-failed", (_e, message: string) => {
    dialog.showMessageBox(overlay ?? dashboard!, { type: "warning", message: "Could not capture audio", detail: message });
  });
}

// ---- App lifecycle -------------------------------------------------------------------------

app.whenReady().then(async () => {
  settings = loadSettings();
  chatgptAuth = new ChatGPTAuth();
  provider = makeProvider();
  sessions = new SessionStore();
  docs = new DocumentStore();
  live = new LiveController({
    provider: () => provider,
    settings: () => settings,
    docs,
    store: sessions,
    transcriber,
    send: toOverlay,
    sessionsChanged,
    captureScreen,
  });
  meetings = new MeetingDetector((appName) => {
    if (live.active) return;
    const note = new Notification({ title: "Meeting started?", body: `${appName} is using your microphone. Click to start a Mynah session.` });
    note.on("click", () => {
      showDashboard();
      toDashboard("meeting-detected", appName);
    });
    note.show();
  });

  // getDisplayMedia() in the live window gets the screen plus system audio
  // ("loopback"), which is how the other side of the call is heard.
  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    desktopCapturer
      .getSources({ types: ["screen"] })
      .then((sources) => callback({ video: sources[0], audio: "loopback" }))
      .catch(() => callback({}));
  });

  registerIpc();
  createDashboard();
  void transcriber.load(settings.modelDir);
  if (settings.detectMeetings) meetings.start();
  ensureChatGPTModel().catch((err) => console.error("[chatgpt] model list:", (err as Error).message));
});

app.on("will-quit", () => globalShortcut.unregisterAll());
app.on("window-all-closed", () => {
  if (!ending) app.quit();
});
