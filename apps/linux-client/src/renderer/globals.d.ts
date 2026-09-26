import type { SottoDesktopAPI } from "../preload/preload.cjs";

declare global {
  interface Window {
    sotto: SottoDesktopAPI;
  }
}

export {};
