import { app, safeStorage } from "electron";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { PublicSettings, Settings } from "../shared/types";

type Stored = Omit<Settings, "apiKey"> & { apiKeyEnc?: string };

function defaults(): Settings {
  return {
    provider: "chatgpt",
    chatgptModel: "",
    apiKey: "",
    model: "claude-opus-5-5",
    liveEffort: "low",
    autoAnswer: true,
    alwaysOnTop: true,
    opacity: 0.97,
    modelDir: path.join(app.getAppPath(), "models"),
    detectMeetings: true,
    interviewerVoice: "",
    mockQuestions: 6,
  };
}

const file = () => path.join(app.getPath("userData"), "settings.json");

export function loadSettings(): Settings {
  let stored: Partial<Stored> = {};
  try {
    stored = JSON.parse(readFileSync(file(), "utf8"));
  } catch {
    // First run or unreadable file: fall back to defaults.
  }
  let apiKey = "";
  if (stored.apiKeyEnc && safeStorage.isEncryptionAvailable()) {
    try {
      apiKey = safeStorage.decryptString(Buffer.from(stored.apiKeyEnc, "base64"));
    } catch {
      // Key was encrypted under another Windows user; ask for it again.
    }
  }
  // Only known keys survive, so settings from older versions drop out.
  const base = defaults();
  const known = Object.fromEntries(Object.keys(base).filter((k) => k in stored).map((k) => [k, stored[k as keyof Stored]]));
  return { ...base, ...known, apiKey };
}

export function saveSettings(settings: Settings): void {
  const { apiKey, ...rest } = settings;
  const stored: Stored = { ...rest };
  // The key is only persisted encrypted (DPAPI on Windows), never as plain text.
  if (apiKey && safeStorage.isEncryptionAvailable()) {
    stored.apiKeyEnc = safeStorage.encryptString(apiKey).toString("base64");
  }
  mkdirSync(path.dirname(file()), { recursive: true });
  writeFileSync(file(), JSON.stringify(stored, null, 2));
}

export function toPublic(settings: Settings, chatgptAccount: string | null): PublicSettings {
  const { apiKey, ...rest } = settings;
  return { ...rest, hasApiKey: Boolean(apiKey || process.env.ANTHROPIC_API_KEY), chatgptAccount };
}
