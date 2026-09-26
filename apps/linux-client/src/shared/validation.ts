import { z } from "zod";

export const sessionIDSchema = z.string().uuid();
export const configurationSchema = z
  .object({
    endpoint: z.string().min(1).max(4096),
    token: z
      .string()
      .max(4096)
      .refine((value) => !/\s/.test(value), "Token cannot contain whitespace."),
    deviceID: z.string().trim().min(1).max(128),
    deviceName: z.string().trim().min(1).max(128),
  })
  .strict();
export const audioChunkSchema = z
  .object({
    kind: z.enum(["inference", "original"]),
    samples: z
      .instanceof(ArrayBuffer)
      .refine(
        (value) => value.byteLength > 0 && value.byteLength <= 1_048_576,
        "Invalid chunk size.",
      ),
    sampleRate: z.number().int().min(8000).max(192000),
    channels: z.number().int().min(1).max(8),
  })
  .strict()
  .superRefine((chunk, context) => {
    if (
      chunk.samples.byteLength % (chunk.channels * 4) ||
      (chunk.kind === "inference" && (chunk.sampleRate !== 16000 || chunk.channels !== 1))
    ) {
      context.addIssue({ code: "custom", message: "Unsupported PCM format." });
    }
    if (
      chunk.samples.byteLength % 4 === 0 &&
      new Float32Array(chunk.samples).some((sample) => !Number.isFinite(sample))
    ) {
      context.addIssue({ code: "custom", message: "PCM samples must be finite." });
    }
  });
export const healthSchema = z.object({
  ready: z.boolean(),
  message: z.string(),
  serverVersion: z.string(),
});
export const generationSchema = z.object({
  id: z.string().uuid(),
  status: z.enum([
    "receiving",
    "queued",
    "transcribing",
    "proofreading",
    "completed",
    "failed",
    "cancelled",
  ]),
  finalText: z.string(),
  insertionText: z.string(),
  previewText: z.string(),
  error: z.string().optional(),
  settings: z.object({ preferences: z.object({ keepOriginalAudio: z.boolean() }) }),
});
export const receiptSchema = z.object({
  nextSequence: z.number().int().nonnegative(),
  frameCount: z.number().int().nonnegative(),
});
// Only the proofreading flag is interpreted; other shared preferences pass through
// untouched so a toggle never drops fields this client does not know about.
export const preferencesSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    preferences: z.object({ textCorrectionEnabled: z.boolean() }).passthrough(),
  })
  .strict();
export const errorSchema = z.object({ message: z.string() });
