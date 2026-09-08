export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface DesktopSettings {
  apiBaseUrl: string;
  apiToken: string;
  workspaceKey: string;
  userKey: string;
}

export interface DesktopSecretStore {
  isAvailable: () => Promise<boolean>;
  getSecret: (key: "apiToken") => Promise<string | null>;
  setSecret: (key: "apiToken", value: string) => Promise<{ ok: boolean }>;
  deleteSecret: (key: "apiToken") => Promise<{ ok: boolean }>;
}

export const DESKTOP_SETTINGS_STORAGE_KEY = "jdec.desktop.settings.v1";

export const DEFAULT_DESKTOP_SETTINGS: DesktopSettings = {
  apiBaseUrl: "/api/v2",
  apiToken: "",
  workspaceKey: "default",
  userKey: "local_user",
};

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function normalizeDesktopSettings(input: Partial<DesktopSettings> | null | undefined): DesktopSettings {
  const apiBaseUrl = cleanString(input?.apiBaseUrl) || DEFAULT_DESKTOP_SETTINGS.apiBaseUrl;
  return {
    apiBaseUrl: apiBaseUrl.replace(/\/+$/, "") || DEFAULT_DESKTOP_SETTINGS.apiBaseUrl,
    apiToken: cleanString(input?.apiToken),
    workspaceKey: cleanString(input?.workspaceKey) || DEFAULT_DESKTOP_SETTINGS.workspaceKey,
    userKey: cleanString(input?.userKey) || DEFAULT_DESKTOP_SETTINGS.userKey,
  };
}

export function loadDesktopSettings(storage: KeyValueStorage | null | undefined): DesktopSettings {
  if (!storage) return DEFAULT_DESKTOP_SETTINGS;
  const raw = storage.getItem(DESKTOP_SETTINGS_STORAGE_KEY);
  if (!raw) return DEFAULT_DESKTOP_SETTINGS;
  try {
    return normalizeDesktopSettings(JSON.parse(raw) as Partial<DesktopSettings>);
  } catch {
    return DEFAULT_DESKTOP_SETTINGS;
  }
}

export function saveDesktopSettings(storage: KeyValueStorage | null | undefined, settings: DesktopSettings): DesktopSettings {
  const normalized = normalizeDesktopSettings(settings);
  if (storage) {
    storage.setItem(DESKTOP_SETTINGS_STORAGE_KEY, JSON.stringify(normalized));
  }
  return normalized;
}

export async function loadDesktopSettingsSecure(
  storage: KeyValueStorage | null | undefined,
  secretStore: DesktopSecretStore | null | undefined,
  nativeDefaultApiBaseUrl?: string | null
): Promise<DesktopSettings> {
  const loaded = loadDesktopSettings(storage);
  const base = nativeDefaultApiBaseUrl && loaded.apiBaseUrl === DEFAULT_DESKTOP_SETTINGS.apiBaseUrl
    ? { ...loaded, apiBaseUrl: nativeDefaultApiBaseUrl }
    : loaded;

  if (!secretStore) return base;
  const available = await secretStore.isAvailable().catch(() => false);
  if (!available) return { ...base, apiToken: "" };
  const apiToken = await secretStore.getSecret("apiToken").catch(() => null);
  return normalizeDesktopSettings({ ...base, apiToken: apiToken ?? "" });
}

export async function saveDesktopSettingsSecure(
  storage: KeyValueStorage | null | undefined,
  secretStore: DesktopSecretStore | null | undefined,
  settings: DesktopSettings
): Promise<DesktopSettings> {
  const normalized = normalizeDesktopSettings(settings);
  if (!secretStore) {
    return saveDesktopSettings(storage, normalized);
  }

  const available = await secretStore.isAvailable().catch(() => false);
  if (!available && normalized.apiToken) {
    throw new Error("Native OS secret storage is unavailable; API token was not saved.");
  }

  if (storage) {
    storage.setItem(
      DESKTOP_SETTINGS_STORAGE_KEY,
      JSON.stringify({ ...normalized, apiToken: "" })
    );
  }

  if (available) {
    if (normalized.apiToken) {
      await secretStore.setSecret("apiToken", normalized.apiToken);
    } else {
      await secretStore.deleteSecret("apiToken");
    }
  }

  return normalized;
}

export function clearDesktopSettings(storage: KeyValueStorage | null | undefined): void {
  storage?.removeItem(DESKTOP_SETTINGS_STORAGE_KEY);
}

export function redactSecret(secret: string): string {
  const trimmed = secret.trim();
  if (trimmed.length === 0) return "";
  if (trimmed.length <= 8) return "********";
  return `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`;
}
