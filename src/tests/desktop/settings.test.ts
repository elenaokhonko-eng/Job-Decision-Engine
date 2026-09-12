import { describe, expect, it } from "vitest";
import {
  DESKTOP_SETTINGS_STORAGE_KEY,
  clearDesktopSettings,
  loadDesktopSettings,
  loadDesktopSettingsSecure,
  normalizeDesktopSettings,
  redactSecret,
  saveDesktopSettings,
  saveDesktopSettingsSecure,
  type DesktopSecretStore,
  type DesktopSecretKey,
  type KeyValueStorage,
} from "../../desktop/settings.js";

class MemoryStorage implements KeyValueStorage {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

class MemorySecretStore implements DesktopSecretStore {
  available = true;
  readonly values = new Map<string, string>();

  async isAvailable(): Promise<boolean> {
    return this.available;
  }

  async hasSecret(key: DesktopSecretKey): Promise<boolean> {
    return this.values.has(key);
  }

  async setSecret(key: DesktopSecretKey, value: string): Promise<{ ok: boolean }> {
    this.values.set(key, value);
    return { ok: true };
  }

  async deleteSecret(key: DesktopSecretKey): Promise<{ ok: boolean }> {
    this.values.delete(key);
    return { ok: true };
  }
}

describe("desktop settings", () => {
  it("normalizes local runtime settings with safe defaults", () => {
    expect(normalizeDesktopSettings({
      apiBaseUrl: " http://127.0.0.1:3000/api/v2/// ",
      workspaceKey: "",
      userKey: "  me  ",
    })).toEqual({
      apiBaseUrl: "http://127.0.0.1:3000/api/v2",
      apiToken: "",
      workspaceKey: "default",
      userKey: "me",
    });
  });

  it("loads, saves, clears, and tolerates malformed stored settings", () => {
    const storage = new MemoryStorage();
    const saved = saveDesktopSettings(storage, {
      apiBaseUrl: "/api/v2/",
      apiToken: "secret-token",
      workspaceKey: "default",
      userKey: "local_user",
    });

    expect(saved.apiBaseUrl).toBe("/api/v2");
    expect(loadDesktopSettings(storage).apiToken).toBe("secret-token");

    storage.setItem(DESKTOP_SETTINGS_STORAGE_KEY, "{");
    expect(loadDesktopSettings(storage).apiBaseUrl).toBe("/api/v2");

    clearDesktopSettings(storage);
    expect(storage.getItem(DESKTOP_SETTINGS_STORAGE_KEY)).toBeNull();
  });

  it("redacts configured tokens for display", () => {
    expect(redactSecret("")).toBe("");
    expect(redactSecret("short")).toBe("********");
    expect(redactSecret("abcd-1234-efgh")).toBe("abcd...efgh");
  });

  it("stores API tokens in native secret storage when available", async () => {
    const storage = new MemoryStorage();
    const secretStore = new MemorySecretStore();

    await saveDesktopSettingsSecure(storage, secretStore, {
      apiBaseUrl: "http://127.0.0.1:3217/api/v2",
      apiToken: "native-token",
      workspaceKey: "default",
      userKey: "local_user",
    });

    expect(storage.getItem(DESKTOP_SETTINGS_STORAGE_KEY)).not.toContain("native-token");
    expect(secretStore.values.get("apiToken")).toBe("native-token");
    await expect(saveDesktopSettingsSecure(storage, secretStore, {
      apiBaseUrl: "http://127.0.0.1:3217/api/v2",
      apiToken: "native-token",
      workspaceKey: "default",
      userKey: "local_user",
    })).resolves.toMatchObject({ apiToken: "" });
    await expect(loadDesktopSettingsSecure(storage, secretStore)).resolves.toMatchObject({
      apiBaseUrl: "http://127.0.0.1:3217/api/v2",
      apiToken: "",
    });
  });

  it("preserves an OS-backed token when saving unrelated native settings", async () => {
    const storage = new MemoryStorage();
    const secretStore = new MemorySecretStore();
    secretStore.values.set("apiToken", "existing-token");

    await saveDesktopSettingsSecure(storage, secretStore, {
      apiBaseUrl: "https://api.example.com/api/v2",
      apiToken: "",
      workspaceKey: "workspace-2",
      userKey: "user-2",
    }, { preserveExistingToken: true });

    expect(secretStore.values.get("apiToken")).toBe("existing-token");
  });

  it("deletes an OS-backed token only when clearing is explicit", async () => {
    const storage = new MemoryStorage();
    const secretStore = new MemorySecretStore();
    secretStore.values.set("apiToken", "existing-token");

    await saveDesktopSettingsSecure(storage, secretStore, {
      apiBaseUrl: "https://api.example.com/api/v2",
      apiToken: "",
      workspaceKey: "default",
      userKey: "local_user",
    });

    expect(secretStore.values.has("apiToken")).toBe(false);
  });

  it("refuses to persist native tokens when OS secret storage is unavailable", async () => {
    const storage = new MemoryStorage();
    const secretStore = new MemorySecretStore();
    secretStore.available = false;

    await expect(saveDesktopSettingsSecure(storage, secretStore, {
      apiBaseUrl: "/api/v2",
      apiToken: "native-token",
      workspaceKey: "default",
      userKey: "local_user",
    })).rejects.toThrow(/secret storage is unavailable/);
  });
});
