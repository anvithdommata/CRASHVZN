/**
 * The motion half of the engine: turns the incident spec's observations (spec.ts) into a
 * trajectory for every vehicle, in the plan frame, sampled at SIM_HZ.
 *
 * Observed positions are authoritative. Nothing is simulated, queued, relocated or snapped:
 *
 *   - Between two keyframes the path is a cubic Hermite curve through both positions. Its end
 *     tangents are the keyframes' own reported velocity (speed_mps along heading_deg) when that
 *     agrees with the positions (within 45° and a factor of 2 of the straight-line velocity);
 *     otherwise the straight-line velocity is used, which makes that end linear. Headings are
 *     interpolated the short way round.
 *   - Before the first and after the last keyframe the pose is held (the engine hides the vehicle
 *     there, so it isn't drawn or stored).
 *   - A census-only vehicle (no keyframes, but a lane hint from the per-camera census) gets two
 *     synthesized keyframes: its lane centre, its census speed, passing the site's origin halfway
 *     through the time it was on camera. A stopped one waits in its lane upstream of the origin,
 *     one car length plus a gap per stopped vehicle in that lane. Every synthesized vehicle says so
 *     in its adjustments, because its position along the road is an assumption.
 *   - Anything else without keyframes is removed, with the reason.
 *
 * Velocities, accelerations and forces are derived later from these tracks (src/kinematics/derive.ts).
 * Pure TypeScript with no app imports, so it can be tested on its own. See docs/vision-pipeline.md.
 */
import type { IncidentSpec, Keyframe, SpecObject } from "./spec";

/** 50 Hz: a multiple of the demo footage's 12.5 fps, so every measured frame lands exactly on a sample. */
export const SIM_HZ = 50;
/** A keyframe's reported velocity is used as the curve tangent only if it is this close in direction... */
const MAX_TANGENT_ANGLE_DEG = 45;
/** ...and within this factor of the straight-line speed between the two keyframes. */
const MAX_TANGENT_SPEED_RATIO = 2;
/** Below this straight-line speed (m/s) a segment is treated as standing still: no curve. */
const STILL_MPS = 0.5;
/** Gap left between stopped census vehicles in one lane (m), on top of their length. */
const QUEUE_GAP_M = 2.5;
/** Where the first stopped census vehicle in a lane waits, upstream of the origin (m). */
const QUEUE_START_M = 12;

type V2 = [number, number];

export type Track = { x: Float64Array; y: Float64Array; h: Float64Array };

export type PlannedVehicle = {
  object: SpecObject;
  track: Track;
  /** Every way the track departs from plain interpolation of observed keyframes. */
  adjustments: string[];
};

export type LaneModel = {
  /** Plan-y of each lane centre for traffic moving +x, and for traffic moving -x. Innermost first. */
  forward: number[];
  backward: number[];
};

export type PlanOptions = {
  /** Lane centres of the main road, when it runs straight along x. Needed to place census-only vehicles. */
  lanes?: LaneModel;
};

export type MotionPlan = {
  duration: number;
  samples: number;
  vehicles: PlannedVehicle[];
  crash: { start_s: number; end_s: number; participants: string[] } | null;
  /** Objects not placed in the scene, with the reason. */
  removed: { id: string; label: string; reason: string }[];
  notes: string[];
};

const wrapDeg = (deg: number) => ((((deg + 180) % 360) + 360) % 360) - 180;
const rad = (deg: number) => (deg * Math.PI) / 180;

export function trackAt(track: Track, t: number): { p: V2; h: number } {
  const n = track.x.length;
  if (n < 2) return { p: [track.x[0], track.y[0]], h: track.h[0] };
  const f = Math.min(n - 1, Math.max(0, t * SIM_HZ));
  const i = Math.min(n - 2, Math.floor(f));
  const k = f - i;
  const dh = wrapDeg(track.h[i + 1] - track.h[i]);
  return { p: [track.x[i] + (track.x[i + 1] - track.x[i]) * k, track.y[i] + (track.y[i + 1] - track.y[i]) * k], h: track.h[i] + dh * k };
}

/** The keyframe's reported velocity if it agrees with the straight-line velocity `chord`, else `chord`. */
function tangent(frame: Keyframe, chord: V2): { v: V2; used: boolean } {
  const chordSpeed = Math.hypot(chord[0], chord[1]);
  if (chordSpeed < STILL_MPS) return { v: chord, used: false };
  const h = rad(frame.heading_deg);
  const v: V2 = [frame.speed_mps * Math.cos(h), frame.speed_mps * Math.sin(h)];
  const speed = frame.speed_mps;
  const cos = (v[0] * chord[0] + v[1] * chord[1]) / (Math.max(speed, 1e-9) * chordSpeed);
  const agrees =
    speed > 0 &&
    cos >= Math.cos(rad(MAX_TANGENT_ANGLE_DEG)) &&
    speed <= chordSpeed * MAX_TANGENT_SPEED_RATIO &&
    speed >= chordSpeed / MAX_TANGENT_SPEED_RATIO;
  return agrees ? { v, used: true } : { v: chord, used: false };
}

/** Cubic Hermite position between a and b at u ∈ [0, 1], tangents in m/s over a gap of dt seconds. */
function hermite(a: V2, b: V2, va: V2, vb: V2, dt: number, u: number): V2 {
  const u2 = u * u;
  const u3 = u2 * u;
  const h00 = 2 * u3 - 3 * u2 + 1;
  const h10 = u3 - 2 * u2 + u;
  const h01 = -2 * u3 + 3 * u2;
  const h11 = u3 - u2;
  return [
    h00 * a[0] + h10 * dt * va[0] + h01 * b[0] + h11 * dt * vb[0],
    h00 * a[1] + h10 * dt * va[1] + h01 * b[1] + h11 * dt * vb[1],
  ];
}

/** Samples keyframes into a SIM_HZ track. Returns the track and how many segment ends fell back to straight lines. */
function interpolate(frames: Keyframe[], n: number): { track: Track; rejected: number; segments: number } {
  const track: Track = { x: new Float64Array(n), y: new Float64Array(n), h: new Float64Array(n) };
  // Tangents per segment, decided once.
  const segs = frames.slice(0, -1).map((a, i) => {
    const b = frames[i + 1];
    const dt = b.t_s - a.t_s;
    const chord: V2 = dt > 0 ? [(b.x_m - a.x_m) / dt, (b.y_m - a.y_m) / dt] : [0, 0];
    const ta = tangent(a, chord);
    const tb = tangent(b, chord);
    return { a, b, dt, va: ta.v, vb: tb.v, rejected: Number(!ta.used) + Number(!tb.used) };
  });
  let segment = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SIM_HZ;
    while (segment < segs.length - 1 && t > segs[segment].b.t_s) segment++;
    const s = segs[segment];
    if (!s) {
      // A single keyframe: hold it.
      track.x[i] = frames[0].x_m;
      track.y[i] = frames[0].y_m;
      track.h[i] = frames[0].heading_deg;
      continue;
    }
    const u = s.dt > 0 ? Math.max(0, Math.min(1, (t - s.a.t_s) / s.dt)) : 0;
    const p = hermite([s.a.x_m, s.a.y_m], [s.b.x_m, s.b.y_m], s.va, s.vb, s.dt, u);
    track.x[i] = p[0];
    track.y[i] = p[1];
    track.h[i] = s.a.heading_deg + wrapDeg(s.b.heading_deg - s.a.heading_deg) * u;
  }
  const chordOnly = segs.filter((s) => Math.hypot(s.b.x_m - s.a.x_m, s.b.y_m - s.a.y_m) / Math.max(s.dt, 1e-9) >= STILL_MPS);
  return { track, rejected: chordOnly.reduce((sum, s) => sum + s.rejected, 0), segments: chordOnly.length * 2 };
}

/**
 * Two keyframes for a census-only vehicle: lane centre, census speed, passing x = 0 at the middle of
 * its on-camera window (or waiting upstream when stopped). `queued` counts stopped vehicles per lane.
 */
function censusKeyframes(object: SpecObject, lanes: LaneModel, queued: Map<string, number>): { frames: Keyframe[]; note: string } | null {
  const hint = object.lane_hint;
  if (!hint) return null;
  const centres = hint.direction === "with" ? lanes.forward : lanes.backward;
  if (!centres.length) return null;
  const lane = Math.min(centres.length - 1, Math.max(0, hint.lane_from_median - 1));
  const y = centres[lane];
  const sx = hint.direction === "with" ? 1 : -1;
  const heading = sx > 0 ? 0 : 180;
  const from = hint.first_seen_s;
  const to = Math.max(hint.last_seen_s, from + 1 / SIM_HZ);
  const where = `lane ${lane + 1} from the median, travelling ${sx > 0 ? "+x" : "-x"}, seen ${from.toFixed(1)}–${to.toFixed(1)} s by ${hint.cameras.join(", ")}`;
  if (hint.stopped || hint.speed_mps < STILL_MPS) {
    const key = `${hint.direction}/${lane}`;
    const slot = queued.get(key) ?? 0;
    queued.set(key, slot + 1);
    const x = -sx * (QUEUE_START_M + slot * (object.length_m + QUEUE_GAP_M));
    return {
      frames: [
        { t_s: from, x_m: x, y_m: y, heading_deg: heading, speed_mps: 0 },
        { t_s: to, x_m: x, y_m: y, heading_deg: heading, speed_mps: 0 },
      ],
      note: `placed from the camera census (${where}); stopped, so its position along the road is assumed: waiting upstream of the site, slot ${slot + 1} in its lane`,
    };
  }
  const mid = (from + to) / 2;
  const x = (t: number) => sx * hint.speed_mps * (t - mid);
  return {
    frames: [
      { t_s: from, x_m: x(from), y_m: y, heading_deg: heading, speed_mps: hint.speed_mps },
      { t_s: to, x_m: x(to), y_m: y, heading_deg: heading, speed_mps: hint.speed_mps },
    ],
    note: `placed from the camera census (${where}) at ${hint.speed_mps.toFixed(1)} m/s; its position along the road is assumed: it passes the site halfway through that window`,
  };
}

export function planMotion(spec: IncidentSpec, options: PlanOptions = {}): MotionPlan {
  const n = Math.floor(spec.duration_s * SIM_HZ + 1e-6) + 1;
  const vehicles: PlannedVehicle[] = [];
  const removed: MotionPlan["removed"] = [];
  const queued = new Map<string, number>();
  let synthesized = 0;
  for (const object of spec.objects) {
    const adjustments: string[] = [];
    let frames = object.keyframes;
    if (!frames.length) {
      const census = options.lanes ? censusKeyframes(object, options.lanes, queued) : null;
      if (!census) {
        removed.push({
          id: object.id,
          label: object.label,
          reason: object.lane_hint ? "only seen by the camera census, and this road has no straight lanes to place it in" : "no observed positions available",
        });
        continue;
      }
      // The engine plans on a clone of the spec (engine.ts), so the stored reading is never changed.
      object.keyframes = frames = census.frames;
      adjustments.push(census.note);
      synthesized++;
    }
    const { track, rejected, segments } = interpolate(frames, n);
    if (rejected > 0 && segments > 0) {
      adjustments.push(`used straight-line speed at ${rejected} of ${segments} keyframe ends where the reported speed or heading disagreed with the positions`);
    }
    vehicles.push({ object, track, adjustments });
  }
  const notes = [
    "Positions follow the reported observations: curves through each keyframe using the reported speed where it agrees with the positions, held outside them. Occlusion and uncalibrated footage limit accuracy; contacts and forces are not independently measured.",
  ];
  if (synthesized) notes.push(`${synthesized} vehicle${synthesized === 1 ? " was" : "s were"} seen only by the per-camera census; their lane, speed and timing are observed but their position along the road is assumed.`);
  return {
    duration: spec.duration_s,
    samples: n,
    vehicles,
    removed,
    crash: spec.crash
      ? { start_s: spec.crash.start_s, end_s: spec.crash.end_s, participants: spec.crash.participants.filter((id) => vehicles.some((v) => v.object.id === id)) }
      : null,
    notes,
  };
}
