# Kinematics database (MongoDB)

The "vector database" is a **MongoDB store of per-frame kinematic vectors**: for every object at
every stored frame, its position, velocity, acceleration, heading, yaw rate and force vectors. It is
**not** an embedding/similarity-search vector database. Lookups are by incident, entity and time.

It exists so that the timeline, the kinematics panel and the AI assistant all quote the same numbers.
The assistant never reads the renderer's animation; it reads these rows.

Code: `FrontEnd/app/electron/kinematics.ts` (main process: MongoDB, IPC, interpolation),
`src/kinematics/derive.ts` (computes the rows), `src/kinematics/store.ts` (renderer sync and reads),
`src/assistant/sceneController.ts` (assistant tools that query it).

## Where the database runs

| Condition | Database |
| --- | --- |
| `MONGODB_URI` set | That server (Atlas, team server, local `mongod`) |
| Otherwise | Embedded `mongod` from `mongodb-memory-server`, WiredTiger files in `<Electron userData>/mongo`, persisted across restarts. The first run may download a MongoDB binary. |

Database name: `MONGODB_DB`, default `reconstruct`. On quit the app runs `fsync` before stopping
the embedded server so nothing is lost on Windows.

## Collections

| Collection | Written by | Contents |
| --- | --- | --- |
| `incidents` | `kinematics:sync` | One document per scene: metadata, entity list, crash period, contacts, physics, content hash |
| `frames` | `kinematics:sync` | One document per entity per stored frame (below) |
| `analyses` | `electron/analysis.ts` | Raw LLM outputs (scan, census, merge, pass 1, pass 2) and the sanitized spec, keyed by analysis id |
| `scenes` | `electron/analysis.ts` | Library entries: `analysisId` + `seed`, rebuilt by the engine at startup |

Indexes on `frames`: **unique** `{ incident_id, entity_id, t }`, and `{ incident_id, t }`.

### `frames` document

All vectors are `[x, y, z]` in the **assistant world frame**: meters, +x east, +y up, −z north,
origin at the crash point ([coordinate-frames.md](coordinate-frames.md)). Vehicles are on the ground,
so position y and all vertical components are 0.

| Field | Meaning |
| --- | --- |
| `incident_id`, `entity_id` | Scene id and vehicle or static-object id |
| `t` | Seconds on the source timeline (rounded to 1 µs) |
| `frame` | Index at the **database rate (30 fps)**, not a source-video frame number |
| `position` | Ground position (m) |
| `velocity`, `speed` | Vector (m/s) and its magnitude |
| `accel`, `accel_long` | Acceleration vector (m/s²) and its component along the direction of travel (negative = slowing) |
| `heading_deg` | Compass bearing of travel: 0 north, 90 east. Below 0.3 m/s it falls back to the body's facing |
| `yaw_rate_dps` | Heading change rate, positive = turning right |
| `mass_kg` | Spec mass, else class default (`CLASS_MASS`: sedan 1500, SUV 1900, van 2200, truck 8000, bus 12000 kg) |
| `force_net` | `mass × accel` (N) |
| `force_parts` | `force_net` split into `tyre_road`, `drag`, `rolling`, `grade`, `contact`; the parts sum to `force_net` |
| `force_reported` | The vision model's own force reading within 0.25 s of this time (`{ vector, cause, note }`, scene frame), for comparison with `force_net`. Null when it gave none (only crash vehicles get readings, from pass 2) and for the prepared demo, whose spec has no model forces |
| `involvement` | `crash` or `background` |
| `sigma` | Fixed 1σ band by tier, **not a fitted covariance**: crash 0.5 m / 1.0 m/s / 1.5 m/s², background 2.0 m / 3.0 m/s / 3.0 m/s². Null for scripted preview scenes |

### `incidents` document

`{ _id, title, hash, fps, duration_s, origin_scene, crash: { start_s, end_s, vehicles }, entities[],
basis, physics: { wind, gradePercent, surface, mu, air_density }, contacts[], synced_at }`

- `origin_scene` is the crash point in three.js coordinates, the offset between scene and world.
- `basis` is plain-language provenance, e.g. "scripted preview animation, not measured from footage".
- `entities[]` has `{ id, label, type, mass_kg, from_s, to_s, involvement }`. Static scenery (median
  verge, barrier) has `type: "static"` plus a `static` block: footprint, height, material, friction,
  restitution, stiffness, `immovable`, `sigma_m`, `source`, `note`.
- `contacts[]` has `{ a, b, kind, t_s, frame, point, normal, impulse_ns, impulse_basis, window_s,
  force_avg_n, source, note }`. `normal` is the direction **b** is pushed.

## How rows are computed (`deriveSceneKinematics`)

Input is a scene's layout (`poseAt(t)` for every vehicle) plus its spec-derived metadata. For each
vehicle:

1. Sample the pose at `FPS = 30` over the whole duration. Frames where the vehicle is `hidden` are not
   stored, so the database answers "not in the scene" there.
2. `position = scene position − crash origin`.
3. `velocity` and then `accel` by **central difference**, falling back to one-sided differences at the
   ends, at hidden edges, and across any jump over **15 m** in one frame (treated as leaving and
   re-entering, never as motion).
4. Forces, with `θ = atan(grade%/100)`, `v_air = v − wind`, `ρ = 1.225 kg/m³`:

   ```
   F_net     = m · a
   drag      = −½ · ρ · CdA · |v_air| · v_air          CdA by class: sedan 0.65 m², SUV 0.9, van 1.1, truck 5.0
   rolling   = −Crr · m · g · cos θ · v̂                 Crr 0.012 (0.007 trucks/buses)
   grade     = [−m · g · sin θ, 0, 0]                   slope rises toward +x
   tyre_road = F_net − drag − rolling − grade
   ```

   During the crash period, for crash vehicles, any `tyre_road` above `1.1 · μ · m · g` is more than
   tyres can transmit. The excess is moved into `contact` and `tyre_road` is capped at that limit.
5. **Static objects** get one row per frame with zero position change, velocity and acceleration, and
   `mass_kg: 0`. A contact force on them is spread over a window of ±3 frames (±0.1 s) and cancelled
   by the anchorage (`tyre_road = −contact`), so they never move.
6. **Contact impulses**: if the spec gives `impulse_ns`, it's used (`impulse_basis: "spec"`).
   Otherwise it's derived from the change in vehicle a's velocity along the normal across the window:
   `J = m_a · max(0, (v_a(before) − v_a(after)) · n)` (`"derived"`). `force_avg_n = n · J / window_s`.
7. The incident `hash` is an FNV-1a hash of the JSON of `[meta, frames]`.

## Sync and read API

Renderer → main process over IPC (`window.crashvzn.kinematics`, see `electron/preload.cjs`):

| IPC | What it does |
| --- | --- |
| `kinematics:status` | `starting` / `ready` / `error`, and `embedded` or `external` |
| `kinematics:sync(meta, rows)` | If the stored incident has the same `hash`, does nothing. Otherwise deletes that incident's frames, inserts the new rows in chunks of 5,000 (journaled), and upserts the incident. |
| `analysis:delete-scene(id)` | Deletes the saved scene, then its frames and incident doc (`forget` in `kinematics.ts`). Leaves the cached `analyses` reading |
| `kinematics:incident(id)` | Incident metadata, or an error if it was never synced |
| `kinematics:sample(id, entity, times[])` | Values at arbitrary times |
| `kinematics:positions(id, t)` | Every entity's position at one time (for distances and "what's near what") |

`src/kinematics/store.ts` calls `sync` once per scene per session (`ensureKinematics`), again after
`forgetKinematics(sceneId)` when a scene is rebuilt, and for all built-in scenes at startup.

**Sampling between stored frames.** `sample` loads rows within ±2 database frames (±2/30 s) of the
requested times. It returns the exact row on a match; otherwise it **linearly interpolates** every field between
the neighbouring rows (headings by the shortest angle; `force_reported` snaps to the nearer row). If
the two rows are more than 15 m apart it returns the nearer row instead of blending. Outside the
data it returns the edge row within 1.5 frames, otherwise `null`.

## Who may write

Only the app writes: `kinematics:sync` from data the engine computed, and deleting a reconstruction
from the library. Both run through one queue per incident in the main process (`enqueue` in
`electron/kinematics.ts`), so a delete waits for a sync still in flight instead of racing it. No
assistant/MCP tool can write or change trajectories; the assistant's tools are read-only on this data.

## Known issues

- Fixed 2026-11-16: startup used to log an E11000 duplicate-key error while restoring saved scenes.
  React StrictMode runs startup effects twice in development, so two `kinematics:sync` calls for the
  same scene overlapped: one deleted rows while the other inserted. Syncs of one incident are now
  queued in the main process (`enqueue` in `electron/kinematics.ts`), and the second sees the
  matching hash and skips.
- Rows are a resampling of interpolated tracks (see
  [vision-pipeline.md](vision-pipeline.md#from-keyframes-to-per-frame-vectors)). Acceleration and force
  inherit the keyframe spacing and are the least reliable fields.
- `tracks.json` from the older Python pipeline (`BackEnd/pipeline`) was meant to load through the same
  sync call. Nothing does that today.
