import DOMPurify from "dompurify";
import { marked } from "marked";
import type { MynahApi } from "../shared/types";

declare global {
  interface Window {
    mynah: MynahApi;
    __startCapture?: () => Promise<void>;
  }
}

export const api = window.mynah;

export const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

type Child = Node | string | null | undefined | false;
type Props<K extends keyof HTMLElementTagNameMap> = Partial<Omit<HTMLElementTagNameMap[K], "style">> & {
  class?: string;
  style?: string;
  [handler: `on${string}`]: unknown;
};

/** Tiny element builder: h("button", { class: "primary", onclick }, "Save"). */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props<K> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined) continue;
    if (key === "class") el.className = value as string;
    // Through the CSSOM: the CSP (style-src 'self') blocks style attributes.
    else if (key === "style") el.style.cssText = value as string;
    else if (key.startsWith("on") && typeof value === "function") el.addEventListener(key.slice(2), value as EventListener);
    else (el as any)[key] = value;
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

export function renderMarkdown(el: HTMLElement, text: string): void {
  el.innerHTML = DOMPurify.sanitize(marked.parse(text, { async: false }) as string);
}

/** "12:05" from milliseconds. */
export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/** "11 mins 23 secs" like a call log. */
export function duration(ms: number): string {
  if (!ms) return "—";
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  return m ? `${m} min${m === 1 ? "" : "s"} ${s % 60} secs` : `${s} secs`;
}

export function date(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** ipcRenderer wraps remote errors as "Error invoking remote method 'x': Error: message". */
export function errorText(err: unknown): string {
  return String((err as Error)?.message ?? err).replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, "");
}

export function switchInput(id: string, checked = false): HTMLLabelElement {
  return h("label", { class: "switch" }, h("input", { type: "checkbox", id, checked }), h("i"));
}
