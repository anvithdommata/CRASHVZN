/**
 * Video export: plays the chosen range at 1× and records the 3D view, with a watermark
 * burned into every frame so the result can't be mistaken for original footage.
 *
 * Records with the browser's MediaRecorder (MP4/H.264 where Chromium supports it, WebM
 * otherwise), so no ffmpeg is needed. Saved through a save dialog in the desktop app, or
 * downloaded in a plain browser.
 */
import { formatRelative } from "@/lib/time";
import { whenSceneReady } from "@/scene/activeScene";
import { useAppStore, type ExportJob } from "@/store/useAppStore";

export const WATERMARK = "DEMONSTRATIVE RECONSTRUCTION · NOT ORIGINAL FOOTAGE";
const FPS = 30;
const MAX_WIDTH = 1920;

let active: { stop: (reason: "done" | "cancelled") => void } | null = null;

function pickMimeType() {
  const candidates = ["video/mp4;codecs=avc1.42E01E", "video/mp4", "video/webm;codecs=vp9", "video/webm"];
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) ?? "";
}

function drawWatermark(ctx: CanvasRenderingContext2D, width: number, height: number, title: string, clock: string) {
  const pad = Math.round(height * 0.025);
  const size = Math.max(14, Math.round(height * 0.028));
  ctx.save();
  ctx.font = `700 ${size}px system-ui, -apple-system, Segoe UI, sans-serif`;
  const text = WATERMARK;
  const w = ctx.measureText(text).width + pad * 1.6;
  const h = size * 1.7;
  ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
  ctx.fillRect(pad, height - pad - h, w, h);
  ctx.fillStyle = "#ffffff";
  ctx.textBaseline = "middle";
  ctx.fillText(text, pad * 1.8, height - pad - h / 2);

  ctx.font = `500 ${Math.round(size * 0.85)}px system-ui, -apple-system, Segoe UI, sans-serif`;
  const info = `${title}  ·  ${clock}`;
  const iw = ctx.measureText(info).width + pad * 1.6;
  ctx.fillStyle = "rgba(0, 0, 0, 0.45)";
  ctx.fillRect(width - pad - iw, pad, iw, h);
  ctx.fillStyle = "#ffffff";
  ctx.fillText(info, width - pad - iw + pad * 0.8, pad + h / 2);
  ctx.restore();
}

export function cancelExport() {
  active?.stop("cancelled");
}

/** Starts an export of [start, end] seconds. Resolves once recording has started. */
export async function startExport(range: [number, number]): Promise<ExportJob> {
  if (active) throw new Error("An export is already running. Wait for it to finish or cancel it.");
  if (typeof MediaRecorder === "undefined") throw new Error("Video export isn't supported in this window.");
  const handle = await whenSceneReady();
  const store = useAppStore.getState();
  const scene = store.scenes.find((item) => item.id === store.selectedId);
  if (!scene || store.view !== "viewer") throw new Error("Open a reconstruction before exporting.");

  const mimeType = pickMimeType();
  const extension = mimeType.includes("mp4") ? "mp4" : "webm";
  const composite = document.createElement("canvas");
  const ctx = composite.getContext("2d");
  if (!ctx) throw new Error("Couldn't prepare the export canvas.");

  const job: ExportJob = { id: `export-${Date.now()}`, status: "rendering", progress: 0, range };
  const update = (patch: Partial<ExportJob>) => {
    const current = useAppStore.getState().exportJob;
    if (current?.id === job.id) useAppStore.getState().setExportJob({ ...current, ...patch });
  };
  store.setExportJob(job);

  const stream = composite.captureStream(FPS);
  const recorder = new MediaRecorder(stream, { mimeType: mimeType || undefined, videoBitsPerSecond: 12_000_000 });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  };

  const previous = { speed: store.speed };
  let outcome: "done" | "cancelled" = "done";
  let stopped = false;
  const stop = (reason: "done" | "cancelled") => {
    if (stopped) return;
    stopped = true;
    outcome = reason;
    handle.onFrame(null);
    unsubscribe();
    useAppStore.getState().setPlaying(false);
    useAppStore.getState().setSpeed(previous.speed);
    if (recorder.state !== "inactive") recorder.stop();
  };
  active = { stop };

  recorder.onstop = async () => {
    active = null;
    stream.getTracks().forEach((track) => track.stop());
    if (outcome === "cancelled") {
      update({ status: "cancelled" });
      return;
    }
    update({ status: "saving", progress: 1 });
    try {
      const blob = new Blob(chunks, { type: mimeType || "video/webm" });
      const safeTitle = scene.title.replace(/[^\w-]+/g, "_").slice(0, 60) || "reconstruction";
      const fileName = `${safeTitle}_${range[0].toFixed(1)}-${range[1].toFixed(1)}s_demonstrative.${extension}`;
      if (window.crashvzn?.saveExport) {
        const path = await window.crashvzn.saveExport(new Uint8Array(await blob.arrayBuffer()), fileName);
        update(path ? { status: "done", path } : { status: "cancelled" });
      } else {
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = fileName;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 30_000);
        update({ status: "done", path: fileName });
      }
    } catch (error) {
      update({ status: "error", error: error instanceof Error ? error.message : "Couldn't save the video." });
    }
  };

  // Stop when the user pauses or leaves the viewer mid-export.
  const unsubscribe = useAppStore.subscribe((state, prev) => {
    if (stopped) return;
    if (state.view !== "viewer" || state.selectedId !== prev.selectedId) stop("cancelled");
    else if (prev.playing && !state.playing && state.time < range[1] - 0.05) stop("cancelled");
  });

  handle.onFrame((canvas) => {
    const state = useAppStore.getState();
    const scaleDown = Math.min(1, MAX_WIDTH / canvas.width);
    const width = Math.round((canvas.width * scaleDown) / 2) * 2;
    const height = Math.round((canvas.height * scaleDown) / 2) * 2;
    if (composite.width !== width || composite.height !== height) {
      composite.width = width;
      composite.height = height;
    }
    ctx.drawImage(canvas, 0, 0, width, height);
    const clock = scene.impactTime == null ? `${state.time.toFixed(2)} s` : formatRelative(state.time, scene.impactTime);
    drawWatermark(ctx, width, height, scene.title, clock);
    update({ progress: Math.min(1, Math.max(0, (state.time - range[0]) / (range[1] - range[0]))) });
    if (state.time >= range[1] - 1e-3 || (!state.playing && state.time >= state.duration - 0.05)) stop("done");
  });

  // Start at the beginning of the range, in real time.
  useAppStore.setState({ time: range[0], speed: 1, playing: true });
  recorder.start(250);
  return job;
}
