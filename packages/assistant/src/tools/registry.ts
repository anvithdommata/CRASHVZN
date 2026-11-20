import { z } from "zod";
import type { SceneController } from "../controller";
import { CAMERA_PRESET_NAMES, KINEMATICS_FIELDS, type CameraPreset, type KinematicsField, type TimeRef, type ToggleTarget, type Vec3 } from "../types";

// This registry also runs in the app's renderer, whose Content-Security-Policy forbids eval
// (FrontEnd/app/vite.config.ts). Without this, Zod probes `new Function` once and logs a CSP
// violation before falling back. Tool arguments are tiny, so the interpreted path costs nothing.
z.config({ jitless: true });

/**
 * The assistant's tool surface (docs/history/hackathon-requirements.md §7 plus docs/product/ux-features.md), defined
 * once and served two ways:
 *   - over MCP to the user's CLI (claude / codex / gemini), see mcp/server.ts
 *   - directly to the API-key adapters, see providers/*-api.ts
 *
 * Names use underscores (`camera_orbit`), not the dots in §7 (`camera.orbit`):
 * the Anthropic and OpenAI APIs only accept [a-zA-Z0-9_-] in tool names, and
 * Claude Code exposes them as `mcp__crashvzn__camera_orbit`.
 *
 * Every tool is view/query-only except marker_add and export_video. None can
 * change the reconstruction, the trajectories or the kinematics.
 *
 * Descriptions are part of the prompt: the model reads them on every turn.
 * Keep conventions here in sync with prompt/system-prompt.ts.
 */

const vec3 = z.tuple([z.number(), z.number(), z.number()]).describe("World point [x, y, z] in meters. +x east, +y up, -z north, origin at the crash point");
const target = z.union([z.string().describe("Entity id, e.g. v1"), vec3]);
const fields = z.array(z.enum(KINEMATICS_FIELDS));

/** t_s, or event + optional offset_s. Neither = the current playhead. */
const timeRefShape = {
  t_s: z.number().optional().describe("Absolute seconds from the start of the footage"),
  event: z.string().optional().describe('Event type to measure from: "crash_start", "crash_end", "brake", ...'),
  offset_s: z.number().optional().describe("Seconds after the event (negative = before). Only with event"),
};
type TimeRefArgs = { t_s?: number; event?: string; offset_s?: number };
const timeRefOk = (v: TimeRefArgs) => !(v.t_s !== undefined && v.event !== undefined) && !(v.offset_s !== undefined && v.event === undefined);
const TIME_REF_MSG = "Give t_s, or event with an optional offset_s, or neither for the current playhead";
function toTimeRef(v: TimeRefArgs): TimeRef | undefined {
  if (v.t_s !== undefined) return { t_s: v.t_s };
  if (v.event !== undefined) return { event: v.event, ...(v.offset_s !== undefined ? { offset_s: v.offset_s } : {}) };
  return undefined;
}

export interface ToolDef<S extends z.ZodType = z.ZodType> {
  name: string;
  /** Dotted name for humans. */
  title: string;
  description: string;
  input: S;
  /** True when the tool only reads state or moves the view. */
  readOnly: boolean;
  run(ctl: SceneController, args: z.infer<S>): Promise<unknown>;
}

function tool<S extends z.ZodType>(def: ToolDef<S>): ToolDef {
  return def as unknown as ToolDef;
}

const CAMERA_NOTE = " Works while playing. The camera can't leave the scene box; clamped: true in the result means it stopped at the edge.";

export const TOOLS: ToolDef[] = [
  // ── Home screen ────────────────────────────────────────────────────────
  tool({
    name: "library_list",
    title: "library.list",
    description: "List the uploaded reconstructions by folder, and which one is open in the viewer (open: null = the user is on the home screen).",
    input: z.object({}),
    readOnly: true,
    run: (ctl) => ctl.listLibrary(),
  }),
  tool({
    name: "incident_open",
    title: "incident.open",
    description: "Open a reconstruction from the library in the full-page viewer. Returns the same summary as scene_describe.",
    input: z.object({ incident_id: z.string() }),
    readOnly: true,
    run: (ctl, a) => ctl.openIncident(a.incident_id),
  }),
  tool({
    name: "incident_close",
    title: "incident.close",
    description: "Close the viewer and go back to the home screen with the folders (the app's Back button).",
    input: z.object({}),
    readOnly: true,
    run: (ctl) => ctl.closeIncident(),
  }),

  // ── Scene ──────────────────────────────────────────────────────────────
  tool({
    name: "scene_describe",
    title: "scene.describe",
    description:
      "Get the open incident: objects (ids, labels, when each is in the scene), events, the crash period (start_s, end_s), the scene bounds box, duration, the playhead and the camera. Call this first when you don't yet know the ids or the crash times.",
    input: z.object({}),
    readOnly: true,
    run: (ctl) => ctl.describe(),
  }),
  tool({
    name: "entity_find",
    title: "entity.find",
    description:
      'Find objects matching what the user said, e.g. "red toyota" or "the SUV". Returns matches ranked by score (1 = exact). Use the top match id with other tools.',
    input: z.object({ query: z.string().min(1) }),
    readOnly: true,
    run: (ctl, a) => ctl.findEntities(a.query),
  }),

  // ── Camera ─────────────────────────────────────────────────────────────
  tool({
    name: "camera_focus",
    title: "camera.focus",
    description: "Fly the camera to a vehicle and frame it. Optional distance in meters (default about 12 m)." + CAMERA_NOTE,
    input: z.object({ entity_id: z.string(), distance_m: z.number().positive().optional() }),
    readOnly: true,
    run: (ctl, a) => ctl.focus(a.entity_id, a.distance_m),
  }),
  tool({
    name: "camera_pan_to",
    title: "camera.pan_to",
    description:
      "Slide the camera sideways, without turning or zooming, so a vehicle (entity_id, where it is at the playhead) or a world point is centered in the view. Use for 'pan to', 'center on', 'slide over to'. Use camera_focus instead to fly in close and frame it." +
      CAMERA_NOTE,
    input: z
      .object({ entity_id: z.string().optional(), point: vec3.optional() })
      .refine((v) => (v.entity_id === undefined) !== (v.point === undefined), "Give either entity_id or point"),
    readOnly: true,
    run: (ctl, a) => ctl.panTo(a.entity_id !== undefined ? { entity_id: a.entity_id } : { point: a.point as Vec3 }),
  }),
  tool({
    name: "camera_orbit",
    title: "camera.orbit",
    description:
      "Circle the camera around what it's looking at, in degrees. yaw_deg: positive = orbit right, negative = left. pitch_deg: positive = rise to look down from higher, negative = lower. 'Orbit 90 degrees to the left' → yaw_deg -90." +
      CAMERA_NOTE,
    input: z.object({ yaw_deg: z.number().min(-360).max(360), pitch_deg: z.number().min(-89).max(89).default(0) }),
    readOnly: true,
    run: (ctl, a) => ctl.orbit(a.yaw_deg, a.pitch_deg),
  }),
  tool({
    name: "camera_rotate",
    title: "camera.rotate",
    description:
      "Turn the view in place, like turning your head: the camera stays where it is. yaw_deg: positive = look right, negative = left. pitch_deg: positive = look up, negative = down. Use for 'look left', 'look up'; use camera_orbit for 'rotate around' something." +
      CAMERA_NOTE,
    input: z.object({ yaw_deg: z.number().min(-360).max(360), pitch_deg: z.number().min(-89).max(89).default(0) }),
    readOnly: true,
    run: (ctl, a) => ctl.rotate(a.yaw_deg, a.pitch_deg),
  }),
  tool({
    name: "camera_move",
    title: "camera.move",
    description:
      "Move the camera (and what it looks at) by exact meters relative to the current view: right_m (+ right, - left), up_m (+ up, - down), forward_m (+ toward where it's looking, - back). This is the pan/hand tool." +
      CAMERA_NOTE,
    input: z
      .object({ right_m: z.number().default(0), up_m: z.number().default(0), forward_m: z.number().default(0) })
      .refine((v) => v.right_m !== 0 || v.up_m !== 0 || v.forward_m !== 0, "Give at least one non-zero distance"),
    readOnly: true,
    run: (ctl, a) => ctl.move(a.right_m, a.up_m, a.forward_m),
  }),
  tool({
    name: "camera_zoom",
    title: "camera.zoom",
    description:
      "Move closer to or farther from what the camera is looking at. Give factor (>1 = zoom in, 2 halves the distance; <1 = zoom out, 0.5 doubles it) or an exact distance_m." +
      CAMERA_NOTE,
    input: z
      .object({ factor: z.number().positive().optional(), distance_m: z.number().positive().optional() })
      .refine((v) => (v.factor === undefined) !== (v.distance_m === undefined), "Give factor or distance_m"),
    readOnly: true,
    run: (ctl, a) => ctl.zoom(a),
  }),
  tool({
    name: "camera_set",
    title: "camera.set",
    description:
      "Place the camera at exact world coordinates and/or point it at an exact world point. Use when the user gives coordinates or you've computed a position, e.g. 'put the camera 10 m above the crash point' → position [0, 10, 0], target [0, 0, 0]." +
      CAMERA_NOTE,
    input: z
      .object({ position: vec3.optional(), target: vec3.optional() })
      .refine((v) => v.position !== undefined || v.target !== undefined, "Give position, target, or both"),
    readOnly: true,
    run: (ctl, a) => ctl.setCamera({ position: a.position as Vec3 | undefined, target: a.target as Vec3 | undefined }),
  }),
  tool({
    name: "camera_preset",
    title: "camera.preset",
    description:
      'Snap to a standard engineering view of the scene, like CAD software: "front" (from the south), "back" (from the north), "left" (from the west), "right" (from the east), "top" (straight down), "bottom" (straight up; the road surface stops it at ground level), "iso" (isometric), "dimetric", or "trimetric". Keeps the current zoom distance and target.' +
      CAMERA_NOTE,
    input: z.object({ preset: z.enum(CAMERA_PRESET_NAMES) }),
    readOnly: true,
    run: (ctl, a) => ctl.preset(a.preset as CameraPreset),
  }),
  tool({
    name: "camera_follow",
    title: "camera.follow",
    description: "Keep a vehicle centered from outside as the timeline plays (the user can still orbit and zoom). entity_id null stops following.",
    input: z.object({ entity_id: z.string().nullable() }),
    readOnly: true,
    run: (ctl, a) => ctl.follow(a.entity_id),
  }),
  tool({
    name: "camera_pov",
    title: "camera.pov",
    description:
      "Ride along in a vehicle's driver seat, looking where it's heading, as the timeline plays. This is an approximate eye point from the reconstruction, not what the driver actually saw. entity_id null leaves the POV view.",
    input: z.object({ entity_id: z.string().nullable() }),
    readOnly: true,
    run: (ctl, a) => ctl.pov(a.entity_id),
  }),
  tool({
    name: "camera_reset",
    title: "camera.reset",
    description: "Return the camera to the default overview of the whole scene and leave any follow or POV view.",
    input: z.object({}),
    readOnly: true,
    run: (ctl) => ctl.resetView(),
  }),

  // ── Timeline ───────────────────────────────────────────────────────────
  tool({
    name: "timeline_seek",
    title: "timeline.seek",
    description:
      'Move the playhead (the source video moves with it). Give one of: t_s (seconds from start); event with optional offset_s ("3 s before the crash" → event "crash_start", offset_s -3; "after the crash" → event "crash_end"); or relative_s (step from the current time, negative = back).',
    input: z
      .object({ ...timeRefShape, relative_s: z.number().optional() })
      .refine((v) => [v.t_s, v.event, v.relative_s].filter((x) => x !== undefined).length === 1, "Give exactly one of t_s, event, relative_s")
      .refine(timeRefOk, "offset_s only goes with event"),
    readOnly: true,
    run: (ctl, a) => ctl.seek(a.relative_s !== undefined ? { relative_s: a.relative_s } : toTimeRef(a)!),
  }),
  tool({
    name: "timeline_play",
    title: "timeline.play",
    description: "Start playback, or change speed while playing. speed is a multiplier from 0.1 to 4 (1 = real time, 0.25 = slow motion, 2 = double speed).",
    input: z.object({ speed: z.number().min(0.1).max(4).optional() }),
    readOnly: true,
    run: (ctl, a) => ctl.play(a.speed),
  }),
  tool({
    name: "timeline_pause",
    title: "timeline.pause",
    description: "Pause playback.",
    input: z.object({}),
    readOnly: true,
    run: (ctl) => ctl.pause(),
  }),

  // ── Data ───────────────────────────────────────────────────────────────
  tool({
    name: "kinematics_query",
    title: "kinematics.query",
    description:
      'Read one object\'s reconstructed motion at one moment from the per-frame database: position, velocity (vector), speed (m/s, mph, km/h), acceleration (negative = slowing, also in g), heading (compass), yaw_rate, forces (mass, net force and, where available, its breakdown: tyre_road = braking/accelerating/steering through the tyres, drag = air incl. wind, rolling, grade = slope, contact = the impact; plus what the vision model itself read off the footage). Time: t_s, or event + offset_s ("3 s before the crash" → event "crash_start", offset_s -3), or omit for the playhead. Doesn\'t move the playhead. This and kinematics_series are the ONLY sources for motion numbers you tell the user.',
    input: z
      .object({ entity_id: z.string(), ...timeRefShape, fields: fields.default(["speed"]) })
      .refine(timeRefOk, TIME_REF_MSG),
    readOnly: true,
    run: (ctl, a) => ctl.queryKinematics(a.entity_id, toTimeRef(a), a.fields as KinematicsField[]),
  }),
  tool({
    name: "kinematics_series",
    title: "kinematics.series",
    description:
      "Read an object's motion over a time window, sampled every step_s seconds (at most 60 samples). Use for 'how did its speed change', 'top speed in the last 3 seconds before the crash', 'when did it start slowing'. Times are absolute seconds; get the crash times from scene_describe.",
    input: z
      .object({
        entity_id: z.string(),
        from_s: z.number(),
        to_s: z.number(),
        step_s: z.number().positive().default(0.5),
        fields: fields.default(["speed"]),
      })
      .refine((v) => v.to_s > v.from_s, "to_s must be after from_s")
      .refine((v) => (v.to_s - v.from_s) / v.step_s <= 60, "Too many samples; use a larger step_s (max 60 samples)"),
    readOnly: true,
    run: (ctl, a) => ctl.querySeries(a.entity_id, a.from_s, a.to_s, a.step_s, a.fields as KinematicsField[]),
  }),
  tool({
    name: "crash_forces",
    title: "crash.forces",
    description:
      "The crash in forces and momentum, for every vehicle involved: speed just before and just after the impact, change in velocity (delta-v), impulse (N·s) and the direction it pushed, average impact force over an assumed contact pulse, the slide afterwards (distance, time, mean tyre force), the closing speed, and the forces the vision model read off the footage. Use for 'how hard did they hit', 'what force hit the Toyota', 'delta-v', 'how far did it slide after'. The only source for crash-force numbers.",
    input: z.object({}),
    readOnly: true,
    run: (ctl) => ctl.crashForces(),
  }),
  tool({
    name: "measure_distance",
    title: "measure.distance",
    description:
      "Straight-line distance in meters and feet between two things at one moment. a and b are each an entity id or a world point [x,y,z]. Time as in kinematics_query (default: the playhead).",
    input: z.object({ a: target, b: target, ...timeRefShape }).refine(timeRefOk, TIME_REF_MSG),
    readOnly: true,
    run: (ctl, a) => ctl.measureDistance(a.a as string | Vec3, a.b as string | Vec3, toTimeRef(a)),
  }),

  // ── Annotations and UI ─────────────────────────────────────────────────
  tool({
    name: "marker_add",
    title: "marker.add",
    description: "Drop a labeled pin at a world point or on a vehicle. Markers are annotations; they never change the reconstruction.",
    input: z
      .object({ label: z.string().min(1), point: vec3.optional(), entity_id: z.string().optional() })
      .refine((v) => (v.point === undefined) !== (v.entity_id === undefined), "Give either point or entity_id"),
    readOnly: false,
    run: (ctl, a) => ctl.addMarker(a.label, a.point ? { point: a.point as Vec3 } : { entity_id: a.entity_id! }),
  }),
  tool({
    name: "ui_toggle",
    title: "ui.toggle",
    description:
      'Show or hide part of the view: "source_video" (the original footage, synced to the timeline), "trails" (vehicle paths), "bounds" (the scene boundary box), or "vehicle:<id>". Omit visible to flip it.',
    input: z.object({
      target: z.string().regex(/^(source_video|trails|bounds|vehicle:[\w-]+)$/, "source_video|trails|bounds|vehicle:<id>"),
      visible: z.boolean().optional(),
    }),
    readOnly: true,
    run: (ctl, a) => ctl.toggle(a.target as ToggleTarget, a.visible),
  }),
  tool({
    name: "export_video",
    title: "export.video",
    description:
      "Start rendering an MP4 of the current view (or a named camera path) over an optional time range [start_s, end_s]. Returns a job id; the export is watermarked as a demonstrative reconstruction.",
    input: z.object({ camera_path: z.string().optional(), range: z.tuple([z.number(), z.number()]).optional() }),
    readOnly: false,
    run: (ctl, a) => ctl.exportVideo({ camera_path: a.camera_path, range: a.range as [number, number] | undefined }),
  }),
];

export const TOOLS_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

export type ToolCallResult = { ok: true; result: unknown } | { ok: false; error: string };

/** Validate args and run a tool against the controller. Never throws. */
export async function callTool(ctl: SceneController, name: string, rawArgs: unknown): Promise<ToolCallResult> {
  const def = TOOLS_BY_NAME.get(name);
  if (!def) return { ok: false, error: `Unknown tool "${name}".` };
  const parsed = def.input.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    return { ok: false, error: `Invalid arguments for ${name}: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(args)"}: ${i.message}`).join("; ")}` };
  }
  try {
    return { ok: true, result: await def.run(ctl, parsed.data) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** JSON Schema for a tool's input, for APIs that take raw schemas. */
export function toolJsonSchema(def: ToolDef): Record<string, unknown> {
  const schema = z.toJSONSchema(def.input, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
  delete schema.$schema;
  return schema;
}
