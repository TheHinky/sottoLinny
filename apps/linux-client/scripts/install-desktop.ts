// Installs a per-user .desktop entry for the dev client. KDE's GlobalShortcuts
// portal and the tray use it to identify the app (name, icon, shortcut settings).
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const appDir = resolve(import.meta.dirname, "..");
const electron = join(appDir, "node_modules/.bin/electron");
const dataHome = process.env.XDG_DATA_HOME || join(homedir(), ".local/share");
const target = join(dataHome, "applications/dev.sotto.Linux.desktop");
const quote = (value: string) => `"${value.replace(/(["`$\\])/g, "\\$1")}"`;

await mkdir(join(dataHome, "applications"), { recursive: true });
await writeFile(
  target,
  `[Desktop Entry]
Type=Application
Name=Sotto Linux
Comment=Dictation client for a Sotto server
Exec=${quote(electron)} ${quote(appDir)} --ozone-platform-hint=auto
Icon=${join(appDir, "assets/icon.png")}
Terminal=false
Categories=Utility;
StartupWMClass=Sotto Linux
`,
);
console.log(`Installed ${target}`);
