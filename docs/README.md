# CRASHVZN technical docs

How the desktop app turns crash footage into an explorable 3D replay with per-frame motion data.
Each doc names the source files it describes. When code and docs disagree, the code wins: fix the doc
in the same change.

| Doc | Read it when you're touching… |
| --- | --- |
| [coordinate-frames.md](coordinate-frames.md) | Any position, heading, velocity, force, contact normal or camera pose crossing modules. **Read first.** |
| [vision-pipeline.md](vision-pipeline.md) | Footage upload, LLM prompts and schemas, keyframes, the prepared demo shortcut, analysis caching |
| [kinematics-database.md](kinematics-database.md) | MongoDB, per-frame vectors, force decomposition, assistant data queries |
| [lanes.md](lanes.md) | Road cross-sections, lane widths, measured paint, census lane hints |
| [camera-and-views.md](camera-and-views.md) | Orbit/pan/zoom, preset views, follow/POV, scene bounds, projection |

## System in one picture

```text
video ──► vision pipeline (LLM keyframes, or the prepared measured spec for the demo clip)
            │  IncidentSpec, plan frame
            ▼
          engine: road + lanes (drawing), 50 Hz tracks, scene poses
            │                                   │
            ▼                                   ▼
          three.js viewer ◄── camera ops    derive: 30 fps vectors ──► MongoDB frames
            ▲                                                             │
            └──────── assistant tools (MCP) ── read-only queries ─────────┘
```

Historical planning docs at the repository root (`requirements.md`, `roles.md`, `STATUS.md`,
`HANDOFF.md`) describe the hackathon plan and earlier checkpoints. They are not a description of the
current code. `personalprojecthandoff.md` is the most recent project-level summary.
