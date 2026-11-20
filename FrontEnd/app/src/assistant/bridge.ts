/**
 * Renderer half of the assistant.
 *
 * Desktop: the model runs in the Electron main process (see electron/assistant.ts). Its tool
 * calls come back here as scene:call messages and run against appSceneController.
 *
 * Plain browser (vite dev without Electron): there's no CLI to talk to, so only the instant
 * fast-path commands ("pause", "top view", "zoom in") work, run locally with the same tools.
 */
import type { SceneControllerMethod } from "@assistant/controller";
import { matchFastPath } from "@assistant/fastpath";
import { callTool } from "@assistant/tools/registry";
import { appSceneController } from "@/assistant/sceneController";
import { useChatStore } from "@/assistant/chatStore";

let localTurn = 1_000_000;

/** Answers the main process's tool calls. Returns an unsubscribe function. */
export function connectSceneBridge() {
  const api = window.crashvzn;
  if (!api?.scene) return () => {};
  const offCalls = api.scene.onCall(async ({ id, method, args }) => {
    try {
      const fn = appSceneController[method as SceneControllerMethod] as (...a: unknown[]) => Promise<unknown>;
      if (typeof fn !== "function") throw new Error(`The app doesn't support "${method}".`);
      const result = await fn(...(Array.isArray(args) ? args : []));
      api.scene.reply({ id, ok: true, result: JSON.parse(JSON.stringify(result ?? null)) });
    } catch (error) {
      api.scene.reply({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });
  const offEvents = api.assistant.onEvent(({ turn, event }) => useChatStore.getState().applyEvent(turn, event));
  return () => {
    offCalls();
    offEvents();
  };
}

export function hasModel() {
  return Boolean(window.crashvzn?.assistant);
}

/** Sends one message from the chat box. */
export async function sendMessage(text: string) {
  const chat = useChatStore.getState();
  const trimmed = text.trim();
  if (!trimmed) return;
  chat.addUser(trimmed);

  if (window.crashvzn?.assistant) {
    try {
      const { turn } = await window.crashvzn.assistant.send(trimmed);
      useChatStore.getState().beginTurn(turn);
    } catch (error) {
      const turn = ++localTurn;
      useChatStore.getState().beginTurn(turn);
      useChatStore.getState().finishTurn(turn, error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(error));
    }
    return;
  }

  // Browser fallback: fast path only.
  const turn = ++localTurn;
  chat.beginTurn(turn);
  const fast = matchFastPath(trimmed);
  if (!fast) {
    useChatStore.getState().finishTurn(
      turn,
      "The language model runs in the desktop app. In the browser, only quick commands work, like \"pause\", \"top view\", \"zoom in\" or \"jump to the crash\".",
    );
    return;
  }
  const started = performance.now();
  const apply = useChatStore.getState().applyEvent;
  apply(turn, { type: "tool_call", id: `fast-${turn}`, name: fast.tool, source: "fast-path" });
  const res = await callTool(appSceneController, fast.tool, fast.args);
  apply(turn, { type: "tool_result", id: `fast-${turn}`, name: fast.tool, ok: res.ok, output: res.ok ? JSON.stringify(res.result) : res.error });
  apply(turn, { type: "text", delta: res.ok ? fast.reply : `Sorry, that didn't work: ${res.error}` });
  apply(turn, { type: "done", durationMs: Math.round(performance.now() - started) });
}

export async function interruptTurn() {
  await window.crashvzn?.assistant?.interrupt().catch(() => {});
  const items = useChatStore.getState().items;
  const last = [...items].reverse().find((item) => item.kind === "assistant" && !item.done);
  if (last && last.kind === "assistant") useChatStore.getState().finishTurn(last.turn, "Stopped.");
}
