const { contextBridge, ipcRenderer } = require("electron");

function readArg(name) {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : "";
}

contextBridge.exposeInMainWorld("jdecSecrets", {
  isAvailable: () => ipcRenderer.invoke("jdec:secret:is-available"),
  hasSecret: (key) => ipcRenderer.invoke("jdec:secret:has", key),
  setSecret: (key, value) => ipcRenderer.invoke("jdec:secret:set", key, value),
  deleteSecret: (key) => ipcRenderer.invoke("jdec:secret:delete", key),
});

contextBridge.exposeInMainWorld("jdecRuntime", {
  defaults: {
    apiBaseUrl: readArg("jdec-api-base-url"),
  },
  getStatus: () => ipcRenderer.invoke("jdec:runtime:get-status"),
  checkForUpdates: () => ipcRenderer.invoke("jdec:updates:check"),
});

contextBridge.exposeInMainWorld("jdecApi", {
  request: (input) => ipcRenderer.invoke("jdec:api:request", input),
});
