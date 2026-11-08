import { join } from "node:path";
import { BrowserWindow, screen } from "electron";
import type { OverlayPosition } from "../shared/validation.js";

// ---- Status overlay ----
// Small pill: Recording → Processing → a short result flash → hidden. One
// window, created on first use and reused; hidden between takes so it costs no
// rendering. On KDE Wayland apps cannot position windows, so the KWin script in
// assets/kwin-overlay (installed by scripts/install-desktop.ts) places it. The
// window title carries the chosen position for that script:
// "Sotto Status: <position>".
export type OverlayStatus = "recording" | "processing" | "copied" | "no-speech" | "failed";

const pagePath = join(import.meta.dirname, "../renderer/overlay.html");
const width = 168;
const height = 40;
const gap = 4;
const flashMs = 1500;

let window: BrowserWindow | undefined;
let loaded: Promise<void> | undefined;
let hideTimer: NodeJS.Timeout | undefined;
// Latest requested status; a slower show() that finishes after a newer
// show/hide must not override it.
let wanted: OverlayStatus | undefined;
let position: OverlayPosition = "above-taskbar";
const title = () => `Sotto Status: ${position}`;

function ensureWindow() {
  if (window && !window.isDestroyed()) return window;
  window = new BrowserWindow({
    width,
    height,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    title: title(),
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  window.setIgnoreMouseEvents(true);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  // Keep our title; the page's <title> would drop the position.
  window.on("page-title-updated", (event) => event.preventDefault());
  loaded = window.loadFile(pagePath);
  return window;
}

// Honoured on X11 and Windows; Wayland ignores it and KWin places the window.
// Mirrors the positions in assets/kwin-overlay/contents/code/main.js, on the
// display under the cursor.
function place(target: BrowserWindow) {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const usable = display.workArea;
  const full = display.bounds;
  let y = usable.y + usable.height - height - gap;
  if (position === "center") {
    y = usable.y + (usable.height - height) / 2;
  } else if (position === "over-taskbar") {
    const strip = full.y + full.height - (usable.y + usable.height);
    y = full.y + full.height - (strip >= height ? (strip + height) / 2 : height + gap);
  }
  target.setBounds({
    x: Math.round(usable.x + (usable.width - width) / 2),
    y: Math.round(y),
    width,
    height,
  });
}

async function show(status: OverlayStatus) {
  wanted = status;
  const target = ensureWindow();
  await loaded;
  if (target.isDestroyed() || wanted !== status) return;
  // `status` is one of the fixed literals above, never user text.
  await target.webContents.executeJavaScript(
    `document.body.dataset.status = ${JSON.stringify(status)}`,
  );
  if (target.isDestroyed() || wanted !== status) return;
  if (!target.isVisible()) {
    place(target);
    target.showInactive();
  }
}

function hide() {
  clearTimeout(hideTimer);
  hideTimer = undefined;
  wanted = undefined;
  if (window && !window.isDestroyed()) window.hide();
}

// Recording and processing stay up until the phase changes.
export function showStatus(status: "recording" | "processing") {
  clearTimeout(hideTimer);
  hideTimer = undefined;
  void show(status).catch(console.error);
}
// Result states hide themselves after a moment. The timer starts synchronously
// so the idleStatus() call that follows a result does not hide the flash.
export function flashStatus(status: "copied" | "no-speech" | "failed") {
  clearTimeout(hideTimer);
  hideTimer = setTimeout(hide, flashMs);
  void show(status).catch(console.error);
}
// Idle hides immediately unless a result flash is still counting down.
export function idleStatus() {
  if (!hideTimer) hide();
}
// A visible pill moves straight away (KWin watches the title); otherwise the
// position applies on the next show.
export function setOverlayPosition(next: OverlayPosition) {
  position = next;
  if (!window || window.isDestroyed()) return;
  window.setTitle(title());
  if (window.isVisible()) place(window);
}
export function destroyStatusOverlay() {
  hide();
  if (window && !window.isDestroyed()) window.destroy();
}
