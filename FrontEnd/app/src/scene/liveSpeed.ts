import { getLayout } from "@/scene/layouts";

const STEP = 0.05;
/** A jump this large between samples is a looped road sending the car back, not motion. */
const TELEPORT_M = 15;

/**
 * Speed (m/s) of a vehicle at scene time `t`, read off the layout's trajectory with a central
 * difference. Null when the vehicle is off the road at that moment or the scene has no layout
 * (a Gaussian splat). Same frame and units as kinematics/derive.ts.
 */
export function speedAt(sceneId: string, vehicleId: string, t: number): number | null {
  const motion = getLayout(sceneId)?.vehicles.find((item) => item.id === vehicleId);
  if (!motion) return null;
  const here = motion.poseAt(t);
  if (here.hidden) return null;
  let a = motion.poseAt(t - STEP);
  let b = motion.poseAt(t + STEP);
  let span = 2 * STEP;
  // At the edge of its time on the road, fall back to a one-sided difference.
  if (a.hidden) {
    a = here;
    span = STEP;
  }
  if (b.hidden) {
    b = here;
    span = a === here ? 0 : STEP;
  }
  if (span === 0) return null;
  const distance = Math.hypot(b.x - a.x, b.z - a.z);
  if (distance > TELEPORT_M) return null;
  return distance / span;
}

export const toKmh = (mps: number) => mps * 3.6;
export const toMph = (mps: number) => mps * 2.23694;
