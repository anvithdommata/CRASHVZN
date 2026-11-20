# Coordinate frames and transforms

Every number in CRASHVZN belongs to one of five frames. Most bugs in this codebase have been a
vector crossing a frame boundary with the wrong sign, so read this before touching positions,
headings, velocities, forces or contact normals.

All frames use **meters, seconds, and a flat ground plane**. Only the camera leaves the ground;
vehicle positions always have zero height.

## The five frames

| Frame | Used by | Axes | Origin | Heading convention |
| --- | --- | --- | --- | --- |
| **W** (measurement world) | Python measurement code in `FrontEnd/app/electron/demo-incident/measure/` | X along the road *away* from the crash camera, Y to the camera's *right*, Z up | Point on the ground below the camera's lane line (see `measure/README.md`) | `0` = +X, `90` = +Y |
| **Plan** | LLM output, `IncidentSpec` (`src/incident/spec.ts`), motion planning (`src/incident/motion.ts`) | x along the main road, y across it, **positive to the left** when facing +x (so +y is "north" when +x is "east") | Junction centre, or the main-road centre line nearest the crash | `0` = facing +x, `90` = facing +y (counter-clockwise seen from above) |
| **Scene** (three.js) | Renderer (`src/scene/*`), road painter, vehicle rigs | +x east, +y up, **−z north** | Same ground point as plan | Rig `rotation.y` (`yaw`); forward vector is `(sin yaw, 0, cos yaw)` |
| **Assistant world** | MongoDB `frames`, every assistant tool, `SceneController` | Same axes as scene | **Crash point**: mean scene position of the crash vehicles at `impactTime`, with y = 0 | Compass bearing: `0` = north (−z), `90` = east (+x) |
| **Image** | Frame sheets, calibration, burned-in boxes | u right, v **down** | Top-left pixel of the crop | — |

The plan frame is right-hand traffic: vehicles travelling +x are at **negative y**, vehicles
travelling −x at positive y. On a divided highway the median barrier is at y = 0.

## Transforms

### W → plan (measured demo only)

`build-measured-spec.py` converts calibrated measurements into the spec. The crash carriageway's
traffic moves −X in W, and the plan frame wants it to move +x:

```
plan_x       = -(X - X_ref)
plan_y       =  Y - Y_median
heading_plan = 180 - heading_W
(fx, fy)_plan = (-fx, fy)_W        # velocities, forces, any ground vector
```

`X_ref` and `Y_median` are printed by the builder and recorded in `incident-spec.json.build.json`.
Image-box centres are not ground-contact points. The calibration (`measure/cam.py`,
`to_ground(u, v)`) maps the box's ground footprint, not its centre.

### Plan → scene

`planToPose` in `src/incident/engine.ts`:

```
scene_x = plan_x
scene_z = -plan_y
yaw     = atan2(cos h, -sin h)     # h = plan heading in radians
```

As a matrix on ground vectors `[x, y]_plan → [x, z]_scene`:

```
| 1   0 |
| 0  -1 |
```

Check: `h = 0` gives `yaw = 90°` and forward `(1, 0, 0)` (east). `h = 90°` gives `yaw = 180°` and
forward `(0, 0, -1)` (north). Contact normals and wind use the same mapping:
`normal_deg → [cos, 0, -sin]` (`src/kinematics/derive.ts`, `addStatics`), and
`wind.toward_deg → [s·cos, 0, -s·sin]` (`engine.ts`).

### Scene → assistant world

A pure translation by the crash origin `o` (`crashOrigin` in `src/kinematics/derive.ts`):

```
world = scene - o          # toWorld()  in src/assistant/sceneController.ts
scene = world + o          # toScene()
```

The database and the assistant use the same origin, so a position the assistant reads back from
MongoDB can be passed straight to `camera_set` or `measure`. Scenes with no crash use `o = [0, 0, 0]`.

### Headings across frames

| From | To | Formula |
| --- | --- | --- |
| Plan heading `h` | Compass bearing | `bearing = (90 - h) mod 360` |
| Scene velocity `v` | Compass bearing | `atan2(v.x, -v.z)` in degrees, mod 360 (`bearing()` in `derive.ts`) |
| Rig yaw | Compass bearing (used below 0.3 m/s, where velocity direction is noise) | `(180 - yaw_deg) mod 360` |
| W heading | Plan heading | `180 - heading_W` |

`yaw_rate_dps` in the database is positive for a **right** (clockwise from above) turn.

## Measurement crop (image frame)

The demo footage is a 960×610 mosaic of four cameras. The crash camera is the bottom-right tile:
**x=481, y=304, w=479, h=300**. Calibration pixel coordinates are relative to that crop. The column
gutter (x = 479–480), row gutter (y = 300–303) and letterbox (y ≥ 604) belong to no camera. The
grid splitter for arbitrary uploads (`electron/split-grid.ts`) may round crops differently for
encoding, so never mix its pixel coordinates with calibration coordinates.

Image v grows downward. It is not the 3D y axis.

## Time

- Source time `t = frame / fps`. The demo clip is 12.5 fps; frames 0–399 cover 0–31.92 s.
- The motion planner samples tracks at `SIM_HZ = 50` (`src/incident/motion.ts`).
- The kinematics database stores frames at `FPS = 30` (`src/kinematics/derive.ts`). **The `frame`
  field there is a 30 fps index, not a source-video frame.** Use `t` to compare with footage.
- Multi-video uploads report every time on **video 1's** clock. Tiles cropped from the same grid
  file share its clock exactly (offset 0). Separate files use the LLM's `time_offset_s` estimate.

## Where to check before changing a transform

1. `measure/cam.py` and `build-measured-spec.py` (W ↔ plan; run it with `--check`).
2. `planToPose` in `src/incident/engine.ts` (plan → scene).
3. `crashOrigin`, `fromPlan` and `bearing` in `src/kinematics/derive.ts` (scene → database).
4. `toWorld` / `toScene` / `around` in `src/assistant/sceneController.ts` (database ↔ assistant ↔ camera).
