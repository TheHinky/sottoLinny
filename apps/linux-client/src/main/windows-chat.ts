import { spawn } from "node:child_process";
import { join } from "node:path";

// Separate helper keeps Win32 input out of the sandboxed renderer. No shell
// interpolation, transcript arguments, auto-send, focus switching or server changes.
export function pasteIntoLMU(text: string): Promise<void> {
  const chatKey = process.env.SOTTO_LMU_CHAT_KEY || "";
  if (chatKey && !/^[A-Z0-9]$/i.test(chatKey))
    return Promise.reject(new Error("SOTTO_LMU_CHAT_KEY must be one letter or digit."));
  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-STA",
        "-File",
        join(import.meta.dirname, "../../assets/lmu-paste.ps1"),
        "-ChatKey",
        chatKey || "NONE",
      ],
      { windowsHide: true, stdio: ["pipe", "ignore", "pipe"] },
    );
    let error = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("Chat paste timed out; not retried."));
    }, 8000);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      error = (error + chunk).slice(-2000);
    });
    child.on("error", () => {
      clearTimeout(timeout);
      reject(new Error("Could not start the Windows chat helper."));
    });
    child.on("exit", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else
        reject(
          new Error(
            error.includes("LMU must")
              ? "LMU must be the foreground window."
              : error.includes("Clipboard changed")
                ? "Clipboard changed; paste cancelled."
                : "Chat paste failed; not retried. Check game focus and helper configuration.",
          ),
        );
    });
    child.stdin.on("error", () => {});
    child.stdin.end(text, "utf8");
  });
}
