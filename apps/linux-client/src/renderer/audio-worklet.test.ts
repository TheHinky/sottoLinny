import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

interface WorkletMessage {
  type: string;
  kind?: string;
  samples?: ArrayBuffer;
  message?: string;
}
interface Processor {
  frames: number;
  port: { onmessage: (event: { data: unknown }) => void };
  process(inputs: Float32Array[][]): boolean;
}
function processor(rate: number, keepOriginalAudio = false) {
  const messages: WorkletMessage[] = [];
  let instance!: Processor;
  runInNewContext(readFileSync(new URL("./audio-worklet.js", import.meta.url), "utf8"), {
    sampleRate: rate,
    AudioWorkletProcessor: class {
      port = { onmessage: () => {}, postMessage: (value: WorkletMessage) => messages.push(value) };
    },
    registerProcessor: (
      _name: string,
      Constructor: new (options: { processorOptions: { keepOriginalAudio: boolean } }) => Processor,
    ) => {
      instance = new Constructor({ processorOptions: { keepOriginalAudio } });
    },
  });
  return { instance, messages };
}

test("resampling preserves frame counts across render blocks; flush closes admission", () => {
  for (const rate of [16000, 44100, 48000, 96000]) {
    const { instance, messages } = processor(rate);
    for (let i = 0; i < rate; i += 128)
      instance.process([[new Float32Array(Math.min(128, rate - i)).fill(0.2)]]);
    instance.port.onmessage({ data: "flush" });
    const count = messages
      .filter((m) => m.kind === "inference")
      .reduce((sum, m) => sum + m.samples!.byteLength / 4, 0);
    expect(Math.abs(count - 16000)).toBeLessThanOrEqual(1);
    expect(messages.some((m) => m.kind === "original")).toBe(false);
    expect(messages.at(-1)?.type).toBe("flushed");
    const length = messages.length;
    instance.process([[new Float32Array(128)]]);
    expect(messages.length).toBe(length);
  }
});
test("original PCM is retained only when enabled and byte-derived limit seals capture", () => {
  const { instance, messages } = processor(192000, true);
  const maximum = Math.floor(268435456 / 32 - 192000 * 0.1);
  instance.frames = maximum - 64;
  instance.process([Array.from({ length: 8 }, () => new Float32Array(128).fill(0.1))]);
  expect(instance.frames).toBe(maximum);
  expect(messages.at(-1)?.type).toBe("limit");
  expect(messages.find((m) => m.kind === "original")?.samples?.byteLength).toBe(64 * 8 * 4);
});
test("worklet bounds unacknowledged IPC audio even if the renderer cannot drain messages", () => {
  const { instance, messages } = processor(48000, true);
  for (let i = 0; i < 1600; i++)
    instance.process([Array.from({ length: 8 }, () => new Float32Array(128))]);
  const bytes = messages.reduce((sum, m) => sum + (m.samples?.byteLength ?? 0), 0);
  expect(bytes).toBeLessThanOrEqual(4 * 1024 * 1024);
  expect(messages.some((m) => m.type === "error")).toBe(true);
});
