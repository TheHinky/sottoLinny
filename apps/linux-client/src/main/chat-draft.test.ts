import { expect, test } from "bun:test";
import { ChatDraft } from "./chat-draft.js";

test("only a fresh matching clipboard can be consumed, once", async () => {
  const draft = new ChatDraft(() => 100);
  draft.ready("hello");
  const delivered: string[] = [];
  await draft.paste(
    () => "hello",
    async (text) => {
      delivered.push(text);
    },
  );
  expect(delivered).toEqual(["hello"]);
  await expect(
    draft.paste(
      () => "hello",
      async () => {},
    ),
  ).rejects.toThrow("No fresh");
});
test("expired, replaced, silent and cancelled takes cannot paste", async () => {
  let now = 0;
  const draft = new ChatDraft(() => now);
  const never = async () => {
    throw new Error("delivery must not run");
  };
  draft.ready("old");
  now = 120001;
  await expect(draft.paste(() => "old", never)).rejects.toThrow("No fresh");
  draft.ready("new");
  await expect(draft.paste(() => "other", never)).rejects.toThrow("Clipboard changed");
  draft.ready("new");
  draft.clear();
  await expect(draft.paste(() => "new", never)).rejects.toThrow("No fresh");
  draft.ready("   ");
  await expect(draft.paste(() => "   ", never)).rejects.toThrow("No fresh");
});
test("failure consumes the draft and concurrent delivery is rejected", async () => {
  const draft = new ChatDraft();
  draft.ready("hello");
  let release!: () => void;
  const pending = draft.paste(
    () => "hello",
    () =>
      new Promise<void>((r) => {
        release = r;
      }),
  );
  await expect(
    draft.paste(
      () => "hello",
      async () => {},
    ),
  ).rejects.toThrow("already running");
  release();
  await pending;
  draft.ready("hello");
  await expect(
    draft.paste(
      () => "hello",
      async () => {
        throw new Error("focus lost");
      },
    ),
  ).rejects.toThrow("focus lost");
  await expect(
    draft.paste(
      () => "hello",
      async () => {},
    ),
  ).rejects.toThrow("No fresh");
});
