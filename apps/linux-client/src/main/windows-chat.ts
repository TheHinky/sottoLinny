import { spawn } from "node:child_process";
import { join } from "node:path";

// Separate helper keeps Win32 input out of the sandboxed renderer. No shell
// interpolation, transcript arguments, focus switching or server changes.
export function pasteIntoLMU(text: string): Promise<void> {
  if (!isChatTextSupported(text))
    return Promise.reject(
      new Error(
        "Chat supports 1–240 plain English characters; record a shorter message without special characters.",
      ),
    );
  const chatKey = process.env.SOTTO_LMU_CHAT_KEY || "ENTER";
  if (!/^(ENTER|NONE|[A-Z0-9])$/i.test(chatKey))
    return Promise.reject(
      new Error("SOTTO_LMU_CHAT_KEY must be ENTER, NONE, or one letter/digit."),
    );
  return new Promise((resolve, reject) => {
    console.log(new Date().toISOString(), "[chat] starting typing helper; characters", text.length);
    const child = spawn(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-NonInteractive",
        "-STA",
        "-File",
        join(import.meta.dirname, "../../assets/lmu-paste.ps1"),
        "-ChatKey",
        chatKey.toUpperCase(),
        ...(process.env.SOTTO_LMU_CHAT_NO_SEND === "1" ? ["-NoSend"] : []),
      ],
      { windowsHide: true, stdio: ["pipe", "ignore", "pipe"] },
    );
    let error = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("Chat typing timed out; not retried."));
    }, 20000);
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
      console.log(new Date().toISOString(), "[chat] helper exit", code);
      if (code !== 0) console.error(new Date().toISOString(), "[chat] helper diagnostic", error);
      if (code === 0) resolve();
      else
        reject(
          new Error(
            error.includes("LMU must")
              ? "LMU must be the foreground window."
              : error.includes("Clipboard changed")
                ? "Clipboard changed; paste cancelled."
                : "Chat typing failed; not retried. Check game focus and helper configuration.",
          ),
        );
    });
    child.stdin.on("error", () => {});
    child.stdin.end(text, "utf8");
  });
}

export function isChatTextSupported(text: string): boolean {
  return !!text.trim() && text.length <= 240 && /^[\x20-\x7e]+$/.test(text);
}
