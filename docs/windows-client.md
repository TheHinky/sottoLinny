# Windows client setup

How to run the Sotto desktop client on the Windows gaming PC against the Sotto server on `gmk`. The PC only captures the microphone, talks to the server and copies the result. No speech or cleanup model runs on Windows.

Status: the shared Electron client (`apps/linux-client`) has Windows code paths but has **not yet been verified on real Windows hardware**. LMU chat delivery, spoken read-back, send confirmation and the wheel trigger are not built yet.

## How it fits together

```text
Windows PC (gaming)                         gmk (Fedora, 192.168.10.45)
-------------------                         ---------------------------
Sotto client (Electron)   -- HTTP + token -->  sotto-server :8391
  mic capture, hotkeys,                          Whisper large-v3-turbo
  clipboard                <-- transcript ---    Qwen3 4B (shared toggle)
```

Traffic is plain HTTP on the home LAN. The token and audio are not encrypted in transit. That is an accepted trade-off for a trusted home network. Use Tailscale or HTTPS if that changes.

## 1. Server side (gmk), already done

- The server listens on `192.168.10.45:8391` and requires a bearer token.
- Settings live in `.local/server.env` (git-ignored, `chmod 600`). `scripts/run-dev.sh` reads it for `start`, `status`, `stop` and login autostart:

  ```sh
  SOTTO_SERVER_HOST=192.168.10.45
  SOTTO_SERVER_TOKEN_FILE=/home/gaydn/dev/sottoLinny/.local/server-token
  ```

- Token file: `/home/gaydn/dev/sottoLinny/.local/server-token`. Copy it without printing: `wl-copy < ~/dev/sottoLinny/.local/server-token`.
- Firewalld's `FedoraWorkstation` zone already allows TCP 1025–65535 on `eno1`. No firewall change was made.
- Recommended: a DHCP reservation for `192.168.10.45` on the router. If gmk's IP changes, the server fails to start.

Check from gmk:

```sh
./scripts/run-dev.sh status
```

## 2. Windows prerequisites

Install these with approval:

| Software | Why |
| --- | --- |
| Git | Clone the repository |
| Bun 1.4.2 | Install dependencies and build/run the client (`powershell -c "irm bun.sh/install.ps1 \| iex"`, then pin 1.4.2) |

`bun install` also downloads Electron (about 100 MB) into the checkout. No drivers, services or game hooks are installed.

Also confirm:

- A working microphone is selected as the Windows default input device. The client uses the system default; there is no microphone selector yet.
- Windows **Settings → Privacy & security → Microphone** allows desktop apps to use the microphone.
- The PC can reach gmk: `curl.exe http://192.168.10.45:8391/v1/health` returns JSON with `"ready":true`.

## 3. Get the code

The Windows PC clones from the remote, so local commits on gmk must be pushed first.

```powershell
git clone <repo-url> sottoLinny
cd sottoLinny
bun install --frozen-lockfile
bun run dev:linux-client
```

`dev:linux-client` builds and starts the client. Later runs can use `bun run --cwd apps/linux-client start`.

## 4. First-run configuration

In the client window:

1. **Server URL:** `http://192.168.10.45:8391`. Remembered on this device.
2. **Access token:** paste the token, then click away. It is encrypted with Windows DPAPI (`safeStorage`) and saved to `token.bin` in the app data folder. The field then shows "Saved".
3. **Device name:** defaults to `Windows PC`. Server history uses it to show which machine a take came from.
4. **Desktop notifications:** untick to stop popups while racing. Sound cues still play.
5. **Proofread with Qwen:** a **shared** server setting that affects every client. Currently off. Leave it unless you want it changed everywhere.

If the Proofread toggle loads without an error, the network and token work.

## 5. Shortcuts

| Action | Default | Override (environment variable) |
| --- | --- | --- |
| Start / stop recording (toggle) | `Ctrl+Alt+F9` | `SOTTO_TOGGLE_SHORTCUT` |
| Cancel | `Ctrl+Alt+F10` | `SOTTO_CANCEL_SHORTCUT` |

Values use Electron accelerator syntax, for example `Control+Alt+F8`. If another app (SimHub, SimPro Manager, LMU) already owns the combination, registration fails and only a console warning is logged. Pick another combination in that case.

Example override for one session:

```powershell
$env:SOTTO_TOGGLE_SHORTCUT = "Control+Alt+F8"
bun run --cwd apps/linux-client start
```

## 6. Stage 2 verification checklist

Run with the car parked or LMU closed. Do not change any wheel or LMU bindings.

- [ ] Client connects; Proofread toggle loads.
- [ ] `Ctrl+Alt+F9`, speak, `Ctrl+Alt+F9` again: start/stop cues play and the transcript appears and is on the clipboard.
- [ ] `Ctrl+Alt+F10` during a recording cancels it with the cancel cue. Nothing is copied.
- [ ] Take appears in history on gmk tagged `Windows PC`.
- [ ] With LMU in the foreground (parked), the toggle hotkey still fires.
- [ ] Stopping the server mid-recording shows an error and leaves the client idle. Nothing is pasted later.
- [ ] Task Manager shows no GPU or inference load from the client beyond normal Electron use.

## Not built yet

These are later stages and each needs approval before testing in LMU:

- Stage 3: open LMU chat, insert a fixed test message and submit it, while parked.
- Stage 4: spoken read-back with a Windows system voice, explicit confirm/cancel, focus check that LMU is foreground, clipboard restore, timeout that discards unsent text.
- Stage 5: wheel-button trigger (SimHub keystroke mapping or direct controller input). Avoid GT4 B02, B00 and B07, which showed repeated transitions. B06 is a candidate.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| `Use HTTPS, localhost, or a literal Tailscale or private LAN IP address.` | Old build or a typo in the URL. Rebuild and use the IP, not a hostname. |
| `Connect with the server's access token.` | Token missing or wrong. Paste it again. |
| `Sotto server not reachable at ...` | Server stopped, IP changed, or the PC is on a different network. Run `run-dev.sh status` on gmk. |
| `No secure keystore available; the token cannot be saved.` | `safeStorage` unavailable. Unexpected on Windows; report it. |
| Hotkey does nothing | Combination owned by another app. Set a different `SOTTO_TOGGLE_SHORTCUT`. |
| Recording starts but no audio | Wrong default input device or microphone privacy setting. |

## Credentials

- Never commit the token or paste it into chat, logs or screenshots.
- Rotating it: write a new token to `.local/server-token`, restart the server with `run-dev.sh stop` then `start`, and paste the new token into each client.
