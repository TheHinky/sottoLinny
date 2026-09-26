// Installs (or with --remove, deletes) a KDE/XDG autostart entry that starts the
// dev server and the client, hidden in the tray, at login. It runs run-dev.sh in
// a login shell so Bun from ~/.bash_profile is on PATH.
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const runDev = resolve(import.meta.dirname, "../../../scripts/run-dev.sh");
const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
const quote = (value: string) => `"${value.replace(/(["`$\\])/g, "\\$1")}"`;
const target = join(configHome, "autostart/dev.sotto.Linux.desktop");

if (process.argv.includes("--remove")) {
  await rm(target, { force: true });
  console.log(`Removed ${target}`);
} else {
  await mkdir(join(configHome, "autostart"), { recursive: true });
  await writeFile(
    target,
    `[Desktop Entry]
Type=Application
Name=Sotto Linux
Comment=Start the Sotto dev server and client in the tray
Exec=env SOTTO_START_HIDDEN=1 /bin/bash -l ${quote(runDev)} start --skip-build
Icon=${resolve(import.meta.dirname, "../assets/icon.png")}
Terminal=false
X-GNOME-Autostart-enabled=true
`,
  );
  console.log(`Installed ${target}`);
}
