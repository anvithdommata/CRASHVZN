import { computeCrashForces } from "../crash-forces";
import type { SceneController } from "../controller";
import { matchEntities } from "../entity-match";
import { CAMERA_PRESETS } from "../types";
import type {
  CameraPreset,
  CameraState,
  CrashPeriod,
  CrashPhase,
  Entity,
  ExportJob,
  KinematicsField,
  KinematicsReading,
  LibraryState,
  Marker,
  MeasureTarget,
  Measurement,
  SceneBounds,
  SceneEvent,
  SceneSummary,
  SeekRequest,
  TimelineState,
  TimeRef,
  ToggleTarget,
  Vec3,
} from "../types";

/**
 * In-memory stand-in for the app, used by the dev chat CLI and tests until the
 * Electron app's Zustand store implements SceneController. Numbers are made up
 * but self-consistent: two cars, crash from 4.0 s to 4.6 s, 8 s of footage.
 * World frame: +x east, +y up, -z north, origin at the crash point.
 */

export const MOCK_ENTITIES: Entity[] = [
  { id: "v1", label: "red Toyota Camry", color: "red", type: "sedan", make: "Toyota", model: "Camry", aliases: ["car 1", "the toyota"], visible_from_s: 0, visible_to_s: 8 },
  { id: "v2", label: "white Honda CR-V", color: "white", type: "suv", make: "Honda", model: "CR-V", aliases: ["car 2", "the honda", "the suv"], visible_from_s: 0, visible_to_s: 8 },
];

const CRASH: CrashPeriod = { start_s: 4.0, end_s: 4.6, vehicles: ["v1", "v2"] };

export const MOCK_EVENTS: SceneEvent[] = [
  { t: 2.6, type: "brake", vehicles: ["v1"], note: "Toyota begins braking" },
  { t: CRASH.start_s, type: "crash_start", vehicles: ["v1", "v2"], note: "Front of Toyota strikes the side of the Honda" },
  { t: CRASH.end_s, type: "crash_end", vehicles: ["v1", "v2"], note: "Both vehicles come to rest" },
];

/** Words people use for the crash events. */
const EVENT_ALIASES: Record<string, string> = { impact: "crash_start", crash: "crash_start", collision: "crash_start", crash_start: "crash_start", crash_end: "crash_end", rest: "crash_end", braking: "brake", brake: "brake" };

const DURATION = 8;
const BOUNDS: SceneBounds = { min: [-75, 0.3, -55], max: [25, 45, 55] };
const DEFAULT_CAMERA: CameraState = { position: [0, 30, 40], target: [0, 0, 0], distance_m: 50, following: null, pov: null, clamped: false };
const LIBRARY = [{ name: "Demo", incidents: [{ id: "mock-001", title: "Intersection side impact (mock)", duration_s: DURATION, created: "2026-11-14" }] }];

interface TrackSample { pos: Vec3; vel: Vec3; speed: number; acc: number; heading: number; mass: number }

/**
 * 1-D motion along a fixed direction from a piecewise speed profile, placed so
 * the vehicle is at the origin at crash start.
 */
function track(dir: Vec3, heading: number, mass: number, speedAt: (t: number) => number, accAt: (t: number) => number) {
  const dt = 0.001;
  const distTo = (t: number) => {
    let d = 0;
    for (let s = 0; s < t; s += dt) d += speedAt(s) * Math.min(dt, t - s);
    return d;
  };
  const atCrash = distTo(CRASH.start_s);
  return (t: number): TrackSample => {
    const d = distTo(Math.max(0, Math.min(DURATION, t))) - atCrash;
    const v = speedAt(t);
    return { pos: [dir[0] * d, 0, dir[2] * d], vel: [dir[0] * v, 0, dir[2] * v], speed: v, acc: accAt(t), heading, mass };
  };
}

/** Toyota heading east: 17 m/s, brakes at 2.6 s (-4 m/s²), then crushes to a stop over the crash period. */
const toyotaImpactSpeed = 17 - 4 * (CRASH.start_s - 2.6);
const toyotaCrashDecel = -toyotaImpactSpeed / (CRASH.end_s - CRASH.start_s);
const toyota = track(
  [1, 0, 0], 90, 1500,
  (t) => (t < 2.6 ? 17 : t < CRASH.start_s ? 17 - 4 * (t - 2.6) : t < CRASH.end_s ? toyotaImpactSpeed + toyotaCrashDecel * (t - CRASH.start_s) : 0),
  (t) => (t < 2.6 ? 0 : t < CRASH.start_s ? -4 : t < CRASH.end_s ? toyotaCrashDecel : 0),
);

/** Honda heading south at a steady 11 m/s, stops over the crash period. */
const hondaCrashDecel = -11 / (CRASH.end_s - CRASH.start_s);
const honda = track(
  [0, 0, 1], 180, 1700,
  (t) => (t < CRASH.start_s ? 11 : t < CRASH.end_s ? 11 + hondaCrashDecel * (t - CRASH.start_s) : 0),
  (t) => (t < CRASH.start_s ? 0 : t < CRASH.end_s ? hondaCrashDecel : 0),
);

const TRACKS: Record<string, (t: number) => TrackSample> = { v1: toyota, v2: honda };

const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const r3 = (v: Vec3, d = 2): Vec3 => [round(v[0], d), round(v[1], d), round(v[2], d)];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const norm = (a: Vec3): Vec3 => scale(a, 1 / (len(a) || 1));
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const RAD = Math.PI / 180;
const COMPASS = ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"];

function phaseAt(t: number): CrashPhase {
  return t < CRASH.start_s ? "before_crash" : t <= CRASH.end_s ? "during_crash" : "after_crash";
}

export interface MockOptions {
  /** Start with the demo incident open (default) or on the home screen. */
  open?: boolean;
}

export class MockSceneController implements SceneController {
  camera: CameraState = structuredClone(DEFAULT_CAMERA);
  timeline: TimelineState = { t_s: 0, duration_s: DURATION, playing: false, speed: 1, t_rel_crash_s: -CRASH.start_s, phase: "before_crash" };
  markers: Marker[] = [];
  toggles: Record<string, boolean> = { trails: false, source_video: false, bounds: true };
  openId: string | null;
  /** Every call, in order — handy in tests and the dev CLI. */
  log: { method: string; args: unknown[] }[] = [];

  constructor(opts: MockOptions = {}) {
    this.openId = opts.open === false ? null : "mock-001";
  }

  private record(method: string, args: unknown[]) {
    this.log.push({ method, args });
  }

  private requireOpen() {
    if (!this.openId) throw new Error("No incident is open. The user is on the home screen; open one from the library first.");
  }

  private entity(id: string): Entity {
    this.requireOpen();
    const e = MOCK_ENTITIES.find((x) => x.id === id);
    if (!e) throw new Error(`No vehicle with id "${id}". Known ids: ${MOCK_ENTITIES.map((x) => x.id).join(", ")}.`);
    return e;
  }

  private eventTime(name: string): number {
    const type = EVENT_ALIASES[name.toLowerCase()] ?? name.toLowerCase();
    const ev = MOCK_EVENTS.find((e) => e.type === type);
    if (!ev) throw new Error(`No "${name}" event. Events: ${MOCK_EVENTS.map((e) => e.type).join(", ")}.`);
    return ev.t;
  }

  private resolveTime(at: TimeRef | undefined): number {
    if (!at) return this.timeline.t_s;
    const t = "t_s" in at ? at.t_s : this.eventTime(at.event) + (at.offset_s ?? 0);
    if (t < 0 || t > DURATION) throw new Error(`That's ${round(t, 2)} s, outside the footage (0 to ${DURATION} s).`);
    return t;
  }

  private setTime(t: number): TimelineState {
    const c = Math.max(0, Math.min(DURATION, t));
    this.timeline = { ...this.timeline, t_s: round(c, 3), t_rel_crash_s: round(c - CRASH.start_s, 3), phase: phaseAt(c) };
    return { ...this.timeline };
  }

  /** Clamp a point into the scene box. The look-at point may sit on the ground (floor 0). */
  private clamp(p: Vec3, floor = BOUNDS.min[1]): { p: Vec3; hit: boolean } {
    const q = p.map((v, i) => Math.max(i === 1 ? floor : BOUNDS.min[i]!, Math.min(BOUNDS.max[i]!, v))) as Vec3;
    return { p: q, hit: q.some((v, i) => v !== p[i]) };
  }

  private commit(position: Vec3, target: Vec3, extra: Partial<CameraState> = {}): CameraState {
    const pos = this.clamp(position);
    const tgt = this.clamp(target, Math.min(0, BOUNDS.min[1]));
    this.camera = { ...this.camera, ...extra, position: r3(pos.p), target: r3(tgt.p), distance_m: round(len(sub(pos.p, tgt.p))), clamped: pos.hit };
    return structuredClone(this.camera);
  }

  private placeCamera(target: Vec3, distance: number, yawDeg: number, pitchDeg: number, extra: Partial<CameraState> = {}): CameraState {
    const yaw = yawDeg * RAD;
    const pitch = Math.max(-89, Math.min(89, pitchDeg)) * RAD;
    const position: Vec3 = [
      target[0] + distance * Math.cos(pitch) * Math.sin(yaw),
      target[1] + distance * Math.sin(pitch),
      target[2] + distance * Math.cos(pitch) * Math.cos(yaw),
    ];
    return this.commit(position, target, extra);
  }

  private angles(): { yaw: number; pitch: number } {
    const d = sub(this.camera.position, this.camera.target);
    const r = len(d) || 1;
    return { yaw: Math.atan2(d[0], d[2]) / RAD, pitch: Math.asin(d[1] / r) / RAD };
  }

  private resolvePoint(t: MeasureTarget, time: number): Vec3 {
    if (typeof t === "string") {
      this.entity(t);
      return TRACKS[t]!(time).pos;
    }
    return t;
  }

  private summary(): SceneSummary {
    return {
      incident_id: this.openId!,
      title: LIBRARY[0]!.incidents[0]!.title,
      duration_s: DURATION,
      entities: MOCK_ENTITIES,
      events: MOCK_EVENTS,
      crash: CRASH,
      bounds: BOUNDS,
      source_videos: 2,
      timeline: { ...this.timeline },
      camera: structuredClone(this.camera),
    };
  }

  async listLibrary(): Promise<LibraryState> {
    this.record("listLibrary", []);
    return { folders: LIBRARY, open: this.openId };
  }

  async openIncident(incidentId: string) {
    this.record("openIncident", [incidentId]);
    const known = LIBRARY.flatMap((f) => f.incidents).find((i) => i.id === incidentId);
    if (!known) throw new Error(`No reconstruction "${incidentId}" in the library.`);
    this.openId = incidentId;
    return this.summary();
  }

  async closeIncident(): Promise<LibraryState> {
    this.record("closeIncident", []);
    this.openId = null;
    this.timeline = { ...this.timeline, playing: false };
    return { folders: LIBRARY, open: null };
  }

  async describe(): Promise<SceneSummary> {
    this.record("describe", []);
    this.requireOpen();
    return this.summary();
  }

  async findEntities(query: string) {
    this.record("findEntities", [query]);
    this.requireOpen();
    return matchEntities(MOCK_ENTITIES, query);
  }

  async focus(entityId: string, distanceM = 12) {
    this.record("focus", [entityId, distanceM]);
    this.entity(entityId);
    const { yaw, pitch } = this.angles();
    return this.placeCamera(TRACKS[entityId]!(this.timeline.t_s).pos, distanceM, yaw, Math.max(pitch, 15), { pov: null });
  }

  async panTo(target: { entity_id: string } | { point: Vec3 }) {
    this.record("panTo", [target]);
    this.requireOpen();
    const point = "point" in target ? target.point : TRACKS[this.entity(target.entity_id).id]!(this.timeline.t_s).pos;
    const delta = sub(point, this.camera.target);
    return this.commit(add(this.camera.position, delta), point, { following: null, pov: null });
  }

  async orbit(yawDeg: number, pitchDeg: number) {
    this.record("orbit", [yawDeg, pitchDeg]);
    this.requireOpen();
    const { yaw, pitch } = this.angles();
    return this.placeCamera(this.camera.target, this.camera.distance_m, yaw + yawDeg, pitch + pitchDeg, { pov: null });
  }

  async rotate(yawDeg: number, pitchDeg: number) {
    this.record("rotate", [yawDeg, pitchDeg]);
    this.requireOpen();
    // View direction is position → target; swing the target around the camera.
    const dir = sub(this.camera.target, this.camera.position);
    const r = len(dir) || 1;
    const yaw = Math.atan2(dir[0], dir[2]) - yawDeg * RAD; // positive yaw = look right (clockwise from above)
    const pitch = Math.max(-89 * RAD, Math.min(89 * RAD, Math.asin(dir[1] / r) + pitchDeg * RAD));
    const target = add(this.camera.position, [r * Math.cos(pitch) * Math.sin(yaw), r * Math.sin(pitch), r * Math.cos(pitch) * Math.cos(yaw)]);
    return this.commit(this.camera.position, target, { following: null });
  }

  async move(rightM: number, upM: number, forwardM: number) {
    this.record("move", [rightM, upM, forwardM]);
    this.requireOpen();
    const fwd = norm(sub(this.camera.target, this.camera.position));
    const right = norm(cross(fwd, [0, 1, 0]));
    const up = norm(cross(right, fwd));
    const delta = add(add(scale(right, rightM), scale(up, upM)), scale(fwd, forwardM));
    return this.commit(add(this.camera.position, delta), add(this.camera.target, delta), { following: null, pov: null });
  }

  async zoom(opts: { factor?: number; distance_m?: number }) {
    this.record("zoom", [opts]);
    this.requireOpen();
    const next = opts.distance_m ?? this.camera.distance_m / (opts.factor ?? 1.5);
    const { yaw, pitch } = this.angles();
    return this.placeCamera(this.camera.target, Math.max(1, next), yaw, pitch);
  }

  async setCamera(opts: { position?: Vec3; target?: Vec3 }) {
    this.record("setCamera", [opts]);
    this.requireOpen();
    return this.commit(opts.position ?? this.camera.position, opts.target ?? this.camera.target, { following: null, pov: null });
  }

  async preset(preset: CameraPreset) {
    this.record("preset", [preset]);
    this.requireOpen();
    const view = CAMERA_PRESETS[preset];
    if (!view) throw new Error(`Unknown view "${preset}". Use ${Object.keys(CAMERA_PRESETS).join(", ")}.`);
    return this.placeCamera(this.camera.target, this.camera.distance_m, view.yaw_deg, view.pitch_deg, { pov: null, following: null });
  }

  async follow(entityId: string | null) {
    this.record("follow", [entityId]);
    if (entityId) this.entity(entityId);
    this.camera = { ...this.camera, following: entityId, pov: null };
    return structuredClone(this.camera);
  }

  async pov(entityId: string | null) {
    this.record("pov", [entityId]);
    if (!entityId) {
      this.camera = { ...this.camera, pov: null };
      return structuredClone(this.camera);
    }
    this.entity(entityId);
    const s = TRACKS[entityId]!(this.timeline.t_s);
    const fwd: Vec3 = [Math.sin(s.heading * RAD), 0, -Math.cos(s.heading * RAD)];
    const eye: Vec3 = [s.pos[0], 1.2, s.pos[2]];
    return this.commit(eye, add(eye, scale(fwd, 10)), { following: null, pov: entityId });
  }

  async resetView() {
    this.record("resetView", []);
    this.requireOpen();
    this.camera = structuredClone(DEFAULT_CAMERA);
    return structuredClone(this.camera);
  }

  async seek(req: SeekRequest) {
    this.record("seek", [req]);
    this.requireOpen();
    if ("relative_s" in req) return this.setTime(this.timeline.t_s + req.relative_s);
    return this.setTime(this.resolveTime(req));
  }

  async play(speed?: number) {
    this.record("play", [speed]);
    this.requireOpen();
    if (speed !== undefined && (speed < 0.1 || speed > 4)) throw new Error("Playback speed must be between 0.1× and 4×.");
    this.timeline = { ...this.timeline, playing: true, speed: speed ?? this.timeline.speed };
    return { ...this.timeline };
  }

  async pause() {
    this.record("pause", []);
    this.requireOpen();
    this.timeline = { ...this.timeline, playing: false };
    return { ...this.timeline };
  }

  private reading(entityId: string, t: number, fields: KinematicsField[]): KinematicsReading {
    const s = TRACKS[entityId]!(t);
    const want = new Set<KinematicsField>(fields.length ? fields : ["speed", "acceleration", "heading"]);
    const sigma = 0.6; // m/s, mock uncertainty
    const out: KinematicsReading = { entity_id: entityId, t_s: round(t, 3), t_rel_crash_s: round(t - CRASH.start_s, 3), phase: phaseAt(t), source: "reconstruction" };
    if (want.has("position")) out.position = { value: r3(s.pos), unit: "m" };
    if (want.has("velocity")) out.velocity = { value: r3(s.vel), unit: "m/s" };
    if (want.has("speed")) {
      out.speed = {
        mps: { value: round(s.speed), unit: "m/s", sigma },
        mph: { value: round(s.speed * 2.23694, 1), unit: "mph", sigma: round(sigma * 2.23694, 1) },
        kmh: { value: round(s.speed * 3.6, 1), unit: "km/h", sigma: round(sigma * 3.6, 1) },
      };
    }
    if (want.has("acceleration")) out.acceleration = { value: round(s.acc), unit: "m/s²", sigma: 0.5, g: round(s.acc / 9.80665) };
    if (want.has("heading")) out.heading = { value: s.heading, unit: "deg", compass: COMPASS[Math.round(s.heading / 45) % 8]! };
    if (want.has("yaw_rate")) out.yaw_rate = { value: 0, unit: "deg/s" };
    if (want.has("forces")) {
      const dir = len(s.vel) > 0 ? norm(s.vel) : ([Math.sin(s.heading * RAD), 0, -Math.cos(s.heading * RAD)] as Vec3);
      const f = s.mass * s.acc;
      out.forces = {
        mass_kg: s.mass,
        net: { vector: r3(scale(dir, f), 0), magnitude: { value: round(Math.abs(f), 0), unit: "N", sigma: round(s.mass * 0.5, 0) } },
        model: "net force = mass × acceleration; air drag and friction not modeled separately",
      };
    }
    return out;
  }

  async queryKinematics(entityId: string, at: TimeRef | undefined, fields: KinematicsField[]): Promise<KinematicsReading> {
    this.record("queryKinematics", [entityId, at, fields]);
    this.entity(entityId);
    return this.reading(entityId, this.resolveTime(at), fields);
  }

  async querySeries(entityId: string, fromS: number, toS: number, stepS: number, fields: KinematicsField[]) {
    this.record("querySeries", [entityId, fromS, toS, stepS, fields]);
    this.entity(entityId);
    const from = Math.max(0, fromS);
    const to = Math.min(DURATION, toS);
    const samples: KinematicsReading[] = [];
    for (let i = 0; from + i * stepS <= to + 1e-9 && i <= 60; i++) samples.push(this.reading(entityId, from + i * stepS, fields));
    return { entity_id: entityId, step_s: stepS, samples };
  }

  async crashForces() {
    this.record("crashForces", []);
    this.requireOpen();
    return computeCrashForces({
      crash: CRASH,
      vehicles: MOCK_ENTITIES.map((e) => ({ id: e.id, label: e.label, mass_kg: TRACKS[e.id]!(0).mass })),
      sample: async (id, times) => times.map((t) => ({ position: TRACKS[id]!(t).pos })),
      speedSigma: 0.6,
    });
  }

  async measureDistance(a: MeasureTarget, b: MeasureTarget, at?: TimeRef): Promise<Measurement> {
    this.record("measureDistance", [a, b, at]);
    this.requireOpen();
    const t = this.resolveTime(at);
    const m = len(sub(this.resolvePoint(a, t), this.resolvePoint(b, t)));
    return { t_s: round(t, 3), distance: { m: round(m), ft: round(m * 3.28084, 1) }, a, b };
  }

  async addMarker(label: string, target: { point: Vec3 } | { entity_id: string }) {
    this.record("addMarker", [label, target]);
    this.requireOpen();
    const point = "point" in target ? target.point : TRACKS[this.entity(target.entity_id).id]!(this.timeline.t_s).pos;
    const marker: Marker = { id: `m${this.markers.length + 1}`, label, point, ...("entity_id" in target ? { entity_id: target.entity_id } : {}) };
    this.markers.push(marker);
    return marker;
  }

  async toggle(target: ToggleTarget, visible?: boolean) {
    this.record("toggle", [target, visible]);
    this.requireOpen();
    if (target.startsWith("vehicle:")) this.entity(target.slice("vehicle:".length));
    const next = visible ?? !(this.toggles[target] ?? true);
    this.toggles[target] = next;
    return { target, visible: next };
  }

  async exportVideo(opts: { camera_path?: string; range?: [number, number] }): Promise<ExportJob> {
    this.record("exportVideo", [opts]);
    this.requireOpen();
    return { job_id: `export-${Date.now()}`, status: "queued" };
  }
}
