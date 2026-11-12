// End-to-end test of "Hide Mynah's windows from screen sharing and recording".
// Starts the built app (npm run build first) with a throwaway profile, so your
// real settings, sessions and sign-in are not touched, and drives it like a user.
//
// On Windows it also checks the effect itself: the window is painted a test
// colour and a screen capture is searched for that colour, with the setting
// off and on. Elsewhere the OS ignores the setting, so only the app's wiring
// is checked.
//
// Run: npm run test:e2e
import { _electron as electron } from "playwright-core";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const windows = process.platform === "win32";
const userData = mkdtempSync(path.join(os.tmpdir(), "mynah-e2e-"));
const results = [];

function check(name, ok, detail = "") {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}
const skip = (name, why) => console.log(`SKIP  ${name}  (${why})`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function launch() {
  const electronPath = path.join(root, "node_modules", "electron", "dist", windows ? "electron.exe" : "electron");
  const entry = windows ? "." : path.join(root, "test", "e2e", "harness.cjs");
  return electron.launch({
    executablePath: electronPath,
    cwd: root,
    args: [entry, `--user-data-dir=${userData}`, ...(windows ? [] : ["--no-sandbox", "--password-store=basic"])],
    env: { ...process.env, MYNAH_MAIN: path.join(root, "dist", "main.mjs") },
  });
}

/** Records every setContentProtection call the app makes, with the window's title. */
async function spy(app) {
  await app.evaluate(({ BrowserWindow }) => {
    globalThis.__calls = [];
    const real = BrowserWindow.prototype.setContentProtection;
    BrowserWindow.prototype.setContentProtection = function (on) {
      globalThis.__calls.push([this.getTitle(), on]);
      return real.call(this, on);
    };
  });
}
const takeCalls = (app) => app.evaluate(() => globalThis.__calls.splice(0));

async function setHidden(page, on) {
  await page.click('.nav[data-view="settings"]');
  await page.setChecked("#hide-from-capture", on);
  await page.click("#btn-settings-save");
  await page.waitForFunction(() => document.getElementById("settings-saved").textContent === "Saved.");
}

/**
 * Paints the dashboard solid magenta on top of everything, captures the screen
 * it is on, and returns the share of the window's area that shows up magenta
 * in the capture (about 1 when visible, about 0 when left out).
 */
async function visibleInCapture(app, page) {
  await page.evaluate(() => {
    let el = document.getElementById("__e2e_paint");
    if (!el) {
      el = document.createElement("div");
      el.id = "__e2e_paint";
      el.style.cssText = "position:fixed;inset:0;z-index:2147483647;background:#ff00ff";
      document.body.append(el);
    }
  });
  return app.evaluate(async ({ BrowserWindow, desktopCapturer, screen }) => {
    const win = BrowserWindow.getAllWindows().find((w) => w.getTitle() === "Mynah");
    win.setAlwaysOnTop(true, "screen-saver");
    win.show();
    win.focus();
    // Protection takes effect at the next desktop composition.
    await new Promise((r) => setTimeout(r, 1000));
    const display = screen.getDisplayMatching(win.getBounds());
    const size = { width: Math.round(display.size.width * display.scaleFactor), height: Math.round(display.size.height * display.scaleFactor) };
    const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: size });
    const source = sources.find((s) => s.display_id === String(display.id)) ?? sources[0];
    const img = source.thumbnail;
    const { width, height } = img.getSize();
    const bgra = img.toBitmap();
    let magenta = 0;
    for (let i = 0; i < bgra.length; i += 4) {
      if (bgra[i] > 200 && bgra[i + 1] < 60 && bgra[i + 2] > 200) magenta++;
    }
    const b = win.getContentBounds();
    const scale = width / display.size.width;
    const area = b.width * scale * (b.height * (height / display.size.height));
    win.setAlwaysOnTop(false);
    return magenta / area;
  });
}

async function main() {
  console.log(`Mynah screen-share privacy test on ${process.platform} ${os.release()}\n`);
  let app = await launch();
  let dash = await app.firstWindow();
  await dash.waitForSelector("#btn-create");
  await spy(app);

  await dash.click('.nav[data-view="settings"]');
  check("setting is off by default", !(await dash.isChecked("#hide-from-capture")));
  const note = await dash.textContent("#hide-from-capture-note");
  console.log(`INFO  Settings says: ${note}`);

  if (windows) {
    const share = await visibleInCapture(app, dash);
    check("with the setting off, the window shows in a screen capture", share > 0.5, `${Math.round(share * 100)}% of it captured`);
  }

  await setHidden(dash, true);
  const on = await takeCalls(app);
  check("turning it on protects the dashboard", on.length === 1 && on[0][1] === true, JSON.stringify(on));
  check("the choice is saved", JSON.parse(readFileSync(path.join(userData, "settings.json"), "utf8")).hideFromCapture === true);

  if (windows) {
    check("Windows reports the dashboard as protected", await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isContentProtected()));
    const share = await visibleInCapture(app, dash);
    check("with the setting on, the window is left out of a screen capture", share < 0.02, `${Math.round(share * 100)}% of it captured`);
  } else {
    skip("the window is left out of a screen capture", "only Windows and macOS honour it");
  }
  await dash.evaluate(() => document.getElementById("__e2e_paint")?.remove());

  // Start a session: the live window must be protected from the moment it exists.
  const opened = app.waitForEvent("window");
  await dash.evaluate(async () => {
    const s = await window.mynah.createSession({ company: "E2E Test", position: "", mode: "regular", kind: "real", language: "English", model: "", resumeDocId: "", documentIds: [], instructions: "", saveTranscript: true });
    void window.mynah.startSession(s.id).catch(() => {});
  });
  const live = await opened;
  await live.waitForSelector("#privacy:not([hidden])");
  const liveCalls = await takeCalls(app);
  check("the live window is protected when it opens", liveCalls.length === 1 && liveCalls[0][1] === true, JSON.stringify(liveCalls));
  const pill = await live.textContent("#privacy");
  check("the live window shows its privacy status", windows ? pill === "Private" || pill === "Blacked out" : pill === "Not private", `pill says "${pill}"`);
  if (windows) {
    check("Windows reports the live window as protected", await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.getTitle() === "Mynah - Live").isContentProtected()));
  }

  // Off and on again during the session.
  await setHidden(dash, false);
  const off = await takeCalls(app);
  check("turning it off releases both windows", off.length === 2 && off.every(([, v]) => v === false), JSON.stringify(off));
  await live.waitForSelector("#privacy", { state: "hidden" });
  check("the live window's status disappears", true);
  await setHidden(dash, true);
  await live.waitForSelector("#privacy:not([hidden])");
  check("turning it back on protects both windows", (await takeCalls(app)).filter(([, v]) => v).length === 2);

  // No native message box (which a screen share would show) while hidden.
  await app.evaluate(({ dialog }) => {
    globalThis.__boxes = 0;
    dialog.showMessageBox = async () => (globalThis.__boxes++, { response: 0 });
  });
  await live.evaluate(() => window.mynah.captureFailed("e2e test"));
  await wait(300);
  check("no native message box while hidden", (await app.evaluate(() => globalThis.__boxes)) === 0);
  await app.close();

  app = await launch();
  dash = await app.firstWindow();
  await dash.waitForSelector("#btn-create");
  await dash.click('.nav[data-view="settings"]');
  check("the setting survives a restart", await dash.isChecked("#hide-from-capture"));
  if (windows) {
    check("windows are protected again after a restart", await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every((w) => w.isContentProtected())));
  }
  await app.close();
}

try {
  await main();
} catch (err) {
  console.error(`\nERROR  ${err.stack ?? err}`);
  results.push(false);
} finally {
  rmSync(userData, { recursive: true, force: true });
}
const failed = results.filter((r) => !r).length;
console.log(failed ? `\n${failed} FAILED` : `\nALL ${results.length} PASSED`);
process.exit(failed ? 1 : 0);
