import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app, safeStorage } from "electron";

// The access token is encrypted with the OS keystore (KWallet/libsecret on
// Linux, DPAPI on Windows) and stored as an opaque blob in the app data dir.
// Electron's "basic_text" fallback is a hardcoded key, so it is refused.
const tokenPath = () => join(app.getPath("userData"), "token.bin");

function requireSecureStorage() {
  if (
    !safeStorage.isEncryptionAvailable() ||
    (process.platform === "linux" && safeStorage.getSelectedStorageBackend() === "basic_text")
  )
    throw new Error("No secure keystore available; the token cannot be saved.");
}

export function loadToken() {
  try {
    const blob = readFileSync(tokenPath());
    requireSecureStorage();
    return safeStorage.decryptString(blob);
  } catch {
    return "";
  }
}

export function saveToken(token: string) {
  if (!token) return rmSync(tokenPath(), { force: true });
  requireSecureStorage();
  writeFileSync(tokenPath(), safeStorage.encryptString(token), { mode: 0o600 });
}
