<img src="landing/public/favicon.svg" width="56" height="56" alt="">

# CRASHVZN

A desktop app that turns traffic-incident footage into an explorable 3D replay. You can watch the
crash from any angle, read per-frame vehicle motion (position, speed, acceleration, forces), and
drive the view by typing or talking to an AI assistant ("focus on the yellow car", "jump to impact,
how fast was it going?").

![The CRASHVZN viewer: camera controls on the left, the 3D replay with a timeline in the middle, the assistant on the right](landing/public/media/reconstruction-workspace.png)

*The viewer in an earlier build (the 59 s fallback demo scene); the current demo uses the measured 32 s reconstruction.*

## How it works

```text
video ─► vision model reads sampled frames ─► keyframes per vehicle (or a prepared, measured spec for the demo clip)
      ─► engine builds road + lanes and interpolates tracks ─► three.js replay
      ─► per-frame velocity / acceleration / force vectors ─► MongoDB ─► assistant answers from the same data
```

The technical docs explain each stage, the coordinate frames, and the known gaps:
**[docs/README.md](docs/README.md)**.

## Quick start (Windows, macOS, Linux)

Requirements: Node.js 22+, ffmpeg/ffprobe on PATH, a GPU with WebGL2. For analysing new footage,
either the Codex CLI on a ChatGPT login (`codex login`) or Claude Code on a Claude subscription
(`claude auth login`). For the chat assistant, any one of the supported CLIs or API keys. Both are
set up on the in-app **Providers** page ([details](FrontEnd/app/README.md#providers-page)).

```sh
cd packages/assistant && npm ci        # the app imports the assistant's source
cd ../../FrontEnd/app && npm ci
npm start                              # builds the assistant bundle, starts Vite, then Electron
```

The demo clip (`demo.mp4` or `demo_32s.mp4`) loads a prepared reconstruction instantly; other footage
goes through the vision model. On first run the app may download an embedded MongoDB binary and the
local speech model.

If your shell has `ELECTRON_RUN_AS_NODE` set, unset it before `npm start`.

## Repository map

| Path | What it is |
| --- | --- |
| `FrontEnd/app/` | Electron + React + three.js desktop app ([README](FrontEnd/app/README.md)) |
| `FrontEnd/app/electron/` | Main process: vision pipeline (Codex or Claude Code), MongoDB, assistant host, provider sign-in, voice |
| `FrontEnd/app/electron/demo-incident/` | Prepared demo spec and the Python measurement work that produced it ([measure/README](FrontEnd/app/electron/demo-incident/measure/README.md)) |
| `FrontEnd/app/src/` | Renderer: scene engine, viewer, kinematics, UI |
| `packages/assistant/` | Chat/voice assistant: provider adapters, MCP server, tool registry ([README](packages/assistant/README.md)) |
| `BackEnd/` | Earlier Python scene-package pipeline, JSON schemas, OpenSplat/Slurm scripts. **Not used by the app today** ([README](BackEnd/README.md)) |
| `landing/` | Marketing site for crashvzn.us ([README](landing/README.md)) |
| `docs/` | Technical docs, product notes, and historical planning documents |
| `demo.mp4`, `demo_32s.mp4` | The reference incident (four-camera motorway mosaic) and its first 32 s |
| `OpenSplat/` | Git submodule used only by the legacy static-splat route in `BackEnd/` |

A few historical names are kept on purpose so existing user data keeps working: the Electron data
folder is still `reconstruct-viewer`, the MongoDB database is `reconstruct`, and saved AI scenes have
ids starting `gemini-`. Everything else uses CRASHVZN (`crashvzn-app`, `@crashvzn/assistant`,
`window.crashvzn`, MCP server `crashvzn`).

## Checks

```sh
cd FrontEnd/app && npm run build                       # type-check + production build
cd packages/assistant && npm run typecheck && npm test
```

## Credits

We build on open-source projects and CC0 assets. Every one is listed, with its license, in
[CREDITS.md](CREDITS.md). Add to it in the same commit whenever you bring something new in.
