# Frame-exact measurement of the demo crash

Python work that produced the prepared demo reconstruction (`../incident-spec.json`). It measures the
first 32 s of `demo.mp4` (frames 0–399, 12.5 fps) from the **bottom-right camera tile**, where the
crash happens, and turns pixel tracks into metric trajectories. The app never runs these scripts;
it only reads the spec they lead to.

How this fits into the app: [docs/vision-pipeline.md](../../../../../docs/vision-pipeline.md#the-prepared-demo-path).
Coordinate frames: [docs/coordinate-frames.md](../../../../../docs/coordinate-frames.md).

## Setup

Python 3.11 with `numpy`, `scipy` and `opencv-python-headless`:

```sh
python -m venv .venv
.venv/bin/pip install numpy scipy opencv-python-headless     # .venv\Scripts\pip on Windows
```

`detect_track.py`, `world_kinematics.py`, `calib.py` and `../build-measured-spec.py` find their inputs
from their own location, so they run from anywhere. The two early scripts use the **current
directory**: run `bg.py <path to demo.mp4>` and `dashes.py` from inside `data/`.

## Frames and crop

- Crash camera crop in the 960×610 mosaic: **x=481, y=304, w=479, h=300**. All pixel coordinates
  here are relative to that crop. `t = frame / 12.5`.
- **World frame W** (meters): X along the road **away** from the camera, Y lateral, positive to the
  camera's **right**, Z up. Y = 0 is the dashed line between lanes 1 and 2 of the far carriageway
  (traffic moving away). The crash carriageway (traffic toward the camera, −X) is at negative Y.
- `cam.py`: pinhole model loaded from `data/calib_joint.json`, principal point at the tile centre
  (239.5, 150). `to_ground(u, v) → (X, Y)` on Z = 0 and `to_img(X, Y, Z) → (u, v)`. The exported camera
  is `data/br_camera.json` (f ≈ 2029 px, height ≈ 8.6 m, pitch ≈ 4.6° down).

## Pipeline

| Step | Script | Input → output |
| --- | --- | --- |
| Background plate | `bg.py <video>` | first 400 frames → `br_bg.png` (median background) in the current directory |
| Dash detection | `dashes.py` | `br_bg.png` → `dashes.json`, `dashes_vis.png` in the current directory |
| Calibration | `calib.py`, `cam.py` | dash ends + every painted line + the stopped van's burned-in 3D box (width 2.05 m, for lateral scale) → `data/calib_3.75.json`, `calib_joint.json`, `br_camera.json`. `calib_3.5.json` is an earlier 3.5 m-lane fit kept for comparison |
| Detection + tracking | `detect_track.py` | burned-in 3D wireframes (cyan car, yellow van, green truck) fitted as projected cuboids → `data/tracks_px.json` (raw, fragmented) |
| Identity cleanup | *not in this folder* (see below) | `tracks_px.json` → `data/tracks_px_clean.json` (merged identities, excluded clutter, reserved crash silhouettes) |
| World kinematics | `world_kinematics.py --in data/tracks_px_clean.json` | ground back-projection + constant-acceleration Kalman/RTS smoother → `data/tracks_world.json` |
| Crash pair | *not in this folder* | per-frame yellow car and white van, contacts, lane sequence → `data/crash_pair.json` |
| Median divider | *not in this folder* | measured verge/barrier footprint and material → `data/divider.json` |
| Spec | `../build-measured-spec.py [--check]` | the four `data/*.json` files above + `br_camera.json` → `../incident-spec.json` (+ `.build.json` with transforms and hashes) |

`world_kinematics.py` defaults to `--in data/tracks_px.json`; the saved `tracks_world.json` records
`source: tracks_px_clean.json`, so pass the clean file explicitly to reproduce it.

**Reproducibility gap:** the identity cleanup, crash-pair and divider measurements were done in
separate review sessions whose scripts were not committed here. The audit scripts that check them are
in `FrontEnd/app/tests/demo-fit/audit/` and the track audit summary is
`review_tracks/REVIEW-COMPLETE.md`. Treat the three JSON outputs as hand-reviewed inputs until those
steps are scripted.

## Review and fixture folders

| Folder | Contents |
| --- | --- |
| `review/` | Reprojection of the **old** fallback spec onto the source (`reproject.py`, `story.py`, `out/`, `out_px/`) |
| `review_calib/` | Calibration overlays |
| `review_tracks/` | Tracking overlay frames and the final track audit (`REVIEW-COMPLETE.md`) |
| `review_world/` | **Synthetic** tracks used to test `world_kinematics.py` (`synth.py`, `check_synth.py`) |
| `review_spec/` | **Synthetic** fixtures for `build-measured-spec.py` (`make_synthetic.py`, `engine-check-measured.mts`). Never use these as real measurements |

Don't regenerate `../incident-spec.json` with `../build-spec.py` or `../traffic.py`. Those are the
older hand-authored fallback and would overwrite the measured result.
