# Hex comparison (reference only)

[anomalyco/hex](https://github.com/anomalyco/hex) is a local-first voice dictation app written in Rust. We reviewed it on 2026-10-31 (upstream commit dated 2026-10-30). We don't plan to adopt it. This note is here for future reference.

## What Hex is

- One Rust desktop app. Transcription runs on each device.
- Platforms: macOS (Apple silicon, macOS 15+), plus Windows and Linux betas (X11 and wlroots Wayland).
- Speech models: Parakeet (ONNX via `transcribe-rs`), Apple Speech, and GGUF models.
- "Modes": corrections, rules for each app or website, ordered text changes, optional OpenCode rewriting (sent to a cloud provider), and Apple Intelligence.
- Extras: meeting capture, notes, and chapters with an MCP server; history kept 7 days by default; voice commands; vocabulary; toggle shortcut mode; signed auto-updates; Homebrew cask; TypeScript SDK; local `/streams` API.
- Large codebase (about 150 Rust files in `src/`).

## How it compares to Sotto

| | Sotto | Hex |
|---|---|---|
| Design | Swift client plus a Bun/Fastify model server (local or remote) | One app, everything on the device |
| Speech-to-text | Whisper large-v3-turbo on the server | Parakeet / Apple Speech / GGUF on each device |
| Cleanup | Local Qwen3-4B (MLX) on the server | Modes, optional cloud OpenCode |
| Clients without a GPU | Yes, one server serves many clients | No, every machine runs its own model |
| Scope | Focused dictation | Full product with many features |

## Ideas worth revisiting later

- Benchmark Parakeet against Whisper large-v3-turbo as a server speech engine.
- Cleanup rules for each app, chosen by the focused app.
