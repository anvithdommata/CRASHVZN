/**
 * The game-engine half: turns an incident spec from the vision model (or the prepared demo spec) into a scene the existing viewer can play.
 *
 * Road, surroundings and vehicles come from the app's own builders (road/spec.ts standards,
 * scene/roads/*, scene/cars.ts), so a reconstructed scene looks like the hand-built ones. The vision model only
 * supplies the numbers: what kind of road, which of ENVIRONMENT_PRESETS, every vehicle's
 * keyframes (and forces, which are not used for motion). Motion is planned in incident/motion.ts.
 *
 * Frames: the vision model works in the plan frame (x along the main road, y to its left). The scene is
 * x = plan x, z = -plan y; a plan heading h faces scene direction (cos h, -sin h).
 */
import * as THREE from "three";
import type { SceneInfo, VehicleInfo } from "@/data/scenes";
import { planMotion, trackAt, type LaneModel, type MotionPlan } from "@/incident/motion";
import { ENVIRONMENT_PRESETS, type IncidentSpec, type SpecObject, type StaticObject } from "@/incident/spec";
import { crossSection, FRICTION, markingLayout, resolveRoadSpec, ROUNDABOUTS, VERGE_WIDTH, type RoadSpec } from "@/road/spec";
import { makeVehicle, type VehicleKind } from "@/scene/cars";
import type { Painter } from "@/scene/draw";
import type { SceneEnvironment } from "@/scene/environment";
import { motorway, registerLayout, type Layout, type Pose } from "@/scene/layouts";
import { fourWayIntersection } from "@/scene/roads/intersection";
import { roundabout } from "@/scene/roads/roundabout";
import { drawStaticObjects } from "@/scene/roads/median";

export const AI_FOLDER = "AI reconstructions";
export const VERIFIED_FOLDER = "Measured reconstructions";
export const VERIFIED_BASIS =
  "measured frame by frame from the calibrated crash camera (fitted burned-in wireframes, Kalman/RTS smoothed); some tracks adjusted or extrapolated, see the scene caveats";
export const AI_BASIS =
  "interpolated from vision-model (Codex or Claude) estimates of sampled footage; positions, velocities and forces are uncertain";

/** Categories the viewer can draw. Pedestrians, bikes and motorcycles are recorded but not drawn yet. */
const RENDERABLE = new Set(["sedan", "hatchback", "suv", "pickup", "van", "truck", "bus", "other"]);

export type EngineReport = {
  seed: number;
  crash: MotionPlan["crash"];
  tiers: { crash: string[]; background: string[] };
  removed: MotionPlan["removed"];
  notes: string[];
  adjustments: Record<string, string[]>;
  caveats: string[];
};

export type IncidentScene = { scene: SceneInfo; layout: Layout; report: EngineReport };

const kindOf = (object: SpecObject): VehicleKind =>
  object.category === "van" ? "van" : object.category === "truck" || object.category === "bus" ? "truck" : "car";

const styleWord = (object: SpecObject) =>
  object.category === "suv" || object.category === "pickup" ? "suv" : object.category === "hatchback" ? "hatchback" : "sedan";

/** Real size of the model the viewer will draw, so contacts are computed on the visible bodies. */
const modelSizes = new Map<string, { length: number; width: number }>();
function modelSize(kind: VehicleKind, style: string) {
  const key = `${kind}/${style}`;
  let size = modelSizes.get(key);
  if (!size) {
    const rig = makeVehicle(kind, "#888888", "measure", style);
    const box = new THREE.Box3().setFromObject(rig.root);
    size = { length: box.max.z - box.min.z, width: box.max.x - box.min.x };
    rig.root.traverse((node) => {
      if (node instanceof THREE.Mesh) node.geometry.dispose();
    });
    modelSizes.set(key, size);
  }
  return size;
}

/** Scene-frame pose from a plan-frame position and heading. */
export const planToPose = (x: number, y: number, headingDeg: number): Pose => {
  const h = (headingDeg * Math.PI) / 180;
  return { x, z: -y, yaw: Math.atan2(Math.cos(h), -Math.sin(h)) };
};

/** A plain undivided road along x through the site. */
function straightRoad(p: Painter, spec: RoadSpec) {
  const section = crossSection(spec);
  const layout = markingLayout(spec);
  const m = spec.markings;
  const west = -p.reach([0, 0], [-1, 0]);
  const east = p.reach([0, 0], [1, 0]);
  const a: [number, number] = [west, 0];
  const b: [number, number] = [east, 0];
  const right = section.pavedHalfWidthForward;
  const left = section.pavedHalfWidthBackward;
  p.paveStrip(a, b, -left, right);
  p.verge(a, b, right, right + VERGE_WIDTH);
  p.verge(a, b, -left, -left - VERGE_WIDTH);
  p.obstacle(a, b, Math.max(left, right) + VERGE_WIDTH + 1);
  const line = (t: number): [number, number][] => [[west, t], [east, t]];
  const phase = (style: { dash: number; gap: number }) => (style.dash > 0 ? -west % (style.dash + style.gap) : 0);
  for (const t of layout.center) p.styled(line(t), m.centerLine, m.centerLine.color, phase(m.centerLine));
  for (const t of [...layout.forwardLanes, ...layout.backwardLanes]) p.styled(line(t), m.laneLine, "white", phase(m.laneLine));
  for (const t of [layout.forwardEdge, layout.backwardEdge]) if (t !== undefined) p.styled(line(t), m.edgeLine);
}

/**
 * layouts.ts motorway(), drawn from measured lines instead of a standard: each carriageway's lines
 * are distances from the median barrier (inner edge, lane lines, outer edge), so lane count and
 * every lane width can differ per lane and per side. Scene offsets: + is the +x carriageway.
 */
function measuredDividedRoad(p: Painter, main: RoadSpec, forward: number[], backward: number[], staticBarrier = false) {
  const m = main.markings;
  const west = -p.reach([0, 0], [-1, 0]);
  const east = p.reach([0, 0], [1, 0]);
  const a: [number, number] = [west, 0];
  const e: [number, number] = [east, 0];
  const right = forward[forward.length - 1] + main.outerShoulder;
  const left = backward[backward.length - 1] + main.outerShoulder;
  p.paveStrip(a, e, -left, right);
  p.verge(a, e, right, right + VERGE_WIDTH);
  p.verge(a, e, -left, -left - VERGE_WIDTH);
  p.obstacle(a, e, Math.max(left, right) + VERGE_WIDTH + 1);
  const line = (t: number): [number, number][] => [[west, t], [east, t]];
  const phase = (style: { dash: number; gap: number }) => (style.dash > 0 ? -west % (style.dash + style.gap) : 0);
  for (const [lines, sign] of [[forward, 1], [backward, -1]] as const) {
    lines.forEach((t, i) => {
      if (i === 0 || i === lines.length - 1) p.styled(line(sign * t), m.edgeLine);
      else p.styled(line(sign * t), m.laneLine, "white", phase(m.laneLine));
    });
  }
  if (!staticBarrier) p.barrier(a, e);
  p.guardrail([east, right + 0.5], [west, right + 0.5]);
  p.guardrail([west, -left - 0.5], [east, -left - 0.5]);
}

/** Measured lines, if valid: at least 2 values, increasing, lanes 2-6 m wide. */
function measuredLines(lines: number[] | undefined) {
  if (!Array.isArray(lines) || lines.length < 2 || lines.length > 9 || lines[0] < 0) return null;
  for (let i = 1; i < lines.length; i++) if (!(lines[i] - lines[i - 1] > 2 && lines[i] - lines[i - 1] < 6)) return null;
  return lines;
}

function roadFor(spec: IncidentSpec) {
  const r = spec.road;
  const divided = r.kind === "divided_highway";
  const main = resolveRoadSpec({
    region: r.region,
    roadClass: divided ? "motorway" : r.road_class === "motorway" ? "arterial" : r.road_class,
    database: { lanesForward: r.lanes_each_way, lanesBackward: r.lanes_each_way, divided, speedLimit: r.speed_limit_mps ?? undefined },
    observed: { surface: r.surface, lanesForward: r.lanes_each_way, lanesBackward: r.lanes_each_way },
  });
  const cross = resolveRoadSpec({
    region: r.region,
    roadClass: r.road_class === "local" ? "local" : "collector",
    database: { lanesForward: r.cross_lanes_each_way, lanesBackward: r.cross_lanes_each_way, divided: false },
    observed: { surface: r.surface },
  });
  const section = crossSection(main);
  // Forward (+x) traffic drives right of the centre line, at scene +z, which is plan -y.
  let lanes: LaneModel | undefined =
    r.kind === "roundabout" ? undefined : { forward: section.forwardLaneCenters.map((o) => -o), backward: section.backwardLaneCenters.map((o) => -o) };
  const fLines = divided ? measuredLines(r.lane_lines_forward_m) : null;
  const bLines = divided ? measuredLines(r.lane_lines_backward_m) : null;
  if (fLines && bLines && lanes) {
    const centres = (l: number[]) => l.slice(1).map((t, i) => (t + l[i]) / 2);
    lanes = { forward: centres(fLines).map((o) => -o), backward: centres(bLines) };
  }
  const build = (p: Painter) => {
    const statics = (spec as { static_objects?: StaticObject[] }).static_objects;
    if (fLines && bLines) measuredDividedRoad(p, main, fLines, bLines, !!statics?.some((o) => o.kind === "barrier"));
    else if (r.kind === "divided_highway") motorway(p, main);
    else if (r.kind === "intersection") fourWayIntersection(p, main, cross);
    else if (r.kind === "roundabout") {
      roundabout(p, [0, 0], ROUNDABOUTS[r.region], [0, Math.PI / 2, Math.PI, -Math.PI / 2].map((angle) => ({ angle, spec: cross })));
    } else straightRoad(p, main);
    drawStaticObjects(p, statics);
    p.finish();
  };
  return { main, lanes, build };
}

/** A force the vision model reported, in the scene frame (x, 0, z), newtons; stored as force_reported. */
export type SceneForce = { t: number; force: [number, number, number]; cause: string; note: string };

export function buildIncidentScene(input: {
  id: string;
  spec: IncidentSpec;
  seed: number;
  created: string;
  sourceVideo?: SceneInfo["sourceVideo"];
}): IncidentScene {
  const { id, seed } = input;
  // Work on a copy: sizes are aligned to the drawn models below.
  const spec: IncidentSpec = structuredClone(input.spec);
  const unsupported = spec.objects.filter((o) => !RENDERABLE.has(o.category));
  spec.objects = spec.objects.filter((o) => RENDERABLE.has(o.category));
  const scales = new Map<string, number>();
  for (const object of spec.objects) {
    const size = modelSize(kindOf(object), styleWord(object));
    const scale = Math.min(1.35, Math.max(0.75, object.length_m / size.length));
    scales.set(object.id, scale);
    object.length_m = size.length * scale;
    object.width_m = size.width * scale;
  }

  const road = roadFor(spec);
  const friction = FRICTION[spec.road.surface];
  const plan = planMotion(spec, { lanes: road.lanes });

  // Site: everything that happens on screen, plus a margin.
  let maxX = 40;
  let maxY = 28;
  for (const v of plan.vehicles) {
    for (const k of v.object.keyframes) {
      maxX = Math.max(maxX, Math.abs(k.x_m) + 15);
      maxY = Math.max(maxY, Math.abs(k.y_m) + 12);
    }
  }
  if (plan.crash) {
    for (const v of plan.vehicles.filter((item) => plan.crash!.participants.includes(item.object.id))) {
      for (let t = Math.max(0, plan.crash.start_s - 3); t <= plan.crash.end_s; t += 0.25) {
        const { p } = trackAt(v.track, t);
        maxX = Math.max(maxX, Math.abs(p[0]) + 15);
        maxY = Math.max(maxY, Math.abs(p[1]) + 12);
      }
    }
  }
  const site = { width: Math.min(400, 2 * maxX), depth: Math.min(220, 2 * maxY) };

  let focus: [number, number, number] = [0, 0, 0];
  if (plan.crash) {
    const points = plan.vehicles
      .filter((v) => plan.crash!.participants.includes(v.object.id))
      .map((v) => trackAt(v.track, plan.crash!.start_s).p);
    if (points.length) {
      focus = [points.reduce((s, p) => s + p[0], 0) / points.length, 0, -points.reduce((s, p) => s + p[1], 0) / points.length];
    }
  }

  const layout: Layout = {
    id,
    site,
    camera: { position: [focus[0] + 24, 22, focus[2] + 30], target: focus },
    build: road.build,
    vehicles: plan.vehicles.map((v) => ({
      id: v.object.id,
      kind: kindOf(v.object),
      scale: scales.get(v.object.id),
      poseAt: (time: number) => {
        const { p, h } = trackAt(v.track, time);
        const frames = v.object.keyframes;
        // Not on the road before its first observation or after its last (it drove in or out of view).
        const hidden = frames.length > 0 && (time < frames[0].t_s - 1e-6 || time > frames[frames.length - 1].t_s + 1e-6);
        return { ...planToPose(p[0], p[1], h), hidden };
      },
    })),
    ...(plan.crash ? { collision: { impactTime: plan.crash.start_s, endTime: plan.crash.end_s, vehicleIds: plan.crash.participants } } : {}),
  };
  registerLayout(layout);

  const crashIds = new Set(plan.crash?.participants ?? []);
  const vehicles: VehicleInfo[] = plan.vehicles.map((v, index) => ({
    id: v.object.id,
    label: v.object.label,
    color: v.object.color_hex,
    type: v.object.category === "pickup" ? "truck" : v.object.category === "other" ? "sedan" : v.object.category,
    aliases: [
      `car ${index + 1}`,
      `the ${v.object.color_name} ${v.object.category}`,
      ...(v.object.make ? [`the ${v.object.make}`, `the ${v.object.color_name} ${v.object.make}`] : []),
      ...(v.object.model ? [`the ${v.object.model}`] : []),
    ],
    involvement: crashIds.has(v.object.id) ? "crash" : "background",
    massKg: v.object.mass_kg,
    // Same window poseAt uses for `hidden`.
    ...(v.object.keyframes.length ? { visibleFrom: v.object.keyframes[0].t_s, visibleTo: v.object.keyframes[v.object.keyframes.length - 1].t_s } : {}),
  }));

  // The prepared demo spec (measured frame by frame by the demo-incident/measure scripts), not a model reading.
  // "hand-verified" is the spec's historical version prefix, kept so saved scenes still match.
  const verified = spec.prompt_version.startsWith("hand-verified");
  const environment: SceneEnvironment = { ...ENVIRONMENT_PRESETS[spec.environment_preset] };
  const windRad = (spec.wind.toward_deg * Math.PI) / 180;
  const scene: SceneInfo = {
    id,
    title: spec.title,
    location: spec.location_guess,
    detail: `${verified ? "Measured reconstruction" : "AI reconstruction"} · ${vehicles.length} vehicle${vehicles.length === 1 ? "" : "s"}`,
    duration: spec.duration_s,
    impactTime: plan.crash?.start_s ?? null,
    crashEnd: plan.crash?.end_s ?? null,
    crashVehicles: plan.crash?.participants ?? [],
    startTime: plan.crash ? Math.max(0, plan.crash.start_s - 4) : 0,
    folder: verified ? VERIFIED_FOLDER : AI_FOLDER,
    created: input.created,
    sourceVideo: input.sourceVideo,
    kind: "proxy",
    vehicles,
    environment,
    environmentSource: verified ? "Read from the footage" : "Vision-model scene reading",
    basis: verified ? VERIFIED_BASIS : AI_BASIS,
    physics: {
      wind: [spec.wind.speed_mps * Math.cos(windRad), 0, -spec.wind.speed_mps * Math.sin(windRad)],
      gradePercent: spec.road.grade_percent,
      surface: spec.road.surface,
      mu: friction.mu,
    },
    // The model's own force readings (pass 2, crash vehicles), plan frame → scene frame. They don't
    // drive motion; the database stores the nearest one next to the derived force as force_reported.
    reportedForces: Object.fromEntries(
      plan.vehicles
        .filter((v) => v.object.forces.length > 0)
        .map((v) => [
          v.object.id,
          v.object.forces.map((f): SceneForce => ({ t: f.t_s, force: [f.fx_n, 0, -f.fy_n], cause: f.cause, note: f.note })),
        ]),
    ),
  };

  const report: EngineReport = {
    seed,
    crash: plan.crash,
    tiers: { crash: [...crashIds], background: vehicles.filter((v) => v.involvement === "background").map((v) => v.id) },
    removed: [
      ...plan.removed,
      ...unsupported.map((o) => ({ id: o.id, label: o.label, reason: `${o.category}s aren't drawn by the viewer yet` })),
    ],
    notes: plan.notes,
    adjustments: Object.fromEntries(plan.vehicles.filter((v) => v.adjustments.length).map((v) => [v.object.id, v.adjustments])),
    caveats: spec.caveats,
  };
  return { scene, layout, report };
}
