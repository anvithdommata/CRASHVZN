# CRASHVZN personal project handoff

Updated: 2026-11-16. Personal continuation repository: https://github.com/anvithdommata/CRASHVZN

## Read this first

CRASHVZN is a desktop application for turning traffic incident footage into an explorable 3D scene over time, with vehicle motion data and a chat/voice assistant. It began as a four-person SunHacks project in https://github.com/AarnavKannan/sunhacks. Anvith is continuing it in this personal fork to develop the product and a technically defensible portfolio project. Preserve the original contributors, source history, and third-party credits; personal continuation does not imply sole authorship of the hackathon implementation.

This document captures the intent, architectural evolution, current source, limitations, and proposed continuation. It was prepared against commit `fe160a6ca83ed9774e3f489404acd0340ef5cdb3`, which matched the fork's `main` before this documentation commit. No app execution, model analysis, or reconstruction acceptance test was performed for this handoff.

**Important correction to older documentation:** [HANDOFF.md](HANDOFF.md) records an interrupted November 15 checkpoint. Its statements that real world tracks and crash-pair outputs are missing, and that the active scene is still the 59.92-second fallback, are superseded by files now present. [STATUS.md](STATUS.md) describes an earlier packaged-scene pipeline, not the current desktop demo. Use those documents for historical requirements and debugging context, then inspect current source and artifacts.

## What we were trying to build

The problem: understanding a crash from several flat camera feeds requires mentally reconstructing space, identity, timing, and vehicle movement. We wanted a user to open an incident, replay it from arbitrary angles, inspect motion, and ask questions without learning a CAD-style interface.

The intended demo was:

1. Open a prepared incident and play the collision in 3D.
2. Scrub or step through the timeline alongside synchronized original footage.
3. Select a vehicle, inspect speed/acceleration/heading, and follow its movement.
4. Say or type commands such as "focus on the yellow car," "jump to impact," and "orbit 90 degrees left."
5. Ask a quantitative question and receive a response grounded in the same stored motion used by playback.
6. Export a clearly labeled demonstrative video.

Long-term audiences considered included investigators, insurers, lawyers, and people involved in crashes. The present implementation is a research/demo application; legal admissibility, liability assessment, and validated forensic measurement were never established.

"4D" here means a 3D scene that changes over time. It does not establish that the current demo uses a trained dynamic Gaussian-splat model.

## How the implementation evolved

### Original reconstruction plan

[requirements.md](requirements.md) proposed a composite Gaussian-splat scene: a static reconstructed background plus independently moving vehicle objects. The intended pipeline included video ingestion and hashes, camera recovery, detection/tracking, segmentation, metric scaling, splat training, kinematics, and a shared scene package. Candidate technologies included COLMAP, OpenSplat/gsplat, YOLO, BoT-SORT, SAM 2, and camera/depth models. These were design candidates, not a list of completed integrations.

ASU Sol and Slurm were intended for heavy reconstruction. AWS GPU compute, S3 storage, and EventBridge/SNS notifications were planned for the final deployment/demo. Backend scripts and a static-splat viewing route exist, but the repository does not establish a working automated upload-to-Sol/AWS-to-dynamic-reconstruction product. See [BackEnd/README.md](BackEnd/README.md).

### Practical demo direction

The product moved toward structured video analysis plus procedural road/vehicle meshes and observed trajectories. The desktop app has a general model-analysis route and a special known-clip route backed by a prepared incident specification. Python measurement work calibrates the crash camera, cleans tracks, derives world motion, and assembles that specification.

This made the demo controllable and inspectable while camera reconstruction, fixed-camera geometry, tracking fragmentation, and physical accuracy remained difficult. The continuation should make this boundary clear in UI, documentation, and portfolio claims.

## Current architecture and code map

```text
Source video(s)
  -> Electron ingestion / source hashing
  -> known demo hash: prepared measured incident-spec.json
     other footage: frame sheets -> authenticated Codex analysis -> incident spec
  -> spec validation -> scene engine -> road geometry + vehicle motion plans
  -> Three.js viewer + Zustand timeline/selection/camera state
  -> per-frame kinematics derivation + MongoDB storage/query

Text or local speech transcript
  -> assistant fast path or LLM provider
  -> MCP / controller tools -> Electron IPC -> renderer state and data queries
```

| Area | Entry points | Purpose |
| --- | --- | --- |
| Desktop application | `FrontEnd/app`, `electron/main.cjs`, `src/App.tsx` | Electron shell, React UI, local files, upload flow |
| Analysis orchestration | `FrontEnd/app/electron/gemini.ts` | Legacy filename; scan, confirmation, multi-pass analysis, cache, known-demo routing |
| Codex vision | `FrontEnd/app/electron/codex-vision.ts` | ffmpeg frame sheets, CLI authentication, structured JSON output |
| Scene contract | `FrontEnd/app/src/gemini/spec.ts` | Incident schema and sanitization |
| Scene construction/replay | `src/gemini/engine.ts`, `motion.ts`, `src/scene/mountScene.ts`, `layouts.ts` under the app | Convert specs to geometry, poses, visibility, playback |
| State and UI | `FrontEnd/app/src/store/useAppStore.ts`, `src/components/` | Library, viewer, timeline, source video, assistant, kinematics |
| Kinematics | `FrontEnd/app/src/kinematics/`, `electron/kinematics.ts` | Position, velocity, acceleration, heading, forces; database synchronization |
| Assistant | `packages/assistant/src/`, app `electron/assistant.ts`, `src/assistant/` | Provider adapters, prompts, tool registry, IPC/controller integration |
| Voice | App `electron/voice.cjs`, `electron/voice/`, `src/voice/` | Local sherpa-onnx speech recognition, model downloads, recorder/hotkey |
| Export | `FrontEnd/app/src/lib/exportVideo.ts` | Canvas capture and MediaRecorder; MP4 when supported, WebM fallback |
| Measured demo | `FrontEnd/app/electron/demo-incident/` | Prepared spec, calibration, tracking, world conversion, builders |
| Earlier pipeline | `pipeline/`, `BackEnd/pipeline/`, `schema/`, `shared/scene-types/` | Python CLI, scene packages, schemas, earlier reconstruction/collision work |
| Marketing site | `landing/` | Separate React/Vite site, CRASHVZN branding, downloads UI, embedded demo |

The duplicate pipeline/schema directories and legacy names reflect parallel hackathon work. Trace actual imports and runtime consumers before consolidating them.

## Current measured demo snapshot

The current `FrontEnd/app/electron/demo-incident/incident-spec.json` declares:

- Version `hand-verified-a9-v2-measured`; duration 32 seconds.
- 133 vehicle objects and 3 static objects. These are scene-object counts, not proof of 133 independently verified identities.
- Primary camera: bottom-right tile of a four-camera motorway mosaic. Other tiles provide context; opposing traffic is omitted.
- Source timing: 12.5 fps, frames 0 through 399, sample times 0 through 31.92 seconds.
- A stopped white van near the median and a yellow car approaching, moving out to overtake, returning, entering the median verge, and contacting the van.
- Median contact at frame 283 / 22.64 s; vehicle contact and crash start at frame 291 / 23.28 s; crash period ends at 31.92 s. These are current reconstruction annotations, not an independent finding made during this handoff.

The measured-data directory now contains `tracks_px_clean.json`, `tracks_world.json`, `crash_pair.json`, camera calibration, and `divider.json`. Current road annotations represent six crash-side lane-width strips rather than the older symmetric three-lane fallback. Check actual geometry and auxiliary-lane semantics before describing all strips as ordinary through lanes.

`electron/gemini.ts` recognizes hashes for both the full demo and the 32-second cut, then loads the prepared spec without live vision. It still uses identifiers `demo-a9-verified-v1` and model label `hand-verified`; those strings are routing/cache names and do not certify accuracy. The supplied full-length clip can therefore open a 32-second prepared reconstruction. Prompts alone cannot change this known-clip result.

### Accuracy compromises already visible in the source

The spec's caveats explicitly disclose uncertain distant speeds, out-of-camera continuation for 40 vehicles, 8 removed duplicate/clutter tracks, and longitudinal separation adjustments to 42 vehicles of up to 13.82 m. The yellow car's post-contact motion includes a pose relationship carried forward after it becomes occluded. Forces and impulses depend on motion estimates and assumed masses.

These adjustments matter: a smooth, non-overlapping animation can deviate from measured positions. The original goal was to preserve observed movement without inventing a universal traffic queue or moving vehicles merely to make the picture look tidy. Review the current builder's separation/continuation behavior against that goal. Preserve raw observations and expose every adjustment's provenance rather than silently treating adjusted output as measurement.

Earlier `STATUS.md` figures of 155 vehicles / 5,355 samples describe a different scene package. Do not combine them with the current 133-object demo as if they were one benchmark.

## Behaviors and constraints we cared about

- Cars must exist before impact when visible in the source. A recurring complaint was missing crash-lane traffic around 17 seconds.
- Recover the yellow car's full approach, lane changes, instability, impact, and aftermath. A straight approach plus a crash pose was insufficient.
- Keep stable identities across frames and use the same motion for playback, database queries, and assistant answers.
- Preserve normal traffic avoiding the stopped van. Do not create a generic pile-up or unexplained braking in every lane.
- Treat the bushy median/divider as a fixed object with contact geometry and coherent vector conventions, rather than decoration alone.
- Preserve the van's post-impact travel and the yellow car's occluded aftermath. Distinguish observation, interpolation, inferred rest, and out-of-view extrapolation.
- Camera movement should work during playback; scrolling UI panels should not accidentally move the scene camera.
- "Before the crash" refers to before the crash period starts; distinguish period boundaries from a particular contact event.
- Assistant quantities must come from tools, with units and uncertainty. The assistant navigates and explains rather than rewriting trajectories or assigning legal fault.
- Exported footage should carry the demonstrative-reconstruction watermark.

The old handoff lists these as outstanding at its checkpoint. Newer measurement commits addressed parts of them; this document does not claim that every concern remains broken or that every concern has passed user acceptance.

## Coordinate and time conventions

The measurement camera crop is x=481, y=304, width=479, height=300 within the 960x610 mosaic. Calibration coordinates are relative to that crop; do not mix them with full-frame coordinates or differently rounded encoded crops.

Measurement world W: X along the road away from the camera, Y to camera-right, Z up. Crash-side traffic travels approximately in -X. The measured builder maps to the application plan using `plan_x = -(X - X_ref)`, `plan_y = Y - Y_median`, heading `180 - heading_W`, and ground vectors `(-fx, fy)`. Three.js then uses `(x, height, z) = (plan_x, height, -plan_y)`. Inspect `measure/cam.py` and the current builder when changing any transform.

Use frame/fps timing consistently. Convert headings and vectors deliberately across frames, including contact normals, yaw, and forces. Image-box centers are not ground-contact points. Earlier packaged scenes may use different origins/conventions; their schemas are not sufficient to infer the current measured-demo transform.

## AI, voice, persistence, and export status

**Reconstruction model:** current vision source requests `gpt-6.1-terra` at `xhigh` through the user's authenticated Codex CLI. Historical project direction explicitly requested this route rather than substituting Gemini or an API key. Check model availability when continuing; do not silently substitute a different route. This is separate from the assistant's provider selection.

**Assistant:** the package implements Claude, Codex, and Gemini CLI adapters plus API adapters, a local command fast path, and a shared tool registry. Its README describes 25 tools and uneven provider verification. Adapter presence does not mean every provider has been exercised end to end. The MCP server uses localhost with a per-session bearer token; tools reach renderer state through the scene controller/IPC bridge. Authentication belongs to the user's installed CLI, not copied credentials.

**Voice:** the source has progressed beyond the old README's "still to do" note. Current code uses sherpa-onnx, Parakeet TDT, and VAD in a utility process; model files are downloaded to application data. Inspect current worker/model code rather than installing the earlier proposed Whisper sidecar by default. Runtime quality and first-run download behavior still need fresh verification on a new machine.

**Persistence:** MongoDB stores analyses/scenes and per-frame kinematics. `MONGODB_URI` selects an external database; otherwise the kinematics implementation starts an embedded mongod with on-disk data under Electron user data. Initial use may require a MongoDB binary download. A historical duplicate-key issue affected restored frame records: inspect incident hashes, IDs, and synchronization instead of deleting user data to hide mismatches.

**Export:** the active frontend implementation captures the viewport at 30 fps and uses browser MediaRecorder, choosing MP4/H.264 if available and WebM otherwise. The original offscreen-ffmpeg/cloud-export requirement is not a description of this implementation. AWS upload and notification completion is not established by the files inspected for this handoff.

## Running and validating the personal fork

Prerequisites: Node/npm, a working desktop/WebGL environment, ffmpeg/ffprobe for video analysis, and an installed/authenticated Codex CLI for the general analysis path. Python measurement work needs an independently recreated environment with NumPy, SciPy, and OpenCV; old temporary-machine venv paths in documentation are not portable. Voice and embedded MongoDB have first-run download requirements. Inspect lockfiles and package engine requirements for the appropriate Node version.

From the repository root, install the two app packages separately:

```powershell
cd packages/assistant
npm ci
cd ../../FrontEnd/app
npm ci
npm start
```

The start script builds the assistant bundle, starts Vite, then Electron. Backend/bundled changes require a rebuild/restart; renderer HMR does not reload the Electron main process. Check existing processes before starting another copy. If a shell has `ELECTRON_RUN_AS_NODE` set, inspect/unset it for the launch so Electron starts as a desktop app.

Useful checks, run separately from their indicated directories:

```powershell
# FrontEnd/app
npm run build

# packages/assistant
npm run typecheck
npm test

# landing, when changing the website
npm ci
npm run build
```

Measurement entry points include `build-measured-spec.py`, `measure/detect_track.py`, and `measure/world_kinematics.py`. Inspect their arguments, input provenance, and dependencies before regeneration. Some generated/review artifacts from historical commits are absent in this checkout; a path mentioned in an older handoff is not proof that the artifact is available. Do not overwrite measured output with `build-spec.py` / `traffic.py`'s older hand-authored fallback. Synthetic fixtures in `review_spec/` and `review_world/` are not real clip measurements.

### Existing evidence and its limits

The checked-in `tests/demo-render-status.json` records `passed: true`, 133 vehicles, impact at 23.28 s, finite values, and no recorded console errors. This is historical render evidence, not a fresh test in the personal fork and not proof of physical/source accuracy. Some screenshot paths point to another checkout and may not resolve here.

`tests/demo-fit/audit/` contains road, lane, motion, crash, and census checks. The motion report records 18,013 keyframes with no bad timing entries, while also listing overlaps and candidate identity fragments. A good timing check does not erase those concerns. Reprojection consistency with fitted tracks is also different from agreement with the original pixels or correct identity assignment.

For a meaningful acceptance pass, compare source and actual viewer at t=0, 10, 15, 17, 20, every frame around contact, and t=24, 28, 31.92. Check vehicle coverage by lane, first/last visibility, lane changes, crash contacts, post-impact motion, and agreement among renderer, database, and assistant. Record residual errors and assumptions, not only a pass/fail flag.

## Proposed personal-project continuation

This is a recommended roadmap, not a record of newly completed work or additional user commitments.

1. **Make the baseline reproducible.** Establish a clean-clone setup, portable paths, a documented prepared demo, and one recorded acceptance run. Replace stale top-level onboarding once the baseline is confirmed.
2. **Resolve motion fidelity and provenance.** Audit the 17-second coverage issue, fragments, overlaps, separation shifts, crash pair, and divider contacts. Retain raw and adjusted trajectories separately and quantify source-space reprojection error and coverage.
3. **Unify the source of truth.** Give a scene a content/version identity shared by rendering, frame storage, assistant queries, and caches. Verify invalidation when the prepared spec or calibration changes.
4. **Generalize beyond the allowlisted clip.** Define supported camera/footage types, user confirmation points, calibration inputs, and failure/quality gates. Validate on additional incidents rather than treating the prepared demo as general pipeline evidence.
5. **Choose the reconstruction direction deliberately.** Continue measured proxy meshes first unless splats solve a demonstrated need. If reviving Gaussian reconstruction, keep static background recovery separate from dynamic vehicle tracking and validate fixed-camera feasibility.
6. **Polish the usable product.** Exercise voice, provider selection, exports, setup errors, and persistence; then address packaging/installers and downloads. Marketing buttons alone do not establish distributed binaries.
7. **Add cloud infrastructure when needed.** Revisit GPU jobs, S3, and notifications after local inputs/outputs and quality checks are stable. Those services were hackathon goals, not prerequisites to understand the current demo.

## Resume and interview context

Describe the project as **an AI-assisted traffic incident reconstruction desktop application combining interactive 3D playback, estimated vehicle kinematics, and natural-language scene control**.

The strongest engineering stories are the integration boundaries: video observations to metric trajectories; one timeline shared across source video, rendering, and data; model tools connected to application state; local speech recognition; and explicit handling of uncertainty and occlusion. Explain the prepared-demo shortcut and the move from the original splat plan to proxy meshes when discussing tradeoffs.

Example wording to adapt to actual personal contributions:

> Co-developed CRASHVZN at SunHacks and continued development in a personal fork, integrating an Electron/React/Three.js incident viewer with synchronized playback, vehicle-motion queries, and MCP-based AI scene controls.

For later bullets, distinguish original team work from improvements made in this fork. The current demo contains 133 vehicle objects; that is scope, not an accuracy or performance result. Do not claim production deployment, forensic validation, fully automated arbitrary-video reconstruction, trained dynamic splats, or personal ownership of every subsystem without supporting work and evidence.

## References and preservation

- [requirements.md](requirements.md): original product vision and MVP acceptance goals.
- [roles.md](roles.md): intended four-person division of responsibilities; assignments are not proof of individual authorship.
- [ux-features.md](ux-features.md): interaction and query expectations.
- [HANDOFF.md](HANDOFF.md): detailed historical user complaints, coordinate notes, and interrupted work; reconcile with newer files.
- [FrontEnd/app/README.md](FrontEnd/app/README.md): startup and older splat boundary notes.
- [packages/assistant/README.md](packages/assistant/README.md): tool/provider architecture and historical verification.
- [BackEnd/README.md](BackEnd/README.md): static reconstruction/HPC route and illustrative collision physics.
- [CREDITS.md](CREDITS.md): third-party code, assets, footage, and license provenance. Preserve notices and review applicable licenses when changing distribution.

Keep source videos, calibration, raw observations, generated scene specs, and review results traceable. Do not commit private API keys, CLI tokens, database credentials, or personal login state. Continuing work should update this document when behavior or validation changes, rather than carrying old checkpoint claims forward as current facts.
