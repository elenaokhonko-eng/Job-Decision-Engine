import { describe, expect, it } from "vitest";
import {
  DESKTOP_SETTINGS_STORAGE_KEY,
  clearDesktopSettings,
  loadDesktopSettings,
  normalizeDesktopSettings,
  redactSecret,
  saveDesktopSettings,
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
});
