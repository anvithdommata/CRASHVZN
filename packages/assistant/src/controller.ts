import type {
  CameraPreset,
  CameraState,
  CrashForces,
  EntityMatch,
  ExportJob,
  KinematicsField,
  KinematicsReading,
  KinematicsSeries,
  LibraryState,
  Marker,
  MeasureTarget,
  Measurement,
  SceneSummary,
  SeekRequest,
  TimelineState,
  TimeRef,
  ToggleTarget,
  Vec3,
} from "./types";

/**
 * The contract between the assistant and the app state.
 *
 * The app implements this on top of its Zustand store. Every MCP tool, the
 * fast path, and the API-key adapters call *only* these functions, so the
 * assistant can never touch reconstruction data directly.
 *
 * Methods are async so the Electron main process can forward each call to
 * the renderer over IPC (see `createIpcSceneController`).
 *
 * Conventions the app must honor (the system prompt promises them):
 * - Every camera method clamps the camera to the scene bounds and sets
 *   `clamped: true` in the returned state when it had to stop at the edge.
 * - Camera methods work while playback runs; they never pause it.
 * - Scene methods throw "No incident is open." when the user is on the home screen.
 *
 * Errors: throw an Error with a plain-language message ("No vehicle with id
 * v9"). The tool layer turns it into a tool error the model can read.
 */
export interface SceneController {
  // Home screen
  listLibrary(): Promise<LibraryState>;
  openIncident(incidentId: string): Promise<SceneSummary>;
  closeIncident(): Promise<LibraryState>;

  // Scene
  describe(): Promise<SceneSummary>;
  findEntities(query: string): Promise<EntityMatch[]>;

  // Camera (all exact: degrees and meters)
  focus(entityId: string, distanceM?: number): Promise<CameraState>;
  /** Slide camera and target together (no turning, no zoom) so a vehicle or point is centered. */
  panTo(target: { entity_id: string } | { point: Vec3 }): Promise<CameraState>;
  /** Circle around the target. */
  orbit(yawDeg: number, pitchDeg: number): Promise<CameraState>;
  /** Turn the view in place (the camera stays put, the target swings). */
  rotate(yawDeg: number, pitchDeg: number): Promise<CameraState>;
  /** Move camera and target together, relative to the current view. */
  move(rightM: number, upM: number, forwardM: number): Promise<CameraState>;
  zoom(opts: { factor?: number; distance_m?: number }): Promise<CameraState>;
  /** Absolute placement in world coordinates. */
  setCamera(opts: { position?: Vec3; target?: Vec3 }): Promise<CameraState>;
  preset(preset: CameraPreset): Promise<CameraState>;
  follow(entityId: string | null): Promise<CameraState>;
  /** Ride along from a vehicle's driver seat; null leaves POV. */
  pov(entityId: string | null): Promise<CameraState>;
  resetView(): Promise<CameraState>;

  // Timeline
  seek(req: SeekRequest): Promise<TimelineState>;
  play(speed?: number): Promise<TimelineState>;
  pause(): Promise<TimelineState>;

  // Data (read-only, from the per-frame database)
  queryKinematics(entityId: string, at: TimeRef | undefined, fields: KinematicsField[]): Promise<KinematicsReading>;
  querySeries(entityId: string, fromS: number, toS: number, stepS: number, fields: KinematicsField[]): Promise<KinematicsSeries>;
  measureDistance(a: MeasureTarget, b: MeasureTarget, at?: TimeRef): Promise<Measurement>;
  /** Momentum change, impulse and impact force for each vehicle in the crash. Throws when there's no crash. */
  crashForces(): Promise<CrashForces>;

  // Annotations and UI
  addMarker(label: string, target: { point: Vec3 } | { entity_id: string }): Promise<Marker>;
  toggle(target: ToggleTarget, visible?: boolean): Promise<{ target: ToggleTarget; visible: boolean }>;
  exportVideo(opts: { camera_path?: string; range?: [number, number] }): Promise<ExportJob>;
}

export type SceneControllerMethod = keyof SceneController;

/**
 * Builds a SceneController that forwards every call through one function,
 * e.g. Electron's `ipcRenderer.invoke` bridged from the main process:
 *
 * ```ts
 * // main process
 * const controller = createIpcSceneController((method, args) =>
 *   invokeRenderer(win.webContents, "scene:call", method, args));
 * ```
 */
export function createIpcSceneController(
  invoke: (method: SceneControllerMethod, args: unknown[]) => Promise<unknown>,
): SceneController {
  return new Proxy({} as SceneController, {
    get(_target, prop) {
      if (typeof prop !== "string") return undefined;
      return (...args: unknown[]) => invoke(prop as SceneControllerMethod, args);
    },
  });
}
