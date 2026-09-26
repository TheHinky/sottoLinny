import { expect, test } from "bun:test";
import { SottoServerClient } from "./server-client.js";

const configuration = {
  endpoint: "http://127.0.0.1:8391",
  token: "",
  deviceID: "linux-test",
  deviceName: "Test",
};

test("proofreading toggle preserves other preferences and the revision", async () => {
  const stored = {
    revision: 4,
    preferences: { language: "de", vocabulary: "x", textCorrectionEnabled: false },
  };
  let sent: unknown;
  const transport = (async (_input: URL | RequestInfo, init?: RequestInit) => {
    if (init?.method === "PUT") {
      sent = JSON.parse(String(init.body));
      return Response.json({ ...(sent as object), revision: 5 });
    }
    return Response.json(stored);
  }) as typeof fetch;
  const client = new SottoServerClient(configuration, transport);
  expect(await client.setProofreading(true)).toBe(true);
  expect(sent).toEqual({
    revision: 4,
    preferences: { language: "de", vocabulary: "x", textCorrectionEnabled: true },
  });
});
