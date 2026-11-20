# Vision pipeline: footage → LLM observations → per-frame vectors

This is how uploaded footage becomes vehicle motion. In short: **the LLM does not predict a vector
for every frame.** It returns sparse **keyframes** (position, heading, speed at chosen times). The
app draws curves through them, and per-frame velocity, acceleration and force vectors are then
**derived numerically** from those curves. The model's reported speeds shape the curves where they
agree with its positions; its force estimates are stored next to the derived forces for comparison
but don't drive motion.

Code: `FrontEnd/app/electron/analysis.ts` (orchestration),
`electron/vision.ts` (provider choice), `electron/vision-frames.ts` (frame sheets),
`electron/codex-vision.ts` and `electron/claude-vision.ts` (the two providers), `electron/vision-prompts/*.md`
(prompts), `src/incident/spec.ts` (schemas + validation), `src/incident/motion.ts` (tracks),
`src/incident/engine.ts` (scene assembly), `src/kinematics/derive.ts` (vectors).

## End-to-end flow

```text
upload (1..n videos)
  │ SHA-256 each file
  ├─ all hashes in DEMO_SHA256S? ──► load electron/demo-incident/incident-spec.json (no LLM call)
  │
  ├─ cached analysis for (prompt version, provider + effort, models, video hashes)? ──► reuse spec
  │
  ├─ provider preflight: Codex needs a ChatGPT login (`codex login status`),
  │                      Claude Code needs a Claude subscription login (`claude auth status`)
  ├─ camera grid? split each tile into its own clip (electron/split-grid.ts)
  │
  ├─ 1  Scan      per camera, whole clip, 3 fps      → candidate events (contact, spin, debris…)
  ├─ 1b Verify    ≤5 candidates, t−3 s (t−6 s if not a contact) to t+3 s, 10 fps
  │                                                    → collision true/false + first_contact_s
  ├─ 2  Pass 1    all views, whole clip, 2 fps        → road, environment, every vehicle, crash period
  ├─ 3  Pass 2    all views, crash window, 10 fps     → dense keyframes, forces, contacts, rest poses
  ├─ 4  Census    per camera, whole clip, 2 fps       → every vehicle: lane, direction, seen times
  └─ 5  Merge     text only                           → which census sightings are the same vehicle
        │
        ▼
  sanitizeSpec(pass1, pass2) + applyCensus()  →  IncidentSpec (stored in MongoDB `analyses`)
        │
        ▼
  engine: planMotion() → 50 Hz tracks → layout.poseAt(t) → renderer
        │
        ▼
  deriveSceneKinematics() → 30 fps position/velocity/accel/force rows → MongoDB `frames`
```

## How frames reach the model

Neither provider is sent video. `prepareFrameSheets` in `vision-frames.ts` does the following for
each view, and the active provider then reads the sheets:

1. Plans sample times with `samplePlan(from, to, fps, views)`. The frame count is
   `min(ceil((to − from) · fps), max(4, floor(160 / views)))`, so **the requested fps is a ceiling,
   not a guarantee**. With four camera tiles each view gets at most 40 frames per request. Example:
   pass 1 asks for 2 fps on a 60 s clip, which would be 120 frames per view; it gets 40, about 0.67 fps.
2. Extracts frames with ffmpeg, scaled and padded to 768×432, and tiles them **2×2 into JPEG contact
   sheets** (four frames per image).
3. Labels every sheet in the prompt with the **absolute source timestamps** of its four cells in
   row-major order, and tells the model to use those times, never sheet indices.
4. Sends the sheets and the step's JSON schema (closed objects via `strictSchema`) to the provider
   chosen on the Providers page (`vision.ts`, stored in the app's `settings.json`; default Codex):

   | Provider | How it runs | Default model |
   | --- | --- | --- |
   | Codex (`codex-vision.ts`) | `codex exec` read-only on the ChatGPT login, every tool disabled, `SKILL.md` as developer instructions, `--output-schema`, sheets attached with `-i` | `gpt-6.1-terra`, xhigh effort |
   | Claude Code (`claude-vision.ts`) | `claude -p --json-schema` on the Claude subscription login, only the `Read` tool on a temp folder of sheets, no user settings, MCP servers or skills, `SKILL.md` as the system prompt, no session saved | `claude-opus-5-5`, high effort (Sonnet/Haiku selectable) |

   Both strip API-key environment variables, so they always bill the user's subscription login.
   API keys are never used for video processing. Codex requests time out after 10 minutes.

Because the model only sees sampled stills, it cannot observe motion between samples. Speeds and
contacts are inferred from position changes across sheets, which is why the prompts ask for
uncertainty in `caveats`.

## What the model returns

All positions use the **plan frame** ([coordinate-frames.md](coordinate-frames.md)): x along the
main road, y positive to the left, origin at the junction or nearest the crash. `SKILL.md` gives the
model reference sizes for scale (lane widths, dash lengths, vehicle lengths) and the rule that
positions are the **footprint centre on the ground**, not the image-box centre.

| Step | Schema (`spec.ts`) | Key output |
| --- | --- | --- |
| Scan | `SCAN_SCHEMA` | `{ t_s, camera, kind, vehicles, lane, description, confidence }[]` |
| Verify | `VERIFY_SCHEMA` | `collision`, `first_contact_s`, `confidence` |
| Pass 1 | `PASS1_SCHEMA` | road (`kind`, `region`, `lanes_each_way`, surface, grade), wind, crash period, `objects[]` with `keyframes[]` |
| Pass 2 | `PASS2_SCHEMA` | per crash participant: dense `keyframes`, `forces[]` (`fx_n`, `fy_n`, `cause`), `rest`; `contacts[]` with `normal_deg` |
| Census | `CENSUS_SCHEMA` | per camera: `toward_camera`, `lane_from_median`, `first_seen_s`, `last_seen_s`, `speed_mps`, `stopped` |
| Merge | `MERGE_SCHEMA` | groups of census entries, each optionally matched to a pass-1 object id |

A **keyframe** is `{ t_s, x_m, y_m, heading_deg, speed_mps }`. Pass 2 asks for one every
0.1–0.2 s inside the crash window; pass 1 keyframes are coarser and limited by the sampling cap above.

### Validation (`sanitizeSpec`)

- Drops keyframes with non-finite t/x/y; clamps `t` to the clip, x/y to ±2000 m, speed to 70 m/s;
  sorts by time.
- Pass 2's dense keyframes **replace** pass 1's inside the crash window (±0.3 s); outside it, pass 1's
  stay. Pass 2 contacts replace pass 1 contacts. Forces are kept only from pass 2.
- Fixes a common model error: pass 2 answering in clip-relative time (`fixClipTimes` shifts it back).
- Validates painted-line offsets, static-object footprints (counter-clockwise polygons) and contact
  references (`a` must be a vehicle; `b` a vehicle or static object).
- Category defaults (`CATEGORY_DEFAULTS`) fill missing or implausible size and mass.

`applyCensus` then adds every merged census vehicle that pass 1 missed as a **background** object
with a `lane_hint` and **no keyframes**, up to 150 objects. The motion step places these from their
lane hint (below). Matched pass-1 objects also gain a `lane_hint`, but they keep moving by their own
keyframes.

## From keyframes to per-frame vectors

1. **Tracks** (`planMotion` in `motion.ts`), sampled at `SIM_HZ = 50`:
   - Between two keyframes the path is a **cubic Hermite curve** through both positions. Each end's
     tangent is that keyframe's reported velocity (`speed_mps` along `heading_deg`) if it is within
     45° and a factor of 2 of the straight-line velocity between the two keyframes; otherwise the
     straight-line velocity is used, which makes that end linear. A vehicle's
     `adjustments` count how many ends fell back. Segments slower than 0.5 m/s stay straight.
     Heading is interpolated the short way round. Every keyframe is hit exactly.
   - Before the first and after the last keyframe the pose is held.
   - **Census-only vehicles** (no keyframes, but a `lane_hint`) get two synthesized keyframes: the
     centre of their reported lane, their census speed, passing the site's origin halfway through
     the time they were on camera. Stopped ones wait upstream of the origin in their lane, one car
     length plus 2.5 m apart. Their lane, direction, speed and on-camera window are observed; **their
     position along the road is assumed**, and their `adjustments` say so. This needs a straight
     road with lanes; on roundabouts they are removed with a reason.
   - Anything else without keyframes is removed (`"no observed positions available"`).
2. **Visibility** (`engine.ts`). A vehicle is `hidden` outside `[first keyframe t, last keyframe t]`,
   so it is neither drawn nor stored there.
3. **Scene poses**. `planToPose` converts plan x/y/heading to scene x/z/yaw. The engine registers a
   layout whose `poseAt(t)` reads the 50 Hz track.
4. **Derived vectors** (`deriveSceneKinematics` in `derive.ts`). The layout is resampled at **30 fps**
   and differentiated by central differences (one-sided at ends and across >15 m jumps):
   `v = Δp / Δt`, `a = Δv / Δt`, `F_net = m·a`, then split into drag, rolling resistance, grade,
   tyre/road and impact parts. See [kinematics-database.md](kinematics-database.md).

Even with Hermite curves, acceleration is the second derivative of a curve fitted through sparse
observations, so acceleration and force are much less reliable than positions, especially with
sparse keyframes. On the measured demo (one keyframe per 12.5 Hz frame) the curves move positions at
most 0.15 m from straight-line interpolation, and about 1.8% of reported speeds fall back.

The model's pass-2 force samples (`forces[]`, plan frame) are converted to the scene frame
(`[fx, 0, −fy]`) as `reportedForces` and stored as `force_reported` on the database row nearest in
time (within 0.25 s). They are never used to move vehicles.

## The prepared demo path

When every uploaded file's SHA-256 is in `DEMO_SHA256S` (`demo.mp4` and `demo_32s.mp4`), no model is
called. `loadDemoSpec` reads `electron/demo-incident/incident-spec.json` from disk on each use, stores
it under analysis id `demo-a9-verified-v1`, and labels the model `hand-verified`. Those strings are
routing and cache names, not evidence of verification.

That spec is built by `build-measured-spec.py` from calibrated per-frame measurements
(`measure/data/tracks_world.json`, `crash_pair.json`, `br_camera.json`, `divider.json`). There is one
keyframe per source frame (12.5 Hz) instead of LLM keyframes, so the same interpolation and
derivation above produce much denser, better-grounded vectors. Changing prompts does not change the
demo. Regenerate the spec instead.

## Caching and invalidation

- Analyses are cached in MongoDB `analyses` under
  `sha256(PROMPT_VERSION | "<provider>-frame-sheets-v2-<effort>" | fast model | precise model | video hashes…)`,
  so readings from different providers or models never collide. For Codex the middle part is
  `codex-frame-sheets-v2-xhigh`, the same as before providers were added.
  Bump `PROMPT_VERSION` in `spec.ts` whenever any `vision-prompts/*.md` prompt changes.
  "Refresh" in the UI bypasses the cache.
- Prompts are bundled into the Electron main process by esbuild (`--loader:.md=text`). Edit them,
  then run `npm run build:assistant` and restart Electron.
- Scenes store `analysisId + seed` and are rebuilt by the engine at startup.

## Known gaps

1. **Sampling cap.** Long or multi-camera clips are sampled far below the fps named in the prompts
   (see above). Pass 1 positions for long clips can be several seconds apart.
2. **Census placement is an assumption along the road.** Two census-only vehicles in the same lane
   with overlapping on-camera windows can overlap in the replay; nothing separates them.
3. **Forces are derived, not measured.** Stored forces are `m·a` from fitted curves with class-default
   masses. `force_reported` (the model's own reading) is available for comparison only.
