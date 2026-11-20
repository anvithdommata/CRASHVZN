/**
 * Renderer access to the kinematics database. The data lives in MongoDB in the main process;
 * this module makes sure each preview scene's frames are stored (once per content change) and
 * reads them back for the assistant's tools and the panel.
 */
import { BUILTIN_SCENES, type SceneInfo } from "@/data/scenes";
import type { KinematicsFrame, KinematicsIncident } from "@/electron.d";
import { deriveSceneKinematics } from "@/kinematics/derive";

const syncs = new Map<string, Promise<boolean>>();

function api() {
  const kinematics = window.crashvzn?.kinematics;
  if (!kinematics) throw new Error("Motion data is stored in the desktop app's database; it isn't available in a plain browser.");
  return kinematics;
}

const clean = (error: unknown) =>
  new Error(error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(error));

/** Stores a scene's frames if the database doesn't have this exact version. Resolves false when the scene has none. */
export function ensureKinematics(scene: SceneInfo): Promise<boolean> {
  const existing = syncs.get(scene.id);
  if (existing) return existing;
  const job = (async () => {
    const derived = deriveSceneKinematics(scene);
    if (!derived) return false;
    await api().sync(derived.meta, derived.frames);
    return true;
  })();
  job.catch(() => syncs.delete(scene.id));
  syncs.set(scene.id, job);
  return job;
}

/** Drops the remembered sync for a scene (after it was rebuilt), so the next read stores the new frames. */
export function forgetKinematics(sceneId: string) {
  syncs.delete(sceneId);
}

/** Called once at startup in the desktop app: loads every built-in scene into the database. */
export async function syncBuiltinScenes() {
  if (!window.crashvzn?.kinematics) return;
  for (const scene of BUILTIN_SCENES) {
    try {
      await ensureKinematics(scene);
    } catch (error) {
      console.error(`Couldn't store motion data for ${scene.id}`, error);
    }
  }
}

export async function incidentMeta(scene: SceneInfo): Promise<KinematicsIncident> {
  if (!(await ensureKinematics(scene).catch((error) => Promise.reject(clean(error))))) {
    throw new Error("This reconstruction has no per-frame motion data yet.");
  }
  return api().incident(scene.id).catch((error) => Promise.reject(clean(error)));
}

export async function sampleKinematics(scene: SceneInfo, entityId: string, times: number[]): Promise<(KinematicsFrame | null)[]> {
  await incidentMeta(scene);
  return api().sample(scene.id, entityId, times).catch((error) => Promise.reject(clean(error)));
}
