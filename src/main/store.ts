import { app } from "electron";
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { extractText, getDocumentProxy } from "unpdf";
import type { DocumentInfo, SessionConfig, SessionRecord, SessionSummary } from "../shared/types";

function writeJson(file: string, data: unknown): void {
  // Atomic write so a crash mid-save cannot corrupt a session.
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, file);
}

export function summarize(r: SessionRecord): SessionSummary {
  const { segments, answers, notes, feedback, chat, ...summary } = r;
  return summary;
}

/** One JSON file per session in %APPDATA%/mynah/sessions. */
export class SessionStore {
  private dir = path.join(app.getPath("userData"), "sessions");
  private cache = new Map<string, SessionRecord>();

  constructor() {
    mkdirSync(this.dir, { recursive: true });
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith(".json")) continue;
      try {
        const r = JSON.parse(readFileSync(path.join(this.dir, f), "utf8")) as SessionRecord;
        if (!r.id) continue; // files from the first version had no id
        // A session that was live when the app closed has ended.
        if (r.state === "live") r.state = "ended";
        r.generating = false;
        this.cache.set(r.id, r);
      } catch {
        // Skip unreadable files rather than failing to start.
      }
    }
  }

  list(): SessionSummary[] {
    return [...this.cache.values()].sort((a, b) => b.createdAt - a.createdAt).map(summarize);
  }

  get(id: string): SessionRecord | null {
    return this.cache.get(id) ?? null;
  }

  create(config: SessionConfig): SessionRecord {
    const r: SessionRecord = {
      ...config,
      id: randomUUID(),
      createdAt: Date.now(),
      startedAt: null,
      endedAt: null,
      durationMs: 0,
      state: "ready",
      segments: [],
      answers: [],
      notes: "",
      feedback: "",
      chat: [],
      generating: false,
    };
    this.save(r);
    return r;
  }

  save(r: SessionRecord): void {
    this.cache.set(r.id, r);
    writeJson(path.join(this.dir, `${r.id}.json`), r);
  }

  delete(id: string): void {
    this.cache.delete(id);
    rmSync(path.join(this.dir, `${id}.json`), { force: true });
  }
}

/** Uploaded files are copied into %APPDATA%/mynah/documents with their text extracted once. */
export class DocumentStore {
  private dir = path.join(app.getPath("userData"), "documents");
  private indexFile = path.join(this.dir, "index.json");
  private docs: DocumentInfo[] = [];

  constructor() {
    mkdirSync(this.dir, { recursive: true });
    try {
      this.docs = JSON.parse(readFileSync(this.indexFile, "utf8"));
    } catch {
      this.docs = [];
    }
  }

  list(): DocumentInfo[] {
    return [...this.docs].sort((a, b) => b.uploadedAt - a.uploadedAt);
  }

  get(id: string): DocumentInfo | undefined {
    return this.docs.find((d) => d.id === id);
  }

  async add(files: string[]): Promise<DocumentInfo[]> {
    const added: DocumentInfo[] = [];
    try {
      for (const file of files) {
        const id = randomUUID();
        const ext = path.extname(file).slice(1).toLowerCase();
        const text = await extract(file, ext);
        copyFileSync(file, path.join(this.dir, `${id}.${ext || "bin"}`));
        writeFileSync(path.join(this.dir, `${id}.txt`), text);
        const info: DocumentInfo = { id, name: path.basename(file), ext, size: statSync(file).size, uploadedAt: Date.now(), chars: text.length };
        this.docs.push(info);
        added.push(info);
      }
    } finally {
      // Files added before one that fails stay in the index.
      writeJson(this.indexFile, this.docs);
    }
    return added;
  }

  text(id: string): string {
    const file = path.join(this.dir, `${id}.txt`);
    return existsSync(file) ? readFileSync(file, "utf8") : "";
  }

  delete(id: string): void {
    const doc = this.get(id);
    if (!doc) return;
    this.docs = this.docs.filter((d) => d.id !== id);
    rmSync(path.join(this.dir, `${id}.${doc.ext || "bin"}`), { force: true });
    rmSync(path.join(this.dir, `${id}.txt`), { force: true });
    writeJson(this.indexFile, this.docs);
  }
}

async function extract(file: string, ext: string): Promise<string> {
  const data = readFileSync(file);
  if (ext === "pdf") {
    const pdf = await getDocumentProxy(new Uint8Array(data));
    const { text } = await extractText(pdf, { mergePages: true });
    return text.trim();
  }
  if (ext === "docx") {
    throw new Error(`${path.basename(file)}: Word files are not supported yet. Save it as PDF and upload that.`);
  }
  return data.toString("utf8").trim();
}
