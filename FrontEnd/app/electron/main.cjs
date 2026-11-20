/**
 * Electron main process entry. It owns the window and three groups of IPC handlers:
 *   - footage:stage and export:save, defined here (copying source videos, saving exported clips);
 *   - everything in electron/assistant.bundle.cjs (built by `npm run build:assistant` from
 *     electron/assistant.ts): the Providers page backend, the chat assistant and its MCP server,
 *     the MongoDB kinematics store, and the vision pipeline (analysis.ts);
 *   - stand-ins that fail politely when the bundle hasn't been built.
 * The renderer reaches all of it through window.crashvzn (electron/preload.cjs). Changes here or in
 * the bundle need an Electron restart; Vite only hot-reloads the renderer.
 */
const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

// Electron names the user-data folder after package.json "name". The package was renamed from
// "reconstruct-viewer" to "crashvzn-app"; keep the old folder so the embedded MongoDB, saved
// scenes, provider keys, settings and voice models stay where they are. Must run before "ready".
app.setPath("userData", path.join(app.getPath("appData"), "reconstruct-viewer"));

const isDev = !app.isPackaged;
const videoExtensions = new Set([".mp4", ".mov", ".m4v", ".mkv", ".avi", ".webm"]);

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const input = fs.createReadStream(filePath);
    input.on("error", reject);
    input.on("data", (chunk) => hash.update(chunk));
    input.on("end", () => resolve(hash.digest("hex")));
  });
}

/** Copies the queued source videos into <userData>/incidents/<uuid>/sources and writes a manifest of names, sizes and SHA-256 hashes. */
ipcMain.handle("footage:stage", async (_event, filePaths) => {
  if (!Array.isArray(filePaths) || filePaths.length === 0) {
    throw new Error("Select at least one video file.");
  }

  const incidentId = crypto.randomUUID();
  const incidentDir = path.join(app.getPath("userData"), "incidents", incidentId);
  const sourceDir = path.join(incidentDir, "sources");
  await fs.promises.mkdir(sourceDir, { recursive: true });

  const videos = [];
  try {
    for (const [index, rawPath] of filePaths.entries()) {
      if (typeof rawPath !== "string" || !path.isAbsolute(rawPath)) {
        throw new Error("A selected video path is invalid.");
      }

      const sourcePath = path.resolve(rawPath);
      const sourceStat = await fs.promises.stat(sourcePath);
      const extension = path.extname(sourcePath).toLowerCase();
      if (!sourceStat.isFile() || !videoExtensions.has(extension)) {
        throw new Error(`Unsupported video file: ${path.basename(sourcePath)}`);
      }

      const originalName = path.basename(sourcePath);
      const fileStem = path.basename(sourcePath, extension).replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").slice(0, 160);
      const storedName = `${String(index + 1).padStart(2, "0")}-${fileStem || "video"}${extension}`;
      const storedPath = path.join(sourceDir, storedName);
      await fs.promises.copyFile(sourcePath, storedPath, fs.constants.COPYFILE_EXCL);

      videos.push({
        fileName: originalName,
        storedName,
        sizeBytes: sourceStat.size,
        sha256: await hashFile(storedPath),
      });
    }

    const manifest = {
      schemaVersion: 1,
      incidentId,
      createdAt: new Date().toISOString(),
      processingStatus: "staged",
      videos,
    };
    await fs.promises.writeFile(
      path.join(incidentDir, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { flag: "wx" },
    );

    return {
      incidentId,
      videos: videos.map(({ fileName, sizeBytes, sha256 }) => ({ fileName, sizeBytes, sha256 })),
    };
  } catch (error) {
    await fs.promises.rm(incidentDir, { recursive: true, force: true });
    throw error;
  }
});

let mainWindow = null;

// Development only: API keys for the chat fallbacks (ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY)
// may live in the gitignored packages/assistant/.env. Keys saved on the Providers page take their place
// in the packaged app. Video processing never uses API keys.
if (isDev) {
  try {
    process.loadEnvFile(path.join(__dirname, "../../../packages/assistant/.env"));
  } catch {
    // No .env: the CLI logins are the main providers anyway.
  }
}

// Handles to the bundle's services, disposed on quit (null if the bundle failed to load).
let assistant = null;
let kinematics = null;
let providers = null;
try {
  const bundle = require("./assistant.bundle.cjs");
  // Providers page: settings, encrypted API keys, provider status and sign-in (electron/providers.ts).
  providers = bundle.registerProviders({ ipcMain, getWindow: () => mainWindow });
  assistant = bundle.registerAssistant({ ipcMain, getWindow: () => mainWindow, providers });
  kinematics = bundle.registerKinematics({ ipcMain, app });
  // The vision pipeline (analysis.ts) reads the footage; its analyses and scenes live in the same MongoDB as the kinematics.
  bundle.registerAnalysis({
    ipcMain,
    getWindow: () => mainWindow,
    db: kinematics.db,
    cacheDir: path.join(app.getPath("userData"), "camera-tiles"),
    forgetKinematics: kinematics.forget,
    // Codex (ChatGPT login) or Claude Code (Claude subscription), as chosen on the Providers page.
    getProcessor: () => providers.processor(),
  });
} catch (error) {
  console.error("Assistant failed to load. Run `npm run build:assistant`.", error);
  const unavailable = async () => {
    throw new Error("The assistant isn't built. Run `npm run build:assistant` and restart the app.");
  };
  ipcMain.handle("assistant:providers", async () => []);
  ipcMain.handle("assistant:start", unavailable);
  ipcMain.handle("assistant:send", unavailable);
  ipcMain.handle("assistant:interrupt", async () => {});
  ipcMain.handle("analysis:status", async () => ({ configured: false, models: { fast: "", precise: "" } }));
  ipcMain.handle("analysis:analyze", unavailable);
  ipcMain.handle("analysis:save-scene", unavailable);
  ipcMain.handle("analysis:list-scenes", async () => []);
  // Nothing is saved without the bundle, so there is nothing to delete.
  ipcMain.handle("analysis:delete-scene", async () => {});
  ipcMain.handle("providers:status", unavailable);
  for (const channel of ["providers:check", "providers:login", "providers:cancel-login", "providers:open-terminal", "providers:open-url", "providers:set-key", "providers:clear-key", "providers:set-processor"]) {
    ipcMain.handle(channel, unavailable);
  }
}

/** Asks where to save an exported video (MP4 or WebM from src/lib/exportVideo.ts) and writes it there. */
ipcMain.handle("export:save", async (_event, bytes, fileName) => {
  if (!(bytes instanceof Uint8Array) || typeof fileName !== "string") throw new Error("Nothing to save.");
  const safeName = path.basename(fileName).replace(/[<>:"/\|?*\x00-\x1f]/g, "_") || "reconstruction.mp4";
  const options = {
    title: "Save exported video",
    defaultPath: path.join(app.getPath("videos"), safeName),
    filters: [{ name: "Video", extensions: [path.extname(safeName).slice(1) || "mp4"] }],
  };
  const result = mainWindow ? await dialog.showSaveDialog(mainWindow, options) : await dialog.showSaveDialog(options);
  if (result.canceled || !result.filePath) return null;
  await fs.promises.writeFile(result.filePath, bytes);
  return result.filePath;
});

try {
  require("./voice.cjs").register({ ipcMain, app, getWindow: () => mainWindow });
} catch (error) {
  console.error("Voice transcription failed to register", error);
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1100,
    minHeight: 720,
    title: "CRASHVZN",
    backgroundColor: "#0a2378",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow = win;
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });

  if (isDev) {
    // Surface renderer warnings and errors in the terminal that runs `npm start`.
    win.webContents.on("console-message", (event) => {
      if (event.level === "warning" || event.level === "error") console.log(`[renderer ${event.level}] ${event.message}`);
    });
    win.loadURL("http://127.0.0.1:5173");
  } else {
    win.loadFile(path.join(__dirname, "../dist/index.html"));
  }
}

app.whenReady().then(createWindow);

let quitting = false;
app.on("before-quit", (event) => {
  if (quitting) return;
  // Close the CLIs and flush the kinematics database to disk before exiting.
  quitting = true;
  event.preventDefault();
  const timeout = new Promise((resolve) => setTimeout(resolve, 5000));
  void Promise.race([Promise.allSettled([assistant?.dispose(), kinematics?.dispose(), providers?.dispose()]), timeout]).finally(() => app.quit());
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
