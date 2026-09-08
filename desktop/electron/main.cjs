const { app, BrowserWindow, ipcMain, safeStorage, session, shell } = require("electron");
const { autoUpdater } = require("electron-updater");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const SECRET_KEYS = new Set(["apiToken"]);
const RELEASE_CHANNELS = new Set(["alpha", "beta", "stable"]);
const DEFAULT_API_PORT = 3217;

let mainWindow = null;
let apiProcess = null;
let apiRuntime = {
  started: false,
  status: "not_started",
  pid: null,
  logPath: null,
  reason: null,
};

function appRoot() {
  return path.resolve(__dirname, "..", "..");
}

function normalizedUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function desktopApiBaseUrl() {
  const configured = normalizedUrl(process.env.JDEC_DESKTOP_API_BASE_URL || process.env.JDEC_API_BASE_URL);
  if (configured) return configured;
  const port = Number.parseInt(String(process.env.JDEC_DESKTOP_API_PORT || DEFAULT_API_PORT), 10);
  const safePort = Number.isFinite(port) && port > 0 && port <= 65535 ? port : DEFAULT_API_PORT;
  return `http://127.0.0.1:${safePort}/api/v2`;
}

function rendererUrl() {
  return normalizedUrl(process.env.JDEC_DESKTOP_RENDERER_URL);
}

function shouldStartLocalApiRuntime() {
  if (process.env.JDEC_DESKTOP_START_API === "false") return false;
  return !app.isPackaged;
}

function releaseChannel() {
  const configured = String(process.env.JDEC_DESKTOP_RELEASE_CHANNEL || "").trim().toLowerCase();
  if (RELEASE_CHANNELS.has(configured)) return configured;
  return app.isPackaged ? "stable" : "dev";
}

function updaterChannel(channel) {
  return channel === "stable" ? "latest" : channel;
}

function apiPortFromBaseUrl(apiBaseUrl) {
  try {
    const parsed = new URL(apiBaseUrl);
    return parsed.port || (parsed.protocol === "https:" ? "443" : "80");
  } catch {
    return String(DEFAULT_API_PORT);
  }
}

async function appendRuntimeLog(chunk) {
  if (!apiRuntime.logPath) return;
  try {
    await fsp.appendFile(apiRuntime.logPath, chunk);
  } catch {
    // Logging must not crash the native shell.
  }
}

function startLocalApiRuntime(apiBaseUrl) {
  if (!shouldStartLocalApiRuntime()) {
    apiRuntime = {
      started: false,
      status: "disabled",
      pid: null,
      logPath: null,
      reason: app.isPackaged ? "packaged_runtime_external" : "disabled_by_env",
    };
    return;
  }

  const logsDir = path.join(app.getPath("userData"), "logs");
  fs.mkdirSync(logsDir, { recursive: true });
  const logPath = path.join(logsDir, "api-runtime.log");
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const port = apiPortFromBaseUrl(apiBaseUrl);

  apiProcess = spawn(npmCommand, ["run", "api:v2"], {
    cwd: appRoot(),
    env: {
      ...process.env,
      PORT: port,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  apiRuntime = {
    started: true,
    status: "running",
    pid: apiProcess.pid ?? null,
    logPath,
    reason: null,
  };

  apiProcess.stdout.on("data", (data) => {
    const text = data.toString();
    process.stdout.write(text);
    void appendRuntimeLog(text);
  });
  apiProcess.stderr.on("data", (data) => {
    const text = data.toString();
    process.stderr.write(text);
    void appendRuntimeLog(text);
  });
  apiProcess.on("exit", (code, signal) => {
    apiRuntime = {
      ...apiRuntime,
      started: false,
      status: "exited",
      pid: null,
      reason: `code=${code ?? "null"} signal=${signal ?? "null"}`,
    };
  });
  apiProcess.on("error", (error) => {
    apiRuntime = {
      ...apiRuntime,
      started: false,
      status: "failed",
      pid: null,
      reason: error.message,
    };
  });
}

function stopLocalApiRuntime() {
  if (apiProcess && !apiProcess.killed) {
    apiProcess.kill();
  }
  apiProcess = null;
}

function secretFilePath(key) {
  if (!SECRET_KEYS.has(key)) {
    throw new Error(`Unsupported desktop secret key: ${key}`);
  }
  return path.join(app.getPath("userData"), "secrets", `${key}.secret`);
}

async function getSecret(key) {
  if (!safeStorage.isEncryptionAvailable()) return null;
  const filePath = secretFilePath(key);
  try {
    const encrypted = await fsp.readFile(filePath);
    return safeStorage.decryptString(encrypted);
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw error;
  }
}

async function setSecret(key, value) {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("OS secret storage is unavailable on this machine.");
  }
  const filePath = secretFilePath(key);
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  if (!String(value || "").trim()) {
    await fsp.rm(filePath, { force: true });
    return;
  }
  const encrypted = safeStorage.encryptString(String(value));
  await fsp.writeFile(filePath, encrypted, { mode: 0o600 });
}

async function deleteSecret(key) {
  const filePath = secretFilePath(key);
  await fsp.rm(filePath, { force: true });
}

function updatesEnabled() {
  return app.isPackaged && process.env.JDEC_DESKTOP_ENABLE_UPDATES === "true";
}

function configureAutoUpdater(channel) {
  autoUpdater.autoDownload = false;
  autoUpdater.allowPrerelease = channel !== "stable";
  autoUpdater.channel = updaterChannel(channel);
}

function registerIpc(apiBaseUrl) {
  const channel = releaseChannel();
  configureAutoUpdater(channel);

  ipcMain.handle("jdec:secret:is-available", () => safeStorage.isEncryptionAvailable());
  ipcMain.handle("jdec:secret:get", async (_event, key) => getSecret(String(key || "")));
  ipcMain.handle("jdec:secret:set", async (_event, key, value) => {
    await setSecret(String(key || ""), String(value || ""));
    return { ok: true };
  });
  ipcMain.handle("jdec:secret:delete", async (_event, key) => {
    await deleteSecret(String(key || ""));
    return { ok: true };
  });
  ipcMain.handle("jdec:runtime:get-status", () => ({
    appVersion: app.getVersion(),
    isPackaged: app.isPackaged,
    releaseChannel: channel,
    updaterChannel: updaterChannel(channel),
    apiBaseUrl,
    apiRuntime,
    safeStorageAvailable: safeStorage.isEncryptionAvailable(),
    updatesEnabled: updatesEnabled(),
  }));
  ipcMain.handle("jdec:updates:check", async () => {
    if (!updatesEnabled()) {
      return { ok: false, status: "disabled" };
    }
    try {
      configureAutoUpdater(channel);
      const result = await autoUpdater.checkForUpdates();
      return { ok: true, status: "available", updateInfo: result ? result.updateInfo : null };
    } catch (error) {
      return { ok: false, status: "failed", error: error instanceof Error ? error.message : String(error) };
    }
  });
}

function installContentSecurityPolicy() {
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'self' http://127.0.0.1:* http://localhost:* https://*",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join("; ");

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [csp],
      },
    });
  });
}

function isSafeExternalUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

async function createMainWindow(apiBaseUrl) {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 1040,
    minHeight: 720,
    title: "Job Decision Engine",
    backgroundColor: "#eef2f7",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      additionalArguments: [`--jdec-api-base-url=${apiBaseUrl}`],
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });

  const devRendererUrl = rendererUrl();
  if (devRendererUrl) {
    await mainWindow.loadURL(devRendererUrl);
  } else {
    await mainWindow.loadFile(path.join(appRoot(), "dist", "index.html"));
  }
}

const singleInstanceLock = app.requestSingleInstanceLock();
if (!singleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    const apiBaseUrl = desktopApiBaseUrl();
    installContentSecurityPolicy();
    registerIpc(apiBaseUrl);
    startLocalApiRuntime(apiBaseUrl);
    await createMainWindow(apiBaseUrl);
  });
}

app.on("before-quit", stopLocalApiRuntime);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    const apiBaseUrl = desktopApiBaseUrl();
    void createMainWindow(apiBaseUrl);
  }
});
