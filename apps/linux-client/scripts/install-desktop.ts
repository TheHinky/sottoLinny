// Installs a per-user .desktop entry for the dev client. KDE's GlobalShortcuts
// portal and the tray use it to identify the app (name, icon, shortcut settings).
// On KDE it also installs the KWin script that places the status overlay.
import { spawnSync } from "node:child_process";
import { cp, mkdir, writeFile } from "node:fs/promises";
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

// ---- KWin status overlay ----
// Wayland apps cannot position their own windows or refuse focus, so on KDE:
// a KWin script keeps the status pill at the bottom centre, and a window rule
// stops KWin from giving it keyboard focus. Both match titles starting with
// "Sotto Status" (the client appends the chosen position). Skipped outside KDE.
const run = (command: string, args: string[]) => spawnSync(command, args, { encoding: "utf8" });
if (run("kwriteconfig6", ["--help"]).status === 0) {
  const scriptDir = join(dataHome, "kwin/scripts/sotto-overlay");
  await cp(join(appDir, "assets/kwin-overlay"), scriptDir, { recursive: true });
  run("kwriteconfig6", [
    "--file",
    "kwinrc",
    "--group",
    "Plugins",
    "--key",
    "sotto-overlayEnabled",
    "true",
  ]);

  // Rule ids are a comma list in [General]; keep the user's own rules.
  const ruleId = "sotto-status-overlay";
  const readRules = run("kreadconfig6", [
    "--file",
    "kwinrulesrc",
    "--group",
    "General",
    "--key",
    "rules",
  ]);
  const rules = readRules.stdout.trim().split(",").filter(Boolean);
  if (!rules.includes(ruleId)) rules.push(ruleId);
  const rule: Record<string, string> = {
    Description: "Sotto status overlay",
    title: "Sotto Status",
    titlematch: "2", // substring; the title ends with the position
    acceptfocus: "false",
    acceptfocusrule: "2", // force
  };
  for (const [key, value] of Object.entries(rule))
    run("kwriteconfig6", ["--file", "kwinrulesrc", "--group", ruleId, "--key", key, value]);
  run("kwriteconfig6", [
    "--file",
    "kwinrulesrc",
    "--group",
    "General",
    "--key",
    "rules",
    rules.join(","),
  ]);
  run("kwriteconfig6", [
    "--file",
    "kwinrulesrc",
    "--group",
    "General",
    "--key",
    "count",
    String(rules.length),
  ]);

  // Reconfigure loads the script and rule now; otherwise they apply at next login.
  run("dbus-send", [
    "--session",
    "--type=method_call",
    "--dest=org.kde.KWin",
    "/KWin",
    "org.kde.KWin.reconfigure",
  ]);
  console.log(`Installed ${scriptDir} and KWin rule ${ruleId}`);
}
