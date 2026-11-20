export type CameraAdjustments = {
  panX: number;
  panY: number;
  panZ: number;
  zoom: number;
  tilt: number;
  rotate: number;
};

export const CAMERA_ADJUSTMENT_BASE: CameraAdjustments = {
  panX: 0,
  panY: 0,
  panZ: 0,
  zoom: 1,
  tilt: 0,
  rotate: 0,
};

/**
 * What drives the camera. Exactly one mode at a time: the user (or assistant) moving it freely,
 * keeping a vehicle centred from outside, or riding in a vehicle's driver seat.
 */
export type CameraMode = { kind: "free" } | { kind: "follow"; entityId: string } | { kind: "pov"; entityId: string };

export const FREE_CAMERA: CameraMode = { kind: "free" };

/** The vehicle a mode is attached to, if any. */
export const modeEntity = (mode: CameraMode): string | null => (mode.kind === "free" ? null : mode.entityId);

/**
 * A one-shot instruction from the UI to the 3D view. `seq` increases with every request, so the
 * viewport applies each one exactly once even when two consecutive requests are identical.
 */
export type CameraRequest =
  | { seq: number; kind: "adjust"; adjustments: CameraAdjustments }
  | { seq: number; kind: "reset" };
