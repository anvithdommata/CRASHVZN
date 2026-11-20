/**
 * Static roadside objects from an incident spec (median verge, median barrier, hedges), drawn with
 * the Painter's own primitives so they look like the rest of the road.
 *
 * Footprints are plan-frame polygons (x along the road, y to its left); the scene is x = plan x,
 * z = -plan y.
 */
import type { StaticObject } from "@/incident/spec";
import type { P, Painter } from "@/scene/draw";

const toScene = (footprint: [number, number][]): P[] => footprint.map(([x, y]) => [x, -y]);

/** The footprint's long axis: a centre line from end to end, and the width across it. */
function centreLine(points: P[]) {
  let best: [P, P] = [points[0], points[1]];
  let bestLength = -1;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (length > bestLength) {
      bestLength = length;
      best = [a, b];
    }
  }
  const u: P = [(best[1][0] - best[0][0]) / bestLength, (best[1][1] - best[0][1]) / bestLength];
  const n: P = [-u[1], u[0]];
  const along = points.map((p) => p[0] * u[0] + p[1] * u[1]);
  const across = points.map((p) => p[0] * n[0] + p[1] * n[1]);
  const mid = (Math.min(...across) + Math.max(...across)) / 2;
  const at = (s: number): P => [u[0] * s + n[0] * mid, u[1] * s + n[1] * mid];
  return { a: at(Math.min(...along)), b: at(Math.max(...along)), width: Math.max(...across) - Math.min(...across) };
}

/** Draws every static object. Returns true when one of them is a barrier. */
export function drawStaticObjects(p: Painter, objects: StaticObject[] | undefined): boolean {
  let barrier = false;
  for (const object of objects ?? []) {
    if (!Array.isArray(object.footprint_m) || object.footprint_m.length < 3) continue;
    const outline = toScene(object.footprint_m);
    const height = Math.max(0.02, object.height_m || 0.15);
    if (object.kind === "barrier") {
      const { a, b } = centreLine(outline);
      p.barrier(a, b);
      barrier = true;
    } else {
      // Median verge (the environment's island grass, snowed over in winter) or a low hedge: a grass-topped
      // raised block of the object's height.
      p.raised(outline, { height, top: "grass" });
    }
  }
  return barrier;
}
