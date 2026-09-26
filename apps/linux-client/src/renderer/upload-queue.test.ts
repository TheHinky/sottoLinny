import { expect, test } from "bun:test";
import { UploadQueue } from "./upload-queue.js";

test("slow uploads stay within a byte budget and overflow prevents queued sends", async () => {
  let release!: () => void;
  const pending = new Promise<void>((r) => {
    release = r;
  });
  const sent: number[] = [];
  const queue = new UploadQueue<number>(async (value) => {
    sent.push(value);
    await pending;
  }, 16);
  const first = queue.enqueue(1, 8);
  await Promise.resolve();
  const second = queue.enqueue(2, 8);
  const failed = second.catch((error: Error) => error);
  await expect(queue.enqueue(3, 8)).rejects.toThrow("cannot keep up");
  expect(queue.pendingBytes).toBe(16);
  release();
  await first;
  expect(await failed).toBeInstanceOf(Error);
  await expect(queue.drain()).rejects.toThrow();
  expect(sent).toEqual([1]);
  expect(queue.pendingBytes).toBe(0);
});
test("failed upload stops all subsequent uploads", async () => {
  const sent: number[] = [];
  const queue = new UploadQueue<number>(async (value) => {
    sent.push(value);
    throw new Error("network failed");
  });
  const first = queue.enqueue(1, 4),
    second = queue.enqueue(2, 4);
  await Promise.all([
    expect(first).rejects.toThrow("network failed"),
    expect(second).rejects.toThrow("network failed"),
  ]);
  expect(sent).toEqual([1]);
  expect(queue.pendingBytes).toBe(0);
});
