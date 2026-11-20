/**
 * Voice transcription (main process). main.cjs calls register({ ipcMain, app, getWindow }) once.
 *
 * Local, on-device speech to text with NVIDIA Parakeet TDT 0.6B v2 run by sherpa-onnx in a
 * separate utility process (electron/voice/worker.cjs). The model downloads on first use into
 * <userData>/voice-models. Microphone capture happens in the renderer (src/voice/), which sends
 * finished clips here as Float32Array PCM.
 *
 * Renderer API, through window.crashvzn.voice.invoke(method, ...args):
 *   status()                         -> VoiceStatus
 *   prepare()                        -> VoiceStatus once the model is downloaded, loaded and warm
 *   cancelDownload()                 -> void
 *   requestMicAccess()               -> boolean (asks macOS for microphone access; true elsewhere)
 *   transcribe(samples, sampleRate, { partial }) -> { text, discarded?, audioMs, decodeMs? }
 * Events, through window.crashvzn.voice.on(cb):
 *   { type: "status", status: VoiceStatus }
 * VoiceStatus: { phase, model: { id, label, bytes }, received, total, error? } where phase is
 *   "missing" | "downloading" | "downloaded" | "loading" | "ready" | "error".
 */
const path = require("path");
const models = require("./voice/models.cjs");
const { Engine } = require("./voice/engine.cjs");
const { cleanTranscript } = require("./voice/cleanup.cjs");

const MAX_CLIP_SECONDS = 180;
const PROGRESS_INTERVAL_MS = 150;

function plainError(error, model) {
  const message = error instanceof Error ? error.message : String(error);
  const code = error && typeof error === "object" ? error.code || error.cause?.code : undefined;
  if (code === "ENOSPC") return `Not enough disk space for the speech model (${Math.round(models.totalBytes(model) / 1e6)} MB).`;
  if (/fetch failed|ENOTFOUND|ECONNRESET|ETIMEDOUT|EAI_AGAIN|network/i.test(`${message} ${code ?? ""}`)) {
    return "Couldn't download the speech model. Check your internet connection and try again.";
  }
  return message;
}

/** PCM from the renderer as a Float32Array, whichever way the bridge delivered it. */
function toFloat32(input) {
  if (input instanceof Float32Array) return input;
  if (input instanceof ArrayBuffer) return input.byteLength % 4 === 0 ? new Float32Array(input) : null;
  if (ArrayBuffer.isView(input) && input.byteLength % 4 === 0) {
    return new Float32Array(input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength));
  }
  return null;
}

function register({ ipcMain, app, getWindow }) {
  const model = models.DEFAULT_MODEL;
  const root = () => path.join(app.getPath("userData"), "voice-models");
  const engine = new Engine();

  let phase = models.isInstalled(root(), model) ? "downloaded" : "missing";
  let received = 0;
  let lastError;
  let preparing = null;
  let download = null;
  let lastProgressAt = 0;

  const status = () => ({
    phase,
    model: { id: model.id, label: model.label, bytes: models.totalBytes(model) },
    received: phase === "downloading" ? received : phase === "missing" ? models.bytesOnDisk(root(), model) : models.totalBytes(model),
    total: models.totalBytes(model),
    ...(lastError ? { error: lastError } : {}),
  });

  const emit = () => getWindow()?.webContents.send("voice:event", { type: "status", status: status() });

  const setPhase = (next, error) => {
    phase = next;
    lastError = error;
    emit();
  };

  engine.onCrash = (code) => {
    preparing = null;
    setPhase("downloaded", `The speech engine stopped (code ${code}). It restarts the next time you dictate.`);
  };

  async function prepareOnce() {
    if (!models.isInstalled(root(), model)) {
      download = new AbortController();
      received = 0;
      setPhase("downloading");
      try {
        await models.ensureModel(root(), model, {
          signal: download.signal,
          onProgress: (progress) => {
            received = progress.received;
            const now = Date.now();
            if (now - lastProgressAt >= PROGRESS_INTERVAL_MS) {
              lastProgressAt = now;
              emit();
            }
          },
        });
      } finally {
        download = null;
      }
    }
    setPhase("loading");
    await engine.request("load", { paths: models.filePaths(root(), model) });
    setPhase("ready");
  }

  function prepare() {
    if (phase === "ready") return Promise.resolve(status());
    if (!preparing) {
      preparing = prepareOnce()
        .catch((error) => {
          engine.stop();
          const installed = models.isInstalled(root(), model);
          if (error?.name === "AbortError") setPhase(installed ? "downloaded" : "missing");
          else setPhase("error", plainError(error, model));
          throw error?.name === "AbortError" ? new Error("Download canceled") : new Error(plainError(error, model));
        })
        .finally(() => {
          preparing = null;
        });
    }
    return preparing.then(status);
  }

  ipcMain.handle("voice:status", () => status());
  ipcMain.handle("voice:prepare", () => prepare());
  ipcMain.handle("voice:cancelDownload", () => {
    download?.abort();
  });

  ipcMain.handle("voice:requestMicAccess", async () => {
    if (process.platform !== "darwin") return true;
    const { systemPreferences } = require("electron");
    if (systemPreferences.getMediaAccessStatus("microphone") === "granted") return true;
    return systemPreferences.askForMediaAccess("microphone");
  });

  ipcMain.handle("voice:transcribe", async (_event, input, sampleRate, options) => {
    const samples = toFloat32(input);
    if (!samples) throw new Error("No audio to transcribe.");
    const rate = Number(sampleRate);
    if (!Number.isFinite(rate) || rate < 8000 || rate > 192000) throw new Error("Unsupported sample rate.");
    if (samples.length > rate * MAX_CLIP_SECONDS) throw new Error(`Recordings are limited to ${MAX_CLIP_SECONDS / 60} minutes.`);
    const partial = Boolean(options && options.partial);
    if (phase !== "ready") {
      if (!models.isInstalled(root(), model)) throw new Error("The speech model isn't downloaded yet.");
      if (partial) return { text: "", discarded: "not-ready", audioMs: 0 };
      await prepare();
    }
    const result = await engine.request("transcribe", { samples, sampleRate: rate, partial });
    return {
      text: cleanTranscript(result.text),
      discarded: result.discarded,
      audioMs: result.audioMs,
      decodeMs: result.decodeMs,
    };
  });

  app.on("will-quit", () => engine.stop());
}

module.exports = { register };
