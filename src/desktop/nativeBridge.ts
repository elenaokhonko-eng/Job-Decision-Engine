import type { DesktopSecretStore } from "./settings.js";

export interface DesktopRuntimeStatus {
  appVersion: string;
  isPackaged: boolean;
  apiBaseUrl: string;
  apiRuntime: {
    started: boolean;
    status: string;
    pid: number | null;
    logPath: string | null;
    reason: string | null;
  };
  safeStorageAvailable: boolean;
  updatesEnabled: boolean;
}

export interface DesktopRuntimeBridge {
  defaults?: {
    apiBaseUrl?: string;
  };
  getStatus: () => Promise<DesktopRuntimeStatus>;
  checkForUpdates: () => Promise<{ ok: boolean; status: string; updateInfo?: unknown; error?: string }>;
}

type NativeWindowRoot = {
  jdecSecrets?: DesktopSecretStore;
  jdecRuntime?: DesktopRuntimeBridge;
};

declare global {
  interface Window {
    jdecSecrets?: DesktopSecretStore;
    jdecRuntime?: DesktopRuntimeBridge;
  }
}

export function getNativeSecretStore(root: NativeWindowRoot | undefined = globalThis.window): DesktopSecretStore | null {
  return root?.jdecSecrets ?? null;
}

export function getNativeRuntimeBridge(root: NativeWindowRoot | undefined = globalThis.window): DesktopRuntimeBridge | null {
  return root?.jdecRuntime ?? null;
}

export function nativeDefaultApiBaseUrl(root: NativeWindowRoot | undefined = globalThis.window): string | null {
  const value = root?.jdecRuntime?.defaults?.apiBaseUrl;
  return typeof value === "string" && value.trim() ? value.trim().replace(/\/+$/, "") : null;
}
