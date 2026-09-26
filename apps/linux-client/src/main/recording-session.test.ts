import { describe, expect, test } from "bun:test";
import { RecordingSession } from "./recording-session.js";
import { SottoServerClient, readBounded } from "./server-client.js";
import type { AudioChunk, GenerationRecord } from "../shared/types.js";

const id = "00000000-0000-4000-8000-000000000001";
const configuration = {
  endpoint: "http://127.0.0.1:8391",
  token: "",
  deviceID: "test",
  deviceName: "Test",
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const record = (status: GenerationRecord["status"] = "receiving"): GenerationRecord => ({
  id,
  status,
  finalText: "Hello.",
  insertionText: "Hello.",
  previewText: "Hello.",
  settings: { preferences: { keepOriginalAudio: false } },
});
const audio = (): AudioChunk => ({
  kind: "inference",
  samples: new Float32Array(8000).buffer,
  sampleRate: 16000,
  channels: 1,
});
function fixture(
  hooks: {
    create?: () => Promise<Response>;
    finish?: () => Promise<Response>;
    events?: (signal?: AbortSignal | null) => Promise<Response>;
    audio?: () => Promise<Response>;
  } = {},
) {
  const calls: string[] = [],
    copied: string[] = [];
  const transport = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    calls.push(path);
    if (path === "/v1/health")
      return Response.json({ ready: true, message: "Ready", serverVersion: "test" });
    if (path === "/v1/generations") return hooks.create ? hooks.create() : Response.json(record());
    if (path.endsWith("/cancel")) return Response.json(record("cancelled"));
    if (path.includes("/audio/"))
      return hooks.audio ? hooks.audio() : Response.json({ nextSequence: 1, frameCount: 8000 });
    if (path.endsWith("/finish"))
      return hooks.finish ? hooks.finish() : Response.json(record("completed"));
    if (path.endsWith("/events"))
      return hooks.events
        ? hooks.events(init?.signal)
        : new Response(JSON.stringify(record("completed")) + "\n");
    return Response.json(record("completed"));
  }) as typeof fetch;
  const client = new SottoServerClient(configuration, transport);
  const session = new RecordingSession(
    id,
    client,
    () => {},
    (text) => {
      copied.push(text);
    },
  );
  return { session, client, calls, copied };
}

describe("recording ownership", () => {
  test("completes acknowledged audio and copies once", async () => {
    const f = fixture();
    await f.session.start();
    await f.session.append(audio());
    expect(await f.session.finish()).toEqual({ transcript: "Hello.", delivery: "copied" });
    expect(f.copied).toEqual(["Hello."]);
  });
  test("late creation is cancelled without reopening capture", async () => {
    const response = deferred<Response>(),
      entered = deferred<void>();
    const f = fixture({
      create: () => {
        entered.resolve();
        return response.promise;
      },
    });
    const starting = f.session.start();
    const rejection = starting.catch((error: Error) => error);
    await entered.promise;
    const cancelling = f.session.cancel();
    response.resolve(Response.json(record()));
    expect(await rejection).toBeInstanceOf(Error);
    await cancelling;
    expect(f.calls.filter((path) => path.endsWith("/cancel"))).toHaveLength(1);
    expect(f.copied).toHaveLength(0);
  });
  test("too-short finish can still cancel its server generation", async () => {
    const f = fixture();
    await f.session.start();
    await expect(f.session.finish()).rejects.toThrow("quarter second");
    await f.session.cancel();
    expect(f.calls.at(-1)).toBe(`/v1/generations/${id}/cancel`);
  });
  test("cancel during delayed finish suppresses clipboard even if transport returns late", async () => {
    const response = deferred<Response>(),
      entered = deferred<void>();
    const f = fixture({
      finish: () => {
        entered.resolve();
        return response.promise;
      },
    });
    await f.session.start();
    await f.session.append(audio());
    const finishing = f.session.finish();
    const rejection = finishing.catch((error: Error) => error);
    await entered.promise;
    await f.session.cancel();
    response.resolve(Response.json(record("completed")));
    expect(await rejection).toBeInstanceOf(Error);
    expect(f.copied).toHaveLength(0);
  });
  test("cancel interrupts a pending event read without copying", async () => {
    const entered = deferred<void>();
    let aborted = false;
    const f = fixture({
      finish: async () => Response.json(record("transcribing")),
      events: async (signal) =>
        new Response(
          new ReadableStream({
            start(controller) {
              signal?.addEventListener(
                "abort",
                () => {
                  aborted = true;
                  controller.error(signal.reason);
                },
                { once: true },
              );
              entered.resolve();
            },
          }),
        ),
    });
    await f.session.start();
    await f.session.append(audio());
    const finished = f.session.finish().catch((error: Error) => error);
    await entered.promise;
    await f.session.cancel();
    expect(await finished).toBeInstanceOf(Error);
    expect(aborted).toBe(true);
    expect(f.copied).toHaveLength(0);
    expect(f.calls.filter((path) => path.endsWith("/cancel"))).toHaveLength(1);
  });
  test("malformed IPC and concurrent uploads are rejected", async () => {
    const response = deferred<Response>();
    const f = fixture({ audio: () => response.promise });
    await f.session.start();
    await expect(f.session.append({ ...audio(), kind: "invalid" })).rejects.toThrow();
    await expect(f.session.append({ ...audio(), samples: [1, 2, 3] })).rejects.toThrow();
    const first = f.session.append(audio());
    await expect(f.session.append(audio())).rejects.toThrow("Concurrent");
    response.resolve(Response.json({ nextSequence: 1, frameCount: 8000 }));
    await first;
    await f.session.cancel();
  });
  test("silence does not overwrite the clipboard", async () => {
    const f = fixture({
      finish: async () => Response.json({ ...record("completed"), finalText: "", previewText: "" }),
    });
    await f.session.start();
    await f.session.append(audio());
    expect((await f.session.finish()).delivery).toBe("none");
    expect(f.copied).toHaveLength(0);
  });
});

describe("bounded server responses", () => {
  test("cancels an oversized body while reading", async () => {
    let cancelled = false;
    const response = new Response(
      new ReadableStream({
        pull(c) {
          c.enqueue(new Uint8Array(32));
        },
        cancel() {
          cancelled = true;
        },
      }),
    );
    await expect(readBounded(response, 16)).rejects.toThrow("too large");
    expect(cancelled).toBe(true);
  });
  test("processes several valid lines in one large read, then cancels the reader", async () => {
    let cancelled = false;
    const progress = { ...record("transcribing"), rawPadding: "x".repeat(1100000) };
    const bytes = new TextEncoder().encode(
      JSON.stringify(progress) +
        "\n" +
        JSON.stringify(progress) +
        "\n" +
        JSON.stringify(record("completed")) +
        "\n",
    );
    const f = fixture({
      events: async () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(bytes);
            },
            cancel() {
              cancelled = true;
            },
          }),
        ),
    });
    expect((await f.client.events(id, () => {}, new AbortController().signal)).status).toBe(
      "completed",
    );
    expect(cancelled).toBe(true);
  });
  test("rejects mismatched IDs and releases the event stream", async () => {
    const f = fixture({
      events: async () =>
        new Response(
          JSON.stringify({ ...record("completed"), id: "00000000-0000-4000-8000-000000000002" }) +
            "\n",
        ),
    });
    await expect(f.client.events(id, () => {}, new AbortController().signal)).rejects.toThrow(
      "Unexpected recording",
    );
  });
  test("rejects invalid response shapes", async () => {
    const f = fixture({ create: async () => Response.json({ id }) });
    await expect(f.session.start()).rejects.toThrow();
  });
});
