/**
 * The app's implementation of the assistant's SceneController (packages/assistant/src/controller.ts).
 *
 * Every MCP tool, the fast path and the API-key adapters end up here, so the assistant can
 * only do what these functions allow: navigate, query the scene description, annotate and
 * export. Nothing here can change the reconstruction.
 *
 * Coordinates: the assistant's world frame is meters with +x east, +y up, -z north and the
 * origin at the crash point. The three.js scene uses the same axes but its own origin, so
 * every point crossing this boundary is shifted by `origin()`.
 *
 * Per-frame kinematics (positions, speeds, accelerations, forces) come from the MongoDB
 * frames collection in the main process (electron/kinematics.ts, src/kinematics/*), never
 * from the renderer's animation, so the assistant reports exactly what's stored.
 *
 * Fixed scenery (median verge, barrier) is in the same data as "static" entities: it can be
 * found, queried (always zero motion; the contact force on it is cancelled by its anchorage) and
 * measured to (nearest point of its footprint). scene_describe lists it with the contacts.
 */
import type { SceneController } from "@assistant/controller";
import { computeCrashForces } from "@assistant/crash-forces";
import { matchEntities } from "@assistant/entity-match";
import {
  CAMERA_PRESETS,
  type CameraPreset,
  type CameraState,
  type CrashPhase,
  type Entity,
  type ExportJob,
  type KinematicsField,
  type KinematicsReading,
  type KinematicsSeries,
  type LibraryState,
  type Marker as AssistantMarker,
  type MeasureTarget,
  type SceneEvent,
  type SceneSummary,
  type SeekRequest,
  type TimelineState,
  type TimeRef,
  type ToggleTarget,
  type Vec3,
} from "@assistant/types";
import type { SceneInfo } from "@/data/scenes";
import type { KinematicsFrame, KinVec3 } from "@/electron.d";
import { crashOrigin, sceneContacts, sceneStatics } from "@/kinematics/derive";
import { incidentMeta, sampleKinematics } from "@/kinematics/store";
import { startExport } from "@/lib/exportVideo";
import { whenSceneReady } from "@/scene/activeScene";
import { FREE_CAMERA } from "@/scene/camera";
import type { Point3, SceneHandle } from "@/scene/mountScene";
import { MAX_SPEED, MIN_SPEED, useAppStore } from "@/store/useAppStore";

const RAD = Math.PI / 180;
const DEFAULT_FOCUS_DISTANCE = 12;
const FOLLOW_DISTANCE = 18;

const COMPASS = ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"];
const MAX_SERIES_SAMPLES = 61;

const EVENT_ALIASES: Record<string, string> = {
  impact: "crash_start",
  crash: "crash_start",
  collision: "crash_start",
  hit: "crash_start",
  crash_start: "crash_start",
  start_of_crash: "crash_start",
  crash_end: "crash_end",
  end_of_crash: "crash_end",
  rest: "crash_end",
};

const round = (n: number, digits = 2) => Math.round(n * 10 ** digits) / 10 ** digits;
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const norm = (a: Vec3): Vec3 => scale(a, 1 / (len(a) || 1));
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const r3 = (v: Vec3): Vec3 => [round(v[0]), round(v[1]), round(v[2])];

const store = () => useAppStore.getState();

function openScene(): SceneInfo {
  const state = store();
  if (state.view !== "viewer") {
    throw new Error("No incident is open. The user is on the home screen; open one from the library first.");
  }
  const scene = state.scenes.find((item) => item.id === state.selectedId);
  if (!scene) throw new Error("No incident is open. The user is on the home screen; open one from the library first.");
  return scene;
}

function phaseAt(scene: SceneInfo, t: number): CrashPhase | null {
  if (scene.impactTime == null) return null;
  if (t < scene.impactTime) return "before_crash";
  if (scene.crashEnd == null || t <= scene.crashEnd) return "during_crash";
  return "after_crash";
}

function events(scene: SceneInfo): SceneEvent[] {
  const out: SceneEvent[] = [];
  if (scene.impactTime != null) {
    out.push({ t: scene.impactTime, type: "crash_start", vehicles: scene.crashVehicles, note: "First contact between the vehicles" });
  }
  if (scene.crashEnd != null) {
    out.push({ t: scene.crashEnd, type: "crash_end", vehicles: scene.crashVehicles, note: "The vehicles involved have come to rest" });
  }
  for (const contact of sceneContacts(scene)) {
    out.push({ t: contact.t_s, type: "contact", vehicles: [contact.a, contact.b], note: contact.note ?? `${contact.a} touches ${contact.b}` });
  }
  return out.sort((x, y) => x.t - y.t);
}

function eventTime(scene: SceneInfo, name: string): number {
  const key = name.trim().toLowerCase().replace(/[\s-]+/g, "_");
  const type = EVENT_ALIASES[key] ?? key;
  const event = events(scene).find((item) => item.type === type);
  if (!event) {
    const known = events(scene).map((item) => item.type);
    throw new Error(known.length ? `No "${name}" event. Events in this reconstruction: ${known.join(", ")}.` : "This reconstruction has no crash or other events.");
  }
  return event.t;
}

function resolveTime(scene: SceneInfo, at: TimeRef | undefined): number {
  if (!at) return store().time;
  const t = "t_s" in at ? at.t_s : eventTime(scene, at.event) + (at.offset_s ?? 0);
  if (!Number.isFinite(t) || t < 0 || t > scene.duration) {
    throw new Error(`That's ${round(t)} s, outside the footage (0 to ${scene.duration} s).`);
  }
  return t;
}

function timeline(scene: SceneInfo): TimelineState {
  const state = store();
  return {
    t_s: round(state.time, 3),
    duration_s: scene.duration,
    playing: state.playing,
    speed: state.speed,
    t_rel_crash_s: scene.impactTime == null ? null : round(state.time - scene.impactTime, 3),
    phase: phaseAt(scene, state.time),
  };
}

/** The crash point in scene coordinates (shared with the stored kinematics). */
function origin(scene: SceneInfo): Vec3 {
  return crashOrigin(scene);
}

const toWorld = (p: Point3, o: Vec3): Vec3 => r3(sub(p, o));
const toScene = (p: Vec3, o: Vec3): Point3 => add(p, o);

/** Extra names for fixed scenery, by kind. */
const STATIC_ALIASES: Record<string, string[]> = {
  median_divider: ["the median", "the divider", "the median divider", "the verge", "the central reservation"],
  barrier: ["the barrier", "the median barrier", "the guardrail", "the wall"],
};

function staticEntities(scene: SceneInfo): Entity[] {
  return sceneStatics(scene).map((item) => ({
    id: item.id,
    label: item.label ?? item.id,
    type: "static",
    aliases: [...(STATIC_ALIASES[item.kind ?? ""] ?? []), ...(item.material ? [item.material.replace(/_/g, " ")] : [])],
    visible_from_s: 0,
    visible_to_s: scene.duration,
  }));
}

function entities(scene: SceneInfo): Entity[] {
  return [...vehicleEntities(scene), ...staticEntities(scene)];
}

function vehicleEntities(scene: SceneInfo): Entity[] {
  return scene.vehicles.map((vehicle) => {
    const color = vehicle.label.split(/[\s-]/)[0]?.toLowerCase();
    return {
      id: vehicle.id,
      label: vehicle.label,
      color,
      type: vehicle.type,
      aliases: vehicle.aliases,
      ...(vehicle.involvement ? { involvement: vehicle.involvement } : {}),
      ...(vehicle.visibleFrom != null ? { visible_from_s: round(vehicle.visibleFrom, 2) } : {}),
      ...(vehicle.visibleTo != null ? { visible_to_s: round(vehicle.visibleTo, 2) } : {}),
    };
  });
}

function requireEntity(scene: SceneInfo, id: string) {
  const vehicle = scene.vehicles.find((item) => item.id === id);
  if (!vehicle) {
    const known = scene.vehicles.map((item) => `${item.id} (${item.label})`).join(", ");
    throw new Error(known ? `No vehicle with id "${id}". Vehicles: ${known}.` : "This reconstruction has no tracked vehicles.");
  }
  return vehicle;
}

/** A vehicle or a fixed object, for the kinematics reads (the camera tools take vehicles only). */
function requireKinEntity(scene: SceneInfo, id: string): { label: string; type: string } {
  const item = sceneStatics(scene).find((s) => s.id === id);
  return item ? { label: item.label ?? item.id, type: "static" } : requireEntity(scene, id);
}

async function context() {
  const scene = openScene();
  const handle = await whenSceneReady();
  return { scene, handle, o: origin(scene) };
}

function cameraState(handle: SceneHandle, o: Vec3, clamped = false): CameraState {
  const pose = handle.getCamera();
  const state = store();
  return {
    position: toWorld(pose.position, o),
    target: toWorld(pose.target, o),
    distance_m: round(len(sub(pose.position, pose.target))),
    // The tool contract reports the mode as two fields; at most one is set.
    following: state.cameraMode.kind === "follow" ? state.cameraMode.entityId : null,
    pov: state.cameraMode.kind === "pov" ? state.cameraMode.entityId : null,
    clamped,
  };
}

/**
 * Moves the camera in scene coordinates and reports the result in world coordinates. Any explicit
 * move leaves POV; it also stops following unless `keepFollow` (orbit and zoom keep the same target).
 */
function commit(handle: SceneHandle, o: Vec3, position: Vec3, target: Vec3, keepFollow = false): CameraState {
  const mode = store().cameraMode;
  store().setCameraMode(keepFollow && mode.kind === "follow" ? mode : FREE_CAMERA);
  const placed = handle.setCamera({ position, target });
  return cameraState(handle, o, placed.clamped);
}

function angles(handle: SceneHandle) {
  const pose = handle.getCamera();
  const d = sub(pose.position, pose.target);
  const r = len(d) || 1;
  return { yaw: Math.atan2(d[0], d[2]) / RAD, pitch: Math.asin(d[1] / r) / RAD, distance: r, target: pose.target, position: pose.position };
}

/** Camera position around `target`: yaw 0 = south of it looking north, 90 = east; pitch 90 = above. */
function around(target: Vec3, distance: number, yawDeg: number, pitchDeg: number): Vec3 {
  const yaw = yawDeg * RAD;
  const pitch = Math.max(-89.9, Math.min(89.9, pitchDeg)) * RAD;
  return [
    target[0] + distance * Math.cos(pitch) * Math.sin(yaw),
    target[1] + distance * Math.sin(pitch),
    target[2] + distance * Math.cos(pitch) * Math.cos(yaw),
  ];
}

function vehiclePoint(handle: SceneHandle, id: string): Vec3 {
  const state = store();
  let t = state.time;
  let pose = handle.vehiclePose(id, t);
  if (!pose) throw new Error(`Vehicle "${id}" isn't in the 3D scene.`);
  if (pose.hidden) {
    // Before it drives in or after it leaves there's nothing on screen to point the camera at
    // (its held pose is off at the edge of view): jump to the nearest moment it's on the road.
    const vehicle = state.scenes.find((s) => s.id === state.selectedId)?.vehicles.find((v) => v.id === id);
    if (vehicle?.visibleFrom != null && vehicle.visibleTo != null) {
      t = Math.min(Math.max(t, vehicle.visibleFrom), vehicle.visibleTo);
      state.setTime(t);
      pose = handle.vehiclePose(id, t) ?? pose;
    }
    if (pose.hidden) throw new Error(`The ${vehicle?.label ?? id} isn't in the scene at ${state.time.toFixed(1)} s.`);
  }
  return add(pose.position, [0, 0.8, 0]);
}

function reading(scene: SceneInfo, frame: KinematicsFrame, fields: KinematicsField[], basis: string, type: string): KinematicsReading {
  const want = new Set<KinematicsField>(fields.length ? fields : ["speed", "acceleration", "heading"]);
  const sigma = frame.sigma ?? {};
  const out: KinematicsReading = {
    entity_id: frame.entity_id,
    t_s: round(frame.t, 3),
    t_rel_crash_s: scene.impactTime == null ? null : round(frame.t - scene.impactTime, 3),
    phase: phaseAt(scene, frame.t),
    source: "reconstruction",
    basis,
  };
  if (want.has("position")) out.position = { value: r3(frame.position), unit: "m" };
  if (want.has("velocity")) out.velocity = { value: r3(frame.velocity), unit: "m/s" };
  if (want.has("speed")) {
    const s = sigma.speed_mps;
    out.speed = {
      mps: { value: round(frame.speed), unit: "m/s", ...(s !== undefined ? { sigma: round(s) } : {}) },
      mph: { value: round(frame.speed * 2.23694, 1), unit: "mph", ...(s !== undefined ? { sigma: round(s * 2.23694, 1) } : {}) },
      kmh: { value: round(frame.speed * 3.6, 1), unit: "km/h", ...(s !== undefined ? { sigma: round(s * 3.6, 1) } : {}) },
    };
  }
  if (want.has("acceleration")) {
    out.acceleration = {
      value: round(frame.accel_long),
      unit: "m/s²",
      g: round(frame.accel_long / 9.80665),
      ...(sigma.accel_mps2 !== undefined ? { sigma: round(sigma.accel_mps2) } : {}),
    };
  }
  if (want.has("heading")) {
    out.heading = { value: round(frame.heading_deg, 1), unit: "deg", compass: COMPASS[Math.round(frame.heading_deg / 45) % 8]! };
  }
  if (want.has("yaw_rate")) out.yaw_rate = { value: round(frame.yaw_rate_dps, 1), unit: "deg/s" };
  if (want.has("forces")) {
    const q = (v: KinVec3) => ({ vector: [Math.round(v[0]), Math.round(v[1]), Math.round(v[2])] as Vec3, magnitude: { value: Math.round(len(v)), unit: "N" } });
    const parts = frame.force_parts;
    out.forces = {
      mass_kg: frame.mass_kg,
      net: q(frame.force_net),
      ...(parts
        ? { parts: { tyre_road: q(parts.tyre_road), drag: q(parts.drag), rolling: q(parts.rolling), grade: q(parts.grade), contact: q(parts.contact) } }
        : {}),
      ...(frame.force_reported
        ? { reported: { ...q(frame.force_reported.vector), cause: frame.force_reported.cause, note: frame.force_reported.note } }
        : {}),
      model: type === "static"
        ? "immovable fixed object: no motion; force_parts.contact is what the vehicles push on it, tyre_road is its anchorage's equal and opposite reaction (mass stored as 0 = immovable)"
        : parts
        ? `net force = mass × acceleration (${frame.mass_kg} kg, estimated ${type}); split into tyre/road, air drag (with wind), rolling resistance, slope and impact using standard coefficients`
        : `net force = mass × acceleration, using a nominal ${frame.mass_kg} kg for a ${type}; air drag and friction not modeled separately`,
    };
  }
  return out;
}

async function kinematicsAt(scene: SceneInfo, entityId: string, t: number) {
  const vehicle = requireKinEntity(scene, entityId);
  const [frame] = await sampleKinematics(scene, entityId, [t]);
  if (!frame) throw new Error(`The ${vehicle.label} isn't in the scene at ${round(t)} s.`);
  return frame;
}

function library(): LibraryState {
  const state = store();
  const folders = new Map<string, LibraryState["folders"][number]>();
  for (const scene of state.scenes) {
    const folder = folders.get(scene.folder) ?? { name: scene.folder, incidents: [] };
    folder.incidents.push({ id: scene.id, title: scene.title, duration_s: scene.duration, created: scene.created });
    folders.set(scene.folder, folder);
  }
  return { folders: [...folders.values()], open: state.view === "viewer" ? state.selectedId : null };
}

async function summary(): Promise<SceneSummary> {
  const { scene, handle, o } = await context();
  const bounds = handle.bounds();
  return {
    incident_id: scene.id,
    title: scene.title,
    duration_s: scene.duration,
    entities: entities(scene),
    events: events(scene),
    crash:
      scene.impactTime == null
        ? null
        : { start_s: scene.impactTime, end_s: scene.crashEnd ?? scene.impactTime, vehicles: scene.crashVehicles },
    bounds: { min: toWorld(bounds.min, o), max: toWorld(bounds.max, o) },
    source_videos: scene.sourceVideo ? 1 : 0,
    timeline: timeline(scene),
    camera: cameraState(handle, o),
    ...(await scenery(scene)),
  };
}

/** Fixed objects and contacts as stored with the kinematics (none, or nothing if the database isn't reachable). */
async function scenery(scene: SceneInfo) {
  if (!sceneStatics(scene).length && !sceneContacts(scene).length) return {};
  const meta = await incidentMeta(scene).catch(() => null);
  if (!meta) return {};
  return {
    static_objects: meta.entities
      .filter((entity) => entity.type === "static" && entity.static)
      .map((entity) => ({ id: entity.id, label: entity.label, ...entity.static! })),
    contacts: meta.contacts ?? [],
  };
}

export const appSceneController: SceneController = {
  async listLibrary() {
    return library();
  },

  async openIncident(incidentId) {
    const scene = store().scenes.find((item) => item.id === incidentId || item.title.toLowerCase() === incidentId.toLowerCase());
    if (!scene) throw new Error(`No reconstruction "${incidentId}" in the library.`);
    store().openScene(scene.id);
    return summary();
  },

  async closeIncident() {
    store().closeScene();
    return library();
  },

  describe: summary,

  async findEntities(query) {
    const scene = openScene();
    return matchEntities(entities(scene), query);
  },

  async focus(entityId, distanceM = DEFAULT_FOCUS_DISTANCE) {
    const { scene, handle, o } = await context();
    requireEntity(scene, entityId);
    const target = vehiclePoint(handle, entityId);
    const { yaw, pitch } = angles(handle);
    const mode = store().cameraMode;
    const keep = mode.kind === "follow" && mode.entityId === entityId;
    return commit(handle, o, around(target, distanceM, yaw, Math.max(pitch, 15)), target, keep);
  },

  async panTo(target) {
    const { scene, handle, o } = await context();
    let point: Vec3;
    if ("entity_id" in target) {
      requireEntity(scene, target.entity_id);
      point = vehiclePoint(handle, target.entity_id);
    } else {
      point = toScene(target.point, o);
    }
    const pose = handle.getCamera();
    const delta = sub(point, pose.target);
    return commit(handle, o, add(pose.position, delta), point);
  },

  async orbit(yawDeg, pitchDeg) {
    const { handle, o } = await context();
    const { yaw, pitch, distance, target } = angles(handle);
    return commit(handle, o, around(target, distance, yaw + yawDeg, pitch + pitchDeg), target, true);
  },

  async rotate(yawDeg, pitchDeg) {
    const { handle, o } = await context();
    const pose = handle.getCamera();
    // View direction is camera → target; swing the target around the camera.
    const dir = sub(pose.target, pose.position);
    const r = len(dir) || 1;
    const yaw = Math.atan2(dir[0], dir[2]) - yawDeg * RAD; // positive = look right (clockwise from above)
    const pitch = Math.max(-89 * RAD, Math.min(89 * RAD, Math.asin(dir[1] / r) + pitchDeg * RAD));
    const target = add(pose.position, [r * Math.cos(pitch) * Math.sin(yaw), r * Math.sin(pitch), r * Math.cos(pitch) * Math.cos(yaw)]);
    return commit(handle, o, pose.position, target);
  },

  async move(rightM, upM, forwardM) {
    const { handle, o } = await context();
    const pose = handle.getCamera();
    const fwd = norm(sub(pose.target, pose.position));
    let right = cross(fwd, [0, 1, 0]);
    right = len(right) < 1e-6 ? [1, 0, 0] : norm(right);
    const up = norm(cross(right, fwd));
    const delta = add(add(scale(right, rightM), scale(up, upM)), scale(fwd, forwardM));
    return commit(handle, o, add(pose.position, delta), add(pose.target, delta));
  },

  async zoom(opts) {
    const { handle, o } = await context();
    const { yaw, pitch, distance, target } = angles(handle);
    const next = opts.distance_m ?? distance / (opts.factor ?? 1.5);
    return commit(handle, o, around(target, Math.max(1, next), yaw, pitch), target, true);
  },

  async setCamera(opts) {
    const { handle, o } = await context();
    const pose = handle.getCamera();
    const position = opts.position ? toScene(opts.position, o) : pose.position;
    const target = opts.target ? toScene(opts.target, o) : pose.target;
    return commit(handle, o, position, target);
  },

  async preset(preset: CameraPreset) {
    const { handle, o } = await context();
    const view = CAMERA_PRESETS[preset];
    if (!view) throw new Error(`Unknown view "${preset}". Use ${Object.keys(CAMERA_PRESETS).join(", ")}.`);
    const { distance, target } = angles(handle);
    return commit(handle, o, around(target, distance, view.yaw_deg, view.pitch_deg), target);
  },

  async follow(entityId) {
    const { scene, handle, o } = await context();
    if (entityId) {
      requireEntity(scene, entityId);
      const { yaw, pitch, distance } = angles(handle);
      const target = vehiclePoint(handle, entityId);
      // Bring it into frame first if the camera is far away.
      const d = distance > 45 ? FOLLOW_DISTANCE : distance;
      store().setCameraMode(FREE_CAMERA);
      handle.setCamera({ position: around(target, d, yaw, Math.max(pitch, 15)), target });
    }
    store().setCameraMode(entityId ? { kind: "follow", entityId } : FREE_CAMERA);
    return cameraState(handle, o);
  },

  async pov(entityId) {
    const { scene, handle, o } = await context();
    if (entityId) {
      requireEntity(scene, entityId);
      vehiclePoint(handle, entityId); // seeks into the time it's on the road, if it isn't now
    }
    store().setCameraMode(entityId ? { kind: "pov", entityId } : FREE_CAMERA);
    handle.render();
    return cameraState(handle, o);
  },

  async resetView() {
    const { handle, o } = await context();
    store().resetCamera();
    return cameraState(handle, o);
  },

  async seek(req: SeekRequest) {
    const scene = openScene();
    const state = store();
    if ("relative_s" in req) state.setTime(state.time + req.relative_s);
    else state.setTime(resolveTime(scene, req));
    return timeline(scene);
  },

  async play(speed) {
    const scene = openScene();
    if (speed !== undefined && (speed < MIN_SPEED || speed > MAX_SPEED)) {
      throw new Error(`Playback speed must be between ${MIN_SPEED}× and ${MAX_SPEED}×.`);
    }
    const state = store();
    if (speed !== undefined) state.setSpeed(speed);
    if (!state.playing) state.togglePlay();
    return timeline(scene);
  },

  async pause() {
    const scene = openScene();
    store().setPlaying(false);
    return timeline(scene);
  },

  async queryKinematics(entityId, at, fields) {
    const scene = openScene();
    const meta = await incidentMeta(scene);
    const t = resolveTime(scene, at);
    const frame = await kinematicsAt(scene, entityId, t);
    return reading(scene, frame, fields, meta.basis, requireKinEntity(scene, entityId).type);
  },

  async querySeries(entityId, fromS, toS, stepS, fields): Promise<KinematicsSeries> {
    const scene = openScene();
    const vehicle = requireKinEntity(scene, entityId);
    const meta = await incidentMeta(scene);
    const from = Math.max(0, fromS);
    const to = Math.min(scene.duration, toS);
    if (to < from) throw new Error(`That window is outside the footage (0 to ${scene.duration} s).`);
    const times: number[] = [];
    for (let i = 0; i < MAX_SERIES_SAMPLES && from + i * stepS <= to + 1e-9; i++) times.push(round(from + i * stepS, 6));
    const frames = await sampleKinematics(scene, entityId, times);
    const samples = frames.filter((frame) => frame !== null).map((frame) => reading(scene, frame, fields, meta.basis, vehicle.type));
    if (!samples.length) throw new Error(`The ${vehicle.label} isn't in the scene between ${round(from)} and ${round(to)} s.`);
    return { entity_id: entityId, step_s: stepS, samples };
  },

  async crashForces() {
    const scene = openScene();
    if (scene.impactTime == null || scene.crashVehicles.length === 0) throw new Error("This reconstruction has no crash.");
    const meta = await incidentMeta(scene);
    const crash = { start_s: scene.impactTime, end_s: scene.crashEnd ?? scene.impactTime, vehicles: scene.crashVehicles };
    return computeCrashForces({
      crash,
      vehicles: scene.vehicles.map((vehicle) => ({
        id: vehicle.id,
        label: vehicle.label,
        mass_kg: meta.entities.find((entity) => entity.id === vehicle.id)?.mass_kg ?? 1500,
      })),
      sample: async (entityId, times) =>
        (await sampleKinematics(scene, entityId, times)).map((frame) =>
          frame ? { position: frame.position, tyre: frame.force_parts?.tyre_road, reported: frame.force_reported ?? null } : null,
        ),
      basis: meta.basis,
    });
  },

  async measureDistance(a: MeasureTarget, b: MeasureTarget, at?: TimeRef) {
    const scene = openScene();
    const t = resolveTime(scene, at);
    const point = async (target: MeasureTarget): Promise<Vec3> => (typeof target === "string" ? (await kinematicsAt(scene, target, t)).position : target);
    // A fixed object is measured at its footprint's nearest point, not its centre.
    const statics = typeof a === "string" || typeof b === "string" ? (await incidentMeta(scene)).entities.filter((e) => e.static) : [];
    const footprints = new Map(statics.map((e) => [e.id, e.static!.footprint]));
    const shape = (target: MeasureTarget) => (typeof target === "string" ? footprints.get(target) : undefined);
    const [sa, sb] = [shape(a), shape(b)];
    let pa = sa ? null : await point(a);
    let pb = sb ? null : await point(b);
    if (sa && sb) {
      pa = sa.reduce((best, p) => (len(sub(nearestOn(sb, p), p)) < len(sub(nearestOn(sb, best), best)) ? p : best));
      pb = nearestOn(sb, pa);
    }
    if (sa && !pa) pa = nearestOn(sa, pb!);
    if (sb && !pb) pb = nearestOn(sb, pa!);
    const m = len(sub(pa!, pb!));
    return { t_s: round(t, 3), distance: { m: round(m), ft: round(m * 3.28084, 1) }, a, b };
  },

  async addMarker(label, target) {
    const { scene, handle, o } = await context();
    let point: Point3;
    let entityId: string | undefined;
    if ("entity_id" in target) {
      requireEntity(scene, target.entity_id);
      const pose = handle.vehiclePose(target.entity_id, store().time);
      if (!pose) throw new Error(`Vehicle "${target.entity_id}" isn't in the 3D scene.`);
      point = pose.position;
      entityId = target.entity_id;
    } else {
      point = toScene(target.point, o);
      const bounds = handle.bounds();
      const inside = point.every((v, i) => i === 1 || (v >= bounds.min[i] - 1e-6 && v <= bounds.max[i] + 1e-6));
      if (!inside) throw new Error("That point is outside the scene boundary.");
    }
    const marker = store().addMarker({ label, point, entityId });
    const out: AssistantMarker = { id: marker.id, label, point: toWorld(point, o), ...(entityId ? { entity_id: entityId } : {}) };
    return out;
  },

  async toggle(target: ToggleTarget, visible?: boolean) {
    const scene = openScene();
    const state = store();
    if (target === "source_video") {
      if (!scene.sourceVideo) throw new Error("This reconstruction has no source video attached.");
      const next = visible ?? !state.layers.sourceVideo;
      state.setLayers({ sourceVideo: next });
      return { target, visible: next };
    }
    if (target === "trails" || target === "bounds") {
      if (target === "trails" && scene.vehicles.length === 0) throw new Error("This reconstruction has no vehicle paths to show.");
      const next = visible ?? !state.layers[target];
      state.setLayers({ [target]: next });
      return { target, visible: next };
    }
    const id = target.slice("vehicle:".length);
    requireEntity(scene, id);
    const hidden = state.layers.hiddenVehicles.includes(id);
    const next = visible ?? hidden;
    state.setVehicleHidden(id, !next);
    return { target, visible: next };
  },

  async exportVideo(opts): Promise<ExportJob> {
    const scene = openScene();
    if (opts.camera_path) throw new Error("Named camera paths aren't available yet. I can export the current view instead.");
    const range: [number, number] = opts.range ?? [0, scene.duration];
    if (range[0] < 0 || range[1] > scene.duration || range[1] <= range[0]) {
      throw new Error(`Give a range inside the footage (0 to ${scene.duration} s), with the end after the start.`);
    }
    const job = await startExport(range);
    return { job_id: job.id, status: "rendering" };
  },
};

/** Nearest point of a flat footprint polygon (y = 0) to p; p itself (at ground level) when it's inside. */
function nearestOn(poly: Vec3[], p: Vec3): Vec3 {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [a, b] = [poly[i], poly[j]];
    if (a[2] > p[2] !== b[2] > p[2] && p[0] < ((b[0] - a[0]) * (p[2] - a[2])) / (b[2] - a[2]) + a[0]) inside = !inside;
  }
  if (inside) return [p[0], 0, p[2]];
  let best: Vec3 = poly[0];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const d = sub(poly[(i + 1) % poly.length], a);
    const k = Math.max(0, Math.min(1, ((p[0] - a[0]) * d[0] + (p[2] - a[2]) * d[2]) / (d[0] * d[0] + d[2] * d[2] || 1)));
    const q: Vec3 = [a[0] + d[0] * k, 0, a[2] + d[2] * k];
    if (Math.hypot(q[0] - p[0], q[2] - p[2]) < Math.hypot(best[0] - p[0], best[2] - p[2])) best = q;
  }
  return best;
}

export type { Vec3 };
