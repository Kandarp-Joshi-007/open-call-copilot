// Keeping Mynah's windows out of a screen share. On Windows,
// BrowserWindow.setContentProtection asks the OS to leave a window out of
// screen capture (SetWindowDisplayAffinity with WDA_EXCLUDEFROMCAPTURE).
// It is a best-effort OS feature, not a guarantee: the taskbar button,
// Alt+Tab and Task Manager still show the app, and Microsoft does not promise
// that every capture tool honours it.

/** What a viewer of the shared screen sees where a protected window is. */
export type CaptureProtection =
  /** Nothing: the desktop behind the window is shown. */
  | "hidden"
  /** A black rectangle (Windows before 10 version 2004, build 19041). */
  | "blacked-out"
  /** Not known to work on this system. */
  | "unsupported";

/** release: os.release(), e.g. "10.0.19045". */
export function captureProtection(platform: string, release: string): CaptureProtection {
  if (platform !== "win32") return "unsupported";
  const [major, , build] = release.split(".").map(Number);
  if (major > 10 || (major === 10 && build >= 19041)) return "hidden";
  return "blacked-out";
}
