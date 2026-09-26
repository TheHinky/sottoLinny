import type { AudioChunk, ClientConfiguration } from "../shared/types.js";
import { UploadQueue } from "./upload-queue.js";

function input(id: string) {
  const value = document.getElementById(id);
  if (!(value instanceof HTMLInputElement)) throw new Error(id);
  return value;
}
function button(id: string) {
  const value = document.getElementById(id);
  if (!(value instanceof HTMLButtonElement)) throw new Error(id);
  return value;
}
function element(id: string) {
  const value = document.getElementById(id);
  if (!value) throw new Error(id);
  return value;
}
const endpoint = input("endpoint"),
  token = input("token"),
  deviceName = input("device-name");
const startButton = button("start"),
  stopButton = button("stop"),
  cancelButton = button("cancel");
const status = element("status"),
  transcript = element("transcript");
interface Take {
  id: string;
  cancelled: boolean;
  phase: "starting" | "recording" | "finishing";
  queue: UploadQueue<AudioChunk>;
  stream?: MediaStream;
  context?: AudioContext;
  source?: MediaStreamAudioSourceNode;
  worklet?: AudioWorkletNode;
  cleanup?: Promise<void>;
  cancelTask?: Promise<void>;
  timer?: number;
}
let active: Take | undefined;
function controls() {
  startButton.disabled = !!active;
  stopButton.disabled = active?.phase !== "recording" || active.cancelled;
  cancelButton.disabled = !active || active.cancelled;
  endpoint.disabled = token.disabled = deviceName.disabled = !!active;
}
function configuration(): ClientConfiguration {
  const deviceID = localStorage.getItem("sotto.device-id") || `linux-${crypto.randomUUID()}`;
  localStorage.setItem("sotto.device-id", deviceID);
  const configuration = {
    endpoint: endpoint.value.trim(),
    token: token.value,
    deviceID,
    deviceName: deviceName.value.trim() || "KDE desktop",
  };
  token.value = ""; // This prototype does not persist credentials.
  return configuration;
}
function message(error: unknown) {
  return error instanceof Error ? error.message : "The operation failed.";
}
function requireActive(take: Take) {
  if (active !== take || take.cancelled) throw new Error("Recording cancelled.");
}
function releaseHardware(take: Take) {
  return (take.cleanup ??= (async () => {
    clearTimeout(take.timer);
    take.source?.disconnect();
    take.worklet?.disconnect();
    take.stream?.getTracks().forEach((track) => track.stop());
    if (take.context && take.context.state !== "closed") await take.context.close();
  })());
}
function cancel(take: Take, reason = "Cancelled") {
  if (take.cancelTask) return take.cancelTask;
  take.cancelled = true;
  take.queue.cancel();
  controls();
  return (take.cancelTask = (async () => {
    try {
      try {
        await releaseHardware(take);
      } finally {
        await window.sotto.cancel(take.id);
      }
    } catch (error) {
      reason += ` ${message(error)} Server cleanup may still be pending.`;
    } finally {
      if (active === take) {
        active = undefined;
        status.textContent = reason;
        controls();
      }
    }
  })());
}
async function openMicrophone(take: Take, keepOriginalAudio: boolean) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { autoGainControl: false, echoCancellation: false, noiseSuppression: false },
    video: false,
  });
  if (active !== take || take.cancelled) {
    stream.getTracks().forEach((track) => track.stop());
    throw new Error("Recording cancelled.");
  }
  take.stream = stream;
  const context = new AudioContext();
  take.context = context;
  if (context.sampleRate < 8000 || context.sampleRate > 192000)
    throw new Error("Unsupported microphone sample rate.");
  await context.audioWorklet.addModule("./audio-worklet.js");
  requireActive(take);
  const worklet = new AudioWorkletNode(context, "sotto-capture", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    channelCountMode: "max",
    processorOptions: { keepOriginalAudio },
  });
  take.worklet = worklet;
  worklet.onprocessorerror = () => {
    void cancel(take, "Microphone processing failed.");
  };
  worklet.port.onmessage = (event: MessageEvent) => {
    if (active !== take || take.cancelled) return;
    const value = event.data;
    if (value.type === "error") {
      void cancel(take, String(value.message));
      return;
    }
    if (value.type === "limit") {
      void finish(take);
      return;
    }
    if (value.type !== "chunk") return;
    const chunk: AudioChunk = {
      kind: value.kind,
      samples: value.samples,
      sampleRate: value.sampleRate,
      channels: value.channels,
    };
    void take.queue
      .enqueue(chunk, chunk.samples.byteLength)
      .then(() => {
        worklet.port.postMessage({ type: "ack", bytes: chunk.samples.byteLength });
      })
      .catch((error: unknown) => {
        if (!take.cancelled) void cancel(take, message(error));
      });
  };
  take.source = context.createMediaStreamSource(stream);
  take.source.connect(worklet);
  // The processor emits silence; connecting the graph keeps capture scheduled.
  worklet.connect(context.destination);
  stream.getTracks().forEach((track) =>
    track.addEventListener("ended", () => {
      if (take.phase === "recording") void cancel(take, "Microphone disconnected.");
    }),
  );
  await context.resume();
  requireActive(take);
  take.phase = "recording";
  take.timer = window.setTimeout(() => {
    void finish(take);
  }, 179000);
  status.textContent = "Listening";
  controls();
}
async function flush(take: Take) {
  const worklet = take.worklet;
  if (!worklet) throw new Error("The microphone did not start.");
  await new Promise<void>((resolve, reject) => {
    const clean = () => {
      clearTimeout(timer);
      worklet.port.removeEventListener("message", listener);
    };
    const listener = (event: MessageEvent) => {
      if (event.data?.type === "flushed") {
        clean();
        resolve();
      }
    };
    const timer = window.setTimeout(() => {
      clean();
      reject(new Error("Microphone did not acknowledge its final audio."));
    }, 2000);
    worklet.port.addEventListener("message", listener);
    worklet.port.postMessage("flush");
  });
}
async function finish(take: Take) {
  if (active !== take || take.cancelled || take.phase !== "recording") return;
  take.phase = "finishing";
  controls();
  status.textContent = "Finishing upload";
  try {
    await flush(take);
    await releaseHardware(take);
    await take.queue.drain();
    requireActive(take);
    const result = await window.sotto.finish(take.id);
    requireActive(take);
    transcript.textContent = result.transcript || "No speech detected.";
    status.textContent =
      result.delivery === "copied"
        ? "Copied to clipboard"
        : "No speech detected. Clipboard unchanged.";
    active = undefined;
    controls();
  } catch (error) {
    if (!take.cancelled) await cancel(take, message(error));
  }
}
startButton.addEventListener("click", async () => {
  if (active) return;
  const id = crypto.randomUUID();
  const take: Take = {
    id,
    cancelled: false,
    phase: "starting",
    queue: new UploadQueue((chunk) => window.sotto.appendAudio(id, chunk)),
  };
  active = take;
  controls();
  transcript.textContent = "";
  status.textContent = "Connecting to the server";
  try {
    const started = await window.sotto.start(id, configuration());
    requireActive(take);
    await openMicrophone(take, started.keepOriginalAudio);
  } catch (error) {
    if (!take.cancelled) await cancel(take, message(error));
  }
});
stopButton.addEventListener("click", () => {
  if (active) void finish(active);
});
cancelButton.addEventListener("click", () => {
  if (active) void cancel(active);
});
window.sotto.onEvent((id, event) => {
  if (active?.id !== id || active.cancelled) return;
  if (event.type === "status") status.textContent = event.message;
  if (event.type === "generation")
    status.textContent = event.generation.error || event.generation.status;
  if (event.type === "failed") status.textContent = event.message;
});
controls();
