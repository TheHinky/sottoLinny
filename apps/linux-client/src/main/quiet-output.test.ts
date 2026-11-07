import { describe, expect, test } from "bun:test";
import { QuietOutput } from "./quiet-output.js";

function fakeControl() {
  const log: string[] = [];
  let releaseMute!: () => void;
  const muted = new Promise<void>((resolve) => (releaseMute = resolve));
  const control = {
    pauseMedia: async () => {
      log.push("pause");
      return async () => void log.push("resume");
    },
    muteSpeakers: async () => {
      await muted;
      log.push("mute");
      return async () => void log.push("unmute");
    },
  };
  return { log, control, releaseMute };
}

describe("QuietOutput", () => {
  test("a restore during muting waits, then undoes in reverse order", async () => {
    const { log, control, releaseMute } = fakeControl();
    const output = new QuietOutput(control);
    const silenced = output.silence("take-1");
    const restored = output.restore("take-1");
    releaseMute();
    await Promise.all([silenced, restored]);
    expect(log).toEqual(["pause", "mute", "unmute", "resume"]);
  });

  test("repeated silence applies once and a failed mute still resumes media", async () => {
    const log: string[] = [];
    const output = new QuietOutput({
      pauseMedia: async () => {
        log.push("pause");
        return async () => void log.push("resume");
      },
      muteSpeakers: () => Promise.reject(new Error("wpctl missing")),
    });
    await output.silence("take-1");
    await output.silence("take-1");
    await output.restore("take-1");
    await output.restore("take-1");
    expect(log).toEqual(["pause", "resume"]);
  });

  test("a late restore from an earlier take leaves the current take silenced", async () => {
    const { log, control, releaseMute } = fakeControl();
    releaseMute();
    const output = new QuietOutput(control);
    await output.silence("take-2");
    await output.restore("take-1");
    expect(log).toEqual(["pause", "mute"]);
    await output.restore("take-2");
    expect(log).toEqual(["pause", "mute", "unmute", "resume"]);
  });
});
