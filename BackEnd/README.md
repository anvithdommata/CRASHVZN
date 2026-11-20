# Backend reconstruction pipeline

> **Not used by the desktop app today.** The app builds scenes from the vision pipeline and the prepared
> demo spec (see [docs/vision-pipeline.md](../docs/vision-pipeline.md)). This folder holds the earlier
> hackathon routes: a static OpenSplat reconstruction for ASU Sol, and the `reconstruct` Python package
> that writes scene packages from the burned-in boxes in `demo.mp4`. Nothing in the app reads
> `scene-packages/`, `schema/` or `scene-types/`.

## Layout

| Path | What it is |
| --- | --- |
| `pipeline/` | `reconstruct` Python package: `reconstruct build`, `reconstruct validate`, `export-collision-trajectories` |
| `pipeline/configs/incident-demo.yaml` | Build config for the demo package |
| `scene-packages/incident-demo/` | Generated scene package (tracks, entities, events, cameras, stub splats) |
| `schema/` | JSON Schemas for the scene package (source of truth for the Pydantic models) |
| `scene-types/` | Matching TypeScript types |
| `pipeline/build_opensplat.sh`, `pipeline/reconstruct.sh`, `slurm/reconstruct.sbatch` | Static OpenSplat route for Sol |

## Scene-package pipeline

```sh
python -m venv BackEnd/pipeline/.venv
BackEnd/pipeline/.venv/bin/pip install -e "BackEnd/pipeline[dev]"     # Scripts\ on Windows
BackEnd/pipeline/.venv/bin/reconstruct build                          # writes BackEnd/scene-packages/incident-demo
BackEnd/pipeline/.venv/bin/reconstruct validate BackEnd/scene-packages/incident-demo
cd BackEnd/pipeline && .venv/bin/pytest -q
```

The package format is documented in [scene-packages/README.md](scene-packages/README.md).

Known test state (2026-11-16): 22 pass, 2 fail. `test_demo_package_detects_the_accident` and
`test_package_is_measured_from_the_mosaic` expect the detected impact between 18 and 26 s. A rebuild
on Windows (ffmpeg 8.1.2, numpy 2.4.6, scipy 1.17.1) finds **160 tracks / 5,514 samples and the first
impact at 27.28 s (v62–v77)**, while the committed package has 155 tracks / 5,355 samples and impact
21.76 s (v53–v56). The same failure happens with the code before it moved under `BackEnd/`, so the
difference is environmental: the box detector reads ffmpeg's `rgb24` output with fixed colour
thresholds, and the decode step doesn't pin the YUV→RGB conversion, so a different ffmpeg build
likely changes which wireframe pixels pass. That cause is a hypothesis; it hasn't been confirmed
against the original build machine. Don't regenerate the committed package until it's resolved. On Windows, pass
`--basetemp <writable dir>` to pytest if the default temp folder is not writable.

The backend runs on ASU Sol. The `OpenSplat` directory at the repository root is a Git submodule; the backend scripts use its built executable at `OpenSplat/build/opensplat`. OpenSplat is licensed under AGPL-3.0, which should be considered before distributing this application.

## Prepare OpenSplat on Sol

Initialize the submodule after cloning the project:

```bash
git submodule update --init --recursive
```

Load or activate the LibTorch, OpenCV, CMake, and CUDA environment supported by your Sol allocation. Set the CMake paths, then build:

```bash
export CMAKE_PREFIX_PATH=/path/to/libtorch
export OPENCV_DIR=/path/to/opencv
export GPU_RUNTIME=CUDA
bash BackEnd/pipeline/build_opensplat.sh
```

`CMAKE_PREFIX_PATH` and `OPENCV_DIR` must point to the compatible installations on Sol. Do not build OpenSplat on the Windows desktop for the Sol job.

## Run a static reconstruction

First make sure `ffmpeg`, `colmap`, and the OpenSplat executable are available in the job environment. Then submit:

```bash
sbatch BackEnd/slurm/reconstruct.sbatch \
  /scratch/$USER/sunhacks/incident-001/sources \
  /scratch/$USER/sunhacks/incident-001/output
```

The pipeline extracts frames into one folder per input video, runs COLMAP feature extraction/matching/mapper, and trains `background.splat` with OpenSplat. `FRAME_RATE` defaults to 1 frame per second and `OPEN_SPLAT_ITERATIONS` defaults to 2000; both can be overridden when exported into the Slurm job environment.

The output contains `background.splat`, `manifest.json`, and the COLMAP project used for training. The manifest records source filenames and SHA-256 hashes. The output is **static** and uses COLMAP-relative coordinates. This job does not yet create vehicle segmentation, 6DoF tracks, kinematics, or per-vehicle splats, so it is not the complete 4D incident package.

The Electron app currently stages selected source videos locally; it does not transfer them to Sol or submit this job automatically. Transfer inputs to Sol, submit the Slurm job, and download `background.splat` to the desktop. In the app, choose **Load splat output** to view it.

To try it, copy `demo.mp4` (the four-camera mosaic) to Sol before submitting; COLMAP still needs enough camera motion/parallax and visual overlap to estimate poses and geometry. A fixed-camera clip may not produce a usable 3D reconstruction, while overlapping views from multiple cameras are more suitable.

## Built-in proxy collision motion

The roundabout and Apache viewer scenes detect the first contact between the vehicles' oriented elliptical hitboxes along their authored paths. Their impact times are derived from that contact, so changing a hitbox or path can move the crash or prevent it. The viewer resolves a normal impulse with angular response, conserves linear momentum, and applies dry-asphalt Coulomb friction after impact. These are illustrative reconstructions, not measured crash results.

The current illustrative masses are 1,950 kg (roundabout SUV), 1,500 kg (roundabout sedan), 1,600 kg (Apache sedan), and 2,000 kg (Apache SUV). Both pairs approach at about 20 m/s; restitution is 0.15 and dry-asphalt friction is 0.75. The Python `export-collision-trajectories` command and its NumPy/SymPy point-mass solver remain available for offline experiments, but the interactive viewer no longer consumes the generated `impactTrajectories.json`.
