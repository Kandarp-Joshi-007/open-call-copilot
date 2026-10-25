import { execFile } from "node:child_process";

// Windows records which apps are using the microphone right now: under this key,
// an app whose LastUsedTimeStop is 0 currently has the mic open. That works for
// Zoom, Teams, Webex and browser calls (Google Meet) alike, with no app hooks.
const MIC_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone";
const POLL_MS = 5000;

const APPS: [RegExp, string][] = [
  [/zoom/i, "Zoom"],
  [/teams/i, "Microsoft Teams"],
  [/webex|ciscospark/i, "Webex"],
  [/slack/i, "Slack"],
  [/discord/i, "Discord"],
  [/skype/i, "Skype"],
  [/whatsapp/i, "WhatsApp"],
  [/chrome\.exe/i, "a browser call (Google Meet?)"],
  [/msedge\.exe/i, "a browser call (Google Meet?)"],
  [/firefox\.exe|brave\.exe/i, "a browser call (Google Meet?)"],
];

/** Calls onStart(appName) when a known meeting app starts using the microphone. */
export class MeetingDetector {
  private timer: NodeJS.Timeout | undefined;
  private inUse = new Set<string>();

  constructor(private onStart: (app: string) => void) {}

  start(): void {
    if (process.platform !== "win32" || this.timer) return;
    this.timer = setInterval(() => void this.poll(), POLL_MS);
    void this.poll(true);
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private async poll(initial = false): Promise<void> {
    const now = await micUsers();
    for (const app of now) {
      // Apps already in a call when Mynah starts do not trigger a prompt.
      if (!this.inUse.has(app) && !initial) this.onStart(app);
    }
    this.inUse = now;
  }
}

function micUsers(): Promise<Set<string>> {
  return new Promise((resolve) => {
    execFile("reg", ["query", MIC_KEY, "/s", "/v", "LastUsedTimeStop"], { windowsHide: true }, (err, stdout) => {
      const users = new Set<string>();
      if (err) return resolve(users);
      let key = "";
      for (const line of stdout.split(/\r?\n/)) {
        if (line.startsWith("HKEY_")) key = line;
        else if (/LastUsedTimeStop\s+REG_QWORD\s+0x0\s*$/.test(line)) {
          if (/electron|mynah/i.test(key)) continue; // our own mic use
          const app = APPS.find(([re]) => re.test(key))?.[1];
          if (app) users.add(app);
        }
      }
      resolve(users);
    });
  });
}
