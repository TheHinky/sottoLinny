import type { AudioChunk, ClientEvent, RecordingResult } from "../shared/types.js";
import { audioChunkSchema } from "../shared/validation.js";
import { SottoServerClient, terminal } from "./server-client.js";

interface StreamState {
  sequence: number;
  frames: number;
  sampleRate?: number;
  channels?: number;
}

/** One owner for a take, including late create replies and cancellation cleanup. */
export class RecordingSession {
  private readonly controller = new AbortController();
  private readonly streams: Record<AudioChunk["kind"], StreamState> = {
    inference: { sequence: 0, frames: 0 },
    original: { sequence: 0, frames: 0 },
  };
  private state: "starting" | "recording" | "finishing" | "completed" | "cancelled" = "starting";
  private generationID?: string;
  private keepOriginalAudio = false;
  private startTask?: Promise<{ keepOriginalAudio: boolean }>;
  private cancelTask?: Promise<void>;
  private uploading = false;

  constructor(
    readonly id: string,
    private readonly client: SottoServerClient,
    private readonly emit: (event: ClientEvent) => void,
    private readonly copy: (text: string) => void,
  ) {}

  start() {
    return (this.startTask ??= this.open());
  }
  private async open() {
    const health = await this.client.health(this.controller.signal);
    this.controller.signal.throwIfAborted();
    if (!health.ready) throw new Error(health.message || "The server is not ready.");
    const generation = await this.client.create(this.id);
    this.generationID = generation.id;
    this.controller.signal.throwIfAborted();
    if (generation.status !== "receiving")
      throw new Error("The server did not open the recording.");
    this.keepOriginalAudio = generation.settings.preferences.keepOriginalAudio;
    this.state = "recording";
    return { keepOriginalAudio: this.keepOriginalAudio };
  }
  async append(value: unknown) {
    this.controller.signal.throwIfAborted();
    if (this.state !== "recording" || !this.generationID)
      throw new Error("No recording is accepting audio.");
    if (this.uploading) throw new Error("Concurrent audio upload rejected.");
    const chunk = audioChunkSchema.parse(value);
    if (chunk.kind === "original" && !this.keepOriginalAudio)
      throw new Error("Original audio retention is disabled.");
    const stream = this.streams[chunk.kind];
    if (
      (stream.sampleRate !== undefined && stream.sampleRate !== chunk.sampleRate) ||
      (stream.channels !== undefined && stream.channels !== chunk.channels)
    )
      throw new Error("Microphone format changed.");
    const frames = stream.frames + chunk.samples.byteLength / (chunk.channels * 4);
    if (frames / chunk.sampleRate > 180 || frames * chunk.channels * 4 > 268435456)
      throw new Error("Recording limit reached.");
    this.uploading = true;
    try {
      const receipt = await this.client.appendAudio(
        this.generationID,
        stream.sequence,
        chunk,
        this.controller.signal,
      );
      this.controller.signal.throwIfAborted();
      if (receipt.nextSequence !== stream.sequence + 1 || receipt.frameCount !== frames)
        throw new Error("Unexpected audio acknowledgement.");
      Object.assign(stream, {
        sequence: receipt.nextSequence,
        frames,
        sampleRate: chunk.sampleRate,
        channels: chunk.channels,
      });
    } finally {
      this.uploading = false;
    }
  }
  async finish(): Promise<RecordingResult> {
    this.controller.signal.throwIfAborted();
    if (this.state !== "recording" || !this.generationID || this.uploading)
      throw new Error("Recording is not ready to finish.");
    if (this.streams.inference.frames < 4000)
      throw new Error("Record for at least a quarter second.");
    this.state = "finishing";
    const id = this.generationID;
    let generation = await this.client.finish(
      id,
      this.streams.inference.frames,
      this.keepOriginalAudio ? this.streams.original.frames : undefined,
      this.controller.signal,
    );
    this.controller.signal.throwIfAborted();
    if (generation.id.toLowerCase() !== id.toLowerCase())
      throw new Error("Unexpected recording response.");
    if (!terminal(generation))
      generation = await this.client.events(
        id,
        (record) => {
          this.emit({ type: "generation", generation: record });
        },
        this.controller.signal,
      );
    this.controller.signal.throwIfAborted();
    if (generation.status !== "completed") throw new Error(generation.error || "Recording failed.");
    // No async gap between the cancellation check and clipboard mutation.
    const transcript = generation.finalText;
    if (transcript) this.copy(transcript);
    this.state = "completed";
    const result: RecordingResult = { transcript, delivery: transcript ? "copied" : "none" };
    // A delivery receipt must not delay the completed result or a later take.
    if (transcript) void this.client.delivery(id, this.controller.signal).catch(() => {});
    return result;
  }
  cancel() {
    if (this.cancelTask) return this.cancelTask;
    this.controller.abort(new Error("Recording cancelled."));
    if (this.state === "completed") return Promise.resolve();
    this.state = "cancelled";
    return (this.cancelTask = (async () => {
      // Creation is deliberately not aborted: recover its ID, then cancel it.
      await this.startTask?.catch(() => {});
      if (this.generationID) await this.client.cancel(this.generationID);
    })());
  }
}
