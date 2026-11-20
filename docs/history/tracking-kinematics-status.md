> **Historical.** Status of the older Python scene-package pipeline (now `BackEnd/pipeline`), not the current desktop demo. Its numbers (155 vehicles, 59.92 s, impact 21.76 s) describe that package only. Commands below now live under `BackEnd/` (e.g. `BackEnd/pipeline/.venv/bin/reconstruct build`).

# Status — `tracking-kinematics`

**Role:** Tracking & kinematics (role 2)  
**Updated:** 2026-11-14  
**Branch:** `tracking-kinematics`

## Summary

`reconstruct build` measures vehicles from `demo.mp4` (burned-in class boxes), lifts them onto the road, smooths kinematics (Kalman + RTS), and writes `scene-packages/incident-demo/`. The clip contains a **multi-vehicle accident** on carriageway B (visible mainly in `cam_br`). The package keeps moving traffic **and** stopped/braking vehicles, and records `impact` / `brake` / `rest` events when the tracks support them.

Viewer and MCP teammates load the folder; they do not need to run the pipeline.

## Current package (`incident-demo`)

| | |
|---|---|
| Source | `demo.mp4` → `sources/mosaic.mp4` |
| Command | `reconstruct build` |
| `tracks_are_schematic` | `false` |
| Vehicles / samples | **155** / **5355** |
| Accident | Yes — carriageway B / `cam_br` |
| `impact_time_s` | **21.76** (primary crash wave on carriageway B; visual impact ~23 s) |
| Impact events | `v53`–`v56` @ 21.76 s (hard-stop near neighbor; some wreck boxes incomplete) |
| Other events | brakes, rests, passes, lane changes |
| Per-sample kinematics | `pos`, `quat`, `vel`, `acc`, `speed_mps`, `heading_deg`, `yaw_rate`, `sigma` |

## How to regenerate

```sh
pipeline/.venv/bin/pip install -e "pipeline/[dev]"   # once
pipeline/.venv/bin/reconstruct build
pipeline/.venv/bin/reconstruct validate scene-packages/incident-demo
cd pipeline && .venv/bin/pytest -q
```

Config: `pipeline/configs/incident-demo.yaml`.

## What works

- [x] Scene package format + JSON Schema + TS types
- [x] CLI: `reconstruct build` / `reconstruct validate`
- [x] Box detection from class wireframes (not YOLO on this mosaic)
- [x] Per-camera tracking, ground lift, cross-camera associate
- [x] Kalman + RTS kinematics; heading held when nearly stopped
- [x] Keep stopped / braking vehicles from the incident (not only free-flow)
- [x] Impact detection that rejects clearing overtakes but keeps crash contacts
- [x] `brake` and `rest` events from kinematics
- [x] Measured package for persons 3 and 4

## Intentionally deferred

- YOLO11 / BoT-SORT / SAM 2 (overlays are the detections; SAM skipped)
- Make/model labels (always `null`)
- Trained `.spz` splats (stub class PLYs)
- Measured camera poses (configured stand-ins)
- AWS / Sol end-to-end run

## Contract notes for app / MCP

- Load the **folder** `scene-packages/incident-demo`.
- Resolve vehicles by **alias** (e.g. `"the red car"`); ids can change across rebuilds.
- `timeline.seek` to `"impact"` should use `manifest.impact_time_s` / the impact event.
- Show `T−` relative to impact when `impact_time_s` is a number.
- Factual speeds/headings must come from track samples / `kinematics.query`.
- Along-road scale uses the configured focal length; phrase answers as reconstruction estimates.

## Known accuracy limits

- Spun-out wreck vehicles sometimes lack burned-in boxes, so some crash participants may be missing or short.
- Along-road meters follow configured `fy`; absolute speeds can be biased even when relative timing of the impact is right.
