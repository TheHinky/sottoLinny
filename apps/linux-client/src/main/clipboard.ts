import { spawn } from "node:child_process";
import { clipboard } from "electron";

// On Wayland a client may only set the clipboard while it has keyboard focus, so
// Electron's writeText silently does nothing when dictating into another app.
// wl-copy uses the data-control protocol, which works without focus. Fall back to
// Electron when wl-copy is missing, not on Wayland, or SOTTO_ELECTRON_CLIPBOARD=1
// (the smoke test intercepts Electron's clipboard instead of the system one).
export async function copyText(text: string) {
  if (
    process.env.WAYLAND_DISPLAY &&
    process.env.SOTTO_ELECTRON_CLIPBOARD !== "1" &&
    (await wlCopy(text))
  )
    return;
  clipboard.writeText(text);
}

function wlCopy(text: string) {
  return new Promise<boolean>((resolve) => {
    // wl-copy forks to serve the selection and exits once the copy is set.
    const child = spawn("wl-copy", ["--type", "text/plain;charset=utf-8"], {
      stdio: ["pipe", "ignore", "ignore"],
    });
    const timer = setTimeout(() => {
      child.kill();
      resolve(false);
    }, 3000);
    child.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
    child.stdin.end(text);
  });
}
