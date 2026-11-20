# @crashvzn/assistant

The assistant layer. Lets the user drive the app by chat or voice using their own Claude Code, Codex, OpenCode, Gemini or Grok CLI login (or an Anthropic, OpenAI or Gemini API key as a fallback). The model controls the app only through our MCP tools. Sign-in and keys are managed on the desktop app's Providers page (see `FrontEnd/app/README.md`).

```
chat/voice panel ──▶ AssistantSession.send(text)
                       ├─ fast path (regex, <1 ms) ─────────────┐
                       └─ provider adapter                       │
                           ├─ claude -p (stream-json, long-lived)│
                           ├─ codex exec --json (per turn)       ├─▶ SceneController ─▶ app state (Zustand)
                           ├─ gemini -p (per turn)               │     (FrontEnd/app/src/assistant/sceneController.ts)
                           ├─ opencode / grok (ACP, long-lived)  │
                           │     └─▶ MCP server 127.0.0.1+token ─┤
                           └─ Anthropic/OpenAI/Gemini API ───────┘
                               (API keys; tools run in-process)
```

## Try it

```sh
npm install
npm run providers                 # which CLIs are installed and signed in
npm run chat                      # REPL against a mock two-car scene
npm run chat -- --provider claude --model haiku "zoom in on the red toyota"
npm test
```

## Integrating with the app

1. Implement `SceneController` (`src/controller.ts`) on top of the Zustand store. Its header lists the conventions the prompt promises users: camera moves clamp to the scene box and report `clamped`, work while playing, and scene calls fail with "No incident is open." on the home screen. World frame: meters, +x east, +y up, −z north, origin at the crash point. Functions are async so the main process can forward them to the renderer over IPC. `createIpcSceneController(invoke)` builds the proxy for you.
2. In the Electron main process:
   ```ts
   const health = await checkAllProviders();          // show in settings
   const session = await AssistantSession.create({
     controller, provider: pickDefaultProvider(health)!,
   });
   for await (const ev of session.send(text)) webContents.send("assistant:event", ev);
   ```
3. Render `SessionEvent`s: `text` deltas, `tool_call`/`tool_result` as small chips ("Orbiting…"), `error`, `done`.

`MockSceneController` (`src/mock/mock-scene.ts`) is a working reference implementation.

## Files

| File | What it is |
|---|---|
| `src/tools/registry.ts` | The 26 tools (`docs/history/hackathon-requirements.md` §7 plus `docs/product/ux-features.md`): library and Back, exact camera moves (degrees and meters), POV, crash-relative timeline seeks, per-frame kinematics and series, overlays including the source video. One definition serves MCP and the API adapters. Names use `_` not `.` (API name rules). |
| `src/mcp/server.ts` | Streamable HTTP MCP server on `127.0.0.1`, random port, per-session bearer token, stateless. |
| `src/prompt/system-prompt.ts` | The system prompt: plain language, numbers only from tools, units + uncertainty, crash as a period (before = before `crash_start`), camera conventions and scene bounds, POV caveat, no fault/liability opinions, read-only data. |
| `src/fastpath.ts` | Instant handling for "pause", "zoom in", "orbit 90 left", "jump to impact", etc. Anything naming a vehicle or asking a question goes to the LLM. |
| `src/providers/catalog.ts` | Every provider the Providers page shows: label, CLI, sign-in command (browser or terminal), install hint, API-key env var, models, efforts, how far it's tested. Also the T3 Code providers we don't support yet. |
| `src/providers/health.ts` | T3 Code-style detection: `--version`, then `claude auth status`, `codex login status`, `opencode auth list --format json`, `grok models`, `cursor-agent status`; Gemini's creds file is only checked for existence; API keys by presence. Never reads credentials. |
| `src/providers/*-cli.ts` | One adapter per CLI, each locked to our tools only (see the header comment in each file for the exact flags). |
| `src/providers/acp.ts` | Agent Client Protocol client (JSON-RPC over stdio) used by the OpenCode and Grok adapters: our MCP server goes in `session/new`, no client fs/terminal capabilities, and permission requests are approved only for our tools. |
| `src/providers/anthropic-api.ts` | API-key fallback: Messages API tool loop, `claude-opus-5-5` at low effort, server-side refusal fallback on. |
| `src/providers/openai-api.ts` | API-key fallback: Chat Completions tool loop over the same registry, `gpt-5.5` by default, plain REST. |
| `src/providers/resolve-cli.ts` | Finds CLIs on PATH and runs Windows npm `.cmd` shims without a shell: JS shims through node, native-binary shims (OpenCode 2) as the `.exe`, so prompts aren't mangled by `cmd.exe`. |

## Adapter lifecycle

Every adapter keeps its process state in one discriminated `state` field instead of separate nullable
fields, and its in-flight turn in a `TurnSlot` (`src/providers/queue.ts`):

| Adapter | States |
| --- | --- |
| `claude-cli.ts` (one long-lived `claude -p`) | `stopped` → `starting` (shared promise, so concurrent sends launch once) → `running { child, dir }` |
| `acp.ts` (OpenCode, Grok) | `stopped` → `booting { proc }` (spawned, negotiating the ACP session) → `ready { proc, sessionId }` |
| `codex-cli.ts` (one `codex exec` per turn) | `stopped` → `idle { dir }` ⇄ `turn { dir, child }` |
| `gemini-cli.ts` (one `gemini -p` per turn) | `stopped` → `preparing` → `idle { dir }` ⇄ `turn { dir, child }` |

A process exit only resets the state if it is still the current process, and `stop()` waits for a
start in progress before cleaning up its temp dir. `TurnSlot.begin()` refuses a second turn while one is
running; `end()` closes the running turn with a final event. The API-key adapters hold only an
`AbortController` for the running request.

## Status

| Provider | Sign in | Status check | Chat status |
|---|---|---|---|
| Claude Code 2.1.x | `claude auth login` (browser) | `claude auth status` (JSON) | Verified end to end: the full demo script, multi-turn, guardrails. Only our tools are exposed. About 1.6 s to the first tool call and 3.5 s per simple command (Pro plan, default model). Status re-checked with 2.1.326 ("Claude Pro"). |
| Codex CLI 0.167+ | `codex login` (browser) | `codex login status` | Verified end to end on 0.169.0 (2026-11-16): `scene_describe` tool call and result parsed, answer streamed. About 16 s to the first tool call with the default model and low effort. |
| OpenCode 2.1.4 | `opencode auth login` (terminal: it asks which model provider) | `opencode auth list --format json` (names and methods only) | Verified end to end over ACP: tool calls, the system prompt, and a refused file read. **Caveat:** OpenCode 2.1.4 reaches MCP tools only through its code-mode `execute` tool, and that JS sandbox has `fetch`, so a model could make a web request. Every built-in tool (files, shell, web, subagents, skills) and the user's own MCP servers are disabled; denying `execute` hides MCP tools altogether in this version. |
| Gemini CLI | first run of `gemini` (terminal) | `~/.gemini/oauth_creds.json` exists (never read) | Written from the docs. Not installed on the dev machine yet, so not run. |
| Grok Build CLI | `grok login` (browser) | `grok models` ("You are logged in"), or `XAI_API_KEY` | **Unverified**: not installed here. ACP launch `grok --permission-mode default agent stdio` taken from T3 Code; we approve only our tools' permission requests. Whether Grok asks before its read-only built-ins is unknown. |
| Cursor Agent CLI | `cursor-agent login` (browser) | `cursor-agent status` | **No chat adapter.** Status and sign-in only: T3 Code drives Cursor through `@cursor/sdk`, not the CLI, and the CLI loads the user's own `~/.cursor/mcp.json`, so a tools-only lock-down can't be confirmed. Unverified (not installed). |
| Anthropic API | key on the Providers page | key present | Typechecked; needs a key to run. |
| OpenAI API | key on the Providers page | key present | **Unverified**: Chat Completions tool loop, typechecked only (no key on the dev machine). |
| Gemini API | key on the Providers page | key present | Last-resort fallback, `gemini-3.1-flash-lite`, plain REST. Typechecked, deliberately not run. |
| Kiro, Pi, Muse Code, fx, Antigravity | | | Not supported yet (T3 Code has them; their non-interactive + MCP interfaces couldn't be determined). Listed on the Providers page. |

API keys: in the desktop app they're stored encrypted with Electron `safeStorage` and passed in when a session starts (`apiKey`, `openaiApiKey`, `geminiApiKey` on `AssistantSession.create`). In development, the gitignored `packages/assistant/.env` still works (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`).

Order when nothing is picked: `claude` → `codex` → `opencode` → `gemini` → `grok` → `gemini-api` → `anthropic-api` → `openai-api`. Claude Code on the user's own login is the main provider. The CLI adapters remove API-key environment variables before they start, so a key in `.env` never changes which account a CLI bills.

Not done: the AWS S3/EventBridge/SNS setup from the hackathon plan. Voice input exists in the app (`FrontEnd/app/electron/voice/`, local sherpa-onnx speech recognition) and feeds the same `AssistantSession.send`. API-key fields live on the app's Providers page.
