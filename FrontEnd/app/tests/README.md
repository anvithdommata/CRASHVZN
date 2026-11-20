# App tests and demo audits

Two kinds of things live here: **checks you can rerun** and **saved evidence** from audits of the
prepared A9 demo. All commands run from the repository root unless noted.

## Offline checks (`npm test` in `FrontEnd/app`)

| File | What it checks |
| --- | --- |
| `motion-observations.test.ts` | `planMotion` keeps every keyframe and the crash time for 131 overlapping tracks; speed tangents are used only when they agree with the positions; census-only vehicles are placed in their lane |
| `codex-vision.test.ts` | Frame sampling plan and the structured-output schemas. `--live` also runs a real Codex vision call and rewrites `codex-vision-live-result.json` |
| `collision.test.mjs` | Ellipse-footprint contact, impulse and friction stopping for the built-in roundabout and Apache scenes (`src/scene/collision.ts`) |

`codex-vision-live-result.json` is a **fixture**: `motion-observations.test.ts` reads it. It came from
a 20–24 s excerpt (four vehicles) and is not a measurement of the full clip; neither is
`codex-vision-full-result.json`.

## Render checks (hidden Electron window)

Run with `FrontEnd/app/node_modules/electron/dist/electron.exe <file>`. Each mounts the real engine
and viewer and writes its PNGs, a `*-status.json` and a `*-console.log` next to itself, so running one
changes committed files.

| File | Output |
| --- | --- |
| `demo-render.test.cjs` | `demo-crash-*.png`, `demo-overview-15.png` from `electron/demo-incident/incident-spec.json` |
| `codex-render.test.cjs` | `codex-render-live.png` from the `--live` vision result. Shows the result renders, not that it is accurate |
| `demo-fit/a2-median.test.cjs` | `demo-fit/a2/`: road, verge and median from the calibrated crash camera and close-ups |
| `demo-fit/harness/compare.cjs` | Real crash-camera tile vs the app's render from the same calibrated camera (`harness/source-camera.ts` mirrors `measure/cam.py`) |

## Demo audit evidence (`demo-fit/`)

Python scripts and their saved results from auditing the measured demo spec against the footage. The
images are evidence for [project-context.md](../../../docs/project-context.md) and the
[measurement README](../electron/demo-incident/measure/README.md); regenerate them with the script in
the same folder rather than editing them.

| Folder | Audit |
| --- | --- |
| `audit/road/` | A9: projected road lines, divider and vehicle footprints vs the crash tile; do vehicles sit inside lanes |
| `audit/lanes/` | A6: lane-change timing in the spec vs measured tracks, with frame overlays |
| `audit/census/` | A7: every spec vehicle vs the measured tracks; galleries of dropped tracks and uncovered wireframe pixels |
| `audit/crash/` | A8: yellow car and white van boxes vs `crash_pair.json` through the impact (`overlays_run1/`, `metrics_run1.json`) |
| `audit/motion/` | A10: keyframe timing, continuity and overlaps over frames 0–399 (`results.json`) |
| `iter1/`, `sheets/latest/` | Real frames, renders and blends from the render-comparison iterations |

These audits check the prepared demo only. Nothing here measures the accuracy of LLM-built scenes.
