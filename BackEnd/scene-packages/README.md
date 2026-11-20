# Scene package

> Output of the earlier `reconstruct` pipeline. The desktop app does not load this format today; it uses the incident spec described in [docs/vision-pipeline.md](../../docs/vision-pipeline.md).

The package is a self-contained **folder**, designed for the app and MCP tools to load. There is no server and no database. `incident-demo` is the package for `demo.mp4`. Vehicle tracks are measured from the class-colored boxes in that video, then smoothed. They are not authored paths.

Regenerate it from the repo root with:

```sh
BackEnd/pipeline/.venv/bin/reconstruct build
BackEnd/pipeline/.venv/bin/reconstruct validate BackEnd/scene-packages/incident-demo
```

JSON Schema in [`schema/`](../schema/) is the source of truth. The pipeline checks every write with those schemas and with the matching Pydantic models. Matching TypeScript types live in [`BackEnd/scene-types/index.ts`](../scene-types/index.ts).

## This clip has an accident

`demo.mp4` is one minute of Autobahn traffic with a **multi-vehicle incident** on carriageway B (most visible in `cam_br`). Vehicles brake, stop, and collide; debris is visible in the mosaic.

- `manifest.json` sets `impact_time_s` from the earliest detected impact
- `events.json` includes `impact`, and may include `brake` / `rest`, plus lane changes and passes
- `tracks_are_schematic` is `false`. Every kept vehicle has full kinematics (`pos`, `vel`, `acc`, `speed_mps`, `heading_deg`, `yaw_rate`) on every sample, including stopped vehicles after the crash. Along-road scale uses the configured focal length

`timeline.seek` to `"impact"` should use `impact_time_s` / the impact event. Show clip time from the first frame, and `T−` relative to impact when `impact_time_s` is a number.

Make and model are `null` on every entity. A label is the measured paint plus the type, so a red car is found by the alias **"the red car"** rather than by a fixed id.

## Folder

```
incident-demo/
  manifest.json          # fps 12.5, duration 59.92 s, 749 frames, impact_time_s set
  tracks.json            # one track per vehicle, samples only while it is in the stretch
  entities.json          # car | van | truck, paint color, aliases, shared splat path
  events.json            # impact / brake / rest / lane changes / passes from the tracks
  cameras.json           # cam_tl, cam_tr, cam_bl, cam_br
  background.ply         # highway strip, a few hundred Gaussians
  vehicles/car.ply       # one blob per class, shared by every entity of that class
  vehicles/van.ply
  vehicles/truck.ply
  sources/mosaic.mp4     # copy of demo.mp4, so the folder stands alone
```

`dims_m` is the proxy box if a class splat is not enough. Length is local +X, height local +Y, width local +Z. The vehicle position is the center of that box, so the bottom sits on the ground.

## Coordinates

Meters, seconds, **Y-up**. The origin is a point on the median. The road runs along X for 160 m (`x` from −80 to 80).

| Carriageway | Cameras | Traffic | Z |
|---|---|---|---|
| A | `cam_tl`, `cam_bl` (left column) | heads **−X** | positive |
| B | `cam_tr`, `cam_br` (right column, exit side) | heads **+X** | negative |

Lane width is 3.5 m, three lanes each way, plus a shoulder. Lane 0 is the inner lane. Quaternions are `[x, y, z, w]`. Heading `0` faces +X, `180` faces −X. Positive heading turns toward −Z.

Picture-in-picture uses **image** coordinates. Y grows downward from the top left of the mosaic. That is not the 3D Y axis.

A sample's longitudinal acceleration is the dot product of `acc` with the heading direction `(cos θ, 0, −sin θ)`, where θ is `heading_deg` in radians. `yaw_rate` is radians per second about +Y. `sigma` is a fixed ± band (`0.5 m`, `0.75 m/s`), not a fitted covariance.

Samples are at 12.5 Hz and only exist inside that vehicle's `visibility` window. Vehicles enter and leave the 160 m stretch. A track does not cover the whole minute.

## Mosaic crops

The file is 960×610. Each view is 479×300. Gutters and the bottom letterbox are not part of any camera.

| Camera | x | y | width | height | Looks along |
|---|---:|---:|---:|---:|---|
| `cam_tl` | 0 | 0 | 479 | 300 | carriageway A, −X |
| `cam_tr` | 481 | 0 | 479 | 300 | carriageway B, +X |
| `cam_bl` | 0 | 304 | 479 | 300 | carriageway A, −X |
| `cam_br` | 481 | 304 | 479 | 300 | carriageway B, +X |

Do not sample these pixels:

- column gutter `x = 479` and `x = 480`
- row gutter `y = 300` through `y = 303`
- letterbox `y = 604` through `y = 609`

The poses in `cameras.json` are configured stand-ins. Role 1 should replace intrinsics and extrinsics and keep the ids, the crop fields, and the object shape. The mosaic has no separate audio track and no sync offset. It is already one clock.

## Entities

Class overlay colors match the boxes burned into the video: cars cyan `#00E5FF`, vans yellow `#FFD600`, trucks green `#00C853`. Those colors are `class_legend` in the manifest. `entity.color` is the paint sampled from inside the box.

Ids are assigned in order of first appearance. The same physical vehicle can be a different id after a rebuild if the tracker splits the path. Look vehicles up by alias.

For a `pass` event the first vehicle id is the one that overtakes.

## Splats

`splat_format` is `ply` (binary, little-endian, 3DGS layout: position, DC color, opacity, scale, rotation). The class files are shared, so every car points at `vehicles/car.ply`. Pose quaternions in the JSON are `[x, y, z, w]`. The rotation inside a PLY file is the 3DGS order `rot_0..3 = (w, x, y, z)`.

## What is not in this package

The tracker reads the burned-in class boxes. It does not run YOLO or SAM. Camera poses in `cameras.json` are still the configured stand-ins; the road lift uses the lane dashes and the configured focal length. Real poses, `.spz` training, and the AWS run are separate work.
