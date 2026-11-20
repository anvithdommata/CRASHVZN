# CRASHVZN desktop app

Electron + React + three.js app (package `crashvzn-app`). It
reconstructs an incident from footage, replays it in 3D with a synced timeline and source video,
stores per-frame motion in MongoDB, and hosts the chat/voice assistant.

How the stages work: [docs/README.md](../../docs/README.md).

## Run

The app imports the assistant's source from `packages/assistant`, so install both. From the
repository root:

```sh
cd packages/assistant && npm ci
cd ../../FrontEnd/app && npm ci
npm start        # bundles electron/assistant.ts, starts Vite on 127.0.0.1:5173, then Electron
npm run build    # bundle + type-check + production build
npm test         # offline checks: motion, vision sampling/schemas, collision (see tests/README.md)
```

Vite hot-reloads the renderer. Anything under `electron/` (including the `vision-prompts/*.md` prompts,
which esbuild bundles as text) needs `npm run build:assistant` and an Electron restart. If your shell
has `ELECTRON_RUN_AS_NODE` set, unset it first. Needs ffmpeg/ffprobe on PATH (or `FFMPEG_PATH`) for
video analysis; `MONGODB_URI` is optional (an embedded MongoDB starts otherwise).

The renderer runs under a Content-Security-Policy written into `index.html` by `vite.config.ts`: no
remote content, no `eval`, WebAssembly and workers only from the app or `blob:`/`data:`. Loading
something new from elsewhere means adding it there.

## Code map

| Path | What it does |
| --- | --- |
| `electron/main.cjs`, `preload.cjs` | Main process entry and the `window.crashvzn` IPC bridge |
| `electron/analysis.ts` | Vision pipeline orchestration (legacy name): scan, verify, pass 1/2, census, merge, cache, demo shortcut |
| `electron/vision.ts`, `codex-vision.ts`, `claude-vision.ts`, `vision-frames.ts` | Video-processing providers and the shared ffmpeg frame-sheet extraction |
| `electron/vision-prompts/*.md` | Prompts sent to the vision model |
| `electron/kinematics.ts` | MongoDB: per-frame kinematics, analyses, scenes |
| `electron/assistant.ts`, `providers.ts` | Assistant host (MCP server, sessions) and the Providers page backend (status, sign-in, encrypted keys) |
| `electron/voice*.cjs`, `electron/voice/` | Local speech recognition (sherpa-onnx) in a utility process |
| `electron/split-grid.ts` | Splits a camera-grid video into per-camera clips |
| `electron/demo-incident/` | Prepared demo spec and the Python measurement work behind it |
| `src/incident/` | Incident spec schema/validation (`spec.ts`), motion (`motion.ts`), scene assembly (`engine.ts`), renderer-side run (`reconstruct.ts`) |
| `src/scene/`, `src/road/` | three.js scene, camera, vehicles, road builders and regional road standards; `scene/liveSpeed.ts` reads a vehicle's speed off its trajectory for the panels |
| `src/kinematics/` | Per-frame vector derivation and database sync |
| `src/assistant/` | The app's implementation of the assistant's `SceneController` |
| `src/components/` | UI: library, viewer panels, timeline, chat, Providers page; shared building blocks in `ui.tsx` |
| `src/lib/` | Footage ingest and analysis client, video export, splat files, scene deletion (`deleteScene.ts`) |
| `src/store/` | Zustand stores (app state, providers) |
| `tests/` | Offline and render checks plus the demo audits and their saved evidence; see [tests/README.md](tests/README.md) |

## Providers page

Open it from the gear next to **New upload** in the library, the gear in the viewer's side panel, or **Manage providers and sign-ins…** at the bottom of the chat model picker. Esc closes it. It has two sections.

**Video processing** chooses the model that reads uploaded footage (**Reconstruct with …** in the upload queue). Only subscription logins through each vendor's own CLI are allowed; API keys are never used for this:

| Provider | Runs through | Account | Default model |
|---|---|---|---|
| OpenAI | Codex CLI (`codex exec`) | ChatGPT login (`codex login`) | `gpt-6.1-terra`, xhigh effort |
| Claude | Claude Code (`claude -p --json-schema`) | Claude subscription login (`claude auth login`) | `claude-opus-5-5`, high effort; Sonnet 5.5 and Haiku 5.5 selectable |

Both share the ffmpeg 2×2 frame-sheet extraction (`electron/vision-frames.ts`). The Claude backend (`electron/claude-vision.ts`) runs one non-interactive `claude -p` per request with only the `Read` tool, the frame sheets in a temp dir granted with `--add-dir`, no user settings/MCP servers/skills, the reconstruction skill as its system prompt, and `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` removed so it bills the subscription. The choice is stored in `settings.json` in Electron's userData folder. Cached analyses are keyed by provider, effort and model, so switching providers never returns another provider's reading (the Codex key is unchanged, so earlier Codex readings still load). The demo clip still loads its prepared measured spec without any model call.

**Chat assistant** lists every chat provider with whether it's installed (and its version), whether it's signed in and as what (for example "Claude Pro", "ChatGPT"), and how far it's been tested. Actions, following T3 Code:

- **Sign in** runs the CLI's own login command (`claude auth login`, `codex login`, `grok login`, `cursor-agent login`), which opens the browser OAuth page. If the browser doesn't open, the sign-in link the CLI printed is shown. Status updates when the command finishes.
- **Open terminal to sign in** opens a visible terminal (a new `cmd` window on Windows, Terminal on macOS, the first terminal found on Linux) running that command. OpenCode (`opencode auth login`) and Gemini CLI (first run of `gemini`) ask questions, so their **Sign in** always uses a terminal.
- **Re-check** runs the status check again. **Install in terminal** / **Install guide** appear when the CLI isn't on PATH.
- API-key providers (Claude API, OpenAI API, Gemini API) take a key. Keys are encrypted with Electron `safeStorage` into `provider-keys.json` in userData, stay in the main process (the page only learns whether one is set), and are passed to the adapter when a chat session starts.
- **Make default for chat** switches the assistant and remembers the choice for next launch (the chat panel's picker does the same).

Status checks never read credential files; they run each CLI's `--version` and its own auth-status command (`packages/assistant/src/providers/health.ts`). Kiro, Pi, Muse Code, fx and Antigravity, which T3 Code also supports, are listed as not supported yet.

## Deleting reconstructions

The trash icon on a library tile or in the viewer's side panel deletes a reconstruction after a
confirmation. A saved reconstruction loses its `scenes` doc and its per-frame rows (`frames`,
`incidents`); the model's reading in `analyses` stays cached, so reconstructing the same footage again
is quick. Built-in examples are only hidden (remembered in `localStorage`) and can be restored from the
library. A dropped splat is only removed from the session.

## Staging footage

**Stage** in the upload queue copies the queued videos into Electron's application data
directory with a `manifest.json` of names, sizes and SHA-256 hashes. It was the hand-off point for the
planned Sol job; nothing submits that job today.

## Static splats (legacy)

The upload control can still open a `.splat`, `.ply` or `.spz` file and show it with Spark. A static
splat has no time-varying data, so the timeline doesn't animate it. Producing one needs the OpenSplat
route in [`BackEnd/README.md`](../../BackEnd/README.md); the app doesn't submit those jobs.
