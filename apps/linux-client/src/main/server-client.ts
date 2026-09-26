import type { z } from "zod";
import type { ClientConfiguration, GenerationRecord, AudioChunk } from "../shared/types.js";
import {
  errorSchema,
  generationSchema,
  healthSchema,
  preferencesSchema,
  receiptSchema,
} from "../shared/validation.js";
import { normalizeServerEndpoint } from "./endpoint.js";

const maximumResponseBytes = 2 * 1024 * 1024;
export const terminal = (record: GenerationRecord) =>
  ["completed", "failed", "cancelled"].includes(record.status);

export async function readBounded(response: Response, limit: number) {
  if (!response.body) throw new Error("The server returned an empty response.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error("The server response was too large.");
      chunks.push(value);
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export class SottoServerClient {
  private readonly endpoint: URL;
  constructor(
    private readonly configuration: ClientConfiguration,
    private readonly transport: typeof fetch = fetch,
  ) {
    this.endpoint = normalizeServerEndpoint(configuration.endpoint);
  }
  health(signal?: AbortSignal) {
    return this.json("v1/health", healthSchema, {}, signal);
  }
  // Read-modify-write with the server's revision check, so a concurrent edit from
  // another client fails with 409 instead of being overwritten.
  async setProofreading(enabled: boolean) {
    const snapshot = await this.json("v1/preferences", preferencesSchema);
    snapshot.preferences.textCorrectionEnabled = enabled;
    const updated = await this.json("v1/preferences", preferencesSchema, {
      method: "PUT",
      body: JSON.stringify(snapshot),
    });
    return updated.preferences.textCorrectionEnabled;
  }
  async proofreading() {
    return (await this.json("v1/preferences", preferencesSchema)).preferences.textCorrectionEnabled;
  }
  create(requestID: string) {
    // Once creation is sent, observe its response even if the take is cancelled,
    // so the session can explicitly cancel a late-created generation.
    return this.json("v1/generations", generationSchema, {
      method: "POST",
      body: JSON.stringify({
        requestID,
        device: { id: this.configuration.deviceID, name: this.configuration.deviceName },
        mode: "dictation",
      }),
    });
  }
  appendAudio(id: string, sequence: number, chunk: AudioChunk, signal: AbortSignal) {
    return this.json(
      `v1/generations/${id}/audio/${chunk.kind}?sequence=${sequence}&sampleRate=${chunk.sampleRate}&channels=${chunk.channels}`,
      receiptSchema,
      {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: chunk.samples,
      },
      signal,
    );
  }
  finish(
    id: string,
    inferenceFrames: number,
    originalFrames: number | undefined,
    signal: AbortSignal,
  ) {
    return this.json(
      `v1/generations/${id}/finish`,
      generationSchema,
      { method: "POST", body: JSON.stringify({ inferenceFrames, originalFrames }) },
      signal,
    );
  }
  async cancel(id: string) {
    await this.json(`v1/generations/${id}/cancel`, generationSchema, { method: "POST" });
  }
  async delivery(id: string, signal: AbortSignal) {
    await this.json(
      `v1/generations/${id}/delivery`,
      generationSchema,
      {
        method: "POST",
        body: JSON.stringify({
          status: "copied",
          message: "Copied to the clipboard by the Linux client.",
        }),
      },
      signal,
    );
  }
  async events(id: string, onRecord: (record: GenerationRecord) => void, signal: AbortSignal) {
    // Bound each stalled read rather than timing out a healthy, heartbeat-driven stream.
    const controller = new AbortController();
    let timer = setTimeout(
      () => controller.abort(new Error("Server event stream stalled.")),
      15000,
    );
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await this.request(
        `v1/generations/${id}/events`,
        { headers: { Accept: "application/x-ndjson" } },
        AbortSignal.any([signal, controller.signal]),
        false,
      );
      if (!response.body) throw new Error("The server closed the event stream.");
      reader = response.body.getReader();
      let pending = Buffer.alloc(0);
      while (true) {
        const { done, value } = await reader.read();
        clearTimeout(timer);
        timer = setTimeout(
          () => controller.abort(new Error("Server event stream stalled.")),
          15000,
        );
        if (done)
          throw new Error("The server disconnected. Completed results remain in server history.");
        let offset = 0;
        while (offset < value.length) {
          const newline = value.indexOf(10, offset);
          const end = newline < 0 ? value.length : newline;
          if (pending.length + end - offset > maximumResponseBytes)
            throw new Error("A server event exceeded its size limit.");
          pending = Buffer.concat([pending, value.subarray(offset, end)]);
          if (newline < 0) break;
          if (pending.length) {
            const record = generationSchema.parse(
              JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(pending)),
            );
            if (record.id.toLowerCase() !== id.toLowerCase())
              throw new Error("Unexpected recording in event stream.");
            signal.throwIfAborted();
            onRecord(record);
            if (terminal(record)) return record;
          }
          pending = Buffer.alloc(0);
          offset = newline + 1;
        }
      }
    } finally {
      clearTimeout(timer);
      controller.abort();
      await reader?.cancel().catch(() => {});
      reader?.releaseLock();
    }
  }
  private async json<T>(
    path: string,
    schema: z.ZodType<T>,
    init: RequestInit = {},
    signal?: AbortSignal,
  ) {
    const response = await this.request(path, init, signal);
    return schema.parse(JSON.parse(await readBounded(response, maximumResponseBytes)));
  }
  private async request(path: string, init: RequestInit, signal?: AbortSignal, timeout = true) {
    const headers = new Headers(init.headers);
    if (!headers.has("Content-Type") && init.body !== undefined)
      headers.set("Content-Type", "application/json");
    if (this.configuration.token)
      headers.set("Authorization", `Bearer ${this.configuration.token}`);
    const signals = [...(signal ? [signal] : []), ...(timeout ? [AbortSignal.timeout(12000)] : [])];
    const response = await this.transport(new URL(path, this.endpoint), {
      ...init,
      headers,
      redirect: "error",
      signal: signals.length ? AbortSignal.any(signals) : undefined,
    });
    if (!response.ok) {
      let message = `The server rejected the request with HTTP ${response.status}.`;
      try {
        message = errorSchema
          .parse(JSON.parse(await readBounded(response, 16384)))
          .message.slice(0, 1000);
      } catch {
        /* Preserve a bounded error if the server returned invalid content. */
      }
      throw new Error(message);
    }
    return response;
  }
}
