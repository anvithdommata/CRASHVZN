const { contextBridge, ipcRenderer, webUtils } = require("electron");

/** Subscribe to a main→renderer channel; returns an unsubscribe function. */
function listen(channel, callback) {
  const handler = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld("crashvzn", {
  isDesktop: true,
  stageVideos: (files) => {
    const paths = files.map((file) => webUtils.getPathForFile(file));
    return ipcRenderer.invoke("footage:stage", paths);
  },

  /** The assistant runs in the main process; the renderer only sends text and renders events. */
  assistant: {
    providers: (refresh) => ipcRenderer.invoke("assistant:providers", Boolean(refresh)),
    choice: () => ipcRenderer.invoke("assistant:choice"),
    start: (opts) => ipcRenderer.invoke("assistant:start", opts),
    send: (text) => ipcRenderer.invoke("assistant:send", text),
    interrupt: () => ipcRenderer.invoke("assistant:interrupt"),
    onEvent: (callback) => listen("assistant:event", callback),
  },

  /**
   * Providers page (electron/providers.ts). API keys go in, but only "stored / not stored" ever
   * comes back: key values stay in the main process.
   */
  providers: {
    status: (refresh) => ipcRenderer.invoke("providers:status", Boolean(refresh)),
    check: (kind) => ipcRenderer.invoke("providers:check", kind),
    login: (kind) => ipcRenderer.invoke("providers:login", kind),
    cancelLogin: (kind) => ipcRenderer.invoke("providers:cancel-login", kind),
    openTerminal: (kind, purpose) => ipcRenderer.invoke("providers:open-terminal", kind, purpose ?? "login"),
    openUrl: (url) => ipcRenderer.invoke("providers:open-url", url),
    setKey: (kind, value) => ipcRenderer.invoke("providers:set-key", kind, value),
    clearKey: (kind) => ipcRenderer.invoke("providers:clear-key", kind),
    setProcessor: (choice) => ipcRenderer.invoke("providers:set-processor", choice),
    onLoginEvent: (callback) => listen("providers:login-event", callback),
    onChanged: (callback) => listen("providers:changed", callback),
  },

  /**
   * The app implements the scene controller in the renderer. The main process calls it
   * (for MCP tools) with scene:call and gets the answer back on scene:result.
   */
  scene: {
    onCall: (callback) => listen("scene:call", callback),
    reply: (payload) => ipcRenderer.send("scene:result", payload),
  },

  /** Per-frame kinematics in MongoDB (electron/kinematics.ts). Read-only apart from sync. */
  kinematics: {
    status: () => ipcRenderer.invoke("kinematics:status"),
    sync: (meta, frames) => ipcRenderer.invoke("kinematics:sync", meta, frames),
    incident: (incidentId) => ipcRenderer.invoke("kinematics:incident", incidentId),
    sample: (incidentId, entityId, times) => ipcRenderer.invoke("kinematics:sample", incidentId, entityId, times),
    positions: (incidentId, t) => ipcRenderer.invoke("kinematics:positions", incidentId, t),
  },

  /** Video processing (electron/analysis.ts, legacy name): Codex or Claude Code, picked on the Providers page. */
  analysis: {
    status: () => ipcRenderer.invoke("analysis:status"),
    analyze: (files, opts) => ipcRenderer.invoke("analysis:analyze", files.map((file) => webUtils.getPathForFile(file)), opts ?? {}),
    saveScene: (record) => ipcRenderer.invoke("analysis:save-scene", record),
    listScenes: () => ipcRenderer.invoke("analysis:list-scenes"),
    deleteScene: (sceneId) => ipcRenderer.invoke("analysis:delete-scene", sceneId),
    onProgress: (callback) => listen("analysis:progress", callback),
  },

  /** Saves an exported video; returns the saved path. */
  saveExport: (bytes, fileName) => ipcRenderer.invoke("export:save", bytes, fileName),

  /** Voice transcription, implemented in electron/voice.cjs. */
  voice: {
    invoke: (method, ...args) => ipcRenderer.invoke(`voice:${method}`, ...args),
    on: (callback) => listen("voice:event", callback),
  },
});
