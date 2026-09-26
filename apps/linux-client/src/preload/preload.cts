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
  appendAudio(sessionID: string, chunk: AudioChunk): Promise<void> {
    return ipcRenderer.invoke("sotto:audio", sessionID, chunk);
  },
  finish(sessionID: string): Promise<RecordingResult> {
    return ipcRenderer.invoke("sotto:finish", sessionID);
  },
  cancel(sessionID: string): Promise<void> {
    return ipcRenderer.invoke("sotto:cancel", sessionID);
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
