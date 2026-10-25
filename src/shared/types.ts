export type Speaker = "them" | "me";
export type SessionMode = "interview" | "regular";
/** real: listen to an actual call. mock: an AI interviewer asks the questions out loud. */
export type SessionKind = "real" | "mock";
export type SessionState = "ready" | "live" | "ended";
export type Effort = "low" | "medium" | "high";
export type ProviderId = "chatgpt" | "claude";

/** Answer languages offered when creating a session. */
export const LANGUAGES = [
  "English", "Hindi", "Spanish", "French", "German", "Portuguese", "Italian", "Dutch", "Polish", "Russian",
  "Ukrainian", "Swedish", "Danish", "Finnish", "Czech", "Greek", "Romanian", "Hungarian", "Bulgarian",
  "Croatian", "Slovak", "Slovenian", "Estonian", "Latvian", "Lithuanian", "Maltese",
] as const;

export const INSTRUCTIONS_LIMIT = 20000;

/** What the user fills in on "Create Session". */
export interface SessionConfig {
  company: string;
  position: string;
  mode: SessionMode;
  kind: SessionKind;
  language: string;
  /** Model id for this session; "" uses the default from Settings. */
  model: string;
  resumeDocId: string;
  documentIds: string[];
  instructions: string;
  saveTranscript: boolean;
}

export interface Segment {
  id: number;
  speaker: Speaker;
  text: string;
  at: number;
}

export type AnswerKind = "answer" | "screenshot" | "chat" | "interviewer";

export interface AnswerRecord {
  id: number;
  kind: AnswerKind;
  /** The question or message that was answered (empty for interviewer turns). */
  question: string;
  text: string;
  auto: boolean;
  at: number;
}

export interface ChatMessage {
  role: "user" | "assistant";
  text: string;
}

export interface SessionRecord extends SessionConfig {
  id: string;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
  durationMs: number;
  state: SessionState;
  segments: Segment[];
  answers: AnswerRecord[];
  notes: string;
  feedback: string;
  /** "Ask AI" conversation about the finished call. */
  chat: ChatMessage[];
  /** True while AI notes are being written after the call. */
  generating: boolean;
}

export type SessionSummary = Omit<SessionRecord, "segments" | "answers" | "notes" | "feedback" | "chat">;

export interface DocumentInfo {
  id: string;
  name: string;
  ext: string;
  size: number;
  uploadedAt: number;
  chars: number;
}

export interface Settings {
  provider: ProviderId;
  /** Default ChatGPT model slug; "" until the account's catalog is loaded. */
  chatgptModel: string;
  apiKey: string;
  /** Default Claude model. */
  model: string;
  liveEffort: Effort;
  autoAnswer: boolean;
  alwaysOnTop: boolean;
  opacity: number;
  modelDir: string;
  detectMeetings: boolean;
  /** speechSynthesis voice name for the mock interviewer; "" = system default. */
  interviewerVoice: string;
  mockQuestions: number;
}

/** What the renderer sees: the API key itself never leaves the main process. */
export type PublicSettings = Omit<Settings, "apiKey"> & {
  hasApiKey: boolean;
  /** Email of the signed-in ChatGPT account, or null. */
  chatgptAccount: string | null;
};
/** apiKey: undefined keeps the stored key. */
export type SettingsUpdate = Partial<Settings>;

export interface ModelOption {
  id: string;
  name: string;
}

export interface AnswerEvent {
  id: number;
  kind: AnswerKind;
  question: string;
  auto: boolean;
  at: number;
  delta?: string;
  done?: boolean;
  error?: string;
}

export interface AskEvent {
  sessionId: string;
  delta?: string;
  done?: boolean;
  error?: string;
}

export interface SttStatus {
  state: "missing-models" | "loading" | "ready" | "error";
  message?: string;
}

export type MainEvent =
  | "segment"
  | "answer"
  | "stt-status"
  | "sessions-changed"
  | "speak"
  | "auto-answer"
  | "ask-ai"
  | "meeting-detected"
  | "open-session";

export interface MynahApi {
  // Settings and accounts
  getSettings(): Promise<PublicSettings>;
  saveSettings(update: SettingsUpdate): Promise<PublicSettings>;
  chatgptSignIn(): Promise<PublicSettings>;
  /** Resolves true when the session was also revoked on OpenAI's side. */
  chatgptSignOut(): Promise<boolean>;
  models(): Promise<ModelOption[]>;
  openUsage(): Promise<void>;
  sttStatus(): Promise<SttStatus>;

  // Sessions (dashboard)
  listSessions(): Promise<SessionSummary[]>;
  getSession(id: string): Promise<SessionRecord | null>;
  createSession(config: SessionConfig): Promise<SessionSummary>;
  updateSession(id: string, config: SessionConfig): Promise<SessionSummary>;
  deleteSession(id: string): Promise<void>;
  startSession(id: string): Promise<void>;
  focusLive(): Promise<void>;
  askAi(id: string, question: string): Promise<void>;
  regenerateNotes(id: string): Promise<void>;

  // Documents
  listDocuments(): Promise<DocumentInfo[]>;
  uploadDocuments(): Promise<DocumentInfo[]>;
  deleteDocument(id: string): Promise<void>;

  // Live session (overlay)
  liveSession(): Promise<SessionRecord | null>;
  sendAudio(speaker: Speaker, samples: Float32Array): void;
  answerNow(): Promise<void>;
  screenshot(): Promise<void>;
  sendMessage(text: string): Promise<void>;
  setAutoAnswer(on: boolean): Promise<void>;
  clearAnswers(): Promise<void>;
  cancelAnswer(): Promise<void>;
  speakingDone(): void;
  endSession(): Promise<void>;
  captureFailed(message: string): void;

  on(event: "segment", cb: (seg: Segment) => void): void;
  on(event: "answer", cb: (ev: AnswerEvent) => void): void;
  on(event: "stt-status", cb: (status: SttStatus) => void): void;
  on(event: "sessions-changed", cb: () => void): void;
  on(event: "speak", cb: (text: string) => void): void;
  on(event: "auto-answer", cb: (on: boolean) => void): void;
  on(event: "ask-ai", cb: (ev: AskEvent) => void): void;
  on(event: "meeting-detected", cb: (app: string) => void): void;
  on(event: "open-session", cb: (id: string) => void): void;
}
