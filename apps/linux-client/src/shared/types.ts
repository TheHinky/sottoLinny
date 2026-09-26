export interface ServerHealth {
  ready: boolean;
  message: string;
  serverVersion: string;
}

export type GenerationStatus =
  "receiving" | "queued" | "transcribing" | "proofreading" | "completed" | "failed" | "cancelled";

export interface GenerationRecord {
  id: string;
  status: GenerationStatus;
  finalText: string;
  insertionText: string;
  previewText: string;
  error?: string;
  settings: {
    preferences: {
      keepOriginalAudio: boolean;
    };
  };
}

export interface ClientConfiguration {
  endpoint: string;
  token: string;
  deviceID: string;
  deviceName: string;
}

export interface AudioChunk {
  kind: "inference" | "original";
  samples: ArrayBuffer;
  sampleRate: number;
  channels: number;
}

export interface RecordingResult {
  transcript: string;
  delivery: "copied" | "none";
}

export type ClientEvent =
  | { type: "status"; message: string }
  | { type: "generation"; generation: GenerationRecord }
  | { type: "completed"; result: RecordingResult }
  | { type: "failed"; message: string };
