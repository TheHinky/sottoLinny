import { expect, test } from "bun:test";
import { isChatTextSupported } from "./windows-chat.js";

test("typed chat accepts spaces, punctuation, capitals and bounded messages", () => {
  expect(isChatTextSupported("Hello! I'm pitting, car #42. Thanks :)")).toBe(true);
  expect(isChatTextSupported("a".repeat(240))).toBe(true);
});
test("typed chat rejects control keys, unsupported text and overlong messages", () => {
  for (const text of [
    "",
    "   ",
    "hello\nworld",
    "hi\r",
    "hi\t",
    "hi\u001b",
    "café",
    "a".repeat(241),
  ])
    expect(isChatTextSupported(text)).toBe(false);
});
