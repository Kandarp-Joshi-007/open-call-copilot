import { contextBridge, ipcRenderer } from "electron";
import type { MainEvent, MynahApi } from "../shared/types";

const events: MainEvent[] = ["segment", "answer", "stt-status", "sessions-changed", "speak", "auto-answer", "ask-ai", "meeting-detected", "open-session"];
const invoke = (channel: string) => (...args: unknown[]) => ipcRenderer.invoke(channel, ...args);

const api: MynahApi = {
  getSettings: invoke("settings:get"),
  saveSettings: invoke("settings:set"),
  chatgptSignIn: invoke("chatgpt:signin"),
  chatgptSignOut: invoke("chatgpt:signout"),
  models: invoke("models"),
  openUsage: invoke("open:usage"),
  sttStatus: invoke("stt:status"),

  listSessions: invoke("sessions:list"),
  getSession: invoke("sessions:get"),
  createSession: invoke("sessions:create"),
  updateSession: invoke("sessions:update"),
  deleteSession: invoke("sessions:delete"),
  startSession: invoke("sessions:start"),
  focusLive: invoke("live:focus"),
  askAi: invoke("ask-ai"),
  regenerateNotes: invoke("sessions:regenerate"),

  listDocuments: invoke("docs:list"),
  uploadDocuments: invoke("docs:upload"),
  deleteDocument: invoke("docs:delete"),

  liveSession: invoke("live:session"),
  sendAudio: (speaker, samples) => ipcRenderer.send("audio:chunk", speaker, samples),
  answerNow: invoke("live:answer"),
  screenshot: invoke("live:screenshot"),
  sendMessage: invoke("live:message"),
  setAutoAnswer: invoke("live:auto"),
  clearAnswers: invoke("live:clear"),
  cancelAnswer: invoke("live:cancel"),
  speakingDone: () => ipcRenderer.send("live:speaking-done"),
  endSession: invoke("live:end"),
  captureFailed: (message) => ipcRenderer.send("live:capture-failed", message),

  on: (event: MainEvent, cb: (payload: any) => void) => {
    if (events.includes(event)) ipcRenderer.on(event, (_e, payload) => cb(payload));
  },
} as MynahApi;

contextBridge.exposeInMainWorld("mynah", api);
