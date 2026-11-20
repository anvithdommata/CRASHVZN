/**
 * Shapes shared between the assistant and the app.
 *
 * Scene data mirrors the scene package (requirements §6). Units are SI
 * (meters, seconds, m/s, newtons). World frame: right-handed, +X = east,
 * +Y = up, -Z = north, origin at the crash point. Anything the assistant reports to a user comes
 * from these values, never from the model's own guesses.
 */

export type Vec3 = [number, number, number];

export interface Entity {
  id: string;
  /** Human label, e.g. "red Toyota Camry". */
  label: string;
  color?: string;
  /** "sedan" | "suv" | "truck" | "pedestrian" | "cyclist" | ... */
  type?: string;
  make?: string;
  model?: string;
  /** Extra names the user might say: "the Toyota", "car 1". */
  aliases?: string[];
  /** Seconds during which the object is inside the scene; objects can enter and leave. */
  visible_from_s?: number;
  visible_to_s?: number;
  /**
   * Precision tier. "crash": involved in the crash, reconstructed precisely. "background":
   * other traffic, approximate; its exact path can differ slightly between rebuilds of the scene.
   */
  involvement?: "crash" | "background";
}

export interface SceneEvent {
  t: number;
  /** "crash_start" | "crash_end" | "brake" | ... */
  type: string;
  vehicles?: string[];
  note?: string;
}

/** The crash is a period, not an instant. "Before the crash" = before start_s. */
export interface CrashPeriod {
  start_s: number;
  end_s: number;
  vehicles: string[];
}

/** Axis-aligned box the camera is confined to (world meters). */
export interface SceneBounds {
  min: Vec3;
  max: Vec3;
}

export interface CameraState {
  position: Vec3;
  target: Vec3;
  /** Distance from camera to target, meters. */
  distance_m: number;
  /** Entity the camera follows (orbit view), if any. */
  following: string | null;
  /** Entity whose point of view the camera is riding in, if any. */
  pov: string | null;
  /** True if the last move was stopped at the scene boundary. */
  clamped: boolean;
}

export type CrashPhase = "before_crash" | "during_crash" | "after_crash";

export interface TimelineState {
  t_s: number;
  duration_s: number;
  playing: boolean;
  /** Playback rate, 1 = real time. */
  speed: number;
  /** Seconds relative to the crash start (negative = before), if there is a crash. */
  t_rel_crash_s: number | null;
  phase: CrashPhase | null;
}

export interface LibraryIncident {
  id: string;
  title: string;
  duration_s: number;
  created: string;
}

export interface LibraryFolder {
  name: string;
  incidents: LibraryIncident[];
}

export interface LibraryState {
  folders: LibraryFolder[];
  /** The incident open in the viewer, or null when the user is on the home screen. */
  open: string | null;
}

export interface SceneSummary {
  incident_id: string;
  title: string;
  duration_s: number;
  entities: Entity[];
  events: SceneEvent[];
  crash: CrashPeriod | null;
  bounds: SceneBounds;
  source_videos: number;
  timeline: TimelineState;
  camera: CameraState;
}

export interface EntityMatch {
  id: string;
  label: string;
  score: number;
}

export type KinematicsField = "position" | "velocity" | "speed" | "acceleration" | "heading" | "yaw_rate" | "forces";
export const KINEMATICS_FIELDS = ["position", "velocity", "speed", "acceleration", "heading", "yaw_rate", "forces"] as const;

export interface Quantity {
  value: number;
  unit: string;
  /** ± uncertainty in the same unit, when the pipeline provides one. */
  sigma?: number;
}

/** A point in time: absolute seconds, or an offset from an event ("3 s before the crash"). */
export type TimeRef = { t_s: number } | { event: string; offset_s?: number };

export interface KinematicsReading {
  entity_id: string;
  t_s: number;
  t_rel_crash_s: number | null;
  phase: CrashPhase | null;
  position?: { value: Vec3; unit: "m" };
  velocity?: { value: Vec3; unit: "m/s" };
  speed?: { mps: Quantity; mph: Quantity; kmh: Quantity };
  /** Signed along the direction of travel: negative = slowing down. */
  acceleration?: Quantity & { g: number };
  /** Compass bearing of travel, 0 = north, 90 = east. */
  heading?: Quantity & { compass: string };
  yaw_rate?: Quantity;
  forces?: {
    mass_kg: number;
    /** Net force = m·a, world frame. */
    net: { vector: Vec3; magnitude: Quantity };
    /**
     * Net force split by source (they sum to net): tyre_road = what the road applies through the
     * tyres (braking, accelerating, steering); drag = air (including wind); rolling = rolling
     * resistance; grade = the slope; contact = the impact itself (only during the crash period).
     */
    parts?: Record<"tyre_road" | "drag" | "rolling" | "grade" | "contact", { vector: Vec3; magnitude: Quantity }>;
    /** What the vision model read off the footage near this moment (its own estimate, for comparison). */
    reported?: { vector: Vec3; magnitude: Quantity; cause: string; note: string };
    /** Which effects the model includes, e.g. "net only; drag and friction not modeled". */
    model: string;
  };
  source: "reconstruction";
  /**
   * Where the numbers come from, e.g. "tracked from the footage" or "scripted preview
   * animation, not measured from footage". Tell the user when it isn't measured.
   */
  basis?: string;
}

/** Speed in the three units people ask for. */
export interface SpeedQuantity {
  mps: Quantity;
  mph: Quantity;
  kmh: Quantity;
}

/** The crash as forces and momentum, per vehicle involved (crash_forces tool). */
export interface CrashForces {
  crash: CrashPeriod;
  /** Speed at which the first two vehicles closed on each other at first contact. */
  closing_speed: SpeedQuantity | null;
  vehicles: {
    entity_id: string;
    label: string;
    mass_kg: number;
    /** Just before first contact. */
    before: { t_s: number; speed: SpeedQuantity; heading_compass: string };
    /** Just after the impulse. */
    after: { t_s: number; speed: SpeedQuantity; heading_compass: string };
    /** Change in velocity across the impact. */
    delta_v: { vector: Vec3; magnitude: SpeedQuantity };
    /** Impulse = mass × delta-v (N·s), and the direction it pushed (compass). */
    impulse: { vector: Vec3; magnitude: Quantity; direction_compass: string };
    /** Average impact force if the contact lasted pulse_s (footage can't resolve the pulse; ~0.1 s is typical for car crashes). */
    average_force: { magnitude: Quantity; pulse_s: number; g: number };
    /** From first contact until it stopped (or the crash ended): distance, time, mean tyre/road force. */
    slide: { distance: { m: number; ft: number }; duration_s: number; mean_tyre_force: Quantity };
    /** The vision model's own force readings during the crash period, for comparison. */
    reported_by_model: { t_s: number; cause: string; magnitude: Quantity; note: string }[];
  }[];
  basis?: string;
  /** What the numbers can and can't support. */
  caveats: string[];
}

export interface KinematicsSeries {
  entity_id: string;
  step_s: number;
  samples: KinematicsReading[];
}

/** Either an entity id or a world-space point. */
export type MeasureTarget = string | Vec3;

export interface Measurement {
  t_s: number;
  distance: { m: number; ft: number };
  a: MeasureTarget;
  b: MeasureTarget;
}

export interface Marker {
  id: string;
  label: string;
  point: Vec3;
  entity_id?: string;
}

/**
 * Standard engineering views (the SolidWorks set, minus "Normal To", which
 * needs a selected plane). Angles are where the camera sits around its
 * target: yaw_deg 0 = south of it looking north, 90 = east of it looking
 * west, -90 = west looking east; pitch_deg 90 = straight above.
 * The app and the mock both read this table, so the views match.
 */
export const CAMERA_PRESETS = {
  front: { yaw_deg: 0, pitch_deg: 0, label: "front (from the south, looking north)" },
  back: { yaw_deg: 180, pitch_deg: 0, label: "back (from the north, looking south)" },
  left: { yaw_deg: -90, pitch_deg: 0, label: "left (from the west, looking east)" },
  right: { yaw_deg: 90, pitch_deg: 0, label: "right (from the east, looking west)" },
  top: { yaw_deg: 0, pitch_deg: 89.9, label: "top (straight down, north up)" },
  bottom: { yaw_deg: 0, pitch_deg: -89.9, label: "bottom (straight up from below)" },
  iso: { yaw_deg: 45, pitch_deg: 35.264, label: "isometric (equal angles to all three axes)" },
  dimetric: { yaw_deg: 45, pitch_deg: 20.705, label: "dimetric (two axes equally foreshortened, lower than iso)" },
  trimetric: { yaw_deg: 30, pitch_deg: 25, label: "trimetric (all three axes foreshortened differently)" },
} as const;

export type CameraPreset = keyof typeof CAMERA_PRESETS;
export const CAMERA_PRESET_NAMES = Object.keys(CAMERA_PRESETS) as [CameraPreset, ...CameraPreset[]];

/** `trails | source_video | bounds | vehicle:<id>` */
export type ToggleTarget = "trails" | "source_video" | "bounds" | `vehicle:${string}`;

export type SeekRequest = TimeRef | { relative_s: number };

export interface ExportJob {
  job_id: string;
  status: "queued" | "rendering" | "uploading" | "done" | "error";
  path?: string;
}
