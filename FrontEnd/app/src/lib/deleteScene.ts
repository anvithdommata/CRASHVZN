import { forgetKinematics } from "@/kinematics/store";
import { isBuiltinScene, useAppStore } from "@/store/useAppStore";

const clean = (error: unknown) =>
  error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(error);

/** What deleting a scene actually does, worded for the confirmation dialog. */
export function deleteEffect(sceneId: string): { verb: "Delete" | "Hide"; detail: string } {
  const scene = useAppStore.getState().scenes.find((item) => item.id === sceneId);
  if (isBuiltinScene(sceneId)) {
    return { verb: "Hide", detail: "This example ships with the app, so it's hidden rather than deleted. You can bring examples back from the library." };
  }
  if (scene?.kind === "splat") {
    return { verb: "Delete", detail: "The splat is removed from this session. The file on your disk isn't touched." };
  }
  return {
    verb: "Delete",
    detail:
      "The saved reconstruction and its per-frame motion data are removed from the database. The model's reading of the footage stays cached, so reconstructing the same footage again is quick.",
  };
}

/**
 * Removes a reconstruction: from the database first (so a failure leaves the library as it was),
 * then from the library. Built-in examples are hidden; splats only live in memory.
 */
export async function deleteScene(sceneId: string) {
  const scene = useAppStore.getState().scenes.find((item) => item.id === sceneId);
  if (!scene) return;
  if (!isBuiltinScene(sceneId) && scene.kind === "proxy") {
    const analysis = window.crashvzn?.analysis;
    if (analysis?.deleteScene) {
      try {
        await analysis.deleteScene(sceneId);
      } catch (error) {
        throw new Error(`Couldn't delete "${scene.title}": ${clean(error)}`);
      }
    }
    forgetKinematics(sceneId);
  }
  // Footage blob URLs aren't revoked: an upload or another scene may still be playing the same one.
  useAppStore.getState().removeScene(sceneId);
}
