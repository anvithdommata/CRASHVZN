/**
 * Main-process side of the in-app assistant.
 *
 * The assistant package (packages/assistant) runs here, in Node: it spawns the user's
 * Claude Code / Codex / Gemini CLI and hosts the MCP server those CLIs call. Every tool
 * call lands on a SceneController, which this file forwards to the renderer over IPC,
 * because the scene, the camera and the timeline live there.
 *
 * Bundled by esbuild into electron/assistant.bundle.cjs (npm run build:assistant) and
 * loaded by main.cjs.
 */
import {
  AssistantSession,
  createIpcSceneController,
  pickDefaultProvider,
  type Effort,
  type ProviderHealth,
  type ProviderKind,
  type SceneControllerMethod,
} from "../../../packages/assistant/src/index";
import type { BrowserWindow, IpcMain } from "electron";
import type { ProvidersHub } from "./providers";

type Choice = { provider: ProviderKind; model?: string; effort?: Effort };

type Deps = { ipcMain: IpcMain; getWindow: () => BrowserWindow | null; providers: ProvidersHub };

/** Tool calls from the model should never hang the chat if the renderer reloads. */
const SCENE_CALL_TIMEOUT_MS = 30_000;

export function registerAssistant({ ipcMain, getWindow, providers: hub }: Deps) {
  let nextCallId = 1;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();

  ipcMain.on("scene:result", (_event, message: { id: number; ok: boolean; result?: unknown; error?: string }) => {
    const call = pending.get(message.id);
    if (!call) return;
    pending.delete(message.id);
    clearTimeout(call.timer);
    if (message.ok) call.resolve(message.result);
    else call.reject(new Error(message.error ?? "The app could not do that."));
  });

  const controller = createIpcSceneController((method: SceneControllerMethod, args: unknown[]) => {
    const win = getWindow();
    if (!win || win.isDestroyed()) return Promise.reject(new Error("The app window is closed."));
    const id = nextCallId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("The app didn't respond in time."));
      }, SCENE_CALL_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      win.webContents.send("scene:call", { id, method, args });
    });
  });

  let session: AssistantSession | null = null;
  let starting: Promise<AssistantSession> | null = null;
  let turn = 0;
  let busy = false;

  const emit = (payload: { turn: number; event: Record<string, unknown> }) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send("assistant:event", payload);
  };

  const providers = (refresh = false): Promise<ProviderHealth[]> => hub.allHealth(refresh);

  /** Default: Claude Code on the user's login, Opus at low effort, unless the Providers page / picker saved another. */
  const DEFAULT_CHOICE: Choice = { provider: "claude", model: "claude-opus-5-5", effort: "low" };
  const saved = hub.chatDefault();
  let choice: Choice = saved.provider
    ? { provider: saved.provider as ProviderKind, model: saved.model || undefined, effort: (saved.effort || undefined) as Effort | undefined }
    : DEFAULT_CHOICE;

  /** Keys come from the encrypted store in the main process, read when a session (re)starts. */
  const credentials = () => ({
    apiKey: hub.getKey("anthropic-api"),
    openaiApiKey: hub.getKey("openai-api"),
    geminiApiKey: hub.getKey("gemini-api"),
  });

  const start = async (opts: Partial<Choice> = {}) => {
    const next: Choice = {
      provider: opts.provider ?? choice.provider,
      model: opts.model === undefined ? choice.model : opts.model || undefined,
      effort: opts.effort === undefined ? choice.effort : opts.effort || undefined,
    };
    const all = await providers();
    if (!all.find((item) => item.kind === next.provider)?.usable) {
      const fallback = pickDefaultProvider(all);
      if (!opts.provider && fallback) {
        // The default provider isn't signed in; use what is, with its own default model.
        next.provider = fallback;
        if (fallback !== "anthropic-api") next.model = undefined;
        if (!["claude", "codex", "anthropic-api", "openai-api"].includes(fallback)) next.effort = undefined;
      } else {
        const hint = all.find((item) => item.kind === next.provider)?.hint;
        throw new Error(hint ? `That assistant isn't ready. ${hint}` : "No assistant is available. Sign in to one on the Providers page.");
      }
    }
    const same = session && choice.provider === next.provider && choice.model === next.model && choice.effort === next.effort;
    if (same) return session!;
    if (session) {
      await session.switchProvider(next.provider, { model: next.model, effort: next.effort, ...credentials() });
      choice = next;
      return session;
    }
    starting ??= AssistantSession.create({
      controller,
      provider: next.provider,
      model: next.model,
      effort: next.effort,
      ...credentials(),
    }).finally(() => {
      starting = null;
    });
    session = await starting;
    choice = next;
    return session;
  };

  ipcMain.handle("assistant:providers", async (_event, refresh?: boolean) => providers(Boolean(refresh)));

  ipcMain.handle("assistant:start", async (_event, opts: Partial<Choice>) => {
    if (busy) throw new Error("Wait for the current reply to finish before switching models.");
    await start(opts ?? {});
    // An explicit pick (chat panel or Providers page) becomes the default for next launch.
    if (opts?.provider) hub.saveChatDefault({ provider: choice.provider, model: choice.model ?? "", effort: choice.effort ?? "" });
    return { ...choice };
  });

  ipcMain.handle("assistant:choice", async () => ({ ...choice }));

  ipcMain.handle("assistant:send", async (_event, text: string) => {
    if (typeof text !== "string" || !text.trim()) throw new Error("Type a message first.");
    if (busy) throw new Error("Still working on the last message.");
    const id = ++turn;
    busy = true;
    void (async () => {
      try {
        const s = session ?? (await start());
        for await (const event of s.send(text)) emit({ turn: id, event: event as unknown as Record<string, unknown> });
      } catch (error) {
        emit({ turn: id, event: { type: "error", message: error instanceof Error ? error.message : String(error) } });
        emit({ turn: id, event: { type: "done" } });
      } finally {
        busy = false;
      }
    })();
    return { turn: id };
  });

  ipcMain.handle("assistant:interrupt", async () => {
    await session?.interrupt();
  });

  return {
    dispose: async () => {
      for (const call of pending.values()) {
        clearTimeout(call.timer);
        call.reject(new Error("The app is closing."));
      }
      pending.clear();
      await session?.close();
      session = null;
    },
  };
}

export { registerKinematics } from "./kinematics";
export { registerAnalysis } from "./analysis";
export { registerProviders } from "./providers";
