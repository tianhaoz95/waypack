import type { HostInfo } from "./types.js";

declare global {
  interface Window {
    __WAYPACK_HOST__?: HostInfo;
    flutter_inappwebview?: { callHandler(name: string, ...args: unknown[]): Promise<unknown> };
  }
}

export function host(): HostInfo {
  if (window.__WAYPACK_HOST__) return window.__WAYPACK_HOST__;
  return { platform: "web" };
}

export function inApp(): boolean {
  return !!window.flutter_inappwebview && host().platform !== "web";
}

/** Calls a native handler in-app; resolves `false` on web so callers can fall back. */
export async function callNative(name: string, payload: unknown): Promise<boolean> {
  if (!inApp()) return false;
  try {
    await window.flutter_inappwebview!.callHandler(name, payload);
    return true;
  } catch {
    return false;
  }
}

/** Base URL of the SDK script (for glyphs/sprites), resolved at load time. */
export const sdkBase: string = (() => {
  const s = document.currentScript as HTMLScriptElement | null;
  const src = s?.src || new URL("/__waypack/sdk/v1/waypack.js", location.href).href;
  return src.replace(/[^/]*$/, "");
})();

/** Trip id from `/t/{trip_id}/…` (in-app and preview servers both use this layout). */
export function tripIdFromLocation(): string {
  const m = location.pathname.match(/\/t\/([^/]+)\//);
  return m ? decodeURIComponent(m[1]) : "local";
}
