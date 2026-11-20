# Credits and third-party code

The hackathon allows open-source projects as long as they are credited properly in version
control. This file is that record. **Whenever you add a library, copy code, vendor a repo,
or bring in an asset or dataset, add it here in the same commit.**

## How to credit (team rules)

1. **Add a row** to the matching table below, in the same commit that brings the thing in:
   name, link, license, what we use it for, and where it lives in this repo.
2. **Say it in the commit message.** Add a `Credits:` trailer for each project, e.g.

   ```
   Add footage-matched environment and sky textures

   Credits: Poly Haven textures and HDRIs (CC0) https://polyhaven.com
   Credits: three.js HDRLoader (MIT) https://github.com/mrdoob/three.js
   ```

3. **Copied or vendored code keeps its notice.** If you paste code from a repo or copy a
   folder in (not installed through npm/pip), keep the original copyright and license
   header, put a comment at the top saying where it came from (repo URL plus commit or
   tag), and keep the project's `LICENSE` file next to it (e.g. `third_party/<name>/LICENSE`).
4. **No license, no copy.** A public repo without a license is "all rights reserved".
   Link to it or ask the author, but don't copy from it.
5. **Check the license before you depend on it.** Watch for:
   - *Copyleft* (GPL, AGPL): if we ship or host something built on it, our code has to be
     released under the same license. AGPL also covers running it as a network service.
   - *Non-commercial* (CC BY-NC, research-only model weights): fine for a hackathon demo,
     but note it here so nobody builds a product on it by mistake.
   - *Model weights often have a different license from the code.* Record both.
6. **Datasets and footage** need a source and license too, including anything used only
   for testing or calibration.

## App runtime dependencies (`app/package.json`)

| Project | Version | License | Used for |
| --- | --- | --- | --- |
| [three.js](https://github.com/mrdoob/three.js) | 0.180.0 | MIT | 3D rendering. Also these add-ons from `three/examples/jsm`: `OrbitControls`, `HDRLoader`, and the post-processing chain `EffectComposer`, `RenderPass`, `GTAOPass` (ambient occlusion), `UnrealBloomPass`, `OutputPass` (`app/src/scene/mountScene.ts`, `app/src/scene/environment.ts`) |
| [Spark](https://github.com/sparkjsdev/spark) (`@sparkjsdev/spark`) | 2.4.0 | MIT | Gaussian splat rendering |
| [React](https://github.com/facebook/react) / React DOM | 19.3.1 | MIT | UI |
| [Zustand](https://github.com/pmndrs/zustand) | 5.1.0 | MIT | App state |
| [Lucide](https://github.com/lucide-icons/lucide) (`lucide-react`) | 1.73.0 | ISC | Icons |
| [Electron](https://github.com/electron/electron) | 45.3.2 | MIT | Desktop shell |
| [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) (`sherpa-onnx-node` and its prebuilt `sherpa-onnx-<platform>-<arch>` binary packages) | 2.0.1 | Apache-2.0 | On-device speech to text for the voice button. Runs Parakeet TDT and Silero VAD in a utility process (`app/electron/voice/worker.cjs`). The binary packages bundle [ONNX Runtime](https://github.com/microsoft/onnxruntime) (MIT). |

## Kinematics database (`app/package.json`)

| Project | Version | License | Used for |
| --- | --- | --- | --- |
| [MongoDB Node.js driver](https://github.com/mongodb/node-mongodb-native) (`mongodb`) | 7.9.0 | Apache-2.0 | Per-frame kinematics store (`app/electron/kinematics.ts`) |
| [mongodb-memory-server](https://github.com/typegoose/mongodb-memory-server) | 11.3.0 | MIT | Runs an embedded `mongod` with on-disk storage in the app's data folder when `MONGODB_URI` isn't set, so demos need no database setup |
| [MongoDB Community Server](https://github.com/mongodb/mongo) (`mongod` 8.2.6, downloaded by mongodb-memory-server into `~/.cache/mongodb-binaries`, not in the repo) | 8.2.6 | **SSPL v1** | The database server itself. Fine to run locally and for the demo. SSPL obligations apply only if we offered MongoDB itself as a hosted service, which we don't; use Atlas or a managed server via `MONGODB_URI` for anything hosted. |

## Assistant package dependencies (`packages/assistant/package.json`)

Also bundled into the Electron main process through `app/electron/assistant.ts`.

| Project | Version | License | Used for |
| --- | --- | --- | --- |
| [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) (`@modelcontextprotocol/sdk`) | 1.32.2 | MIT | Local MCP server that exposes the app's tools to the Claude Code / Codex / Gemini CLIs |
| [Zod](https://github.com/colinhacks/zod) | 4.6.7 | MIT | Tool argument schemas and validation (also imported by the renderer for the fast path) |
| [Anthropic TypeScript SDK](https://github.com/anthropics/anthropic-sdk-typescript) (`@anthropic-ai/sdk`) | 1.8.0 | MIT | API-key fallback provider |
| [tsx](https://github.com/privatenumber/tsx), [Vitest](https://github.com/vitest-dev/vitest) | dev only | MIT | Dev chat CLI and tests |

## App build and dev tools

| Project | Version | License | Used for |
| --- | --- | --- | --- |
| [Vite](https://github.com/vitejs/vite) + [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react) | 8.3.8 / 6.3.0 | MIT | Dev server and bundling |
| [Tailwind CSS](https://github.com/tailwindlabs/tailwindcss) + `@tailwindcss/vite` | 4.3.5 | MIT | Styling |
| [TypeScript](https://github.com/microsoft/TypeScript) | 7.0.2 | Apache-2.0 | Type checking |
| [concurrently](https://github.com/open-cli-tools/concurrently) | 10.0.7 | MIT | Runs Vite and Electron together |
| [wait-on](https://github.com/jeffbski/wait-on) | 9.5.1 | MIT | Waits for Vite before launching Electron |
| [esbuild](https://github.com/evanw/esbuild) | 0.25.12 | MIT | Bundles the assistant bridge for Electron's main process (`app/electron/assistant.ts` → `assistant.bundle.cjs`) |

## Assets

| Asset | Source | License | Where |
| --- | --- | --- | --- |
| PBR textures: asphalt_02, brushed_concrete, concrete_pavement, gravel_ground_01, leafy_grass, withered_grass, snow_02, sandy_gravel | [Poly Haven](https://polyhaven.com/textures) | CC0 | `app/public/textures/` (per-file table in `app/public/textures/CREDITS.md`) |
| Sky HDRIs: kloofendal_48d_partly_cloudy_puresky, kloofendal_overcast_puresky, qwantani_dusk_2_puresky, kloppenheim_02_puresky | [Poly Haven](https://polyhaven.com/hdris) | CC0 | `app/public/textures/sky/` |

CC0 means no attribution is legally required. We credit Poly Haven anyway.

## Model weights (downloaded at runtime, not in the repo)

The voice button downloads these on first use into Electron's `userData` folder
(`voice-models/`). `app/electron/voice/models.cjs` pins each file's URL revision and SHA-256.

| Model | Source | License | Used for |
| --- | --- | --- | --- |
| NVIDIA Parakeet TDT 0.6B v2 (English), int8 ONNX export, 662 MB | Weights: [nvidia/parakeet-tdt-0.6b-v2](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v2). ONNX export by the sherpa-onnx project: [csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8](https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8), revision `84b478d` | CC BY 4.0 (attribution required, commercial use allowed) | Speech recognition for voice input |
| [Silero VAD](https://github.com/snakers4/silero-vad) (`silero_vad.onnx` from sherpa-onnx's `asr-models` release) | https://github.com/k2-fsa/sherpa-onnx/releases/tag/asr-models | MIT | Drops clips with no speech before recognition, so the model doesn't invent text for silence |

## Methods and references

| Reference | Used in |
| --- | --- |
| [Hex](https://github.com/anomalyco/hex) by Christopher Langton, MIT, read at commit `64234cc` (Nov 2026). We reimplemented its dictation behaviour in JavaScript and copied no Hex source files. What we took: the tap-or-hold gesture with its 300 ms hold threshold, the 200 ms post-release tail, the 450 ms pre-roll and keeping the mic open after dictating (`src/dictation.rs`, `src/audio/linger.rs`); the silence gate's algorithm and constants (-50 dBFS fixed threshold, 12 dB over the clip's 10th-percentile noise floor, -66 dBFS floor, 180 ms sustained run in 30 ms windows) and padding clips to 1.5 s for Parakeet (`src/dictation.rs`); the Silero settings (threshold 0.4, 160 ms minimum speech, `src/transcription/speech_detector.rs`); the warm-up on 1.5 s of silence after loading (`src/transcription/local_transcriber.rs`); the filler-word list and rules (`src/dictation/filler_words.rs`) and case-insensitive whole-phrase replacements (`src/dictation/text_replacements.rs`); resumable `.partial` downloads with a size and SHA-256 check (`src/transcription/models.rs`). Each derived file names Hex in its header; `gate.cjs` and `cleanup.cjs`, which follow Hex's code most closely, also carry its copyright line. | `app/electron/voice/gate.cjs`, `cleanup.cjs`, `worker.cjs`, `models.cjs`; `app/src/voice/controller.ts`, `recorder.ts` |
| D. Hasler and S. Süsstrunk, "Measuring colourfulness in natural images", *Proc. SPIE 5007*, 2003 | Colourfulness metric in `app/src/lib/analyzeFootage.ts` (our own implementation) |
| Khronos PBR Neutral tone mapper (built into three.js as `NeutralToneMapping`) | `app/src/scene/mountScene.ts` |
| AASHTO *A Policy on Geometric Design of Highways and Streets* and FHWA *MUTCD* Part 3 (US lane widths, shoulders, cross slope, marking dimensions) | `app/src/road/spec.ts` |
| German FGSV guidelines RAA / RAL / RASt (cross-sections) and RMS (markings) | `app/src/road/spec.ts` |
| Tyre-road friction by surface (`FRICTION` in `app/src/road/spec.ts`): commonly quoted typical ranges, **not yet checked against a cited source**. Before the kinematics are used for real conclusions, verify them against a reconstruction reference (e.g. Fricke, *Traffic Accident Reconstruction*, Northwestern University) and cite it here. | `app/src/road/spec.ts` |
| OpenStreetMap tagging conventions (`highway`, `lanes`, `lanes:forward`, `width`, `maxspeed`, ...) | `fromOsmTags` in `app/src/road/spec.ts`. No OSM data is bundled. If we query OSM/Overpass at runtime, the data is ODbL and the map UI must show "© OpenStreetMap contributors". |

## Footage and data

| Item | Source | License | Used for |
| --- | --- | --- | --- |
| `r05_s03_labels_visualization.mp4` (4-camera highway feed with 3D vehicle boxes) | TUM Traffic Accident dataset (TUMTraf-A / Accid3nD), A9 gantries S040/S050: https://accident-dataset.github.io/ . Identified from the sensor setup and calibration fit; exact release/sequence name still to confirm against the download. | CC BY-NC-SA 4.0 (non-commercial, share-alike) | Reference and calibration for the "Divided highway traffic" scene and the environment analyzer. The video itself is **not** checked into the repo. |
| `19166351-uhd_3840_2160_24fps.mp4` (top-down drone shot of a sunny, sandy town road) | Filename matches Pexels' download naming. **TODO: confirm Pexels video 19166351 and its creator** | Pexels License, if confirmed (free use, credit appreciated) | Calibration of the arid ground colour (`#ab9a88`) and the analyzer's sun/arid rules. Not in the repo. |
| Five traffic photos (night city jam, daytime jam, sunny top-down street, aerial junction, wet queue). Three carry Getty Images, Alamy and iStock watermarks. | Stock photo sites | **Proprietary stock. Not licensed for redistribution.** | Visual reference only: we measured colours and statistics from them to calibrate `analyzeFootage.ts`. **Never commit these images or use them in the demo.** |

The analyzer's calibration clips (made from the items above) live only in a local scratch
folder and are not part of the repo.

## Evaluated and not used

| Project | Why not |
| --- | --- |
| [SpeedBreaker](https://github.com/SpeedBreakerProject/speedbreaker) (GPL-3.0) | A static recompilation of the Xbox 360 *Need for Speed: Most Wanted*. It contains no textures or models ("bring your own disc"), and the game's art belongs to EA, so it cannot be used as a source of visuals. Its C++/PowerPC recompiler code has nothing a three.js viewer can use. |
| [whisper.cpp](https://github.com/ggml-org/whisper.cpp) Node bindings (e.g. `smart-whisper`, MIT) | Considered as the voice engine. The Node bindings compile whisper.cpp at install time, which needs a C++ toolchain on Windows and rebuilds for Electron's ABI. Whisper is also slower than Parakeet on CPU for short English clips, and more prone to inventing text for silence. |
| [Transformers.js](https://github.com/huggingface/transformers.js) Whisper in the renderer (Apache-2.0) | Considered as the voice engine. Installs as pure JS/WASM, but WASM Whisper on the CPU is several times slower than native ONNX Runtime, and in the renderer it competes with the 3D view for the main thread and GPU. |
| Moonshine base and Whisper base.en through sherpa-onnx | Smaller downloads (about 290 MB and 160 MB int8) but less accurate than Parakeet TDT v2 for English dictation. Not wired in. |

## Planned pipeline projects (from `docs/history/hackathon-requirements.md`)

These aren't in the repo yet. When one goes in, move it into a table above and confirm its
license from the repo's `LICENSE` file, and its model-weights license, at the version we use.

| Project | Watch out for |
| --- | --- |
| [Ultralytics YOLO11](https://github.com/ultralytics/ultralytics) | AGPL-3.0 (copyleft, including network use); an enterprise license is sold separately |
| [SAM 2](https://github.com/facebookresearch/sam2) | Check the code and checkpoint licenses |
| [gsplat](https://github.com/nerfstudio-project/gsplat) | Check the license |
| [VGGT](https://github.com/facebookresearch/vggt), [MASt3R](https://github.com/naver/mast3r), [MegaSaM](https://github.com/mega-sam/mega-sam) | Pose models: some are released for research or non-commercial use only. Check both code and weights |
| BoT-SORT / ByteTrack, COLMAP / GLOMAP | Check the license |
| [faster-whisper](https://github.com/SYSTRAN/faster-whisper), [whisper.cpp](https://github.com/ggml-org/whisper.cpp) | Check the license and the Whisper model weights license |
