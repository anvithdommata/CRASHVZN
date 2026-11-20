> **Historical (hackathon MVP plan).** Much of this was not built as written: no trained splats, no Sol/AWS automation, export uses the browser's MediaRecorder rather than offscreen ffmpeg. What exists today is described in [docs/README.md](../README.md).

# Requirements — Traffic Incident 4D Reconstruction (Hackathon MVP)

> Working title: **Reconstruct** (rename freely)
> Status: Draft v0.1 — hackathon MVP scope
> Last updated: 2026-11-14

---

## 1. Summary

A desktop app that turns video footage of a traffic incident into an explorable **4D (3D + time) Gaussian-splat reconstruction** with **vehicle kinematics** (position, speed, acceleration, heading over time). Users navigate the scene with normal 3D tools *or* by talking/typing to an LLM assistant ("orbit 30° left", "zoom in on the red Toyota", "jump to impact"). The assistant runs on the **user's own LLM subscription** (Claude Code, Codex CLI, or Gemini CLI) and controls the app through **MCP tools**, not computer use.

Reference concept: [Liablix — AI accident reconstruction](https://www.liablix.com/automatic-claimsassessment-process/ai-accident-reconstruction/).

### Target users (long term)
Courts, police departments, law firms, insurers, and people involved in accidents. Most are **non-technical**; the LLM assistant is how they operate a CAD-like 3D tool without training.

---

## 2. Hackathon MVP scope

We are building for **one specific traffic incident** for which we already have video(s). Everything is tuned to make that one incident reconstruct well and demo smoothly.

### In scope (MVP)
| # | Capability |
|---|---|
| M1 | Offline pipeline that reconstructs our incident into a 4D splat scene + per-vehicle trajectories |
| M2 | Electron desktop app that loads the reconstructed scene and plays it on a timeline |
| M3 | Kinematics panel: speed / acceleration / heading per vehicle over time, speed at impact |
| M4 | Manual tools: orbit / pan / zoom, view cube, measure distance, place marker |
| M5 | LLM chat (text) driving the app through MCP tools, using the user's signed-in CLI (Claude / OpenAI / Gemini) |
| M6 | Voice input (push-to-talk → local speech-to-text → same chat pipeline) |
| M7 | Export the current camera path + timeline as an MP4 |
| M8 | AWS demo deployment: evidence + outputs in S3, pipeline runnable on AWS GPU, "export ready" notification |

### Out of scope (post-hackathon)
- Arbitrary user-uploaded incidents (generalized pipeline, quality gating)
- Accounts, roles, multi-party case sharing
- Full chain-of-custody / audit logging, court-ready PDF reports
- Formal uncertainty analysis and methodology validation (Daubert/Frye readiness)
- Full SolidWorks-style toolset (section planes, constraints, annotations library)
- Installer / auto-update / code signing

### Demo script (the thing we must nail)
1. Open the app → incident is already loaded (pipeline was pre-run on Sol / AWS).
2. Press play: the collision unfolds in 3D; scrub the timeline.
3. Voice: **"Zoom in on the red Toyota."** → camera flies to it.
4. Voice: **"Jump to the moment of impact. How fast was it going?"** → timeline seeks, assistant answers from kinematics data.
5. Voice: **"Orbit 90 degrees to the left and show me from above."**
6. Manual: measure the distance between the two vehicles 1 s before impact.
7. **"Export this as a video."** → MP4 renders, uploads to S3, notification arrives.

---

## 3. Compute environments

| Environment | Purpose | Notes |
|---|---|---|
| **ASU Sol** (supercomputer) | Development + all heavy pipeline runs during the hackathon | Slurm jobs on A100/H100 nodes; conda/mamba envs (no Docker — use Apptainer if containers are needed); pull artifacts back to laptops |
| **Local GPU** (dev laptops/desktops) | Running the Electron app; optional local pipeline runs | Viewer must run on any GPU that supports WebGL2; pipeline needs NVIDIA ≥16 GB VRAM |
| **AWS** | Final testing + live demo | S3 for evidence and outputs, GPU instance (g5/g6) for an end-to-end pipeline run, event-driven notifications |

The pipeline must be **environment-agnostic**: same Python package and config, runnable via a Slurm script (Sol), a local CLI, or an AWS job.

---

## 4. Architecture

```
            ┌──────────────────────── Offline pipeline (Python, GPU) ────────────────────────┐
 videos ──▶ │ ingest → sync → camera poses → detect/track/segment → 4D splat training →      │
            │ vehicle 6DoF poses → kinematics → scene package (splats + tracks + metadata)    │
            └───────────────────────────────┬───────────────────────────────────────────────┘
                                            │  scene package (S3 or local folder)
                                            ▼
┌────────────────────────────── Electron desktop app ──────────────────────────────┐
│ Renderer (React + three.js + Spark)                                              │
│   3D viewport · timeline · kinematics panel · tools · chat/voice panel           │
│        ▲  app state (Zustand)  ▲                                                 │
│        │ IPC                   │                                                 │
│ Main process                                                                     │
│   MCP server (streamable HTTP, 127.0.0.1 + token) ◀── user's LLM CLI subprocess  │
│   LLM adapter (claude / codex / gemini)                                          │
│   STT sidecar (faster-whisper / whisper.cpp)                                     │
│   Export (offscreen render → ffmpeg) · AWS SDK (S3 upload, events)               │
└──────────────────────────────────────────────────────────────────────────────────┘
```

**Key principle:** the LLM can only **navigate, query, and explain**. It can never modify the reconstruction, trajectories, or kinematics. All MCP tools are view/query-only, except annotations and export.

---

## 5. Functional requirements

### 5.1 Reconstruction pipeline (M1)

**Approach: composite 4D scene ("Street Gaussians"-style).**
- A **static background** splat for road, buildings, and signage, trained with vehicles masked out.
- One **splat object per vehicle**, treated as rigid and moved by a per-frame 6DoF pose.

This gives true 4D playback, keeps each vehicle selectable as an entity, and the vehicle poses *are* the kinematics. Fully deformable 4DGS (e.g. Shape of Motion, MoSca) is a **stretch goal**; we may use it for non-rigid content such as pedestrians.

| Step | Requirement | Candidate tools |
|---|---|---|
| P1 Ingest | Hash every source video (SHA-256), extract frames + metadata (fps, resolution, timestamps) | ffmpeg, ffprobe |
| P2 Sync | If multiple videos, time-align them (audio cross-correlation or manual offset in config) | numpy/scipy; manual fallback |
| P3 Camera poses | Recover intrinsics/extrinsics per frame, per camera | VGGT, MASt3R, MegaSaM (dynamic scenes); COLMAP/GLOMAP fallback |
| P4 Detect & track | Detect vehicles and track IDs across frames | YOLO11 + BoT-SORT/ByteTrack |
| P5 Segment | Per-vehicle masks across time | SAM 2 (prompted by tracker boxes) |
| P6 Attributes | Label each vehicle: color, type, make/model guess → used for "red Toyota" | VLM pass on best crops; manual override in config |
| P7 Metric scale | Convert to meters using known references | Lane width, vehicle dimensions from make/model, manual measurement in config |
| P8 Background splat | Train static splats with vehicle masks excluded | gsplat (nerfstudio) |
| P9 Vehicle objects | Per-vehicle splats + per-frame 6DoF poses | gsplat with per-object pose optimization; fallback: sized proxy mesh |
| P10 Kinematics | Smooth poses, then derive speed, acceleration, yaw rate, impact time/location | numpy/scipy; Kalman + RTS smoother |
| P11 Package | Emit a scene package (see §6) | — |

- Pipeline is config-driven (`incident.yaml`), with idempotent per-step caching so failed steps can be rerun individually.
- Deterministic where possible: fixed seeds, pinned model versions recorded in the package.
- **Manual overrides are allowed** for the MVP (sync offset, scale reference, vehicle labels, impact frame). Correctness of the one demo incident matters more than full automation.

### 5.2 Viewer (M2)
- Render the background splat + per-vehicle splat objects at ≥30 fps on a mid-range GPU.
- Apply vehicle poses from the trajectory data at the current timeline time (interpolated).
- Toggles: show/hide each vehicle, trajectory trails, original-camera frustums, source-video picture-in-picture synced to the timeline.
- Entity selection by click (vehicle highlight + info card).

### 5.3 Timeline (M2)
- Play/pause, scrub, step frame-by-frame, playback speed (0.1×–2×).
- Event markers (e.g. "impact", "braking starts") from the scene package.
- Time displayed relative to impact (e.g. `T−1.20 s`).

### 5.4 Kinematics panel (M3)
- Per-vehicle charts: speed (mph and km/h), acceleration, heading vs. time, with a cursor synced to the timeline.
- Readouts at the current time: speed, distance to other vehicle, time-to-impact.
- Show an uncertainty band where the pipeline provides one (simple ± estimate in the MVP).

### 5.5 Manual tools (M4)
- Orbit / pan / zoom (mouse + trackpad), SolidWorks-style **view cube** (top/front/side/iso snaps), reset view.
- **Measure:** click two points (on splats or vehicles) → distance in meters/feet.
- **Marker:** drop a labeled pin at a 3D point.
- **Follow camera:** lock the camera to a vehicle.

### 5.6 LLM assistant via the user's subscription (M5)
- **Providers:** Anthropic (Claude Code `claude`), OpenAI (Codex CLI `codex`), Google (Gemini CLI `gemini`). The app detects which CLIs are installed and signed in.
- **Adapter interface:** `start()`, `send(message)`, stream back `text | tool_call | done | error`, `stop()`. One implementation per CLI.
  - Claude: long-lived `claude -p --input-format stream-json --output-format stream-json --mcp-config <file> --append-system-prompt <file>`.
  - Codex: `codex exec --json` (or `codex app-server`) with our MCP server registered via config.
  - Gemini: `gemini` non-interactive with streaming JSON output and `mcpServers` in a project-scoped settings file.
  - *Exact flags must be verified in the first spike (§10).*
- **Our MCP server** runs inside the Electron main process on `127.0.0.1` (streamable HTTP, per-session bearer token), and is registered with whichever CLI is used.
- **The CLI is sandboxed to our tools only:** built-in shell/file/web tools are disabled or denied, so the assistant cannot touch the filesystem.
- **Fallback:** user-provided API key for any of the three providers.
- **Terms of service:** the app only runs the CLI that the user installed and signed in to, on their own machine. We never proxy or store their subscription credentials.
- **Fast path:** a local rule-based parser handles trivial commands ("zoom in", "pause", "play", "reset view") instantly without an LLM round trip.

### 5.7 Voice (M6)
- Push-to-talk (hold key / button); optional VAD-based hands-free mode as a stretch goal.
- Local speech-to-text: faster-whisper (Python sidecar, GPU) or whisper.cpp; no audio leaves the machine.
- Transcript is shown in chat, then routed through the fast path → LLM, same as typed text.
- Target: utterance end → transcript in <1 s.

### 5.8 Export (M7)
- Record a camera path (current view, or the assistant's "fly-through"), render offscreen at 1080p/30, encode with ffmpeg to MP4.
- Burned-in overlay: timestamp relative to impact, vehicle speed labels, and a watermark: "Demonstrative reconstruction — not original footage".

### 5.9 AWS demo automation (M8)
- **S3:** a source-videos bucket (versioned; Object Lock as a stretch goal) and a scene-package/exports bucket.
- **Pipeline run:** a script or Step Function that launches a GPU instance (g5/g6), runs the pipeline on the incident from S3, and writes the scene package back.
- **Events:** an S3 put on exports → EventBridge → SNS (email/SMS) "Reconstruction/export ready", with a presigned link.
- **Desktop app:** can load a scene package from S3 as well as from a local folder.
- Credentials via an AWS profile / SSO on the demo machine; nothing hardcoded.

---

## 6. Scene package format (pipeline → app contract)

```
incident-<id>/
  manifest.json          # version, source video hashes, pipeline + model versions, seeds, fps, units, CRS
  background.spz         # static splats (or .ply)
  vehicles/
    v1.spz               # vehicle splat in its local frame
    v2.spz
  tracks.json            # per vehicle: [{t, pos[x,y,z], quat[x,y,z,w], vel, acc, yaw_rate, sigma}]
  entities.json          # per vehicle: id, label ("red Toyota Camry"), color, type, dims, aliases
  events.json            # [{t, type: "impact"|"brake"|..., vehicles:[...], note}]
  cameras.json           # source camera poses over time (for frustums / PiP)
  sources/               # proxy (low-res) copies of source videos for PiP
```

- Units are SI (meters, seconds), Y-up, with an origin at a scene landmark.
- The frontend and pipeline teams can work in parallel against a **hand-made mock package** from day one.

---

## 7. MCP tool surface (v0)

All tools return JSON; navigation tools also return the resulting camera state so the LLM can chain actions.

| Tool | Args | Effect |
|---|---|---|
| `scene.describe` | — | Entities, events, duration, current time & camera |
| `entity.find` | `query` (e.g. "red toyota") | Ranked entity matches with ids |
| `camera.focus` | `entity_id`, `distance_m?` | Fly to / frame an entity |
| `camera.orbit` | `yaw_deg`, `pitch_deg` | Orbit around the current target |
| `camera.pan` | `dx_m`, `dy_m` | Pan in the view plane |
| `camera.zoom` | `factor` or `distance_m` | Dolly in/out |
| `camera.preset` | `top\|front\|left\|right\|iso\|driver:<id>` | View-cube snaps / driver POV |
| `camera.follow` | `entity_id \| null` | Lock / unlock follow camera |
| `timeline.seek` | `t_s` or `event` ("impact") or `relative_s` | Move playhead |
| `timeline.play` / `timeline.pause` | `speed?` | Playback control |
| `kinematics.query` | `entity_id`, `t_s?`, `fields[]` | Speed / accel / heading (with units + uncertainty) |
| `measure.distance` | `a`, `b` (entity ids or points), `t_s?` | Distance at a time |
| `marker.add` | `label`, `point \| entity_id` | Drop a marker |
| `ui.toggle` | `trails\|frustums\|pip\|vehicle:<id>` | Show/hide overlays |
| `export.video` | `camera_path?`, `range?` | Start an MP4 export |

**Harness / system prompt requirements**
- Role: a guide for non-technical users (lawyers, officers, judges). Plain language, no jargon, and always state units.
- Every factual number must come from `kinematics.query` / `measure.distance` (no guessing). Answers are phrased as "the reconstruction estimates…".
- Ambiguous references → ask, or pick the top `entity.find` match and say which one was used.
- Narrate actions briefly ("Zooming in on the red Toyota…").
- Refuse to alter evidence or speculate on fault or liability.

---

## 8. Tech stack

| Layer | Choice |
|---|---|
| Desktop shell | Electron + Vite + React + TypeScript |
| 3D | three.js + Spark (`@sparkjsdev/spark`) for splats; three.js `TransformControls` / custom tools |
| UI | Tailwind + shadcn/ui; Recharts or uPlot for kinematics charts |
| State | Zustand (single store shared by UI and MCP handlers) |
| MCP | `@modelcontextprotocol/sdk` (TypeScript), streamable HTTP transport |
| LLM | User's `claude` / `codex` / `gemini` CLI; API-key fallback via the provider SDKs |
| STT | faster-whisper (Python sidecar) or whisper.cpp |
| Pipeline | Python 3.11, PyTorch, gsplat, VGGT / MASt3R / MegaSaM, Ultralytics YOLO11, SAM 2, scipy, ffmpeg |
| Pipeline orchestration | Typer CLI + per-step cache; Slurm script for Sol |
| Cloud | AWS S3, EC2 GPU (g5/g6), EventBridge, SNS, (Step Functions stretch); AWS SDK v3 in Electron |

---

## 9. Non-functional requirements

| Area | Target |
|---|---|
| Viewer performance | ≥30 fps at 1080p on an RTX 3060-class GPU |
| Command latency | Fast-path commands <100 ms; LLM-driven commands <4 s to first camera motion |
| Privacy | Video and audio stay local or in our S3; the LLM receives only scene metadata and tool results, never raw video |
| Integrity | Source video hashes in the manifest; reconstruction data read-only in the app |
| Portability | The pipeline runs identically on Sol, a local GPU, and AWS from one config |
| Honesty | All exports watermarked as demonstrative; numbers shown with units and (where available) uncertainty |

---

## 10. Risks & fallbacks

| Risk | Fallback |
|---|---|
| Vehicle splats are poor (few views, motion blur) | Replace with a sized proxy car mesh, keeping the same tracks; background stays a splat |
| Camera poses fail on moving/shaky footage | Use the best single static camera; COLMAP with manual masks; hand-placed control points |
| Metric scale is wrong | Manual scale from a known measurement (lane width, curb length) in `incident.yaml` |
| CLI flags/behavior differ from expectations | Day-one spike per CLI; API-key adapter as the guaranteed path for the demo |
| LLM latency too high for voice | Expand the fast-path parser; pre-warm a persistent CLI session |
| Sol queue delays | Submit long training jobs early; cache intermediates; keep a known-good scene package |
| Live AWS run fails during demo | Pre-run and cache; demo the notification with a pre-rendered export |

---

## 11. Work breakdown (suggested tracks)

1. **Pipeline (Sol):** ingest → poses → track/segment → splats → kinematics → scene package.
2. **Viewer:** Electron shell, splat rendering, timeline, vehicle pose playback, manual tools, kinematics panel.
3. **Assistant:** MCP server + tools, CLI adapters (Claude / Codex / Gemini), system prompt, fast path, voice STT.
4. **AWS + export:** S3 buckets, GPU run script, EventBridge/SNS, MP4 export, demo polish.

**Day-one milestones**
- Mock scene package committed, so tracks 2 and 3 are unblocked.
- One CLI (Claude) calling `camera.orbit` end to end.
- Poses recovered for our incident footage on Sol.

---

## 12. Open questions
- Hackathon length and team assignments.
- Incident footage details: how many videos, which sources (dashcam / CCTV / phone), static vs. moving cameras, resolution/fps, and whether there's audio for sync.
- Which Sol partition/GPU allocation we have and the job time limits.
- Do we need pedestrians/cyclists in this incident (non-rigid → deformable 4DGS)?
- Product name.
