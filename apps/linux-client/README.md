# Sotto Linux client

KDE Plasma Wayland prototype. Connects to an independently running Sotto server, captures microphone audio through Chromium, uploads acknowledged PCM chunks, consumes the existing NDJSON generation stream, and copies the finished transcript.

## Implemented

- In-app start, stop, and cancel controls
- Tray icon (KDE system tray); closing the window hides it, **Quit** is in the tray menu
- Global shortcuts through the xdg-desktop-portal GlobalShortcuts D-Bus API (not Electron `globalShortcut`, which registers unnamed per-launch entries): `Meta+Alt+Space` toggles recording, `Meta+Alt+Escape` cancels. KDE asks to confirm them on first launch; change them in System Settings → Shortcuts → Sotto Linux
- Desktop notification with the result when the window is hidden; a **Desktop notifications** checkbox turns them off for this device
- Sandboxed Electron renderer with a CommonJS preload and sender-checked IPC
- Session-scoped cancellation, including delayed creation and in-flight processing
- FIR low-pass filtering and mono 16 kHz resampling in an AudioWorklet
- Optional retained Web Audio PCM when server preferences request original audio
- 4 MiB unacknowledged-audio budget in the worklet and renderer queue
- Stop on upload failure rather than buffering an offline backlog
- Capture limited to 179 seconds or the original-stream byte budget, whichever is smaller
- Explicit final-audio acknowledgement before finishing uploads
- Runtime request/response validation and bounded HTTP/NDJSON reads
- Clipboard delivery from the main process via `wl-copy` (Wayland only lets focused windows set the clipboard, so Electron alone fails while dictating into another app; falls back to Electron without `wl-clipboard`); silence leaves the clipboard unchanged
- HTTP restricted to loopback, literal Tailscale, and private LAN addresses; HTTPS elsewhere

“Original” here means Chromium/Web Audio float32 PCM at the AudioContext rate. It is **not guaranteed untouched hardware audio**. Browser processing/resampling and device selection need real-microphone testing.

## Run

Use the repository's Bun 1.4.2. Keep the existing server running separately.

To run a local server on this Linux machine (one-time build plus ~4 GB of pinned weights, then start/stop):

```sh
./scripts/setup-linux-server.sh
./scripts/run-dev.sh start --skip-build   # starts server + this client; also status, stop, restart
```

```sh
bun install --frozen-lockfile
bun run dev:linux-client
```

The portal identifies the app by `~/.local/share/applications/dev.sotto.Linux.desktop`. `run-dev.sh` installs it; otherwise run `bun run --cwd apps/linux-client install-desktop` once before relying on shortcuts.

To start the server and the client (hidden in the tray) at login, run `bun run --cwd apps/linux-client install-autostart` once; `install-autostart --remove` undoes it. It writes `~/.config/autostart/dev.sotto.Linux.desktop`, which runs `scripts/run-dev.sh start --skip-build` in a login shell, so rebuild after pulling changes. The repo needs Bun 1.4.2 on the login `PATH`.

To serve other machines on the LAN (for example the Windows gaming PC), create `.local/server.env` (git-ignored, `chmod 600`). `run-dev.sh` reads it for `start`, `status` and `stop`, including at login:

```sh
SOTTO_SERVER_HOST=192.168.10.45
SOTTO_SERVER_TOKEN_FILE=/absolute/path/to/.local/server-token
```

Generate the token once with `umask 077; openssl rand -hex 32 > .local/server-token`. Clients then use `http://192.168.10.45:8391` and that token.

The default endpoint is `http://127.0.0.1:8391`. To explicitly request native Wayland:

```sh
bun run build:linux-client
cd apps/linux-client
bun run start -- --ozone-platform=wayland
```

The endpoint and device ID persist in the app profile. The access token is encrypted with the OS keystore (KWallet/libsecret via Electron `safeStorage`) and saved to `token.bin` in the app data directory; the window never reads it back. Without a keystore the token is refused rather than stored in plain text. HTTP is also accepted for private LAN IPs, unencrypted, for trusted home networks. An already connected Tailscale route is an operator responsibility; IP syntax does not prove encrypted routing.

## Verify

```sh
bun run check
bun run test:linux-client
bun run --cwd apps/linux-client smoke
```

The smoke test requires an available Wayland session. It builds the client and launches a separate Electron profile with Chromium's **synthetic microphone**, a temporary server archive and fake inference. It tests the real preload, AudioWorklet, both uploaded streams, completion and cancellation. It intercepts clipboard writes, so the system clipboard is unchanged. No model weights, real microphone, existing server, or personal archive are used. Temporary state lives under the repository's ignored `.local/` and is removed afterward.

The smoke test has passed with `--ozone-platform=wayland`. It does not establish real microphone quality, actual Wayland clipboard interoperability, desktop shortcut support, or every Plasma version's behavior. Test those interactively before treating this as a daily-use app.

Cancellation observes a pending create response so it can cancel a late-created generation. If that response is lost entirely, its ID is unknown; the server's existing receiving-generation expiry remains the recovery mechanism. Cleanup errors are shown rather than treated as successful cancellation.

## Windows (experimental)

The same app runs on Windows for the Le Mans Ultimate dictation workflow; nothing Windows-specific is required on the server. Differences from KDE:

- Shortcuts use Electron `globalShortcut`: `Ctrl+Alt+F9` toggles recording, `Ctrl+Alt+F10` cancels. Override with `SOTTO_TOGGLE_SHORTCUT` / `SOTTO_CANCEL_SHORTCUT` (Electron accelerator syntax). Registration fails silently in the UI (logged to the console) if another app owns the combination.
- The clipboard uses Electron directly; the token is encrypted with DPAPI.
- Device IDs start with `windows-` and the default device name is `Windows PC`.

Requires Bun 1.4.2 and a checkout on the Windows PC: `bun install --frozen-lockfile`, then `bun run dev:linux-client`. Set the server URL (for example `http://192.168.10.45:8391`) and token once. Not yet verified on real Windows hardware. Full setup: [docs/windows-client.md](../../docs/windows-client.md).

## Still to do

- Real-microphone and real clipboard verification on the target KDE desktop
- Persistent XDG preferences
- Microphone selector
- Hold-to-talk (the portal client already receives key-release `Deactivated` signals)
- Sleep/lock handling
- Optional compositor-approved automatic paste
- Generated shared API types, packaging and client-specific CI

A Rust/PipeWire helper is optional and should only be added for demonstrated Chromium or desktop-integration limitations. Portals can be called over D-Bus from Node.
