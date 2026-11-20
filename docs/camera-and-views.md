# Camera, views and perspective transforms

The viewer is a three.js scene with one perspective camera. Everything the user or the assistant does
to "change the view" comes down to setting two points, the **camera position** and the **target**
(look-at point), plus occasionally the field of view. This doc covers the math behind each operation,
the limits, and where each one lives.

Code: `FrontEnd/app/src/scene/mountScene.ts` (camera, controls, bounds, tweening, follow, POV),
`src/scene/camera.ts` (side-panel camera field state), `src/assistant/sceneController.ts` (assistant camera
operations), `packages/assistant/src/types.ts` (`CAMERA_PRESETS`), `packages/assistant/src/tools/registry.ts`
(tool names).

Frames: the renderer works in **scene** coordinates. The assistant speaks **assistant world**
coordinates (the same axes shifted so the crash point is the origin): `world = scene − o`. Axes are
+x east, +y up, −z north. See [coordinate-frames.md](coordinate-frames.md).

## Camera and projection

- `THREE.PerspectiveCamera(fov 32°, aspect = viewport, near 0.1 m, far 3000 m)`. Aspect is updated
  and `updateProjectionMatrix()` called on every resize.
- `setCamera(pose, { fovDeg })` can change the vertical FOV (clamped 1–120°), for example to match a
  source camera. Only the render-comparison test harness (`tests/demo-fit/harness/source-camera.ts`)
  uses it today; there is no user-facing "match source camera" view.
- Rendering: `EffectComposer` with GTAO ambient occlusion, bloom for over-white highlights, tone
  mapping and sRGB output, 4× multisampled half-float target.

## Spherical camera model

Most operations are expressed as the camera's offset from the target in spherical coordinates. The
assistant's helpers in `sceneController.ts`:

```text
angles(pose):      d = position − target,  r = |d|
                   yaw   = atan2(d.x, d.z)          0 = camera south of target looking north, 90 = east of it
                   pitch = asin(d.y / r)            90 = directly above

around(target, r, yaw, pitch):                      pitch clamped to ±89.9°
  position = target + r · ( cos(pitch)·sin(yaw),  sin(pitch),  cos(pitch)·cos(yaw) )
```

The renderer uses `THREE.Spherical(radius, phi, theta)` for the same offset, where `phi` is measured
from straight up (`phi = 90° − pitch`) and `theta` matches `yaw`.

## Operations

| Operation | Who | Math |
| --- | --- | --- |
| **Orbit** (`camera_orbit`, mouse drag) | Assistant, OrbitControls | Keep target and distance, add Δyaw/Δpitch, recompute with `around` |
| **Rotate / look** (`rotate`) | Assistant | Keep the camera position, swing the **target** around it: positive yaw looks right (clockwise from above), pitch clamped to ±89° |
| **Move** (`move(right, up, forward)`) | Assistant | Camera-local basis: `f = normalize(target − position)`, `right = normalize(f × [0,1,0])` (falls back to +x when looking straight up/down), `up = right × f`. Translate camera **and** target by `right·r + up·u + f·fwd` |
| **Pan to** (`pan_to`) | Assistant | Translate camera and target by the same delta so the target lands on a point or vehicle |
| **Zoom** (`zoom`, wheel) | Assistant, OrbitControls | Keep direction, set distance to `distance_m` or `distance / factor` (default factor 1.5). Mouse wheel zooms toward the cursor (`zoomToCursor`) |
| **Set camera** (`camera_set`) | Assistant | Exact world position and/or target, converted with `toScene` |
| **Preset view** (`camera_preset`) | Assistant | Keep target and distance, apply the preset's yaw/pitch with `around` |
| **Focus** (`focus`) | Assistant | Target the vehicle (seeking into its visible window if needed), default 12 m away, pitch at least 15° |
| **Panel number fields** (`setCameraAdjustments`) | UI | Start from the scene's **home** pose: target += (panX, panY, panZ); radius × zoom; phi += tilt; theta += rotate |
| **Reset** (`camera_reset`) | Both | Back to the layout's home pose; leaves follow/POV |

### Preset views

Angles from `CAMERA_PRESETS`, applied around the current target at the current distance:

| Preset | yaw | pitch | Notes |
| --- | --- | --- | --- |
| front | 0° | 0° | From the south looking north |
| back | 180° | 0° | From the north |
| left | −90° | 0° | From the west |
| right | 90° | 0° | From the east |
| top | 0° | 89.9° | Straight down, north up |
| bottom | 0° | −89.9° | **Not reachable in practice**: the polar limit below keeps the camera above the horizon, so the result is clamped and the tool reports `clamped: true` |
| iso | 45° | 35.264° | `atan(1/√2)`: equal foreshortening on all three axes |
| dimetric | 45° | 20.705° | Two axes equally foreshortened |
| trimetric | 30° | 25° | All three different |

These are perspective views at the presets' angles, not orthographic projections, so "isometric" here
means the viewing direction, not parallel lines.

## Limits (`constrain` in `mountScene.ts`)

Every camera placement, from the UI or the assistant, goes through the same limits so the reported
pose is the pose actually taken:

1. **Target** is clamped into the scene box (its floor may sit at ground level).
2. The camera offset is clamped to `phi ∈ [0.0001, π/2.05]` (no lower than about 2.2° above the
   horizon) and `radius ∈ [1.5 m, 220 m]`.
3. The **camera position** is clamped into the scene box.

The scene box is the site extent plus a 20 m margin on each side, from 0.3 m to 90 m high
(`BOUNDS_MARGIN`, `BOUNDS_FLOOR`, `BOUNDS_HEIGHT`). The `bounds` layer draws it as a white wireframe.
`setCamera` returns `clamped: true` when any limit moved the pose, and the assistant is told to say so.

## Animation

Assistant and panel moves **glide** over 0.6 s (`TWEEN_SECONDS`): the target is linearly interpolated,
and the offset is interpolated in spherical coordinates (radius, phi, theta) with a cubic ease-in-out.
Theta is unwrapped first so the camera turns the short way round. `instant: true` skips the glide.
OrbitControls use damping (0.08) for mouse input. Camera moves work while the timeline plays.

## Camera modes: free, follow, POV

The camera is in exactly one mode at a time, held in the app store as `cameraMode`
(`CameraMode` in `src/scene/camera.ts`):

```ts
type CameraMode = { kind: "free" } | { kind: "follow"; entityId: string } | { kind: "pov"; entityId: string };
```

`Viewport.tsx` pushes every change to the scene with `handle.setMode(mode)`. The scene keeps its own
copy and returns to `free` by itself whenever an explicit placement would break the mode.

| Event | From | To |
| --- | --- | --- |
| `camera_follow(id)` or **Follow** in the vehicle list | any | `follow` id |
| `camera_pov(id)` or **Driver's-eye view** | any | `pov` id |
| Orbit or zoom (keep the same target) | `follow` | `follow` (unchanged) |
| Any other explicit move: pan, move, rotate, set, preset, focus on another vehicle | any | `free` |
| Panel number fields, **Fit view** / reset, opening another scene, closing the scene | any | `free` |
| ✕ on the mode chip, Esc (POV only), `camera_follow(null)`, `camera_pov(null)` | `follow` / `pov` | `free` |

- **Follow** (`camera_follow`) (`camera_follow`): each frame the target is set to the vehicle's position + 0.8 m up,
  and the camera is translated by the same delta, so the user can still orbit and zoom around a moving
  car. If the camera is more than 45 m away it first closes to 18 m.
- **POV** (`camera_pov`): each frame the eye is placed at the vehicle position + 0.2 m forward (scaled)
  + a class eye height (car 1.2 m, van 1.7 m, truck 2.4 m), looking 12 m ahead and 0.4 m down along the
  rig's forward vector `(sin yaw, 0, cos yaw)`. The vehicle itself is hidden. This is an approximate
  eye point, not what the driver saw.
- Any explicit camera command (orbit, preset, set, panel field…) leaves POV, and leaves follow unless
  the operation keeps the same target (orbit and zoom keep it).
- The assistant's `CameraState` reply still reports the mode as two fields, `following` and `pov`, at
  most one of them set, because that shape is part of the tool contract.

Panel requests (the number fields and **Fit view**) reach the scene as one sequenced
`cameraRequest` (`{ seq, kind: "adjust", adjustments } | { seq, kind: "reset" }`); the viewport applies
each `seq` once, so two identical requests in a row both take effect.

## Other view controls

- **Layers** (`toggle`): `trails` (vehicle paths), `bounds`, `source_video` (original footage synced
  to the timeline), and per-vehicle visibility `vehicle:<id>`. The renderer also has a
  `hitboxes` layer that no tool exposes. (Source-camera frustums were planned but were never
  implemented, and the option has been removed from the tool.)
- **Playback speed**: 0.1× to 4× (`MIN_SPEED`, `MAX_SPEED` in `src/store/useAppStore.ts`).
- **Markers**: pins with constant-screen-size labels, placed at world points or on vehicles.
