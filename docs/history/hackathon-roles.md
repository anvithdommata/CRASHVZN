> **Historical.** The four-person hackathon plan. Assignments were never filled in and do not describe who built what.

# Team Roles — Hackathon MVP

> Companion to [hackathon-requirements.md](hackathon-requirements.md). Section references (§) point there.

Four people, split along the hand-offs. Reconstruction is the riskiest and slowest work, so two people own it; two own the product.

---

## 1. Reconstruction lead (Sol): turns the videos into a 3D scene

- Gets the Python environment and Slurm job scripts working on Sol.
- Lines up the multiple videos in time, then works out where each camera was in every frame (VGGT / MASt3R / MegaSaM).
- Trains the still background splat and the vehicle splats (gsplat).
- Owns the fallbacks: if vehicle splats look bad, swaps in plain car models; if camera positions fail, places reference points by hand.

**Delivers:** `background.spz`, `vehicles/*.spz`, `cameras.json`
**Best fit:** whoever is strongest in ML/CV and comfortable on Linux/HPC.

---

## 2. Tracking & kinematics lead: turns the scene into numbers and the final package

- Detects and tracks vehicles (YOLO11 + BoT-SORT), outlines them across frames (SAM 2), and labels them ("red Toyota").
- Converts measurements to real-world meters, smooths the paths (Kalman + RTS), and calculates speed, acceleration and the impact moment.
- Owns the scene-package format (§6). The package is measured from `demo.mp4`, so persons 3 and 4 can build against it.
- Later owns the AWS GPU end-to-end run.

**Delivers:** `tracks.json`, `entities.json`, `events.json`, `manifest.json`, `incident.yaml`
**Best fit:** Python and math/physics, and the "is this number right?" mindset.

---

## 3. App / viewer lead (Electron): owns everything the user sees

- Sets up the Electron + Vite + React + TypeScript app and renders the splats with Spark.
- Moves the vehicles in time with the timeline (play, scrub, frame step, event markers) and builds the speed charts.
- Builds the manual tools: view cube, orbit/pan/zoom, measure, marker, follow camera.
- Builds the MP4 export (offscreen render → ffmpeg, watermark overlay).
- Owns the Zustand app state, which is what person 4's MCP tools control.

**Delivers:** the app.
**Best fit:** strongest frontend/three.js person.

---

## 4. Assistant, voice & AWS lead: makes the app controllable by voice and chat, and owns the demo

- Builds the MCP server (streamable HTTP on localhost) and the tools in §7, which call person 3's state functions.
- Builds the Claude, Codex and Gemini connectors with the API-key fallback.
- Writes the system prompt and adds instant handling for simple commands.
- Adds push-to-talk speech-to-text (faster-whisper or whisper.cpp).
- Sets up the S3 buckets and the EventBridge → SNS notification.
- Owns the demo script, pitch and slides.

**Delivers:** a working chat/voice panel, the AWS setup, the demo.
**Best fit:** a full-stack/TypeScript person who's a good presenter.

---

## Agreements that keep you unblocked

| Agreement | Between | Agree on it by |
|---|---|---|
| Scene package format (§6) + measured package from `demo.mp4` committed | 2 → 3, 4 | First 2 hours |
| Named state functions in the app (`focusEntity`, `seek`, `orbit`, …) | 3 ↔ 4 | First 3 hours |
| Splat file format and coordinates (`.spz`, Y-up, meters, origin) | 1 ↔ 2 ↔ 3 | First 3 hours |
| First real scene package from Sol | 1 + 2 → 3 | About halfway |

---

## Rough timeline (as % of the hackathon)

| Phase | Focus |
|---|---|
| **0–10%** | All four agree on the formats above. Persons 1 and 2 submit Sol jobs **immediately**, since the queue is your bottleneck. Person 4 gets Claude to call `camera.orbit` end to end. |
| **10–50%** | Each person works their own track against the measured `incident-demo` package. |
| **50–75%** | Load the real package into the app. Person 2 checks that the speeds make sense. Person 1 retrains or switches to a fallback if quality is poor. Person 3 polishes the tools. |
| **75–90%** | Run the full pipeline on AWS once and test the notification. Rehearse the 7-step demo script (§2) repeatedly. |
| **90–100%** | Freeze the code, record a backup demo video, and practice the pitch. |

---

## Pairing rules

- If Sol work finishes early, person 1 moves over to help person 3 with the viewer's handling of moving vehicles. That's the trickiest piece in the app.
- Person 4 does the pitch, but person 2 explains the speed and impact calculations if judges ask.
- Everyone must be able to run the app from the **known-good scene package**, so the demo never depends on one laptop.

---

## Assignments

| Role | Name |
|---|---|
| 1. Reconstruction lead (Sol) | _TBD_ |
| 2. Tracking & kinematics lead | _TBD_ |
| 3. App / viewer lead | _TBD_ |
| 4. Assistant, voice & AWS lead | _TBD_ |
