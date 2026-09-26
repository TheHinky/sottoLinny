import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  app,
  BrowserWindow,
  clipboard,
  ipcMain,
  session as electronSession,
  type IpcMainInvokeEvent,
} from "electron";
import { configurationSchema, sessionIDSchema } from "../shared/validation.js";
import { RecordingSession } from "./recording-session.js";
import { SottoServerClient } from "./server-client.js";

app.setName("Sotto Linux");
const rendererPath = join(import.meta.dirname, "../renderer/index.html");
const rendererURL = pathToFileURL(rendererPath).href;
let window: BrowserWindow | undefined;
let session: RecordingSession | undefined;

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
  }
}
function createWindow() {
  window = new BrowserWindow({
    width: 520,
    height: 680,
    minWidth: 440,
    minHeight: 560,
    title: "Sotto Linux",
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.removeMenu();
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
  try {
    return await current.start();
  } catch (error) {
    await cancelSession(current).catch(console.error);
    throw error;
  }
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
  try {
    return await current.finish();
  } catch (error) {
    await cancelSession(current).catch(console.error);
    throw error;
  } finally {
    if (session === current) session = undefined;
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
});
app.on("window-all-closed", () => app.quit());
app.on("before-quit", (event) => {
  if (!session) return;
  event.preventDefault();
  void cancelSession(session)
    .catch(console.error)
    .finally(() => app.quit());
});
