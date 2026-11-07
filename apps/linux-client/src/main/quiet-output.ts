import { execFile } from "node:child_process";
import { promisify } from "node:util";
import dbus, { Variant, type MessageBus } from "dbus-next";
import { z } from "zod";

// Keeps the speakers out of the microphone: pauses playing MPRIS media players
// and mutes the default PipeWire sink for the length of a take. Only what this
// module changed is undone (an already muted sink stays muted, already paused
// players stay paused). If the app is killed mid-take nothing restores it.

type Undo = () => Promise<void>;
export interface OutputControl {
  pauseMedia(): Promise<Undo>;
  muteSpeakers(): Promise<Undo>;
}

export class QuietOutput {
  private pending?: { owner: string; undo: Promise<Undo> };
  constructor(private readonly control: OutputControl = systemOutput) {}

  // Idempotent per take. `pending` is set synchronously so a restore that
  // arrives while muting is still running waits for it and then undoes it.
  async silence(owner: string) {
    this.pending ??= { owner, undo: this.apply() };
    await this.pending.undo;
  }
  // Only the take that silenced can restore, so a late cleanup from an earlier
  // take cannot unmute the next one.
  async restore(owner: string) {
    const pending = this.pending;
    if (pending?.owner !== owner) return;
    this.pending = undefined;
    await (
      await pending.undo
    )();
  }
  private async apply(): Promise<Undo> {
    // Pause first so a player does not resume into an unmuted sink, and keep
    // going if one side fails; a missing tool should not stop the recording.
    const resume = await this.control.pauseMedia().catch(failed("pause media"));
    const unmute = await this.control.muteSpeakers().catch(failed("mute speakers"));
    return async () => {
      await unmute().catch(failed("unmute speakers"));
      await resume().catch(failed("resume media"));
    };
  }
}

function failed(action: string) {
  return (error: unknown): Undo => {
    console.warn(`Could not ${action}:`, error instanceof Error ? error.message : error);
    return async () => {};
  };
}

// ---- PipeWire (wpctl) ----
const run = promisify(execFile);
const wpctl = async (...args: string[]) => (await run("wpctl", args, { timeout: 2000 })).stdout;

async function muteSpeakers(): Promise<Undo> {
  // Pin the node ID so a default-device change mid-take unmutes the right sink.
  const id = /^id (\d+),/.exec(await wpctl("inspect", "@DEFAULT_AUDIO_SINK@"))?.[1];
  if (!id) throw new Error("No default audio sink.");
  if ((await wpctl("get-volume", id)).includes("[MUTED]")) return async () => {};
  const unmute = async () => {
    await wpctl("set-mute", id, "0");
  };
  // A timed-out set-mute may still have applied, so always hand back the unmute.
  await wpctl("set-mute", id, "1").catch(failed("mute speakers"));
  return unmute;
}

// A hung player or bus must not hold up the take or its restore.
async function within<T>(work: Promise<T>, ms = 1000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("D-Bus call timed out.")), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// ---- MPRIS media players (D-Bus) ----
// Raw method calls instead of dbus-next proxies: Chromium's player returns an
// empty introspection document, so proxies cannot see its interfaces.
const playerInterface = "org.mpris.MediaPlayer2.Player";
async function call(
  bus: MessageBus,
  destination: string,
  path: string,
  iface: string,
  member: string,
  body: string[] = [],
) {
  const reply = await within(
    bus.call(
      new dbus.Message({
        destination,
        path,
        interface: iface,
        member,
        signature: "s".repeat(body.length),
        body,
      }),
    ),
  );
  return reply?.body ?? [];
}
const playerPath = "/org/mpris/MediaPlayer2";
const playerMethod = (bus: MessageBus, name: string, member: "Pause" | "Play") =>
  call(bus, name, playerPath, playerInterface, member);
async function isPlaying(bus: MessageBus, name: string) {
  const [status] = await call(bus, name, playerPath, "org.freedesktop.DBus.Properties", "Get", [
    playerInterface,
    "PlaybackStatus",
  ]);
  return status instanceof Variant && z.literal("Playing").safeParse(status.value).success;
}

async function withBus<T>(work: (bus: MessageBus) => Promise<T>): Promise<T> {
  const bus = dbus.sessionBus();
  // dbus-next re-emits socket errors; unhandled they crash the main process.
  bus.on("error", (error) => console.warn("Media D-Bus error:", error));
  try {
    return await work(bus);
  } finally {
    bus.disconnect();
  }
}

function pauseMedia(): Promise<Undo> {
  return withBus(async (bus) => {
    const [names] = await call(
      bus,
      "org.freedesktop.DBus",
      "/org/freedesktop/DBus",
      "org.freedesktop.DBus",
      "ListNames",
    );
    const players = z
      .array(z.string())
      .parse(names)
      .filter((name) => name.startsWith("org.mpris.MediaPlayer2."));
    // Each player has its own timeout, so one hung player cannot stop the
    // others from being paused or resumed.
    const paused: string[] = [];
    await Promise.allSettled(
      players.map(async (name) => {
        if (!(await isPlaying(bus, name))) return;
        await playerMethod(bus, name, "Pause");
        paused.push(name);
      }),
    );
    // A player that quit meanwhile just fails its own Play call.
    return () =>
      withBus(async (bus) => {
        await Promise.allSettled(paused.map((name) => playerMethod(bus, name, "Play")));
      });
  });
}

const systemOutput: OutputControl = { pauseMedia, muteSpeakers };
