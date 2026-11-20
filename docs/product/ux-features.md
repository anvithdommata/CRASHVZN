# Viewer UI/UX features

What the viewer should let people do, and what the assistant (chat or voice) must be able to do
through its tools. Each item is marked with its state in the current code. How the camera items work
is in [camera-and-views.md](../camera-and-views.md).

| State | Meaning |
| --- | --- |
| ✅ | Implemented |
| ◐ | Partly implemented; see note |
| ○ | Not implemented |

## Camera

| Feature | State | Notes |
| --- | --- | --- |
| Pan, rotate and zoom with the mouse | ✅ | three.js OrbitControls; wheel zooms toward the cursor |
| Camera moves while the timeline plays | ✅ | |
| Standard views: front, back, left, right, top, isometric, dimetric, trimetric | ✅ | Assistant `camera_preset`; perspective views at those angles, not orthographic |
| Bottom view | ◐ | Exists as a preset but the camera can't go below the horizon, so it is clamped |
| Scrolling the dashboard/chat panels doesn't move the camera | ✅ | The panels sit outside the 3D canvas, which is the only element listening for wheel input |

## Playback

| Feature | State | Notes |
| --- | --- | --- |
| Play, pause, scrub, jump to crash | ✅ | Side panel and assistant |
| Adjustable speed | ✅ | 0.1× to 4× |
| Original footage alongside the 3D scene, in sync | ✅ | `source_video` layer |

## Vehicle POV

| Feature | State | Notes |
| --- | --- | --- |
| Ride along from a vehicle's driver seat | ✅ | Approximate eye point by vehicle class; not what the driver actually saw |
| Follow a vehicle from outside | ✅ | |

## Home screen

| Feature | State | Notes |
| --- | --- | --- |
| Tile layout of reconstructions with folders on the left | ✅ | `HomeScreen.tsx` |
| Demo reconstruction available on launch | ✅ | Built-in scenes plus saved reconstructions from MongoDB |
| Open a scene full-page; Back returns to the library | ✅ | |
| Delete a reconstruction | ✅ | Confirmation dialog; saved scenes and their frames leave MongoDB, built-in examples are hidden and can be restored |

## Exact transformations

| Feature | State | Notes |
| --- | --- | --- |
| Numeric camera controls: pan X/Y/Z (m), zoom (×), tilt and rotate (°) | ✅ | Number fields in the side panel, relative to the scene's home view |
| Exact camera position and target | ✅ | Assistant `camera_set`, `camera_move`, `camera_orbit` in meters and degrees |
| Rotate a vehicle or object by N degrees | ○ | The reconstruction is read-only by design |

## Scene bounds

| Feature | State | Notes |
| --- | --- | --- |
| Visible boundary box around the scene | ✅ | White wireframe; `bounds` layer |
| Camera stops at the box edge | ✅ | Site extent + 20 m, 0.3–90 m high; tools report `clamped: true` |
| Vehicles drive in and out inside it | ✅ | Hidden outside their observed time window |

## Per-frame physics data

| Feature | State | Notes |
| --- | --- | --- |
| Position, velocity, speed, acceleration, heading, yaw rate for every object and frame | ✅ | MongoDB `frames`, 30 fps, see [kinematics-database.md](../kinematics-database.md) |
| Forces, including air drag and rolling resistance | ✅ | Net force split into tyre/road, drag, rolling, grade and impact; coefficients are class defaults |
| The model's own force readings | ✅ | Stored as `force_reported` next to the derived force, for comparison; they don't move vehicles |
| Live speed of every vehicle at the playhead, and speeds at impact | ✅ | Kinematics panel and vehicle list; read off the trajectory (`scene/liveSpeed.ts`), same units as the database |

## Natural-language queries

| Feature | State | Notes |
| --- | --- | --- |
| "What was the red car's speed at 3.2 s?" | ✅ | Assistant reads stored frames with units and uncertainty |
| "…3 seconds before the crash?" | ✅ | Crash-relative time references |

## Crash period

| Feature | State | Notes |
| --- | --- | --- |
| The crash is a period with a start and an end | ✅ | `crash.start_s` / `crash.end_s` in the spec and database |
| "Before the crash" = before the start; "after" = after the end | ✅ | Encoded in the assistant's system prompt and time resolution |
