import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  app,
  BrowserWindow,
  clipboard,
  ipcMain,
  Menu,
  Notification,
  session as electronSession,
  Tray,
  type IpcMainInvokeEvent,
} from "electron";
import { z } from "zod";
import { registerGlobalShortcuts } from "./global-shortcuts.js";
import { configurationSchema, sessionIDSchema } from "../shared/validation.js";
import { RecordingSession } from "./recording-session.js";
import { SottoServerClient } from "./server-client.js";

// ---- App identity ----
// The GlobalShortcuts portal identifies the app by its installed .desktop file
// (`desktopName` in package.json, installed by scripts/install-desktop.ts).
app.setName("Sotto Linux");
const appId = "dev.sotto.Linux";
if (!app.requestSingleInstanceLock()) app.exit(0);

const rendererPath = join(import.meta.dirname, "../renderer/index.html");
const rendererURL = pathToFileURL(rendererPath).href;
const assets = join(import.meta.dirname, "../../assets");
// IDs are stable so KDE keeps user rebinds; triggers use the XDG shortcut syntax.
const shortcuts = [
  { id: "toggle", description: "Start/stop dictation", trigger: "LOGO+ALT+space" },
  { id: "cancel", description: "Cancel dictation", trigger: "LOGO+ALT+Escape" },
];
type ShortcutAction = "toggle" | "cancel";
let unregisterShortcuts: (() => void) | undefined;
let window: BrowserWindow | undefined;
let session: RecordingSession | undefined;
let tray: Tray | undefined;
let quitting = false;
type Phase = "idle" | "recording" | "processing";
let phase: Phase = "idle";

// ---- Tray ----
function setPhase(next: Phase) {
  phase = next;
  tray?.setImage(join(assets, next === "idle" ? "tray-idle.png" : "tray-recording.png"));
  tray?.setToolTip(
    next === "idle" ? "Sotto" : next === "recording" ? "Sotto: recording" : "Sotto: processing",
  );
  updateTrayMenu();
}
function updateTrayMenu() {
  tray?.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Show Sotto", click: showWindow },
      {
        label: phase === "recording" ? "Stop and transcribe" : "Start recording",
        enabled: phase !== "processing",
        click: () => sendShortcut("toggle"),
      },
      { label: "Cancel recording", enabled: phase !== "idle", click: () => sendShortcut("cancel") },
      { type: "separator" },
      { label: "Quit", click: () => app.quit() },
    ]),
  );
}
function createTray() {
  tray = new Tray(join(assets, "tray-idle.png"));
  tray.on("click", showWindow);
  setPhase(phase);
}
function showWindow() {
  if (!window || window.isDestroyed()) return createWindow();
  window.show();
  window.focus();
}
function notify(body: string) {
  // The window already shows the result; only notify when working from the tray.
  if (window?.isVisible() && window.isFocused()) return;
  if (Notification.isSupported()) new Notification({ title: "Sotto", body, silent: true }).show();
}

// ---- Global shortcuts ----
// Recording runs in the renderer (it owns the microphone), so shortcuts are
// forwarded there; the renderer ignores actions that do not fit its state.
function sendShortcut(action: ShortcutAction) {
  if (!window || window.isDestroyed()) return;
  window.webContents.send("sotto:shortcut", action);
}
async function registerShortcuts() {
  try {
    unregisterShortcuts = await registerGlobalShortcuts(appId, shortcuts, {
      activated: (id) => {
        if (id === "toggle" || id === "cancel") sendShortcut(id);
      },
    });
  } catch (error) {
    // The tray and window still work without shortcuts.
    console.warn("Global shortcuts unavailable:", error);
  }
}

function requireSender(event: IpcMainInvokeEvent) {
  if (
    !window ||
    event.sender !== window.webContents ||
    event.senderFrame !== window.webContents.mainFrame ||
    event.senderFrame.url !== rendererURL
  ) {
    throw new Error("Untrusted IPC sender.");
  }
}
function currentSession(id: unknown) {
  const parsed = sessionIDSchema.parse(id);
  if (!session || session.id !== parsed) throw new Error("This recording is no longer active.");
  return session;
}
async function cancelSession(current: RecordingSession) {
  try {
    await current.cancel();
  } finally {
    if (session === current) session = undefined;
    if (!session) setPhase("idle");
  }
}
function createWindow() {
  window = new BrowserWindow({
    width: 520,
    height: 680,
    minWidth: 440,
    minHeight: 560,
    title: "Sotto Linux",
    icon: join(assets, "icon.png"),
    webPreferences: {
      // Keep capture and timers running while the window is hidden in the tray.
      backgroundThrottling: false,
      preload: join(import.meta.dirname, "../preload/preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.removeMenu();
  // Closing hides to the tray; Quit from the tray menu exits.
  window.on("close", (event) => {
    if (quitting || !tray) return;
    event.preventDefault();
    window?.hide();
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  window.webContents.on("render-process-gone", () => {
    if (session) void cancelSession(session).catch(console.error);
  });
  void window.loadFile(rendererPath);
}
ipcMain.handle("sotto:start", async (event, id: unknown, configuration: unknown) => {
  requireSender(event);
  if (session) throw new Error("A recording is already active or being cancelled.");
  const sessionID = sessionIDSchema.parse(id);
  const current = new RecordingSession(
    sessionID,
    new SottoServerClient(configurationSchema.parse(configuration)),
    (value) => {
      if (session === current && !window?.isDestroyed())
        window?.webContents.send("sotto:event", sessionID, value);
    },
    (text) => clipboard.writeText(text),
  );
  session = current;
  setPhase("recording");
  try {
    return await current.start();
  } catch (error) {
    await cancelSession(current).catch(console.error);
    notify(error instanceof Error ? error.message : "Recording failed.");
    throw error;
  }
});
ipcMain.handle("sotto:proofreading", async (event, configuration: unknown, enabled: unknown) => {
  requireSender(event);
  const client = new SottoServerClient(configurationSchema.parse(configuration));
  return enabled === undefined
    ? client.proofreading()
    : client.setProofreading(z.boolean().parse(enabled));
});
ipcMain.handle("sotto:audio", async (event, id: unknown, chunk: unknown) => {
  requireSender(event);
  const current = currentSession(id);
  try {
    await current.append(chunk);
  } catch (error) {
    await cancelSession(current).catch(console.error);
    throw error;
  }
});
ipcMain.handle("sotto:finish", async (event, id: unknown) => {
  requireSender(event);
  const current = currentSession(id);
  setPhase("processing");
  try {
    const result = await current.finish();
    notify(result.delivery === "copied" ? "Copied to clipboard" : "No speech detected.");
    return result;
  } catch (error) {
    await cancelSession(current).catch(console.error);
    notify(error instanceof Error ? error.message : "Transcription failed.");
    throw error;
  } finally {
    if (session === current) session = undefined;
    if (!session) setPhase("idle");
  }
});
ipcMain.handle("sotto:cancel", async (event, id: unknown) => {
  requireSender(event);
  const parsed = sessionIDSchema.parse(id);
  if (session?.id === parsed) await cancelSession(session);
});
app.whenReady().then(() => {
  electronSession.defaultSession.setPermissionCheckHandler(
    (contents, permission, _origin, details) =>
      !!session &&
      contents === window?.webContents &&
      permission === "media" &&
      contents?.getURL() === rendererURL &&
      details.mediaType === "audio",
  );
  electronSession.defaultSession.setPermissionRequestHandler(
    (contents, permission, callback, details) => {
      callback(
        !!session &&
          contents === window?.webContents &&
          contents.getURL() === rendererURL &&
          permission === "media" &&
          "mediaTypes" in details &&
          details.mediaTypes?.length === 1 &&
          details.mediaTypes[0] === "audio",
      );
    },
  );
  createWindow();
  createTray();
  void registerShortcuts();
});
app.on("second-instance", showWindow);
app.on("window-all-closed", () => {
  if (!tray) app.quit();
});
app.on("will-quit", () => unregisterShortcuts?.());
app.on("before-quit", (event) => {
  quitting = true;
  if (!session) return;
  event.preventDefault();
  void cancelSession(session)
    .catch(console.error)
    .finally(() => app.quit());
});
