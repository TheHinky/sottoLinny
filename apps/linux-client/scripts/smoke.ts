import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { _electron as electron, type ElectronApplication } from "playwright-core";
import { GenerationService } from "../../../Server/src/generation-service.ts";
import { createHTTPServer } from "../../../Server/src/http-server.ts";
import { FakeInference } from "../../../Server/tests/support.ts";

class DelayedInference extends FakeInference {
  override async transcribe(...args: Parameters<FakeInference["transcribe"]>) {
    // Longer than the client's idle timeout; the real server's 2s heartbeats
    // must keep the stream alive while inference itself emits no progress.
    await Bun.sleep(16000);
    return super.transcribe(...args);
  }
}

// Isolated server, fake Chromium microphone, temporary profile, intercepted clipboard.
const root = resolve(import.meta.dirname, "../../..");
await mkdir(resolve(root, ".local"), { recursive: true });
const directory = await mkdtemp(resolve(root, ".local/client-smoke-"));
const service = await GenerationService.open(
  { dataDirectory: resolve(directory, "server"), development: true },
  new DelayedInference(),
);
service.start();
const server = createHTTPServer(service);
const address = await server.listen({ host: "127.0.0.1", port: 0 });
let application: ElectronApplication | undefined;
try {
  application = await electron.launch({
    executablePath: resolve(import.meta.dirname, "../node_modules/electron/dist/electron"),
    args: [
      resolve(import.meta.dirname, ".."),
      "--ozone-platform=wayland",
      `--user-data-dir=${resolve(directory, "profile")}`,
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
    ],
    timeout: 20000,
  });
  await application.evaluate(({ clipboard }) => {
    clipboard.writeText = (text: string) => {
      (globalThis as typeof globalThis & { smokeClipboard?: string }).smokeClipboard = text;
    };
  });
  const sandboxed = await application.evaluate(({ BrowserWindow }) => {
    const preferences = BrowserWindow.getAllWindows()[0]?.webContents.getLastWebPreferences();
    return (
      preferences?.sandbox === true &&
      preferences.contextIsolation === true &&
      preferences.nodeIntegration === false
    );
  });
  if (!sandboxed) throw new Error("Desktop security settings were not applied.");
  const page = await application.firstWindow();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.waitForFunction(() => typeof window.sotto?.start === "function");
  await page.locator("#endpoint").fill(address);
  await page.locator("#start").click();
  await page.waitForFunction(
    () => document.querySelector("#status")?.textContent === "Listening",
    undefined,
    {
      timeout: 15000,
    },
  );
  // Wait for acknowledged audio, not an arbitrary UI delay.
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const records = await service.history();
    if (
      records.items.length &&
      Date.parse(records.items[0]!.updatedAt) > Date.parse(records.items[0]!.createdAt)
    )
      break;
    await Bun.sleep(250);
  }
  await page.locator("#stop").click();
  await page.waitForFunction(
    () => document.querySelector("#status")?.textContent === "Copied to clipboard",
    undefined,
    { timeout: 25000 },
  );
  const history = await service.history();
  const completed = history.items.find((record) => record.status === "completed");
  if (!completed?.inferenceAudio || !completed.originalAudio)
    throw new Error("Both PCM streams must be sealed.");
  const copied = await application.evaluate(
    () => (globalThis as typeof globalThis & { smokeClipboard?: string }).smokeClipboard,
  );
  if (copied !== "Hello world.") throw new Error(`Unexpected transcript: ${copied}`);
  await page.locator("#start").click();
  await page.waitForFunction(() => document.querySelector("#status")?.textContent === "Listening");
  await page.locator("#cancel").click();
  await page.waitForFunction(() => document.querySelector("#status")?.textContent === "Cancelled");
  if ((await service.history()).items.some((record) => record.status === "receiving"))
    throw new Error("Cancel orphaned a generation.");
  if (errors.length) throw new Error(errors.join("\n"));
  console.log(
    JSON.stringify(
      {
        preload: "loaded",
        sandbox: sandboxed,
        heartbeatDuringSlowInference: "passed",
        requestedDisplayBackend: "wayland",
        syntheticCapture: "passed",
        inferenceFrames: completed.inferenceAudio.frameCount,
        originalFrames: completed.originalAudio.frameCount,
        transcript: copied,
        cancellation: "passed",
        clipboard: "intercepted; system clipboard untouched",
      },
      null,
      2,
    ),
  );
} finally {
  await application?.close();
  await service.shutdown();
  await server.close();
  await rm(directory, { recursive: true, force: true });
}
