import { contextBridge, ipcRenderer } from "electron";
import type {
  AudioChunk,
  ClientConfiguration,
  ClientEvent,
  RecordingResult,
} from "../shared/types.js";

const api = {
  start(
    sessionID: string,
    configuration: ClientConfiguration,
  ): Promise<{ keepOriginalAudio: boolean }> {
    return ipcRenderer.invoke("sotto:start", sessionID, configuration);
  },
  // Omit `enabled` to read the current server preference.
  proofreading(configuration: ClientConfiguration, enabled?: boolean): Promise<boolean> {
    return ipcRenderer.invoke("sotto:proofreading", configuration, enabled);
  },
  appendAudio(sessionID: string, chunk: AudioChunk): Promise<void> {
    return ipcRenderer.invoke("sotto:audio", sessionID, chunk);
  },
  finish(sessionID: string): Promise<RecordingResult> {
    return ipcRenderer.invoke("sotto:finish", sessionID);
  },
  cancel(sessionID: string): Promise<void> {
    return ipcRenderer.invoke("sotto:cancel", sessionID);
  },
  onShortcut(listener: (action: "toggle" | "cancel") => void) {
    const handler = (_event: Electron.IpcRendererEvent, action: unknown) => {
      if (action === "toggle" || action === "cancel") listener(action);
    };
    ipcRenderer.on("sotto:shortcut", handler);
    return () => ipcRenderer.removeListener("sotto:shortcut", handler);
  },
  onEvent(listener: (sessionID: string, event: ClientEvent) => void) {
    const handler = (_event: Electron.IpcRendererEvent, sessionID: string, value: ClientEvent) =>
      listener(sessionID, value);
    ipcRenderer.on("sotto:event", handler);
    return () => ipcRenderer.removeListener("sotto:event", handler);
  },
};
contextBridge.exposeInMainWorld("sotto", api);
export type SottoDesktopAPI = typeof api;
