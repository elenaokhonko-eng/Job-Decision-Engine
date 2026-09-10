import type { DesktopSecretStore } from "./settings.js";

export interface DesktopRuntimeStatus {
  appVersion: string;
  isPackaged: boolean;
  releaseChannel: string;
  updaterChannel: string;
  apiBaseUrl: string;
  apiRuntime: {
    started: boolean;
    status: string;
    pid: number | null;
    logPath: string | null;
    reason: string | null;
  };
  safeStorageAvailable: boolean;
  apiTokenConfigured: boolean;
  updatesEnabled: boolean;
}

export interface DesktopRuntimeBridge {
  defaults?: {
    apiBaseUrl?: string;
  };
  getStatus: () => Promise<DesktopRuntimeStatus>;
  checkForUpdates: () => Promise<{ ok: boolean; status: string; updateInfo?: unknown; error?: string }>;
}

export interface DesktopApiRequestInput {
  apiBaseUrl: string;
  path: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  workspaceKey?: string;
  userKey?: string;
}

export interface DesktopApiRequestResult {
  status: number;
  body: string;
}

export interface DesktopApiBridge {
  request: (input: DesktopApiRequestInput) => Promise<DesktopApiRequestResult>;
}

type NativeWindowRoot = {
  jdecSecrets?: DesktopSecretStore;
  jdecRuntime?: DesktopRuntimeBridge;
  jdecApi?: DesktopApiBridge;
};

declare global {
  interface Window {
    jdecSecrets?: DesktopSecretStore;
    jdecRuntime?: DesktopRuntimeBridge;
    jdecApi?: DesktopApiBridge;
  }
}

export function getNativeSecretStore(root: NativeWindowRoot | undefined = globalThis.window): DesktopSecretStore | null {
  return root?.jdecSecrets ?? null;
}

export function getNativeRuntimeBridge(root: NativeWindowRoot | undefined = globalThis.window): DesktopRuntimeBridge | null {
  return root?.jdecRuntime ?? null;
}

export function getNativeApiBridge(root: NativeWindowRoot | undefined = globalThis.window): DesktopApiBridge | null {
  return root?.jdecApi ?? null;
}

export function nativeDefaultApiBaseUrl(root: NativeWindowRoot | undefined = globalThis.window): string | null {
  const value = root?.jdecRuntime?.defaults?.apiBaseUrl;
  return typeof value === "string" && value.trim() ? value.trim().replace(/\/+$/, "") : null;
}
