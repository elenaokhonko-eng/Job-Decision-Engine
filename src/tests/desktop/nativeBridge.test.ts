import { describe, expect, it, vi } from "vitest";
import {
  getNativeRuntimeBridge,
  getNativeSecretStore,
  nativeDefaultApiBaseUrl,
  type DesktopRuntimeBridge,
} from "../../desktop/nativeBridge.js";
import type { DesktopSecretStore } from "../../desktop/settings.js";

describe("desktop native bridge", () => {
  it("discovers native secret and runtime bridges from an injected root", async () => {
    const secrets: DesktopSecretStore = {
      isAvailable: vi.fn(async () => true),
      getSecret: vi.fn(async () => "token"),
      setSecret: vi.fn(async () => ({ ok: true })),
      deleteSecret: vi.fn(async () => ({ ok: true })),
    };
    const runtime: DesktopRuntimeBridge = {
      defaults: { apiBaseUrl: "http://127.0.0.1:3217/api/v2/" },
      getStatus: vi.fn(async () => ({
        appVersion: "1.0.0",
        isPackaged: false,
        releaseChannel: "dev",
        updaterChannel: "dev",
        apiBaseUrl: "http://127.0.0.1:3217/api/v2",
        apiRuntime: {
          started: true,
          status: "running",
          pid: 123,
          logPath: "api-runtime.log",
          reason: null,
        },
        safeStorageAvailable: true,
        updatesEnabled: false,
      })),
      checkForUpdates: vi.fn(async () => ({ ok: false, status: "disabled" })),
    };

    const root = { jdecSecrets: secrets, jdecRuntime: runtime };

    expect(getNativeSecretStore(root)).toBe(secrets);
    expect(getNativeRuntimeBridge(root)).toBe(runtime);
    expect(nativeDefaultApiBaseUrl(root)).toBe("http://127.0.0.1:3217/api/v2");
    await expect(getNativeRuntimeBridge(root)?.getStatus()).resolves.toMatchObject({
      releaseChannel: "dev",
      safeStorageAvailable: true,
    });
  });

  it("returns null outside the native shell", () => {
    expect(getNativeSecretStore({})).toBeNull();
    expect(getNativeRuntimeBridge({})).toBeNull();
    expect(nativeDefaultApiBaseUrl({})).toBeNull();
  });
});
