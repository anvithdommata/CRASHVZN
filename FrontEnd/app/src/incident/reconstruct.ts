/**
 * Renderer side of a footage reconstruction: footage → vision model (main process, Codex or Claude Code) → engine → library + MongoDB.
 */
import type { SceneInfo } from "@/data/scenes";
import { buildIncidentScene } from "@/incident/engine";
import type { IncidentSpec } from "@/incident/spec";
import { ensureKinematics, forgetKinematics } from "@/kinematics/store";
import { useAppStore, type UploadItem } from "@/store/useAppStore";

function api() {
  const analysis = window.crashvzn?.analysis;
  if (!analysis) throw new Error("Footage reconstruction runs in the desktop app.");
  return analysis;
}

const clean = (error: unknown) =>
  error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(error);

/** Length of a local video in seconds, read by the browser (null if it can't tell). */
function videoDuration(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    const video = document.createElement("video");
    const url = URL.createObjectURL(file);
    const done = (value: number | null) => {
      URL.revokeObjectURL(url);
      resolve(value);
    };
    video.preload = "metadata";
    video.onloadedmetadata = () => done(Number.isFinite(video.duration) && video.duration > 0 ? video.duration : null);
    video.onerror = () => done(null);
    video.src = url;
  });
}

const newSeed = () => (Math.random() * 2 ** 31) >>> 0;

function build(sceneId: string, spec: IncidentSpec, seed: number, created: string, sourceVideo?: SceneInfo["sourceVideo"]) {
  const built = buildIncidentScene({ id: sceneId, spec, seed, created, sourceVideo });
  forgetKinematics(sceneId);
  useAppStore.getState().upsertScene(built.scene);
  return built;
}

/** Sends the queued videos (one incident, up to 4 views) to the vision model and opens the result. */
export async function reconstructFootage(uploads: UploadItem[], opts: { refresh?: boolean } = {}) {
  const store = useAppStore.getState();
  const videos = uploads.filter((upload) => upload.file.type.startsWith("video/") || /\.(mp4|mov|m4v|mkv|avi|webm)$/i.test(upload.name));
  if (videos.length === 0) {
    store.setAnalysisJob({ state: "error", error: "Queue at least one video first." });
    return;
  }
  const off = api().onProgress((progress) =>
    useAppStore.getState().setAnalysisJob({ state: "running", stage: progress.stage, detail: progress.detail }),
  );
  store.setAnalysisJob({ state: "running", stage: "Starting", detail: "Preparing the footage…" });
  try {
    const durations = await Promise.all(videos.map((upload) => videoDuration(upload.file)));
    const analysis = await api().analyze(
      videos.map((upload) => upload.file),
      { ...opts, durations },
    );
    useAppStore.getState().setAnalysisJob({ state: "running", stage: "Building the scene", detail: "Running the physics engine…" });
    // "gemini-" is a historical prefix kept so scene ids saved in MongoDB stay stable.
    const sceneId = `gemini-${analysis.analysisId.slice(0, 12)}`;
    const seed = newSeed();
    const created = new Date().toISOString().slice(0, 10);
    const sourceVideo = { url: URL.createObjectURL(videos[0].file), name: videos[0].name };
    const built = build(sceneId, analysis.spec, seed, created, sourceVideo);
    await api().saveScene({ sceneId, analysisId: analysis.analysisId, seed, created, title: built.scene.title, report: built.report });
    useAppStore.getState().setAnalysisJob({ state: "running", stage: "Saving motion data", detail: "Storing per-frame kinematics and forces…" });
    await ensureKinematics(built.scene);
    const removed = built.report.removed.length ? ` ${built.report.removed.length} object(s) left out.` : "";
    useAppStore.getState().setAnalysisJob({
      state: "done",
      sceneId,
      message: `${analysis.cached ? "Loaded the stored model reading" : analysis.models.includes("hand-verified") ? "Loaded the prepared measured reconstruction" : `Read by ${analysis.models.join(" + ")}`}: ${built.scene.vehicles.length} vehicles.${removed}`,
    });
    useAppStore.getState().openScene(sceneId);
  } catch (error) {
    useAppStore.getState().setAnalysisJob({ state: "error", error: clean(error) });
  } finally {
    off();
  }
}

/** At startup: rebuilds every AI scene saved in MongoDB and puts it back in the library. */
export async function loadSavedScenes() {
  const analysis = window.crashvzn?.analysis;
  if (!analysis) return;
  try {
    const saved = await analysis.listScenes();
    for (const record of saved.reverse()) {
      try {
        const built = build(record.sceneId, record.spec, record.seed, record.created);
        await ensureKinematics(built.scene);
      } catch (error) {
        console.error(`Couldn't rebuild saved scene ${record.sceneId}`, error);
      }
    }
  } catch (error) {
    console.error("Couldn't load saved scenes", error);
  }
}
